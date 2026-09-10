-- Exact-file verification must be able to publish failure/retry states after
-- generation enforcement. Do not weaken the row guard or the LID evidence.
begin;
set local statement_timeout = '30s';
set local lock_timeout = '3s';

create or replace function public.mark_cloud_title_file_audio_verification(
  p_user_id uuid,
  p_variant_id uuid,
  p_file_external_id text,
  p_verified boolean,
  p_verified_at timestamptz default now(),
  p_provenance jsonb default '{}'::jsonb
) returns boolean
language plpgsql security definer set search_path = '' as $function$
declare
  v_owner record;
  v_changed integer := 0;
begin
  select variant.title_id, variant.source_id, variant.generation_id,
         head.head_revision, lifecycle.config_revision,
         lifecycle.visibility_epoch as source_visibility_epoch,
         epoch.visibility_epoch as user_visibility_epoch
    into v_owner
  from public.cloud_catalog_visible_title_variants variant
  join public.cloud_source_catalog_heads head
    on head.source_id = variant.source_id and head.user_id = variant.user_id
   and head.active_generation_id = variant.generation_id
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id = variant.source_id and lifecycle.user_id = variant.user_id
  join public.cloud_user_catalog_visibility_epochs epoch on epoch.user_id = variant.user_id
  where variant.user_id = p_user_id and variant.id = p_variant_id
    and variant.item_type = 'movie' and variant.external_id = p_file_external_id
    and variant.title_id is not null;
  if not found then return false; end if;

  update public.cloud_title_file_language_observations observation
     set audio_verified_at = case
           when coalesce(p_verified, false) and observation.audio_observed
            and cardinality(observation.audio_languages) > 0
             then coalesce(p_verified_at, clock_timestamp())
           else null
         end,
         audio_verification = coalesce(p_provenance, '{}'::jsonb),
         updated_at = clock_timestamp()
   where observation.user_id = p_user_id and observation.title_id = v_owner.title_id
     and observation.variant_id = p_variant_id
     and observation.file_external_id = p_file_external_id;
  get diagnostics v_changed = row_count;

  -- The normal write guard rechecks all four revisions and the active head.
  -- A concurrent switch/deletion raises and rolls back the preceding ledger
  -- update as well; never acknowledge a partial owner verification.
  update public.cloud_title_variants variant
     set audio_lang_verified_at = case
           when coalesce(p_verified, false) then coalesce(p_verified_at, clock_timestamp())
           else null
         end,
         audio_lang_verify_retry_at = case
           when coalesce(p_verified, false) then null
           else clock_timestamp() + interval '1 day'
         end,
         write_head_revision = v_owner.head_revision,
         write_config_revision = v_owner.config_revision,
         write_source_visibility_epoch = v_owner.source_visibility_epoch,
         write_user_visibility_epoch = v_owner.user_visibility_epoch
   where variant.user_id = p_user_id and variant.id = p_variant_id
     and variant.source_id = v_owner.source_id
     and variant.generation_id = v_owner.generation_id;

  perform public.recompute_cloud_title_file_languages(p_user_id, v_owner.title_id);
  return v_changed = 1;
end
$function$;

-- Retain the canonical-cache and exact-episode contracts byte-for-byte. Only
-- the movie recipient query is narrowed to currently visible owner variants.
do $migration$
declare
  v_definition text;
  v_old text := 'from public.cloud_title_variants variant';
begin
  v_definition := replace(pg_get_functiondef(
    'public.record_catalog_file_audio_verification(text,text,text,boolean,timestamptz,timestamptz,jsonb)'::regprocedure
  ), chr(13), '');
  if length(v_definition) - length(replace(v_definition, v_old, '')) <> length(v_old)
     or position('perform public.mark_cloud_title_file_audio_verification(' in v_definition) = 0 then
    raise exception 'audio verification owner query drifted; refusing migration' using errcode = '55000';
  end if;
  execute replace(v_definition, v_old, 'from public.cloud_catalog_visible_title_variants variant');
end
$migration$;

revoke all on function public.mark_cloud_title_file_audio_verification(uuid,uuid,text,boolean,timestamptz,jsonb)
  from public, anon, authenticated;
grant execute on function public.mark_cloud_title_file_audio_verification(uuid,uuid,text,boolean,timestamptz,jsonb)
  to service_role;
revoke all on function public.record_catalog_file_audio_verification(text,text,text,boolean,timestamptz,timestamptz,jsonb)
  from public, anon, authenticated;
grant execute on function public.record_catalog_file_audio_verification(text,text,text,boolean,timestamptz,timestamptz,jsonb)
  to service_role;
notify pgrst, 'reload schema';
commit;
