-- ingest_attempt stores the monotone lease sequence, not failure_attempt_count.
-- Keep exact job/owner/sequence fencing and the positive int32 range.
SET lock_timeout = '3s';
ALTER TABLE public.cloud_media_items DROP CONSTRAINT cloud_media_items_ingest_lease_ck, ADD CONSTRAINT cloud_media_items_ingest_lease_ck CHECK ((ingest_job_id IS NULL AND ingest_attempt IS NULL AND ingest_lease_owner IS NULL) OR (ingest_job_id IS NOT NULL AND ingest_attempt BETWEEN 1 AND 2147483647 AND btrim(ingest_lease_owner) <> '' AND length(ingest_lease_owner) <= 160)) NOT VALID;
ALTER TABLE public.cloud_title_variants DROP CONSTRAINT cloud_title_variants_ingest_lease_ck, ADD CONSTRAINT cloud_title_variants_ingest_lease_ck CHECK ((ingest_job_id IS NULL AND ingest_attempt IS NULL AND ingest_lease_owner IS NULL) OR (ingest_job_id IS NOT NULL AND ingest_attempt BETWEEN 1 AND 2147483647 AND btrim(ingest_lease_owner) <> '' AND length(ingest_lease_owner) <= 160)) NOT VALID;
ALTER TABLE public.cloud_live_logical_channels DROP CONSTRAINT cloud_live_logical_channels_ingest_lease_ck, ADD CONSTRAINT cloud_live_logical_channels_ingest_lease_ck CHECK ((ingest_job_id IS NULL AND ingest_attempt IS NULL AND ingest_lease_owner IS NULL) OR (ingest_job_id IS NOT NULL AND ingest_attempt BETWEEN 1 AND 2147483647 AND btrim(ingest_lease_owner) <> '' AND length(ingest_lease_owner) <= 160)) NOT VALID;
ALTER TABLE public.catalog_series_episode_memberships DROP CONSTRAINT catalog_series_episode_memberships_ingest_lease_ck, ADD CONSTRAINT catalog_series_episode_memberships_ingest_lease_ck CHECK ((ingest_job_id IS NULL AND ingest_attempt IS NULL AND ingest_lease_owner IS NULL) OR (ingest_job_id IS NOT NULL AND ingest_attempt BETWEEN 1 AND 2147483647 AND btrim(ingest_lease_owner) <> '' AND length(ingest_lease_owner) <= 160)) NOT VALID;
ALTER TABLE public.catalog_series_inventory_state DROP CONSTRAINT catalog_series_inventory_state_ingest_lease_ck, ADD CONSTRAINT catalog_series_inventory_state_ingest_lease_ck CHECK ((ingest_job_id IS NULL AND ingest_attempt IS NULL AND ingest_lease_owner IS NULL) OR (ingest_job_id IS NOT NULL AND ingest_attempt BETWEEN 1 AND 2147483647 AND btrim(ingest_lease_owner) <> '' AND length(ingest_lease_owner) <= 160)) NOT VALID;
ALTER TABLE public.cloud_live_variants DROP CONSTRAINT cloud_live_variants_ingest_lease_ck, ADD CONSTRAINT cloud_live_variants_ingest_lease_ck CHECK ((ingest_job_id IS NULL AND ingest_attempt IS NULL AND ingest_lease_owner IS NULL) OR (ingest_job_id IS NOT NULL AND ingest_attempt BETWEEN 1 AND 2147483647 AND btrim(ingest_lease_owner) <> '' AND length(ingest_lease_owner) <= 160)) NOT VALID;
create or replace function public.norva_catalog_generation_constraint_is_canonical(
  p_constraint_oid oid,
  p_table_oid oid,
  p_constraint_type text,
  p_key_columns name[],
  p_referenced_table_oid oid,
  p_referenced_columns name[],
  p_check_kind text,
  p_update_action text,
  p_delete_action text,
  p_match_type text
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_constraint pg_catalog.pg_constraint%rowtype;
  v_expression text;
begin
  select constraint_state.* into v_constraint
  from pg_catalog.pg_constraint constraint_state
  where constraint_state.oid = p_constraint_oid;
  if not found
     or v_constraint.conrelid <> p_table_oid
     or v_constraint.contype::text <> p_constraint_type
     or v_constraint.condeferrable
     or v_constraint.condeferred
     or v_constraint.conparentid <> 0
     or cardinality(v_constraint.conkey) <> cardinality(p_key_columns)
     or exists (
       select 1
       from pg_catalog.unnest(p_key_columns) with ordinality
         as expected(column_name, ordinal)
       left join pg_catalog.pg_attribute attribute_state
         on attribute_state.attrelid = p_table_oid
        and attribute_state.attname = expected.column_name
        and not attribute_state.attisdropped
       where attribute_state.attnum is null
          or v_constraint.conkey[expected.ordinal]
               <> attribute_state.attnum
     ) then
    return false;
  end if;

  if p_constraint_type = 'f' then
    if v_constraint.confrelid is distinct from p_referenced_table_oid
       or v_constraint.confupdtype::text is distinct from p_update_action
       or v_constraint.confdeltype::text is distinct from p_delete_action
       or v_constraint.confmatchtype::text is distinct from p_match_type
       or cardinality(v_constraint.confkey)
            <> cardinality(p_referenced_columns)
       or exists (
         select 1
         from pg_catalog.unnest(p_referenced_columns) with ordinality
           as expected(column_name, ordinal)
         left join pg_catalog.pg_attribute attribute_state
           on attribute_state.attrelid = p_referenced_table_oid
          and attribute_state.attname = expected.column_name
          and not attribute_state.attisdropped
         where attribute_state.attnum is null
            or v_constraint.confkey[expected.ordinal]
                 <> attribute_state.attnum
       ) then
      return false;
    end if;
    return v_constraint.conbin is null;
  end if;

  if p_constraint_type in ('p', 'u') then
    return v_constraint.conindid <> 0
      and v_constraint.convalidated
      and public.norva_catalog_generation_index_is_canonical(
        v_constraint.conindid,
        p_table_oid,
        p_key_columns,
        true
      );
  end if;

  if p_constraint_type <> 'c'
     or p_check_kind not in (
       'request_fingerprint', 'generation_required', 'ingest_lease'
     ) then
    return false;
  end if;
  v_expression := pg_catalog.regexp_replace(
    pg_catalog.pg_get_expr(v_constraint.conbin, v_constraint.conrelid),
    '[[:space:]]+', '', 'g'
  );
  return case p_check_kind
    when 'request_fingerprint' then
      v_expression = '((request_fingerprintISNULL)OR(request_fingerprint~''^[0-9a-f]{64}$''::text))'
    when 'generation_required' then
      v_expression = '(generation_idISNOTNULL)'
    when 'ingest_lease' then
      v_expression = '(((ingest_job_idISNULL)AND(ingest_attemptISNULL)AND(ingest_lease_ownerISNULL))OR((ingest_job_idISNOTNULL)AND((ingest_attempt>=1)AND(ingest_attempt<=2147483647))AND(btrim(ingest_lease_owner)<>''''::text)AND(length(ingest_lease_owner)<=160)))'
    else false
  end;
end
$function$;
ALTER TABLE public.cloud_media_items VALIDATE CONSTRAINT cloud_media_items_ingest_lease_ck;
ALTER TABLE public.cloud_title_variants VALIDATE CONSTRAINT cloud_title_variants_ingest_lease_ck;
ALTER TABLE public.cloud_live_logical_channels VALIDATE CONSTRAINT cloud_live_logical_channels_ingest_lease_ck;
ALTER TABLE public.catalog_series_episode_memberships VALIDATE CONSTRAINT catalog_series_episode_memberships_ingest_lease_ck;
ALTER TABLE public.catalog_series_inventory_state VALIDATE CONSTRAINT catalog_series_inventory_state_ingest_lease_ck;
ALTER TABLE public.cloud_live_variants VALIDATE CONSTRAINT cloud_live_variants_ingest_lease_ck;
RESET lock_timeout;
