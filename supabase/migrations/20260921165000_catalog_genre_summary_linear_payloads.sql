begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- display_owners already contains only titles from source_titles. Joining the
-- two materialized sets again is redundant and becomes quadratic when both
-- sets are estimated at one row (13,212 actual titles in the Lion series case).
-- Keep source visibility, generation fences, display-owner ordering, payload
-- fallback, unscoped behavior and privileges exactly as deployed.
do $patch$
declare
  signature regprocedure := 'public.cloud_genre_bucket_counts(uuid,text,uuid)'::regprocedure;
  definition text;
  old_payload text := $old$    ), selected_payloads as materialized (
      select
        selected.title_id,
        coalesce(
          projection.genre_buckets,
          title.genre_buckets,
          array['autres']
        ) as genre_buckets
      from source_titles selected
      join display_owners owner
        on owner.title_id = selected.title_id
       and owner.user_id = selected.user_id
      join public.cloud_titles title
        on title.id = selected.title_id
       and title.user_id = selected.user_id
      left join public.cloud_source_catalog_generation_candidate_titles projection
        on projection.title_id = selected.title_id
       and projection.user_id = selected.user_id
       and projection.generation_id = owner.generation_id
    )$old$;
  new_payload text := $new$    ), selected_payloads as materialized (
      select
        owner.title_id,
        coalesce(
          projection.genre_buckets,
          title.genre_buckets,
          array['autres']
        ) as genre_buckets
      -- Every display owner already belongs to the requested source title set.
      from display_owners owner
      join public.cloud_titles title
        on title.id = owner.title_id
       and title.user_id = owner.user_id
      left join public.cloud_source_catalog_generation_candidate_titles projection
        on projection.title_id = owner.title_id
       and projection.user_id = owner.user_id
       and projection.generation_id = owner.generation_id
    )$new$;
begin
  select pg_catalog.pg_get_functiondef(signature) into strict definition;
  if cardinality(string_to_array(definition, new_payload)) = 2
     and position(old_payload in definition) = 0 then
    return;
  end if;
  if cardinality(string_to_array(definition, old_payload)) <> 2
     or position(new_payload in definition) > 0 then
    raise exception 'catalog genre payload scope drift' using errcode = '55000';
  end if;
  execute replace(definition, old_payload, new_payload);
end $patch$;

do $assert$
declare contract record;
begin
  select p.provolatile, p.prosecdef, p.proconfig, l.lanname
  into strict contract
  from pg_catalog.pg_proc p
  join pg_catalog.pg_language l on l.oid = p.prolang
  where p.oid = 'public.cloud_genre_bucket_counts(uuid,text,uuid)'::regprocedure;
  if contract.provolatile <> 's' or not contract.prosecdef
     or contract.lanname <> 'plpgsql'
     or not (coalesce(contract.proconfig, '{}'::text[]) @> array['search_path=""'])
     or has_function_privilege('anon', 'public.cloud_genre_bucket_counts(uuid,text,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.cloud_genre_bucket_counts(uuid,text,uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.cloud_genre_bucket_counts(uuid,text,uuid)', 'EXECUTE') then
    raise exception 'catalog genre payload security contract drift' using errcode = '55000';
  end if;
end $assert$;

notify pgrst, 'reload schema';
commit;
