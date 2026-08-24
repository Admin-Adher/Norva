-- A provider-account deletion drains candidate-title rows before the terminal
-- generation phase.  Their AFTER STATEMENT revision trigger must recognise the
-- same short-lived, leased deletion authority as the row-level delete guards;
-- otherwise a READY generation cannot be purged in bounded batches.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.norva_catalog_generation_row_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_generation_id uuid;
begin
  if tg_op = 'DELETE' then
    for v_generation_id in
      select distinct generation_id from old_rows where generation_id is not null
    loop
      update public.cloud_source_catalog_generations generation
      set revision = generation.revision + 1,
          manifest_counts = case when generation.state = 'active'
            then '{}'::jsonb else generation.manifest_counts end,
          manifest_checksum = case when generation.state = 'active'
            then null else generation.manifest_checksum end,
          identity_evidence = case when generation.state = 'active'
            then '{}'::jsonb else generation.identity_evidence end,
          updated_at = clock_timestamp()
      where generation.id = v_generation_id
        and generation.state in ('building','active')
        and not generation.manifest_sealing;
      if not found then
        if current_setting('norva.catalog_purge_generation', true)
             is not distinct from v_generation_id::text
           and exists (
             select 1 from public.cloud_source_catalog_generations generation
             where generation.id = v_generation_id
               and generation.state = 'purging'
           ) then
          null;
        elsif exists (
          select 1
          from old_rows row_state
          where row_state.generation_id = v_generation_id
            and public.norva_provider_account_delete_batch_fenced(
              row_state.user_id
            )
        ) then
          -- Account deletion has a validated durable worker lease and deletes
          -- this one user/keyset batch only.  It is the sole non-terminal
          -- authority allowed to retire a READY generation's projections.
          null;
        elsif exists (
          select 1 from public.cloud_source_catalog_generations generation
          where generation.id = v_generation_id
            and generation.manifest_sealing
        ) then
          raise exception 'catalog generation is sealed for manifest snapshot'
            using errcode = '40001', detail = 'reason=manifest_sealing';
        else
          raise exception 'catalog generation changed during catalog statement'
            using errcode = '40001',
              detail = 'reason=manifest_generation_changed';
        end if;
      end if;
    end loop;
  else
    for v_generation_id in
      select distinct generation_id from new_rows where generation_id is not null
    loop
      update public.cloud_source_catalog_generations generation
      set revision = generation.revision + 1,
          manifest_counts = case when generation.state = 'active'
            then '{}'::jsonb else generation.manifest_counts end,
          manifest_checksum = case when generation.state = 'active'
            then null else generation.manifest_checksum end,
          identity_evidence = case when generation.state = 'active'
            then '{}'::jsonb else generation.identity_evidence end,
          updated_at = clock_timestamp()
      where generation.id = v_generation_id
        and generation.state in ('building','active')
        and not generation.manifest_sealing;
      if not found then
        if exists (
          select 1 from public.cloud_source_catalog_generations generation
          where generation.id = v_generation_id
            and generation.manifest_sealing
        ) then
          raise exception 'catalog generation is sealed for manifest snapshot'
            using errcode = '40001', detail = 'reason=manifest_sealing';
        else
          raise exception 'catalog generation changed during catalog statement'
            using errcode = '40001',
              detail = 'reason=manifest_generation_changed';
        end if;
      end if;
    end loop;
  end if;
  return null;
end
$function$;

commit;
