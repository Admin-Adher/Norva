begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

create table public.cloud_source_replacement_cleanup_jobs(
  transition_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null,
  state text not null default 'pending'
    check(state in ('pending','completed','cancelled','dead')),
  available_at timestamptz not null,
  attempt_count integer not null default 0 check(attempt_count>=0),
  last_deleted_rows integer not null default 0 check(last_deleted_rows>=0),
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(user_id,source_id,transition_id),
  check((state='completed')=(completed_at is not null))
);
create index cloud_source_replacement_cleanup_due_idx
  on public.cloud_source_replacement_cleanup_jobs(available_at,transition_id)
  where state='pending';
alter table public.cloud_source_replacement_cleanup_jobs enable row level security;
revoke all on table public.cloud_source_replacement_cleanup_jobs
  from public,anon,authenticated,service_role;

create or replace function public.norva_schedule_replacement_cleanup()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if new.transition_kind<>'replacement'
     or new.state not in ('completed','failed','cancelled')
     or (tg_op='UPDATE' and old.state=new.state) then
    return new;
  end if;
  if new.state in ('failed','cancelled') then
    insert into public.cloud_source_replacement_cleanup_jobs(
      transition_id,user_id,source_id,available_at
    ) values (
      new.id,new.user_id,new.candidate_source_id,clock_timestamp()
    ) on conflict(transition_id) do nothing;
  elsif new.reversal_of_transition_id is null then
    insert into public.cloud_source_replacement_cleanup_jobs(
      transition_id,user_id,source_id,available_at
    ) values (
      new.id,new.user_id,new.old_source_id,
      coalesce(new.rollback_until,clock_timestamp())
    ) on conflict(transition_id) do nothing;
  else
    update public.cloud_source_replacement_cleanup_jobs job
    set state='cancelled',updated_at=clock_timestamp(),last_error_code='rolled_back'
    where job.transition_id=new.reversal_of_transition_id and job.state='pending';
    insert into public.cloud_source_replacement_cleanup_jobs(
      transition_id,user_id,source_id,available_at
    ) values (new.id,new.user_id,new.old_source_id,clock_timestamp())
    on conflict(transition_id) do nothing;
  end if;
  return new;
end
$function$;
drop trigger if exists trg_schedule_replacement_cleanup
  on public.cloud_source_transitions;
create trigger trg_schedule_replacement_cleanup
after insert or update of state on public.cloud_source_transitions
for each row execute function public.norva_schedule_replacement_cleanup();

-- Backfill terminal replacements created between promotion-v3 deployment and
-- this scheduler migration.  A completed reversal cancels its original A job
-- and schedules B immediately.
insert into public.cloud_source_replacement_cleanup_jobs(
  transition_id,user_id,source_id,available_at
)
select transition.id,transition.user_id,
  case when transition.state in ('failed','cancelled')
    then transition.candidate_source_id else transition.old_source_id end,
  case when transition.state in ('failed','cancelled') then clock_timestamp()
    when transition.reversal_of_transition_id is null
    then coalesce(transition.rollback_until,clock_timestamp())
    else clock_timestamp() end
from public.cloud_source_transitions transition
where transition.transition_kind='replacement'
  and transition.state in ('completed','failed','cancelled')
on conflict(transition_id) do nothing;
update public.cloud_source_replacement_cleanup_jobs job
set state='cancelled',updated_at=clock_timestamp(),last_error_code='rolled_back'
where job.state='pending' and exists(
  select 1 from public.cloud_source_transitions reversal
  where reversal.reversal_of_transition_id=job.transition_id
    and reversal.user_id=job.user_id and reversal.state='completed'
);

create or replace function public.norva_fail_source_replacement(
  p_transition_id uuid,
  p_user_id uuid,
  p_actor text,
  p_expected_transition_revision bigint,
  p_failure_code text,
  p_idempotency_key text,
  p_request_fingerprint text
) returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_action public.cloud_source_lifecycle_events%rowtype;
  v_result jsonb;
begin
  perform public.norva_credential_require_service_role();
  if p_actor is null or btrim(p_actor)='' or length(p_actor)>200
     or p_failure_code is null or p_failure_code!~'^[a-z0-9_]{1,80}$'
     or p_idempotency_key is null or btrim(p_idempotency_key)=''
     or length(p_idempotency_key)>200
     or p_request_fingerprint is null
     or p_request_fingerprint!~'^[0-9a-f]{64}$' then
    raise exception 'replacement failure input is invalid' using errcode='22023';
  end if;
  perform public.norva_credential_lock_account(p_user_id);
  select action.* into v_action
  from public.cloud_source_lifecycle_events action
  where action.user_id=p_user_id and action.idempotency_key=p_idempotency_key
  for share;
  if found then
    if v_action.transition_id=p_transition_id
       and v_action.event_kind='replacement_failed'
       and v_action.payload->>'requestFingerprint'=p_request_fingerprint
       and jsonb_typeof(v_action.payload->'result')='object' then
      return (v_action.payload->'result')||jsonb_build_object('replayed',true);
    end if;
    raise exception 'replacement failure idempotency key reused' using errcode='22023';
  end if;
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id=p_transition_id and transition.user_id=p_user_id
  for update;
  if not found or v_transition.transition_kind<>'replacement'
     or v_transition.state not in ('validating','staging','importing','ready_to_switch')
     or v_transition.revision<>p_expected_transition_revision then
    raise exception 'replacement failure CAS failed' using errcode='40001';
  end if;
  update public.cloud_source_lifecycle lifecycle
  set lifecycle_state='purge_pending',catalog_visibility='hidden',
      purge_after=clock_timestamp(),updated_at=clock_timestamp()
  where lifecycle.source_id=v_transition.candidate_source_id
    and lifecycle.user_id=p_user_id
    and lifecycle.lifecycle_state in ('staging','purge_pending')
    and lifecycle.catalog_visibility='hidden';
  if not found then
    raise exception 'replacement failed candidate retirement CAS failed'
      using errcode='40001';
  end if;
  update public.cloud_sources source
  set enabled=false,deleted_at=coalesce(source.deleted_at,clock_timestamp()),
      sync_status='disabled',updated_at=clock_timestamp()
  where source.id=v_transition.candidate_source_id and source.user_id=p_user_id;
  update public.cloud_source_transitions transition
  set state='failed',failure_code=p_failure_code,approved_by=p_actor
  where transition.id=p_transition_id and transition.user_id=p_user_id
    and transition.revision=p_expected_transition_revision;
  if not found then
    raise exception 'replacement failure terminal CAS failed' using errcode='40001';
  end if;
  update public.cloud_source_credential_transition_jobs job
  set state='dead',lease_owner=null,lease_until=null,completed_at=null,
      dead_at=clock_timestamp(),last_error_code='catalog_unhealthy'
  where job.transition_id=p_transition_id and job.user_id=p_user_id
    and job.state in ('pending','processing');
  update public.cloud_source_catalog_generations generation
  set state='purging',manifest_sealing=false,
      revision=generation.revision+1,updated_at=clock_timestamp()
  where generation.transition_id=p_transition_id and generation.user_id=p_user_id
    and generation.state in ('building','ready');
  insert into public.cloud_source_credential_transition_jobs(
    user_id,transition_id,source_id,catalog_generation_id,
    expected_source_revision,job_kind,max_attempts
  ) select generation.user_id,p_transition_id,generation.source_id,generation.id,
      v_transition.expected_source_revision,'purge_terminal_generation',25
    from public.cloud_source_catalog_generations generation
    where generation.transition_id=p_transition_id and generation.user_id=p_user_id
      and generation.state='purging'
    on conflict (transition_id,job_kind)
      where state in ('pending','processing') do nothing;
  v_result:=public.norva_replacement_transition_result(p_transition_id,p_user_id);
  insert into public.cloud_source_lifecycle_events(
    user_id,source_id,transition_id,event_kind,idempotency_key,payload,actor
  ) values (
    p_user_id,v_transition.candidate_source_id,p_transition_id,
    'replacement_failed',p_idempotency_key,
    jsonb_build_object('requestFingerprint',p_request_fingerprint,
      'failureCode',p_failure_code,'result',v_result),p_actor
  );
  perform public.norva_clear_terminal_credential_secrets(
    p_transition_id,p_user_id,(v_result->>'revision')::bigint
  );
  return v_result||jsonb_build_object('replayed',false);
end
$function$;

-- An active generation normally requires a currently visible source plus the
-- caller's active-write snapshot.  A rolled-back replacement endpoint is
-- intentionally invisible before its bounded purge begins, so its reaper
-- deletes need a narrower, durable authority.  This exception is DELETE-only,
-- bound to the exact transaction-local source id, and rechecks the due cleanup
-- job plus the hidden PURGE_PENDING tombstone on every row.
do $migration$
declare
  v_signature regprocedure:=
    'public.norva_catalog_generation_write_guard()'::regprocedure;
  v_definition text;
  v_declare_old text:=E'  v_online_backfill boolean := false;\n';
  v_declare_new text:=E'  v_online_backfill boolean := false;\n  v_replacement_source_purge boolean := false;\n';
  v_owner_old text:=E'    v_lease_owner := new.ingest_lease_owner;\n  end if;\n\n  if tg_op = ''DELETE'' and v_generation_id is null';
  v_owner_new text:=E'    v_lease_owner := new.ingest_lease_owner;\n  end if;\n\n  if tg_op = ''DELETE''\n     and current_setting(''norva.catalog_purge_source'', true)\n       is not distinct from v_owner_source_id::text then\n    select exists (\n      select 1\n      from public.cloud_source_replacement_cleanup_jobs cleanup\n      join public.cloud_source_lifecycle lifecycle\n        on lifecycle.source_id = cleanup.source_id\n       and lifecycle.user_id = cleanup.user_id\n      join public.cloud_sources source\n        on source.id = cleanup.source_id\n       and source.user_id = cleanup.user_id\n      where cleanup.source_id = v_owner_source_id\n        and cleanup.user_id = v_owner_user_id\n        and cleanup.state = ''pending''\n        and cleanup.available_at <= clock_timestamp()\n        and lifecycle.lifecycle_state = ''purge_pending''\n        and lifecycle.catalog_visibility = ''hidden''\n        and source.deleted_at is not null\n    ) into v_replacement_source_purge;\n  end if;\n\n  if tg_op = ''DELETE'' and v_generation_id is null';
  v_visibility_old text:=E'    if (v_generation_fence_enforced\n        and v_generation_config_revision is distinct from v_config_revision)\n       or (not v_visible and not v_online_backfill) then';
  v_visibility_new text:=E'    if ((v_generation_fence_enforced\n         and v_generation_config_revision is distinct from v_config_revision)\n        or (not v_visible and not v_online_backfill))\n       and not v_replacement_source_purge then';
  v_proof_old text:=E'    if tg_op = ''DELETE'' and v_generation_fence_enforced then\n';
  v_proof_new text:=E'    if tg_op = ''DELETE'' and v_generation_fence_enforced\n       and not v_replacement_source_purge then\n';
begin
  select replace(pg_get_functiondef(v_signature),chr(13),'') into v_definition;
  if position('v_replacement_source_purge boolean' in v_definition)>0 then
    return;
  end if;
  if position(v_declare_old in v_definition)=0
     or position(v_owner_old in v_definition)=0
     or position(v_visibility_old in v_definition)=0
     or position(v_proof_old in v_definition)=0 then
    raise exception 'replacement catalog delete guard patch precondition drifted'
      using errcode='55000';
  end if;
  v_definition:=replace(v_definition,v_declare_old,v_declare_new);
  v_definition:=replace(v_definition,v_owner_old,v_owner_new);
  v_definition:=replace(v_definition,v_visibility_old,v_visibility_new);
  v_definition:=replace(v_definition,v_proof_old,v_proof_new);
  execute v_definition;
end
$migration$;

-- The established source reaper already owns the difficult dependency order
-- and a global 5k-row budget.  Admit only explicitly scheduled replacement
-- tombstones while keeping all other Phase-3 proof graph sources excluded.
do $migration$
declare
  v_signature regprocedure:='public.reap_deleted_sources()'::regprocedure;
  v_definition text;
  v_old text:=E'      and not exists (\n        select 1 from public.cloud_source_transitions transition\n        where transition.old_source_id = source.id\n           or transition.candidate_source_id = source.id\n      )\n      and not exists (\n        select 1 from public.cloud_source_catalog_generations generation\n        where generation.source_id = source.id\n      )';
  v_new text:=E'      and (\n        (\n          not exists (\n            select 1 from public.cloud_source_transitions transition\n            where transition.old_source_id = source.id\n               or transition.candidate_source_id = source.id\n          )\n          and not exists (\n            select 1 from public.cloud_source_catalog_generations generation\n            where generation.source_id = source.id\n          )\n        )\n        or exists (\n          select 1\n          from public.cloud_source_replacement_cleanup_jobs cleanup\n          where cleanup.source_id = source.id\n            and cleanup.user_id = source.user_id\n            and cleanup.state = ''pending''\n            and cleanup.available_at <= clock_timestamp()\n        )\n      )';
  v_loop_old text:=E'  loop\n    delete from public.cloud_provider_call_permits';
  v_loop_new text:=E'  loop\n    if exists (\n      select 1\n      from public.cloud_source_replacement_cleanup_jobs cleanup\n      join public.cloud_source_lifecycle lifecycle\n        on lifecycle.source_id = cleanup.source_id\n       and lifecycle.user_id = cleanup.user_id\n      where cleanup.source_id = sid\n        and cleanup.state = ''pending''\n        and cleanup.available_at <= clock_timestamp()\n        and lifecycle.lifecycle_state = ''purge_pending''\n        and lifecycle.catalog_visibility = ''hidden''\n    ) then\n      perform set_config(''norva.catalog_purge_source'', sid::text, true);\n    else\n      perform set_config(''norva.catalog_purge_source'', '''', true);\n    end if;\n    delete from public.cloud_provider_call_permits';
begin
  select replace(pg_get_functiondef(v_signature),chr(13),'') into v_definition;
  if position('norva.catalog_purge_source' in v_definition)>0 then
    return;
  end if;
  if position(v_loop_old in v_definition)=0
     or (position(v_old in v_definition)=0 and position(v_new in v_definition)=0) then
    raise exception 'replacement source reaper patch precondition drifted'
      using errcode='55000';
  end if;
  if position(v_old in v_definition)>0 then
    v_definition:=replace(v_definition,v_old,v_new);
  end if;
  v_definition:=replace(v_definition,v_loop_old,v_loop_new);
  execute v_definition;
end
$migration$;

-- The ordinary affinity trigger permits ciphertext mutation only while a
-- credential swap is committing. Replacement cleanup is a distinct terminal
-- operation: it may clear (never replace) the ciphertext after the bounded
-- source reaper has drained B. Bind that one-way exception to the same due
-- cleanup job and PURGE_PENDING tombstone authority.
do $migration$
declare
  v_signature regprocedure:=
    'public.norva_switch_provider_account_affinity()'::regprocedure;
  v_definition text;
  v_old text:=E'  if new.config_ciphertext is not distinct from old.config_ciphertext then\n';
  v_new text:=E'  if old.config_ciphertext is not null\n     and new.config_ciphertext is null\n     and new.config_hint = ''{}''::jsonb\n     and current_setting(''norva.catalog_purge_source'', true)\n       is not distinct from new.id::text\n     and exists (\n       select 1\n       from public.cloud_source_replacement_cleanup_jobs cleanup\n       join public.cloud_source_lifecycle lifecycle\n         on lifecycle.source_id = cleanup.source_id\n        and lifecycle.user_id = cleanup.user_id\n       where cleanup.source_id = new.id\n         and cleanup.user_id = new.user_id\n         and cleanup.state = ''pending''\n         and cleanup.available_at <= clock_timestamp()\n         and lifecycle.lifecycle_state = ''purge_pending''\n         and lifecycle.catalog_visibility = ''hidden''\n         and old.deleted_at is not null\n         and old.provider_deletion_pending\n     ) then\n    return new;\n  end if;\n  if new.config_ciphertext is not distinct from old.config_ciphertext then\n';
begin
  select replace(pg_get_functiondef(v_signature),chr(13),'') into v_definition;
  if position('old.config_ciphertext is not null' in v_definition)>0
     and position('norva.catalog_purge_source' in v_definition)>0 then
    return;
  end if;
  if position(v_old in v_definition)=0 then
    raise exception 'replacement terminal config-clear patch precondition drifted'
      using errcode='55000';
  end if;
  execute replace(v_definition,v_old,v_new);
end
$migration$;

-- A terminal replacement purge has no future catalog writer to fence, so
-- clearing its ciphertext must not synthesize a new config revision after the
-- source is already provider_deletion_pending.  Every non-terminal config
-- mutation continues through the normal revision trigger.
do $migration$
declare
  v_signature regprocedure:=
    'public.norva_cloud_source_track_revision()'::regprocedure;
  v_definition text;
  v_old text:=E'  if new.source_type is distinct from old.source_type\n     or new.config_ciphertext is distinct from old.config_ciphertext then';
  v_new text:=E'  if (new.source_type is distinct from old.source_type\n      or new.config_ciphertext is distinct from old.config_ciphertext)\n     and not (\n       old.config_ciphertext is not null\n       and new.config_ciphertext is null\n       and old.deleted_at is not null\n       and old.provider_deletion_pending\n       and current_setting(''norva.catalog_purge_source'', true)\n         is not distinct from new.id::text\n     ) then';
begin
  select replace(pg_get_functiondef(v_signature),chr(13),'') into v_definition;
  if position('old.provider_deletion_pending' in v_definition)>0
     and position('norva.catalog_purge_source' in v_definition)>0 then
    return;
  end if;
  if position(v_old in v_definition)=0 then
    raise exception 'replacement terminal revision patch precondition drifted'
      using errcode='55000';
  end if;
  execute replace(v_definition,v_old,v_new);
end
$migration$;

-- The account-delete fence still owns every ordinary mutation once a source is
-- provider_deletion_pending.  Admit only the terminal lifecycle CAS performed
-- by the replacement cleanup worker after its bounded drain has completed.
do $migration$
declare
  v_signature regprocedure:=
    'public.norva_provider_account_delete_write_guard()'::regprocedure;
  v_definition text;
  v_old text:=E'    raise exception ''provider account deletion preparation fences catalog writes''\n';
  v_new text:=E'    if tg_table_name = ''cloud_source_lifecycle''\n       and tg_op = ''UPDATE''\n       and v_old ->> ''lifecycle_state'' = ''purge_pending''\n       and v_new ->> ''lifecycle_state'' = ''purged''\n       and v_old ->> ''catalog_visibility'' = ''hidden''\n       and v_new ->> ''catalog_visibility'' = ''hidden''\n       and current_setting(''norva.catalog_purge_source'', true)\n         is not distinct from v_source_id::text\n       and exists (\n         select 1\n         from public.cloud_source_replacement_cleanup_jobs cleanup\n         where cleanup.source_id = v_source_id\n           and cleanup.user_id = v_user_id\n           and cleanup.state = ''pending''\n           and cleanup.available_at <= clock_timestamp()\n       ) then\n      return new;\n    end if;\n    raise exception ''provider account deletion preparation fences catalog writes''\n';
begin
  select replace(pg_get_functiondef(v_signature),chr(13),'') into v_definition;
  if position('v_new ->> ''lifecycle_state'' = ''purged''' in v_definition)>0
     and position('norva.catalog_purge_source' in v_definition)>0 then
    return;
  end if;
  if position(v_old in v_definition)=0 then
    raise exception 'replacement terminal lifecycle patch precondition drifted'
      using errcode='55000';
  end if;
  execute replace(v_definition,v_old,v_new);
end
$migration$;

create or replace function public.norva_replacement_cleanup_delete_rows(
  p_table regclass,
  p_source_id uuid,
  p_limit integer
) returns integer
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_allowed text[]:=array[
    'public.cloud_playback_events',
    'public.cloud_watch_history',
    'public.cloud_title_rating_operations',
    'public.cloud_title_ratings',
    'public.cloud_content_events',
    'public.catalog_enrichment_source_schedule',
    'public.catalog_provider_inventory_backoff',
    'public.catalog_generated_subtitle_notifications',
    'public.catalog_subtitle_email_deliveries',
    'public.cloud_import_notifications',
    'public.catalog_source_provider_identities',
    'public.cloud_catalog_background_owner_snapshot_sources',
    'public.cloud_catalog_generation_backfill_sources',
    'public.cloud_source_catalog_generation_candidate_titles',
    'public.cloud_source_catalog_generation_categories',
    'public.cloud_source_catalog_generation_category_lists',
    'public.cloud_source_catalog_generation_inventory_actions',
    'public.cloud_source_catalog_generation_title_promotions',
    'public.cloud_source_catalog_manifest_seal_progress',
    'public.cloud_source_catalog_title_refresh_actions',
    'public.cloud_source_catalog_title_refresh_checkpoints'
  ];
  v_name text:=p_table::text;
  v_deleted integer;
begin
  if v_name<>all(v_allowed) or p_limit not between 1 and 1000 then
    raise exception 'replacement cleanup table or bound is invalid' using errcode='22023';
  end if;
  execute format(
    'delete from %s target where target.ctid in '
    ||'(select candidate.ctid from %s candidate '
    ||'where candidate.source_id::text=$1::text '
    ||'order by candidate.ctid limit $2 for update of candidate)',
    p_table,p_table
  ) using p_source_id,p_limit;
  get diagnostics v_deleted=row_count;
  return v_deleted;
end
$function$;

create or replace function public.norva_run_replacement_cleanup_batch(
  p_worker text,
  p_limit integer default 200
) returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_job public.cloud_source_replacement_cleanup_jobs%rowtype;
  v_source public.cloud_sources%rowtype;
  v_lifecycle public.cloud_source_lifecycle%rowtype;
  v_table regclass;
  v_deleted integer:=0;
  v_count integer;
  v_remaining integer;
  v_tables regclass[]:=array[
    'public.cloud_playback_events'::regclass,
    'public.cloud_watch_history'::regclass,
    'public.cloud_title_rating_operations'::regclass,
    'public.cloud_title_ratings'::regclass,
    'public.cloud_content_events'::regclass,
    'public.catalog_enrichment_source_schedule'::regclass,
    'public.catalog_provider_inventory_backoff'::regclass,
    'public.catalog_generated_subtitle_notifications'::regclass,
    'public.catalog_subtitle_email_deliveries'::regclass,
    'public.cloud_import_notifications'::regclass,
    'public.catalog_source_provider_identities'::regclass,
    'public.cloud_catalog_background_owner_snapshot_sources'::regclass,
    'public.cloud_catalog_generation_backfill_sources'::regclass,
    'public.cloud_source_catalog_generation_candidate_titles'::regclass,
    'public.cloud_source_catalog_generation_categories'::regclass,
    'public.cloud_source_catalog_generation_category_lists'::regclass,
    'public.cloud_source_catalog_generation_inventory_actions'::regclass,
    'public.cloud_source_catalog_generation_title_promotions'::regclass,
    'public.cloud_source_catalog_manifest_seal_progress'::regclass,
    'public.cloud_source_catalog_title_refresh_actions'::regclass,
    'public.cloud_source_catalog_title_refresh_checkpoints'::regclass
  ];
begin
  perform public.norva_credential_require_service_role();
  if p_worker is null or btrim(p_worker)='' or length(p_worker)>160
     or p_limit not between 1 and 1000 then
    raise exception 'replacement cleanup worker input is invalid' using errcode='22023';
  end if;
  select job.* into v_job
  from public.cloud_source_replacement_cleanup_jobs job
  where job.state='pending' and job.available_at<=clock_timestamp()
  order by job.available_at,job.transition_id
  for update skip locked limit 1;
  if not found then
    return jsonb_build_object('claimed',false,'complete',true,'deletedRows',0);
  end if;
  perform public.norva_credential_lock_account(v_job.user_id);
  select source.* into v_source from public.cloud_sources source
  where source.id=v_job.source_id and source.user_id=v_job.user_id for update;
  select lifecycle.* into v_lifecycle from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id=v_job.source_id and lifecycle.user_id=v_job.user_id
  for update;
  if v_source.id is null or v_lifecycle.source_id is null
     or v_lifecycle.catalog_visibility<>'hidden'
     or v_lifecycle.lifecycle_state not in ('replaced','purge_pending') then
    update public.cloud_source_replacement_cleanup_jobs
    set state='dead',last_error_code='cleanup_endpoint_changed',
        attempt_count=attempt_count+1,updated_at=clock_timestamp()
    where transition_id=v_job.transition_id;
    return jsonb_build_object('claimed',true,'complete',false,
      'dead',true,'deletedRows',0,'code','cleanup_endpoint_changed');
  end if;
  if v_source.deleted_at is null then
    update public.cloud_source_lifecycle lifecycle
    set lifecycle_state='purge_pending',updated_at=clock_timestamp()
    where lifecycle.source_id=v_job.source_id
      and lifecycle.user_id=v_job.user_id
      and lifecycle.lifecycle_state='replaced'
      and lifecycle.catalog_visibility='hidden';
    if not found and v_lifecycle.lifecycle_state<>'purge_pending' then
      raise exception 'replacement cleanup purge-pending CAS failed'
        using errcode='40001';
    end if;
    update public.cloud_sources source
    set enabled=false,deleted_at=clock_timestamp(),sync_status='disabled',
        updated_at=clock_timestamp()
    where source.id=v_job.source_id and source.user_id=v_job.user_id
      and source.deleted_at is null;
    update public.cloud_source_replacement_cleanup_jobs
    set attempt_count=attempt_count+1,available_at=clock_timestamp()+interval '10 seconds',
        updated_at=clock_timestamp()
    where transition_id=v_job.transition_id;
    return jsonb_build_object('claimed',true,'complete',false,
      'waitingForReaper',true,'deletedRows',0,'sourceId',v_job.source_id);
  end if;
  if not v_source.provider_deletion_pending then
    update public.cloud_source_replacement_cleanup_jobs
    set attempt_count=attempt_count+1,available_at=clock_timestamp()+interval '10 seconds',
        updated_at=clock_timestamp()
    where transition_id=v_job.transition_id;
    return jsonb_build_object('claimed',true,'complete',false,
      'waitingForReaper',true,'deletedRows',0,'sourceId',v_job.source_id);
  end if;
  v_remaining:=p_limit;
  foreach v_table in array v_tables loop
    exit when v_remaining<=0;
    v_count:=public.norva_replacement_cleanup_delete_rows(
      v_table,v_job.source_id,v_remaining
    );
    v_deleted:=v_deleted+v_count;
    v_remaining:=v_remaining-v_count;
  end loop;
  if v_deleted>0 then
    update public.cloud_source_replacement_cleanup_jobs
    set attempt_count=attempt_count+1,last_deleted_rows=v_deleted,
        available_at=clock_timestamp()+interval '1 second',updated_at=clock_timestamp()
    where transition_id=v_job.transition_id;
    return jsonb_build_object('claimed',true,'complete',false,
      'deletedRows',v_deleted,'sourceId',v_job.source_id);
  end if;
  perform set_config('norva.catalog_purge_source',v_job.source_id::text,true);
  delete from public.cloud_source_provider_account_affinities affinity
  where affinity.source_id=v_job.source_id and affinity.user_id=v_job.user_id;
  update public.cloud_sources source
  set config_ciphertext=null,config_hint='{}'::jsonb,
      display_name='Deleted source',enabled=false,sync_status='disabled',
      updated_at=clock_timestamp()
  where source.id=v_job.source_id and source.user_id=v_job.user_id
    and source.provider_deletion_pending and source.deleted_at is not null;
  -- Visibility was already atomically hidden by rollback.  PURGE_PENDING ->
  -- PURGED is terminal metadata only, so do not synthesize a second epoch.
  perform set_config('norva.skip_visibility_epoch_bump','on',true);
  update public.cloud_source_lifecycle lifecycle
  set lifecycle_state='purged',catalog_visibility='hidden',
      updated_at=clock_timestamp()
  where lifecycle.source_id=v_job.source_id and lifecycle.user_id=v_job.user_id
    and lifecycle.lifecycle_state='purge_pending';
  if not found then
    raise exception 'replacement cleanup final lifecycle CAS failed' using errcode='40001';
  end if;
  update public.cloud_source_replacement_cleanup_jobs
  set state='completed',completed_at=clock_timestamp(),last_deleted_rows=0,
      attempt_count=attempt_count+1,updated_at=clock_timestamp()
  where transition_id=v_job.transition_id and state='pending';
  return jsonb_build_object('claimed',true,'complete',true,'deletedRows',0,
    'sourceId',v_job.source_id,'transitionId',v_job.transition_id);
end
$function$;

revoke all on function public.norva_replacement_cleanup_delete_rows(
  regclass,uuid,integer
),public.norva_run_replacement_cleanup_batch(text,integer),
public.norva_fail_source_replacement(uuid,uuid,text,bigint,text,text,text)
from public,anon,authenticated,service_role;
grant execute on function public.norva_run_replacement_cleanup_batch(text,integer),
public.norva_fail_source_replacement(uuid,uuid,text,bigint,text,text,text)
to service_role;

commit;
