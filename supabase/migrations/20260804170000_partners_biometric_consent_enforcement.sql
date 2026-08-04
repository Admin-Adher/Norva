-- Apply this final enforcement migration only after both Edge replicas run the
-- v2 KYC prepare and v3 atomic record/purge RPC contract. This sequencing keeps
-- the rolling deploy
-- available while making any later service-role bypass impossible.

set statement_timeout = '30s';
set lock_timeout = '10s';

-- During the rolling Edge update an older replica may have recorded a pending
-- member session without the encrypted staged deletion row introduced by v3.
-- Do not retire v2 until every still-pending Didit session is durably covered;
-- otherwise a later consent withdrawal could not request provider deletion.
do $partners_pending_didit_purge_coverage_guard$
begin
  if exists (
    select 1
    from affiliate_private.affiliate_kyc_sessions session
    where session.status = 'pending'
      and session.provider_session_hash is not null
      and not exists (
        select 1
        from affiliate_private.affiliate_didit_purge_outbox outbox
        where outbox.provider_session_hash = session.provider_session_hash
          and outbox.session_purpose = 'member_kyc'
          and outbox.source_record_id = session.id
          and outbox.provider_environment = session.provider_environment
      )
  ) then
    raise exception
      'pending Didit sessions are missing durable purge coverage'
      using errcode = '55000';
  end if;
end;
$partners_pending_didit_purge_coverage_guard$;

revoke execute on function public.partners_service_kyc_prepare(
  uuid, text, text, boolean, text
) from service_role;
revoke execute on function
  affiliate_private.partners_service_kyc_prepare(
    uuid, text, text, boolean, text
  ) from service_role;
revoke execute on function public.partners_service_kyc_session_record(
  uuid, text, text, text, integer, text, timestamptz, text
) from service_role;
revoke execute on function public.partners_service_kyc_session_record(
  uuid, text, text, text, integer, text, timestamptz, text,
  text, text, integer
) from service_role;
revoke execute on function
  affiliate_private.partners_service_kyc_session_record(
    uuid, text, text, text, integer, text, timestamptz, text
  ) from service_role;
revoke execute on function public.partners_service_kyc_session_record_v2(
  uuid, text, text, text, integer, text, timestamptz, text,
  text, text, integer
) from service_role;
revoke execute on function
  affiliate_private.partners_service_kyc_session_record_v2(
    uuid, text, text, text, integer, text, timestamptz, text,
    text, text, integer
  ) from service_role;

-- Only the 15-argument reducers that atomically enqueue provider deletion stay
-- callable. The legacy 14-argument reducers could commit a terminal decision
-- without a durable encrypted purge envelope.
revoke execute on function
  affiliate_private.partners_service_kyc_webhook_apply(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text
  ) from service_role;
revoke execute on function public.partners_service_kyc_webhook_apply(
  text, text, text, integer, text, timestamptz, integer, text,
  boolean, boolean, boolean, text, text, text
) from service_role;
revoke execute on function
  affiliate_private.partners_service_kyc_certification_webhook_apply(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text
  ) from service_role;
revoke execute on function
  public.partners_service_kyc_certification_webhook_apply(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text
  ) from service_role;
revoke execute on function
  affiliate_private.partners_service_kyc_session_record(
    uuid, text, text, text, integer, text, timestamptz, text,
    text, text, integer
  ) from service_role;

reset lock_timeout;
reset statement_timeout;
