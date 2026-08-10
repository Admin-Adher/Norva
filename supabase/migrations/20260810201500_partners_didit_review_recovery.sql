-- Norva Partners: keep a live Didit certification available while one of its
-- required features is explicitly under manual review, then accept only a
-- signed reviewer update for that exact in-review session.
--
-- The ordinary certification reducer remains authoritative. This wrapper only
-- narrows the additional `data.updated:<event UUID>` namespace before the
-- event can reach it. Quarantined and terminal sessions remain immutable.

create or replace function
affiliate_private.partners_service_kyc_certification_webhook_apply_and_enqueue_pu(
  p_provider_event_id text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_event_created_at timestamptz,
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
  v_response jsonb;
  v_purge_status text;
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
  v_has_review_prefix boolean :=
    lower(v_event_id) like 'data.updated:%';
  v_is_review_update boolean := v_event_id ~*
    '^data\.updated:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  v_event_hash text;
  v_session_hash text;
  v_workflow_hash text;
  v_registry affiliate_private.affiliate_didit_session_registry%rowtype;
  v_session
    affiliate_private.affiliate_didit_certification_sessions%rowtype;
  v_existing_event
    affiliate_private.affiliate_didit_certification_events%rowtype;
begin
  if v_has_review_prefix and not v_is_review_update then
    raise exception 'invalid Didit certification review event identifier'
      using errcode = '22023';
  end if;

  if v_is_review_update then
    if p_provider_session_id is null
      or length(p_provider_session_id) not between 8 and 255
      or p_provider_session_id ~ '[[:space:][:cntrl:]]'
      or p_provider_workflow_id is null
      or length(p_provider_workflow_id) not between 3 and 255
      or p_provider_workflow_id ~ '[[:space:][:cntrl:]]'
      or p_provider_workflow_version is null
      or p_provider_workflow_version not between 1 and 2147483647
      or not affiliate_private.partners_valid_didit_status(
        v_provider_status
      )
      or p_event_created_at is null
      or p_event_created_at > now() + interval '5 minutes'
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
      raise exception 'invalid Didit certification review envelope'
        using errcode = '22023';
    end if;

    v_event_hash := encode(
      extensions.digest(
        'norva:didit:event:v1:' || v_event_id,
        'sha256'
      ),
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

    -- Exact replays are delegated to the original reducer, which compares the
    -- complete normalized event before returning replayed=true. A new reviewer
    -- update is admissible only while this exact certification is in review.
    if not found then
      if v_session.status <> 'in_review'
        or v_session.provider_status <> 'in_review'
        or v_session.provider_workflow_hash <> v_workflow_hash
        or v_session.provider_workflow_version
          <> p_provider_workflow_version
        or v_session.provider_environment <> v_environment
        or v_session.provider_config_fingerprint <> v_fingerprint
        or v_session.expires_at <= now()
        or p_event_created_at > v_session.expires_at
        or v_session.last_event_created_at is null
        or p_event_created_at <= v_session.last_event_created_at
        or v_provider_status not in (
          'in_review', 'approved', 'declined', 'abandoned',
          'expired', 'kyc_expired'
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
            and event.provider_event_created_at =
              v_session.last_event_created_at
        )
      then
        raise exception 'Didit certification review update is not admissible'
          using errcode = 'P0006';
      end if;
    end if;
  end if;

  v_response :=
    affiliate_private.partners_service_kyc_certification_webhook_apply(
      p_provider_event_id,
      p_provider_session_id,
      p_provider_workflow_id,
      p_provider_workflow_version,
      p_provider_status,
      p_event_created_at,
      p_document_age,
      p_document_country_iso3,
      p_id_check_approved,
      p_liveness_approved,
      p_face_match_approved,
      p_payload_hash,
      p_provider_environment,
      p_provider_config_fingerprint
    );
  v_purge_status := affiliate_private.partners_didit_purge_enqueue(
    p_provider_session_id,
    p_provider_session_envelope,
    p_provider_environment
  );
  return v_response || jsonb_build_object(
    'purge_status', v_purge_status
  );
end;
$$;

comment on function
affiliate_private.partners_service_kyc_certification_webhook_apply_and_enqueue_pu(
  text, text, text, integer, text, timestamptz, integer, text,
  boolean, boolean, boolean, text, text, text, text
) is
  'Reduces lifecycle events and admits signed data.updated events only for the exact live certification currently under manual review before staging terminal purge.';

do $partners_didit_review_continuation_contract$
begin
  if to_regprocedure(
    'affiliate_private.partners_service_kyc_certification_webhook_apply_and_enqueue_pu(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)'
  ) is null then
    raise exception 'Didit certification review wrapper is unavailable';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc procedure_row
    join pg_catalog.pg_namespace namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'affiliate_private'
      and procedure_row.proname =
        'partners_service_kyc_certification_webhook_apply_and_enqueue_pu'
      and procedure_row.prosecdef
      and procedure_row.proconfig = array['search_path=""']::text[]
  ) then
    raise exception 'Didit review wrapper security contract is invalid';
  end if;
end;
$partners_didit_review_continuation_contract$;
