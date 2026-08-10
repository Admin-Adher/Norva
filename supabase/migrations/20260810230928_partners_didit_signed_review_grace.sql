-- Norva Partners: accept a terminal Didit reviewer decision only when a fresh,
-- authenticated delivery proves that the provider is sending the current
-- decision for the exact live certification already under review.
--
-- Didit may retain the session's original `created_at` on `data.updated` while
-- refreshing the signed transport timestamp for each delivery. The ordinary
-- KYC reducers intentionally keep their strict expiry semantics. This separate
-- service-only RPC grants a bounded 24-hour grace solely to the one-off live
-- certification and never extends the stored session expiry.

alter table affiliate_private.affiliate_didit_certification_events
  add column provider_delivered_at timestamptz;

alter table affiliate_private.affiliate_didit_certification_events
  add constraint affiliate_didit_certification_events_delivery
  check (
    provider_delivered_at is null
    or (
      provider_delivered_at >= provider_event_created_at - interval '5 minutes'
      and provider_delivered_at <= created_at + interval '5 minutes'
    )
  );

comment on column
  affiliate_private.affiliate_didit_certification_events.provider_delivered_at
is
  'PII-free Didit transport timestamp authenticated by Edge; retained only to audit bounded terminal-review recovery.';

create or replace function
affiliate_private.partners_didit_cert_review_apply_purge(
  p_provider_event_id text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_event_created_at timestamptz,
  p_provider_delivered_at timestamptz,
  p_document_age integer,
  p_document_country_iso3 text,
  p_id_check_approved boolean,
  p_liveness_approved boolean,
  p_face_match_approved boolean,
  p_payload_hash text,
  p_provider_environment text,
  p_provider_config_fingerprint text,
  p_provider_session_envelope text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event_id text := btrim(coalesce(p_provider_event_id, ''));
  v_provider_status text := lower(
    replace(btrim(coalesce(p_provider_status, '')), ' ', '_')
  );
  v_environment text := lower(btrim(coalesce(p_provider_environment, '')));
  v_fingerprint text := lower(
    btrim(coalesce(p_provider_config_fingerprint, ''))
  );
  v_payload_hash text := lower(btrim(coalesce(p_payload_hash, '')));
  v_iso3 text := nullif(
    upper(btrim(coalesce(p_document_country_iso3, ''))),
    ''
  );
  v_event_hash text;
  v_session_hash text;
  v_workflow_hash text;
  v_age_over_minimum boolean := coalesce(p_document_age >= 18, false);
  v_jurisdiction_present boolean := v_iso3 is not null;
  v_target_status text;
  v_verified boolean;
  v_purge_status text;
  v_registry affiliate_private.affiliate_didit_session_registry%rowtype;
  v_session
    affiliate_private.affiliate_didit_certification_sessions%rowtype;
  v_existing_event
    affiliate_private.affiliate_didit_certification_events%rowtype;
begin
  if v_event_id !~*
      '^data\.updated:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_provider_session_id is null
    or length(p_provider_session_id) not between 8 and 255
    or p_provider_session_id ~ '[[:space:][:cntrl:]]'
    or p_provider_workflow_id is null
    or length(p_provider_workflow_id) not between 3 and 255
    or p_provider_workflow_id ~ '[[:space:][:cntrl:]]'
    or p_provider_workflow_version is null
    or p_provider_workflow_version not between 1 and 2147483647
    or v_provider_status not in (
      'approved', 'declined', 'abandoned', 'expired', 'kyc_expired'
    )
    or p_event_created_at is null
    or p_event_created_at > statement_timestamp() + interval '5 minutes'
    or p_provider_delivered_at is null
    or p_provider_delivered_at < statement_timestamp() - interval '10 minutes'
    or p_provider_delivered_at > statement_timestamp() + interval '5 minutes'
    or p_provider_delivered_at < p_event_created_at - interval '5 minutes'
    or (
      p_document_age is not null
      and p_document_age not between 0 and 150
    )
    or (v_iso3 is not null and v_iso3 !~ '^[A-Z]{3}$')
    or v_payload_hash !~ '^[0-9a-f]{64}$'
    or v_environment <> 'live'
    or v_fingerprint !~ '^[0-9a-f]{64}$'
    or p_provider_session_envelope is null
    or length(p_provider_session_envelope) not between 64 and 512
    or p_provider_session_envelope !~
      '^v1\.[a-z0-9][a-z0-9_-]{0,15}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}[A-Za-z0-9_-]*$'
  then
    raise exception 'invalid Didit certification review delivery'
      using errcode = '22023';
  end if;

  v_event_hash := encode(
    extensions.digest('norva:didit:event:v1:' || v_event_id, 'sha256'),
    'hex'
  );
  v_session_hash := encode(
    extensions.digest(
      'norva:didit:session:v1:' || p_provider_session_id,
      'sha256'
    ),
    'hex'
  );
  v_workflow_hash := encode(
    extensions.digest(
      'norva:didit:workflow:v1:' || p_provider_workflow_id,
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:didit:certification-session:v1:' || v_session_hash,
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:didit:certification-event:v1:' || v_event_hash,
      0
    )
  );

  select registry.*
  into v_registry
  from affiliate_private.affiliate_didit_session_registry registry
  where registry.provider_session_hash = v_session_hash;
  if not found or v_registry.session_purpose <> 'certification' then
    raise exception 'Didit certification review session is unknown'
      using errcode = 'P0006';
  end if;

  select session.*
  into v_session
  from affiliate_private.affiliate_didit_certification_sessions session
  where session.id = v_registry.source_record_id
    and session.provider_session_hash = v_session_hash
  for update;
  if not found then
    raise exception 'Didit certification review session is unknown'
      using errcode = 'P0006';
  end if;

  select event.*
  into v_existing_event
  from affiliate_private.affiliate_didit_certification_events event
  where event.provider_event_hash = v_event_hash;
  if found then
    if v_existing_event.certification_session_id = v_session.id
      and v_existing_event.provider_session_hash = v_session_hash
      and v_existing_event.provider_workflow_hash = v_workflow_hash
      and v_existing_event.provider_workflow_version
        = p_provider_workflow_version
      and v_existing_event.provider_environment = v_environment
      and v_existing_event.provider_config_fingerprint = v_fingerprint
      and v_existing_event.payload_hash = v_payload_hash
      and v_existing_event.provider_status = v_provider_status
      and v_existing_event.provider_event_created_at = p_event_created_at
      and v_existing_event.id_check_approved
        is not distinct from p_id_check_approved
      and v_existing_event.liveness_approved
        is not distinct from p_liveness_approved
      and v_existing_event.face_match_approved
        is not distinct from p_face_match_approved
      and v_existing_event.age_over_minimum = v_age_over_minimum
      and v_existing_event.jurisdiction_result_present
        = v_jurisdiction_present
      and v_existing_event.processing_outcome = 'applied'
    then
      v_purge_status := affiliate_private.partners_didit_purge_enqueue(
        p_provider_session_id,
        p_provider_session_envelope,
        p_provider_environment
      );
      return jsonb_build_object(
        'schema_version', 1,
        'action', 'kyc_certification_result_applied',
        'replayed', true,
        'purge_status', v_purge_status,
        'certification', jsonb_build_object(
          'status', v_session.status,
          'verified', v_session.verified
        )
      );
    end if;

    if v_session.status <> 'quarantined' then
      update affiliate_private.affiliate_didit_certification_sessions
      set
        status = 'quarantined',
        verified = false,
        quarantine_reason = 'event_replay_conflict',
        quarantined_at = statement_timestamp(),
        updated_at = statement_timestamp()
      where id = v_session.id
      returning * into v_session;
    end if;
    v_purge_status := affiliate_private.partners_didit_purge_enqueue(
      p_provider_session_id,
      p_provider_session_envelope,
      p_provider_environment
    );
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'kyc_certification_result_quarantined',
      'replayed', true,
      'purge_status', v_purge_status,
      'certification', jsonb_build_object(
        'status', 'quarantined',
        'verified', false,
        'reason', 'binding_conflict'
      )
    );
  end if;

  -- This is the only recovery branch. It is bound to the exact certification,
  -- requires its previous applied in-review observation, permits Didit's stable
  -- event creation time to equal (never precede) that observation, and accepts
  -- a terminal decision only while a fresh signed delivery is within 24 hours
  -- of the immutable local expiry.
  if v_session.status <> 'in_review'
    or v_session.provider_status <> 'in_review'
    or v_session.provider_workflow_hash <> v_workflow_hash
    or v_session.provider_workflow_version <> p_provider_workflow_version
    or v_session.provider_environment <> v_environment
    or v_session.provider_config_fingerprint <> v_fingerprint
    or statement_timestamp() > v_session.expires_at + interval '24 hours'
    or p_provider_delivered_at > v_session.expires_at + interval '24 hours'
    or p_event_created_at > v_session.expires_at
    or p_event_created_at < v_session.created_at - interval '5 minutes'
    or v_session.last_event_created_at is null
    or p_event_created_at < v_session.last_event_created_at
    or not exists (
      select 1
      from affiliate_private.affiliate_didit_certification_events event
      where event.certification_session_id = v_session.id
        and event.provider_session_hash = v_session_hash
        and event.provider_workflow_hash = v_workflow_hash
        and event.provider_workflow_version = p_provider_workflow_version
        and event.provider_environment = v_environment
        and event.provider_config_fingerprint = v_fingerprint
        and event.provider_status = 'in_review'
        and event.processing_outcome = 'applied'
        and event.bounded_reason is null
        and event.provider_event_created_at = v_session.last_event_created_at
    )
    or (
      v_provider_status = 'approved'
      and not coalesce((
        p_id_check_approved is true
        and p_liveness_approved is true
        and p_face_match_approved is true
        and p_document_age between 18 and 150
        and v_iso3 ~ '^[A-Z]{3}$'
      ), false)
    )
  then
    raise exception 'Didit certification terminal review is not admissible'
      using errcode = 'P0006';
  end if;

  v_target_status := case
    when v_provider_status = 'approved' then 'approved'
    when v_provider_status in ('declined', 'abandoned') then 'declined'
    else 'expired'
  end;
  v_verified :=
    v_target_status = 'approved'
    and p_id_check_approved is true
    and p_liveness_approved is true
    and p_face_match_approved is true
    and v_age_over_minimum
    and v_jurisdiction_present;

  insert into affiliate_private.affiliate_didit_certification_events (
    certification_session_id,
    provider_event_hash,
    provider_session_hash,
    provider_workflow_hash,
    provider_workflow_version,
    provider_environment,
    provider_config_fingerprint,
    payload_hash,
    provider_status,
    processing_outcome,
    id_check_approved,
    liveness_approved,
    face_match_approved,
    age_over_minimum,
    jurisdiction_result_present,
    verified,
    provider_event_created_at,
    provider_delivered_at
  ) values (
    v_session.id,
    v_event_hash,
    v_session_hash,
    v_workflow_hash,
    p_provider_workflow_version,
    v_environment,
    v_fingerprint,
    v_payload_hash,
    v_provider_status,
    'applied',
    p_id_check_approved,
    p_liveness_approved,
    p_face_match_approved,
    v_age_over_minimum,
    v_jurisdiction_present,
    v_verified,
    p_event_created_at,
    p_provider_delivered_at
  );

  update affiliate_private.affiliate_didit_certification_sessions
  set
    provider_status = v_provider_status,
    status = v_target_status,
    id_check_approved = p_id_check_approved,
    liveness_approved = p_liveness_approved,
    face_match_approved = p_face_match_approved,
    age_over_minimum = v_age_over_minimum,
    jurisdiction_result_present = v_jurisdiction_present,
    verified = v_verified,
    verified_at = case
      when v_verified then p_provider_delivered_at
      else verified_at
    end,
    last_event_created_at = greatest(
      coalesce(last_event_created_at, created_at),
      p_event_created_at
    ),
    updated_at = statement_timestamp()
  where id = v_session.id
  returning * into v_session;

  v_purge_status := affiliate_private.partners_didit_purge_enqueue(
    p_provider_session_id,
    p_provider_session_envelope,
    p_provider_environment
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_certification_result_applied',
    'replayed', false,
    'purge_status', v_purge_status,
    'certification', jsonb_build_object(
      'status', v_session.status,
      'verified', v_session.verified
    )
  );
end;
$$;

create or replace function
public.partners_service_didit_cert_review_apply_purge(
  p_provider_event_id text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_event_created_at timestamptz,
  p_provider_delivered_at timestamptz,
  p_document_age integer,
  p_document_country_iso3 text,
  p_id_check_approved boolean,
  p_liveness_approved boolean,
  p_face_match_approved boolean,
  p_payload_hash text,
  p_provider_environment text,
  p_provider_config_fingerprint text,
  p_provider_session_envelope text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_didit_cert_review_apply_purge(
    p_provider_event_id,
    p_provider_session_id,
    p_provider_workflow_id,
    p_provider_workflow_version,
    p_provider_status,
    p_event_created_at,
    p_provider_delivered_at,
    p_document_age,
    p_document_country_iso3,
    p_id_check_approved,
    p_liveness_approved,
    p_face_match_approved,
    p_payload_hash,
    p_provider_environment,
    p_provider_config_fingerprint,
    p_provider_session_envelope
  );
$$;

revoke all on function
  affiliate_private.partners_didit_cert_review_apply_purge(
    text, text, text, integer, text, timestamptz, timestamptz, integer,
    text, boolean, boolean, boolean, text, text, text, text
  ),
  public.partners_service_didit_cert_review_apply_purge(
    text, text, text, integer, text, timestamptz, timestamptz, integer,
    text, boolean, boolean, boolean, text, text, text, text
  )
from public, anon, authenticated, service_role;

grant execute on function
  affiliate_private.partners_didit_cert_review_apply_purge(
    text, text, text, integer, text, timestamptz, timestamptz, integer,
    text, boolean, boolean, boolean, text, text, text, text
  ),
  public.partners_service_didit_cert_review_apply_purge(
    text, text, text, integer, text, timestamptz, timestamptz, integer,
    text, boolean, boolean, boolean, text, text, text, text
  )
to service_role;

comment on function
  affiliate_private.partners_didit_cert_review_apply_purge(
    text, text, text, integer, text, timestamptz, timestamptz, integer,
    text, boolean, boolean, boolean, text, text, text, text
  ) is
  'Applies one fresh signed terminal data.updated decision to the exact live certification already in review, within a bounded post-expiry grace, and enqueues provider-data purge.';

comment on function
  public.partners_service_didit_cert_review_apply_purge(
    text, text, text, integer, text, timestamptz, timestamptz, integer,
    text, boolean, boolean, boolean, text, text, text, text
  ) is
  'Service-only PostgREST wrapper for bounded Didit certification terminal-review recovery.';

do $partners_didit_signed_review_grace_contract$
declare
  v_private regprocedure := to_regprocedure(
    'affiliate_private.partners_didit_cert_review_apply_purge(text,text,text,integer,text,timestamptz,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)'
  );
  v_public regprocedure := to_regprocedure(
    'public.partners_service_didit_cert_review_apply_purge(text,text,text,integer,text,timestamptz,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)'
  );
begin
  if octet_length('partners_service_didit_cert_review_apply_purge') >
      current_setting('max_identifier_length')::integer
    or v_private is null
    or v_public is null
  then
    raise exception 'Didit signed review recovery RPC is unavailable';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid = v_private::oid
      and procedure_row.prosecdef
      and procedure_row.proconfig = array['search_path=""']::text[]
  ) or exists (
    select 1
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid = v_public::oid
      and procedure_row.prosecdef
  ) then
    raise exception 'Didit signed review recovery security contract is invalid';
  end if;

  if has_function_privilege('anon', v_private, 'EXECUTE')
    or has_function_privilege('authenticated', v_private, 'EXECUTE')
    or has_function_privilege('anon', v_public, 'EXECUTE')
    or has_function_privilege('authenticated', v_public, 'EXECUTE')
    or not has_function_privilege('service_role', v_private, 'EXECUTE')
    or not has_function_privilege('service_role', v_public, 'EXECUTE')
  then
    raise exception 'Didit signed review recovery ACL is invalid';
  end if;
end;
$partners_didit_signed_review_grace_contract$;
