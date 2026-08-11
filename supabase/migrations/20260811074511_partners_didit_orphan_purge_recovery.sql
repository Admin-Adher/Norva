-- Norva Partners: bounded recovery for historical Didit purge sources that
-- have a one-way provider hash but no durable deletion outbox entry.
--
-- The Edge worker lists only a bounded provider window, matches the one-way
-- hash in memory, encrypts the matching identifier, then sends the identifier
-- only as a transient recovery argument. SQL re-hashes it and persists only
-- the authenticated encrypted envelope; the raw identifier is never stored.

create or replace function
affiliate_private.partners_service_didit_purge_orphans(
  p_provider_environment text,
  p_limit integer default 5
)
returns table (
  provider_session_hash text,
  provider_environment text,
  provider_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_provider_environment not in ('sandbox', 'live')
    or p_limit is null
    or p_limit not between 1 and 5
  then
    raise exception 'invalid Didit purge orphan query'
      using errcode = '22023';
  end if;

  return query
  select
    source.provider_session_hash,
    source.provider_environment,
    source.provider_status
  from (
    select
      session.provider_session_hash,
      session.provider_environment,
      session.provider_status,
      session.id as source_record_id,
      'member_kyc'::text as session_purpose,
      session.provider_purge_requested_at
    from affiliate_private.affiliate_kyc_sessions session
    where session.provider_session_hash is not null
      and session.provider_environment = p_provider_environment
      and session.provider_status is not null
      and session.provider_purge_status = 'purge_pending'
      and (
        session.status <> 'pending'
        or session.provider_status in (
          'approved', 'declined', 'expired', 'abandoned', 'kyc_expired'
        )
      )

    union all

    select
      session.provider_session_hash,
      session.provider_environment,
      session.provider_status,
      session.id as source_record_id,
      'certification'::text as session_purpose,
      session.provider_purge_requested_at
    from affiliate_private.affiliate_didit_certification_sessions session
    where session.provider_session_hash is not null
      and session.provider_environment = p_provider_environment
      and session.provider_status is not null
      and session.provider_purge_status = 'purge_pending'
      and (
        session.status in ('approved', 'declined', 'expired', 'quarantined')
        or session.provider_status in (
          'approved', 'declined', 'expired', 'abandoned', 'kyc_expired'
        )
      )
  ) source
  join affiliate_private.affiliate_didit_session_registry registry
    on registry.provider_session_hash = source.provider_session_hash
    and registry.session_purpose = source.session_purpose
    and registry.source_record_id = source.source_record_id
  where not exists (
    select 1
    from affiliate_private.affiliate_didit_purge_outbox outbox
    where outbox.provider_session_hash = source.provider_session_hash
      and outbox.session_purpose = source.session_purpose
      and outbox.source_record_id = source.source_record_id
      and outbox.provider_environment = source.provider_environment
  )
  order by
    source.provider_purge_requested_at nulls first,
    source.provider_session_hash
  limit p_limit;
end;
$$;

create or replace function public.partners_service_didit_purge_orphans(
  p_provider_environment text,
  p_limit integer default 5
)
returns table (
  provider_session_hash text,
  provider_environment text,
  provider_status text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from affiliate_private.partners_service_didit_purge_orphans(
    p_provider_environment,
    p_limit
  );
$$;

create or replace function
affiliate_private.partners_service_didit_purge_recover(
  p_provider_session_id text,
  p_provider_session_envelope text,
  p_provider_environment text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  -- partners_didit_purge_enqueue is the authoritative binding check: it
  -- re-hashes the raw identifier, locks that hash, checks the registry and
  -- terminal source, and rejects any environment or outbox conflict.
  v_status := affiliate_private.partners_didit_purge_enqueue(
    p_provider_session_id,
    p_provider_session_envelope,
    p_provider_environment
  );
  if v_status not in (
    'purge_pending', 'purged', 'purge_dead_letter'
  ) then
    raise exception 'invalid Didit purge recovery result'
      using errcode = '55000';
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'didit_purge_recovered',
    'purge_status', v_status
  );
end;
$$;

create or replace function public.partners_service_didit_purge_recover(
  p_provider_session_id text,
  p_provider_session_envelope text,
  p_provider_environment text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_didit_purge_recover(
    p_provider_session_id,
    p_provider_session_envelope,
    p_provider_environment
  );
$$;

-- Correct the certification purpose used by the orphan counters. The durable
-- registry and outbox contract has always used `certification`.
create or replace function
affiliate_private.partners_service_didit_purge_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schema_version', 1,
    'waiting_terminal', count(*) filter (
      where outbox.status = 'waiting_terminal'
    ),
    'pending', count(*) filter (where outbox.status in ('pending', 'retry')),
    'leased', count(*) filter (where outbox.status = 'leased'),
    'succeeded', count(*) filter (where outbox.status = 'succeeded'),
    'dead_letter', count(*) filter (where outbox.status = 'dead_letter'),
    'oldest_pending_seconds', coalesce(max(
      extract(epoch from statement_timestamp() - outbox.created_at)::bigint
    ) filter (where outbox.status in ('pending', 'retry', 'leased')), 0),
    'orphaned_source_pending', (
      select count(*)
      from (
        select
          session.id as source_record_id,
          session.provider_session_hash,
          session.provider_environment,
          'member_kyc'::text as session_purpose
        from affiliate_private.affiliate_kyc_sessions session
        where session.provider_session_hash is not null
          and session.provider_purge_status = 'purge_pending'
        union all
        select
          session.id as source_record_id,
          session.provider_session_hash,
          session.provider_environment,
          'certification'::text as session_purpose
        from affiliate_private.affiliate_didit_certification_sessions session
        where session.provider_session_hash is not null
          and session.provider_purge_status = 'purge_pending'
      ) source
      where not exists (
        select 1
        from affiliate_private.affiliate_didit_purge_outbox missing_outbox
        where missing_outbox.provider_session_hash =
          source.provider_session_hash
          and missing_outbox.source_record_id = source.source_record_id
          and missing_outbox.provider_environment =
            source.provider_environment
          and missing_outbox.session_purpose = source.session_purpose
      )
    ),
    'orphaned_source_dead_letter', (
      select count(*)
      from (
        select
          session.id as source_record_id,
          session.provider_session_hash,
          session.provider_environment,
          'member_kyc'::text as session_purpose
        from affiliate_private.affiliate_kyc_sessions session
        where session.provider_session_hash is not null
          and session.provider_purge_status = 'purge_dead_letter'
        union all
        select
          session.id as source_record_id,
          session.provider_session_hash,
          session.provider_environment,
          'certification'::text as session_purpose
        from affiliate_private.affiliate_didit_certification_sessions session
        where session.provider_session_hash is not null
          and session.provider_purge_status = 'purge_dead_letter'
      ) source
      where not exists (
        select 1
        from affiliate_private.affiliate_didit_purge_outbox missing_outbox
        where missing_outbox.provider_session_hash =
          source.provider_session_hash
          and missing_outbox.source_record_id = source.source_record_id
          and missing_outbox.provider_environment =
            source.provider_environment
          and missing_outbox.session_purpose = source.session_purpose
      )
    ),
    'worker', jsonb_build_object(
      'last_started_at', worker.last_started_at,
      'last_completed_at', worker.last_completed_at,
      'last_outcome', worker.last_outcome,
      'heartbeat_fresh', coalesce(
        worker.last_completed_at >= statement_timestamp() - interval '5 minutes',
        false
      )
    )
  )
  from affiliate_private.affiliate_didit_purge_worker_state worker
  left join affiliate_private.affiliate_didit_purge_outbox outbox on true
  where worker.worker_name = 'didit_purge'
  group by
    worker.last_started_at,
    worker.last_completed_at,
    worker.last_outcome;
$$;

-- Keep the migration executor as owner. The disposable Supabase database runs
-- migrations as its isolated PostgreSQL role, while the Hetzner rehearsal and
-- production deployment run them as supabase_admin. An explicit cross-role
-- OWNER change would require unnecessary SET ROLE authority in CI.

revoke all on function
  affiliate_private.partners_service_didit_purge_orphans(text, integer),
  public.partners_service_didit_purge_orphans(text, integer),
  affiliate_private.partners_service_didit_purge_recover(text, text, text),
  public.partners_service_didit_purge_recover(text, text, text)
from public, anon, authenticated, service_role;

grant execute on function
  affiliate_private.partners_service_didit_purge_orphans(text, integer),
  public.partners_service_didit_purge_orphans(text, integer),
  affiliate_private.partners_service_didit_purge_recover(text, text, text),
  public.partners_service_didit_purge_recover(text, text, text)
to service_role;

comment on function
affiliate_private.partners_service_didit_purge_orphans(text, integer) is
  'Returns at most five one-way hashes for terminal purge sources that lack an exact outbox binding; no provider identifier or PII is returned.';
comment on function public.partners_service_didit_purge_orphans(
  text, integer
) is
  'Service-only bounded PostgREST wrapper for Didit purge orphan discovery.';
comment on function
affiliate_private.partners_service_didit_purge_recover(text, text, text) is
  'Revalidates and durably enqueues one provider identifier recovered in bounded Edge memory; SQL stores only its authenticated encrypted envelope.';
comment on function public.partners_service_didit_purge_recover(
  text, text, text
) is
  'Service-only PostgREST wrapper for fail-closed Didit purge orphan recovery.';

do $partners_didit_orphan_purge_recovery_contract$
declare
  v_private_list regprocedure := to_regprocedure(
    'affiliate_private.partners_service_didit_purge_orphans(text,integer)'
  );
  v_public_list regprocedure := to_regprocedure(
    'public.partners_service_didit_purge_orphans(text,integer)'
  );
  v_private_recover regprocedure := to_regprocedure(
    'affiliate_private.partners_service_didit_purge_recover(text,text,text)'
  );
  v_public_recover regprocedure := to_regprocedure(
    'public.partners_service_didit_purge_recover(text,text,text)'
  );
  v_status regprocedure := to_regprocedure(
    'affiliate_private.partners_service_didit_purge_status()'
  );
begin
  if v_private_list is null
    or v_public_list is null
    or v_private_recover is null
    or v_public_recover is null
    or v_status is null
  then
    raise exception 'Didit purge orphan recovery routines are unavailable';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid in (
      v_private_list::oid,
      v_private_recover::oid,
      v_status::oid
    )
      and procedure_row.prosecdef
      and procedure_row.proowner = current_user::regrole
      and procedure_row.proconfig = array['search_path=""']::text[]
  ) <> 3 or exists (
    select 1
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid in (
      v_public_list::oid,
      v_public_recover::oid
    )
      and procedure_row.prosecdef
  ) then
    raise exception 'Didit purge orphan recovery security contract is invalid';
  end if;

  if exists (
    select 1
    from unnest(array[
      v_private_list,
      v_public_list,
      v_private_recover,
      v_public_recover
    ]) as routine(signature)
    where has_function_privilege('anon', routine.signature, 'EXECUTE')
      or has_function_privilege(
        'authenticated', routine.signature, 'EXECUTE'
      )
      or not has_function_privilege(
        'service_role', routine.signature, 'EXECUTE'
      )
  ) then
    raise exception 'Didit purge orphan recovery ACL is invalid';
  end if;

  if position(
    'programme_certification'
    in lower(pg_get_functiondef(v_status))
  ) > 0 or position(
    '''certification''::text as session_purpose'
    in lower(pg_get_functiondef(v_status))
  ) = 0 then
    raise exception 'Didit purge orphan status purpose is invalid';
  end if;
end;
$partners_didit_orphan_purge_recovery_contract$;
