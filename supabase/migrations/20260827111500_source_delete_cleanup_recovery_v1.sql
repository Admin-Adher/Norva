begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Phase 3 made catalog generations durable, but the pre-Phase-3 source reaper
-- deliberately refuses every generation-bearing source unless a cleanup job
-- grants a narrow DELETE-only authority.  Reuse the already-proved replacement
-- cleanup queue and worker for ordinary user removals, while recording the
-- origin explicitly so replacement diagnostics remain truthful.
alter table public.cloud_source_replacement_cleanup_jobs
  add column if not exists cleanup_kind text not null default 'replacement';

do $constraint$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_state
    where constraint_state.conrelid =
        'public.cloud_source_replacement_cleanup_jobs'::regclass
      and constraint_state.conname =
        'cloud_source_replacement_cleanup_jobs_kind_ck'
  ) then
    alter table public.cloud_source_replacement_cleanup_jobs
      add constraint cloud_source_replacement_cleanup_jobs_kind_ck
      check (cleanup_kind in ('replacement','source_delete'));
  end if;
end
$constraint$;

create index if not exists cloud_source_cleanup_kind_due_idx
  on public.cloud_source_replacement_cleanup_jobs(
    cleanup_kind,available_at,transition_id
  ) where state = 'pending';

create unique index if not exists cloud_source_delete_cleanup_one_pending_uidx
  on public.cloud_source_replacement_cleanup_jobs(user_id,source_id)
  where state = 'pending' and cleanup_kind = 'source_delete';

-- A removal may race a credential/replacement transition.  Never use a
-- cleanup job to bypass a live transition.  The recovery scan below retries
-- after every 10-minute reaper tick, so a crash or a later terminal transition
-- cannot strand the tombstone.
create or replace function public.norva_source_delete_cleanup_eligible(
  p_source_id uuid,
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.cloud_sources source
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.source_id = source.id
     and lifecycle.user_id = source.user_id
    where source.id = p_source_id
      and source.user_id = p_user_id
      and source.deleted_at is not null
      and not source.provider_deletion_pending
      and lifecycle.lifecycle_state = 'purge_pending'
      and lifecycle.catalog_visibility = 'hidden'
      and coalesce(lifecycle.purge_after,source.deleted_at)
          <= clock_timestamp()
      and not exists (
        select 1
        from public.cloud_source_replacement_cleanup_jobs cleanup
        where cleanup.source_id = source.id
          and cleanup.user_id = source.user_id
          and (
            cleanup.cleanup_kind = 'source_delete'
            or cleanup.state = 'pending'
          )
      )
      and not exists (
        select 1
        from public.cloud_source_transitions transition
        where transition.user_id = source.user_id
          and (
            transition.old_source_id = source.id
            or transition.candidate_source_id = source.id
          )
          and transition.state not in ('completed','failed','cancelled')
      )
      and not exists (
        select 1
        from public.cloud_source_credential_transition_jobs job
        where job.user_id = source.user_id
          and job.source_id = source.id
          and job.state in ('pending','processing')
      )
  );
$function$;

create or replace function public.norva_enqueue_source_delete_cleanup(
  p_source_id uuid,
  p_user_id uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_enqueued integer := 0;
begin
  if not public.norva_source_delete_cleanup_eligible(
    p_source_id,p_user_id
  ) then
    return false;
  end if;

  insert into public.cloud_source_replacement_cleanup_jobs(
    transition_id,user_id,source_id,state,available_at,cleanup_kind
  )
  select gen_random_uuid(),source.user_id,source.id,'pending',
    greatest(
      source.deleted_at,
      coalesce(lifecycle.purge_after,source.deleted_at)
    ),'source_delete'
  from public.cloud_sources source
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id = source.id
   and lifecycle.user_id = source.user_id
  where source.id = p_source_id
    and source.user_id = p_user_id
  on conflict do nothing;
  get diagnostics v_enqueued = row_count;
  return v_enqueued = 1;
end
$function$;

create or replace function public.norva_schedule_source_delete_cleanup()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    perform public.norva_enqueue_source_delete_cleanup(new.id,new.user_id);
  end if;
  return new;
end
$function$;

drop trigger if exists trg_zz_cloud_sources_schedule_delete_cleanup
  on public.cloud_sources;
create trigger trg_zz_cloud_sources_schedule_delete_cleanup
after update of deleted_at on public.cloud_sources
for each row
when (old.deleted_at is null and new.deleted_at is not null)
execute function public.norva_schedule_source_delete_cleanup();

create or replace function public.norva_recover_source_delete_cleanups(
  p_limit integer default 100
) returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_source record;
  v_enqueued integer := 0;
begin
  if p_limit not between 1 and 1000 then
    raise exception 'source delete cleanup recovery bound is invalid'
      using errcode = '22023';
  end if;

  for v_source in
    select source.id,source.user_id
    from public.cloud_sources source
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.source_id = source.id
     and lifecycle.user_id = source.user_id
    where source.deleted_at is not null
      and not source.provider_deletion_pending
      and lifecycle.lifecycle_state = 'purge_pending'
      and lifecycle.catalog_visibility = 'hidden'
      and coalesce(lifecycle.purge_after,source.deleted_at)
          <= clock_timestamp()
    order by source.deleted_at,source.id
    limit p_limit
  loop
    if public.norva_enqueue_source_delete_cleanup(
      v_source.id,v_source.user_id
    ) then
      v_enqueued := v_enqueued + 1;
    end if;
  end loop;
  return v_enqueued;
end
$function$;

-- A pg_cron connection is an authenticated PostgreSQL operator, not a forged
-- PostgREST service-role request.  Keep the public RPC service-role-only while
-- admitting only the two database owner roles used by migrations/local tests.
do $worker_patch$
declare
  v_signature regprocedure :=
    'public.norva_run_replacement_cleanup_batch(text,integer)'::regprocedure;
  v_definition text;
  v_old text := E'  perform public.norva_credential_require_service_role();\n';
  v_new text := E'  if session_user not in (''postgres'',''supabase_admin'') then\n'
    || E'    perform public.norva_credential_require_service_role();\n'
    || E'  end if;\n';
begin
  select replace(pg_catalog.pg_get_functiondef(v_signature),chr(13),'')
    into v_definition;
  if position('session_user not in (''postgres'',''supabase_admin'')'
      in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'cleanup worker operator patch precondition drifted'
        using errcode = '55000';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end
$worker_patch$;

-- A due cleanup job already proves the exact hidden source and owner on every
-- DELETE.  Reuse that same proof when the generation has entered PURGING;
-- otherwise the legacy bounded reaper is admitted by source authority and
-- then rejected one branch later by the generation-state fence.
do $generation_purge_patch$
declare
  v_signature regprocedure :=
    'public.norva_catalog_generation_write_guard()'::regprocedure;
  v_definition text;
  v_old text := E'  if v_generation_state = ''purging'' then\n'
    || E'    if tg_op = ''DELETE''\n'
    || E'       and current_setting(''norva.catalog_purge_generation'', true)\n'
    || E'         is not distinct from v_generation_id::text then\n'
    || E'      return old;\n'
    || E'    end if;\n';
  v_new text := E'  if v_generation_state = ''purging'' then\n'
    || E'    if tg_op = ''DELETE''\n'
    || E'       and (\n'
    || E'         current_setting(''norva.catalog_purge_generation'', true)\n'
    || E'           is not distinct from v_generation_id::text\n'
    || E'         or v_replacement_source_purge\n'
    || E'       ) then\n'
    || E'      return old;\n'
    || E'    end if;\n';
begin
  select replace(pg_catalog.pg_get_functiondef(v_signature),chr(13),'')
    into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'catalog purging cleanup patch precondition drifted'
        using errcode = '55000';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end
$generation_purge_patch$;

-- The row guard runs per tuple, while this transition-table trigger runs once
-- after the whole DELETE statement.  It must independently recheck the same
-- durable source authority for every generation touched by that statement.
do $generation_statement_patch$
declare
  v_signature regprocedure :=
    'public.norva_catalog_generation_row_changed()'::regprocedure;
  v_definition text;
  v_old text := E'        elsif exists (\n'
    || E'          select 1\n'
    || E'          from old_rows row_state\n'
    || E'          where row_state.generation_id = v_generation_id\n'
    || E'            and public.norva_provider_account_delete_batch_fenced(\n';
  v_new text := E'        elsif exists (\n'
    || E'          select 1\n'
    || E'          from public.cloud_source_catalog_generations generation\n'
    || E'          join public.cloud_source_replacement_cleanup_jobs cleanup\n'
    || E'            on cleanup.source_id = generation.source_id\n'
    || E'           and cleanup.user_id = generation.user_id\n'
    || E'          join public.cloud_source_lifecycle lifecycle\n'
    || E'            on lifecycle.source_id = cleanup.source_id\n'
    || E'           and lifecycle.user_id = cleanup.user_id\n'
    || E'          join public.cloud_sources source\n'
    || E'            on source.id = cleanup.source_id\n'
    || E'           and source.user_id = cleanup.user_id\n'
    || E'          where generation.id = v_generation_id\n'
    || E'            and generation.state = ''purging''\n'
    || E'            and current_setting(''norva.catalog_purge_source'', true)\n'
    || E'              is not distinct from generation.source_id::text\n'
    || E'            and cleanup.state = ''pending''\n'
    || E'            and cleanup.available_at <= clock_timestamp()\n'
    || E'            and lifecycle.lifecycle_state = ''purge_pending''\n'
    || E'            and lifecycle.catalog_visibility = ''hidden''\n'
    || E'            and source.deleted_at is not null\n'
    || E'        ) then\n'
    || E'          null;\n'
    || v_old;
begin
  select replace(pg_catalog.pg_get_functiondef(v_signature),chr(13),'')
    into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'catalog statement cleanup patch precondition drifted'
        using errcode = '55000';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end
$generation_statement_patch$;

-- Ordinary soft delete already hid the source and bumped visibility.  The
-- final one-way true -> false cleanup must not synthesize a second epoch (or
-- write through the deletion-preparation guard) when clearing credentials.
do $terminal_enabled_patch$
declare
  v_signature regprocedure :=
    'public.norva_cloud_source_track_revision()'::regprocedure;
  v_definition text;
  v_old text := E'  if new.enabled is distinct from old.enabled then\n';
  v_new text := E'  if new.enabled is distinct from old.enabled\n'
    || E'     and not (\n'
    || E'       old.enabled and not new.enabled\n'
    || E'       and old.deleted_at is not null\n'
    || E'       and new.deleted_at is not null\n'
    || E'       and old.provider_deletion_pending\n'
    || E'       and current_setting(''norva.catalog_purge_source'', true)\n'
    || E'         is not distinct from new.id::text\n'
    || E'     ) then\n';
begin
  select replace(pg_catalog.pg_get_functiondef(v_signature),chr(13),'')
    into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'terminal enabled cleanup patch precondition drifted'
        using errcode = '55000';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end
$terminal_enabled_patch$;

-- Reconstruct missing jobs before the bounded catalog drain and run one
-- bounded terminal-cleanup step afterwards.  The existing transaction-scoped
-- advisory lock and SKIP LOCKED claim remain the concurrency authority.
do $reaper_patch$
declare
  v_signature regprocedure := 'public.reap_deleted_sources()'::regprocedure;
  v_definition text;
  v_recovery_old text := E'  for sid in\n    select source.id\n';
  v_recovery_new text := E'  perform public.norva_recover_source_delete_cleanups(100);\n'
    || E'  for sid in\n    select source.id\n';
  v_tail_old text := E'  end loop;\nend\n$procedure$\n';
  v_tail_new text := E'  end loop;\n'
    || E'  perform public.norva_run_replacement_cleanup_batch(''source-reaper'',200);\n'
    || E'end\n$procedure$\n';
begin
  select replace(pg_catalog.pg_get_functiondef(v_signature),chr(13),'')
    into v_definition;
  if position('norva_recover_source_delete_cleanups(100)'
      in v_definition) = 0 then
    if position(v_recovery_old in v_definition) = 0 then
      raise exception 'source cleanup recovery patch precondition drifted'
        using errcode = '55000';
    end if;
    v_definition := replace(v_definition,v_recovery_old,v_recovery_new);
  end if;
  if position('norva_run_replacement_cleanup_batch(''source-reaper'',200)'
      in v_definition) = 0 then
    if position(v_tail_old in v_definition) = 0 then
      raise exception 'source cleanup worker patch precondition drifted'
        using errcode = '55000';
    end if;
    v_definition := replace(v_definition,v_tail_old,v_tail_new);
  end if;
  execute v_definition;
end
$reaper_patch$;

-- Recover the durable NINJA tombstone (and any equivalent row) immediately;
-- the next ordinary reaper call then owns all progress.
select public.norva_recover_source_delete_cleanups(100);

revoke all on function
  public.norva_source_delete_cleanup_eligible(uuid,uuid),
  public.norva_enqueue_source_delete_cleanup(uuid,uuid),
  public.norva_schedule_source_delete_cleanup(),
  public.norva_recover_source_delete_cleanups(integer)
from public,anon,authenticated,service_role;

commit;
