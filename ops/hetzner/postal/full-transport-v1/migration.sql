-- Disabled installation; independent of the separate full-production cutover.
begin;
set local lock_timeout='1500ms';set local statement_timeout='30s';
select pg_advisory_xact_lock(1788683001);
do $guard$ begin
if current_user<>'supabase_admin' or current_setting('norva.postal_install',true) is distinct from 'full-v1-disabled' then raise exception 'explicit_disabled_install_required';end if;
if to_regnamespace('norva_postal_full') is not null then raise exception 'fresh_install_only';end if;
if (select md5(pg_get_functiondef(to_regprocedure('complete_import_notification_delivery(uuid,uuid[],uuid,text,integer,text,jsonb)')))) is distinct from '475e36ef447ddd424388e59a3795eb71' then raise exception 'baseline_changed:complete_import_notification_delivery';end if;
if (select md5(pg_get_functiondef(to_regprocedure('fail_import_notification_delivery(uuid,uuid[],uuid,boolean,integer,jsonb,text,integer,integer,integer)')))) is distinct from '5da5c23d81a38ed1c8387c2e0c09e263' then raise exception 'baseline_changed:fail_import_notification_delivery';end if;
if (select md5(pg_get_functiondef(to_regprocedure('fail_billing_receipt_delivery(text,uuid,integer,text,jsonb,boolean,integer,integer)')))) is distinct from 'ff6100c0255bca2907b3fff28abfaf0f' then raise exception 'baseline_changed:fail_billing_receipt_delivery';end if;
if (select md5(pg_get_functiondef(to_regprocedure('complete_billing_receipt_delivery(text,uuid,text,integer,jsonb)')))) is distinct from '299bd44193d0cd6ff9e920ffcff8ac23' then raise exception 'baseline_changed:complete_billing_receipt_delivery';end if;
if (select md5(pg_get_functiondef(to_regprocedure('fail_billing_receipt_delivery_v2(text,uuid,integer,text,jsonb,boolean,integer,integer,boolean)')))) is distinct from 'c75970e229c7fa98fb7954e64f36ce33' then raise exception 'baseline_changed:fail_billing_receipt_delivery_v2';end if;
if (select md5(pg_get_functiondef(to_regprocedure('complete_account_deletion_email_delivery(text,uuid,text,integer,jsonb)')))) is distinct from 'f7facf8d33048e281b91d7a2948ed775' then raise exception 'baseline_changed:complete_account_deletion_email_delivery';end if;
if (select md5(pg_get_functiondef(to_regprocedure('fail_account_deletion_email_delivery(text,uuid,integer,text,jsonb,boolean,integer,integer)')))) is distinct from '403082dc04048b64f2b699671184115a' then raise exception 'baseline_changed:fail_account_deletion_email_delivery';end if;
if (select md5(pg_get_functiondef(to_regprocedure('complete_subtitle_email_delivery(uuid,uuid,integer,text,jsonb)')))) is distinct from '9cadb07a17f76eda58605816079cac49' then raise exception 'baseline_changed:complete_subtitle_email_delivery';end if;
if (select md5(pg_get_functiondef(to_regprocedure('fail_subtitle_email_delivery(uuid,uuid,boolean,integer,jsonb,text,integer,integer,integer,integer,boolean)')))) is distinct from '1f86aa9be983a9ea3efc34494ac76465' then raise exception 'baseline_changed:fail_subtitle_email_delivery';end if;
if (select md5(pg_get_functiondef(to_regprocedure('complete_support_email_delivery(text,uuid,text,integer,jsonb)')))) is distinct from '2521804eb264fbf15772b7b71160f48e' then raise exception 'baseline_changed:complete_support_email_delivery';end if;
if (select md5(pg_get_functiondef(to_regprocedure('fail_support_email_delivery(text,uuid,integer,text,jsonb,boolean,integer,integer)')))) is distinct from 'b3696bc718e53f7c0d4983d81a82edd2' then raise exception 'baseline_changed:fail_support_email_delivery';end if;
if (select md5(pg_get_functiondef(to_regprocedure('claim_branded_email_deliveries(integer,integer,integer)')))) is distinct from '4034307247cf16cf324874798129817d' then raise exception 'baseline_changed:claim_branded_email_deliveries';end if;
if (select md5(pg_get_functiondef(to_regprocedure('complete_branded_email_delivery(uuid,text,uuid,text,integer,jsonb)')))) is distinct from 'b097d255305d3597b1692887ea069433' then raise exception 'baseline_changed:complete_branded_email_delivery';end if;
if (select md5(pg_get_functiondef(to_regprocedure('fail_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer)')))) is distinct from '5385c4170441ebcb45256df78f63b933' then raise exception 'baseline_changed:fail_branded_email_delivery';end if;
if (select md5(pg_get_functiondef(to_regprocedure('fail_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer,boolean)')))) is distinct from '9905504aea1766e2239215e61fceba07' then raise exception 'baseline_changed:fail_branded_email_delivery';end if;
if (select md5(pg_get_functiondef(to_regprocedure('defer_branded_email_delivery(uuid,text,uuid,integer)')))) is distinct from 'dba91e1271c917d6bc7c3fc1467f46d0' then raise exception 'baseline_changed:defer_branded_email_delivery';end if;
if (select md5(pg_get_functiondef(to_regprocedure('authorize_branded_email_delivery_pre_behavioral(uuid,text,uuid)')))) is distinct from '08e0bd94cef1dc3f6affe28b3c4f478e' then raise exception 'baseline_changed:authorize_branded_email_delivery_pre_behavioral';end if;
end $guard$;
alter table public.cloud_branded_email_outbox add column postal_delivery_id text check(postal_delivery_id is null or postal_delivery_id ~ '^postal_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$');
alter table public.cloud_branded_email_outbox add constraint branded_email_outbox_exclusive_receipt check(postal_delivery_id is null or resend_email_id is null);
alter table public.cloud_support_email_outbox add column postal_delivery_id text check(postal_delivery_id is null or postal_delivery_id ~ '^postal_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$');
alter table public.cloud_support_email_outbox add column postal_response jsonb;
alter table public.cloud_support_email_outbox add constraint support_email_outbox_exclusive_receipt check(postal_delivery_id is null or resend_email_id is null);
alter table public.cloud_account_deletion_email_outbox add column postal_delivery_id text check(postal_delivery_id is null or postal_delivery_id ~ '^postal_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$');
alter table public.cloud_account_deletion_email_outbox add column postal_response jsonb;
alter table public.cloud_account_deletion_email_outbox add constraint account_deletion_email_outbox_exclusive_receipt check(postal_delivery_id is null or resend_email_id is null);
alter table public.cloud_billing_receipt_outbox add column postal_delivery_id text check(postal_delivery_id is null or postal_delivery_id ~ '^postal_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$');
alter table public.cloud_billing_receipt_outbox add column postal_response jsonb;
alter table public.cloud_billing_receipt_outbox add constraint billing_receipt_outbox_exclusive_receipt check(postal_delivery_id is null or resend_email_id is null);
alter table public.cloud_import_notifications add column postal_delivery_id text check(postal_delivery_id is null or postal_delivery_id ~ '^postal_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$');
alter table public.cloud_import_notifications add column postal_response jsonb;
alter table public.cloud_import_notifications add constraint import_notifications_exclusive_receipt check(postal_delivery_id is null or resend_email_id is null);
alter table public.catalog_subtitle_email_deliveries add column postal_delivery_id text check(postal_delivery_id is null or postal_delivery_id ~ '^postal_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$');
alter table public.catalog_subtitle_email_deliveries add column postal_response jsonb;
alter table public.catalog_subtitle_email_deliveries add constraint catalog_subtitle_email_deliveries_exclusive_receipt check(postal_delivery_id is null or resend_email_id is null);
create schema norva_postal_full;
revoke all on schema norva_postal_full from public,anon,authenticated,service_role;
create role norva_postal_full_worker nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
grant usage on schema norva_postal_full to norva_postal_full_worker;
create table norva_postal_full.policy(singleton boolean primary key default true check(singleton),enabled boolean not null default false,
 test_only boolean not null default true, test_recipients text[] not null default array['buildtrack.admin@gmail.com','projethorizon2030@gmail.com'],
 ops_recipients text[] not null default '{}');
insert into norva_postal_full.policy default values;
create table norva_postal_full.receipts(
 id text primary key check(id ~ '^postal_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
 delivery_key text not null check(length(delivery_key) between 1 and 256),recipient text,
 auth boolean not null,flow text not null,state text not null default 'pending' check(state in ('pending','sent','failed','uncertain','canceled')),
 postal_message_id bigint unique check(postal_message_id>0),secure boolean not null default false,
 created_at timestamptz not null default clock_timestamp(),sent_at timestamptz,
 check((state='sent')=(sent_at is not null)),check(state<>'sent' or (secure and postal_message_id is not null)));
create index on norva_postal_full.receipts(delivery_key);
create table norva_postal_full.events(event_id uuid primary key,job_id text not null references norva_postal_full.receipts,
 body_sha256 text not null check(body_sha256 ~ '^[a-f0-9]{64}$'),event text not null,event_at timestamptz not null,received_at timestamptz default clock_timestamp());
alter table norva_postal_full.policy enable row level security;
alter table norva_postal_full.receipts enable row level security;
alter table norva_postal_full.events enable row level security;
revoke all on all tables in schema norva_postal_full from public,anon,authenticated,service_role,norva_postal_full_worker;

-- The generator inserts the live, reviewed lifecycle predicate here.
create function norva_postal_full.branded_allowed(p_id uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
declare o record;v_allowed boolean:=true;
begin select * into o from public.cloud_branded_email_outbox where id=p_id;
if not found then return false;end if;
  -- Existing security outbox rows have no lifecycle marker and remain eligible.
  if o.marker_kind is null then
    if exists (
      select 1 from public.cloud_trial_reminder_deliveries d
      join public.cloud_entitlement_projection e on e.user_id = d.user_id
      where d.email_delivery_id = o.id and d.delivered_at is null
        and e.status = 'trialing' and e.trial_ends_at = d.trial_ends_at
        and not exists (select 1 from public.admin_internal_accounts a where a.user_id = d.user_id)
    ) or not exists (
      select 1 from public.cloud_trial_reminder_deliveries d where d.email_delivery_id = o.id
    ) then
      v_allowed := true;
    else
      v_allowed := false;
    end if;
  elsif exists (select 1 from public.admin_internal_accounts a where a.user_id = o.user_id) then
    v_allowed := false;
  elsif o.is_marketing and not public.norva_marketing_email_allowed(o.user_id) then
    v_allowed := false;
  elsif o.marker_kind = 'welcome' then
    v_allowed := exists (
      select 1 where public.norva_signup_welcome_eligible(o.user_id)
    );
  elsif o.marker_kind = 'dunning' then
    v_allowed := exists (
      select 1 from public.cloud_entitlement_projection e
      where e.user_id = o.user_id and e.provider = 'revolut'
        and e.status = 'past_due' and coalesce(e.dunning_stage, 0) < o.marker_stage
    );
  elsif o.marker_kind = 'winback' then
    v_allowed := exists (
      select 1 from public.cloud_entitlement_projection e
      where e.user_id = o.user_id and e.status in ('expired', 'canceled', 'cancelled')
        and e.winback_email_at is null
    );
  elsif o.marker_kind = 'abandoned' then
    v_allowed := exists (
      select 1 from public.cloud_revolut_orders r
      left join public.cloud_entitlement_projection e on e.user_id = r.user_id
      where r.order_id = o.marker_reference and r.user_id = o.user_id
        and r.reminder_sent_at is null and r.finalized_at is null and r.superseded_at is null
        and upper(coalesce(r.state, 'PENDING')) in ('PENDING', 'PROCESSING')
        and not (
          coalesce(e.status, '') in ('trialing', 'active', 'cancelled_at_period_end')
          and (e.status <> 'trialing' or coalesce(e.trial_ends_at, '-infinity'::timestamptz) > clock_timestamp())
          and (e.status not in ('active', 'cancelled_at_period_end')
               or e.current_period_end is null or e.current_period_end > clock_timestamp())
        )
    );
  end if;

return v_allowed;end $$;

create function norva_postal_full.eligibility(p_key text,p_recipient text,p_auth boolean,p_flow text) returns text
language plpgsql security definer set search_path=pg_catalog as $$
declare o record;b record;j record;s record;v_now timestamptz:=clock_timestamp();
begin
 if exists(select 1 from public.cloud_email_suppressions where email=p_recipient and active) then return 'cancel';end if;
 if p_auth and p_key like 'norva-auth-%' then return 'allow';end if;
 if p_auth and p_key like 'norva-mailbox-proof-%' then return 'allow';end if;
 if p_key like 'norva-postal-proof-%' and exists(select 1 from norva_postal_full.policy where test_only and p_recipient=any(test_recipients)) then return 'allow';end if;
 -- Operational recipients come only from NORVA_OPS_EMAIL, never inferred from
 -- Auth or admin accounts. An unset configuration must not send to an admin.
 if p_key like 'norva-ops-%' and exists(select 1 from norva_postal_full.policy where p_recipient=any(ops_recipients))
   then return 'allow';end if;
 select * into o from public.cloud_branded_email_outbox where delivery_key=p_key;
 if found then
  if o.mail_provider<>'postal' or o.state not in ('pending','processing') or o.recipient_email is distinct from p_recipient
    or exists(select 1 from norva_postal_queue.bindings where outbox_id=o.id) then return 'cancel';end if;
  if o.is_marketing and not public.norva_marketing_email_allowed(o.user_id) then return 'cancel';end if;
  select * into b from public.behavioral_lifecycle_outbox where email_outbox_id=o.id;
  if found then
   if b.status<>'email_queued' or not public.norva_behavioral_delivery_eligible(b.id,v_now) then return 'cancel';end if;
   select * into j from public.behavioral_lifecycle_journeys where journey_key=b.journey_key;
   select * into s from public.behavioral_lifecycle_user_state where user_id=b.user_id;
   if greatest(public.norva_behavioral_next_allowed_at(v_now,s.timezone,j.quiet_start_hour,j.quiet_end_hour),
      public.norva_behavioral_frequency_allowed_at(b.user_id,'email',b.journey_key,v_now,b.id))>v_now+interval '1 second' then return 'defer';end if;
  elsif not norva_postal_full.branded_allowed(o.id) then return 'cancel';end if;
  return 'allow';
 end if;
 if exists(select 1 from public.cloud_support_email_outbox where delivery_key=p_key and recipient_email=p_recipient and state in ('pending','processing')) then return 'allow';end if;
 if exists(select 1 from public.cloud_account_deletion_email_outbox where delivery_key=p_key and recipient_email=p_recipient and state in ('pending','processing') and deletion_confirmed_at is not null) then return 'allow';end if;
 if exists(select 1 from public.cloud_billing_receipt_outbox where delivery_key=p_key and recipient_email=p_recipient and sent_at is null and exhausted_at is null) then return 'allow';end if;
 if exists(select 1 from public.catalog_subtitle_email_deliveries where delivery_key=p_key and recipient_email=p_recipient and status in ('pending','processing')) then return 'allow';end if;
 if exists(select 1 from public.cloud_import_notifications where 'norva-import-'||delivery_key::text=p_key and recipient_email=p_recipient and status in ('pending','processing')) then return 'allow';end if;
 if exists(select 1 from public.cloud_provider_access_notifications n join auth.users u on u.id=n.user_id where n.delivery_key=p_key and lower(u.email)=p_recipient
   and n.channel='email' and n.state in ('pending','processing') and public.norva_provider_access_notification_business_eligible(n.user_id,n.source_id,n.access_cycle_id,n.event_kind)
   and public.norva_provider_access_rollout_eligible_internal(n.user_id)) then return 'allow';end if;
 return 'cancel';
end $$;
create function norva_postal_full.preflight(p_key text,p_recipient text,p_auth boolean,p_flow text) returns boolean
language sql security definer set search_path=pg_catalog as $$
 select exists(select 1 from norva_postal_full.policy where enabled and (not test_only or p_recipient=any(test_recipients)))
 and norva_postal_full.eligibility(p_key,p_recipient,p_auth,p_flow)<>'cancel';
$$;
create function norva_postal_full.authorize(p_id text,p_key text,p_recipient text,p_auth boolean,p_flow text) returns text
language plpgsql security definer set search_path=pg_catalog as $$
declare r norva_postal_full.receipts%rowtype;v text;
begin
 if not exists(select 1 from norva_postal_full.policy where enabled and (not test_only or p_recipient=any(test_recipients))) then return 'defer';end if;
 if p_id !~ '^postal_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or p_recipient is null or length(p_recipient)>320 or p_key is null or p_flow is null then raise exception 'invalid_binding';end if;
 insert into norva_postal_full.receipts(id,delivery_key,recipient,auth,flow) values(p_id,p_key,p_recipient,p_auth,p_flow) on conflict(id) do nothing;
 select * into r from norva_postal_full.receipts where id=p_id for update;
 if r.delivery_key<>p_key or r.recipient is distinct from p_recipient or r.auth<>p_auth or r.flow<>p_flow then raise exception 'binding_conflict';end if;
 if r.state<>'pending' then return 'cancel';end if;
 v:=norva_postal_full.eligibility(p_key,p_recipient,p_auth,p_flow);
 return v;
end $$;
create function norva_postal_full.receipt(p_id text,p_state text,p_message_id bigint,p_secure boolean) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
declare r norva_postal_full.receipts%rowtype;
begin
 if p_state not in ('sent','failed','uncertain','canceled') or (p_state='sent' and (p_secure is distinct from true or p_message_id is null or p_message_id<1)) then raise exception 'invalid_receipt';end if;
 select * into r from norva_postal_full.receipts where id=p_id for update;
 if not found then
  -- A job can expire while the SQL authorization was unavailable, without I/O.
  return p_state='canceled' and p_message_id is null;
 end if;
 if r.state<>'pending' then return r.state=p_state and r.postal_message_id is not distinct from p_message_id and r.secure=p_secure;end if;
 update norva_postal_full.receipts set state=p_state,postal_message_id=p_message_id,secure=coalesce(p_secure,false),
  sent_at=case when p_state='sent' then clock_timestamp() end where id=p_id;
 return true;
end $$;
create function norva_postal_full.receipt_is_sent(p_id text,p_key text) returns boolean
language sql security definer set search_path=pg_catalog as $$
 select exists(select 1 from norva_postal_full.receipts where id=p_id and delivery_key=p_key and state='sent' and secure and postal_message_id is not null);
$$;
create function norva_postal_full.feedback(p_id text,p_event_id uuid,p_sha text,p_message_id bigint,p_event text,p_at timestamptz) returns text
language plpgsql security definer set search_path=pg_catalog as $$
declare r norva_postal_full.receipts%rowtype;old norva_postal_full.events%rowtype;
begin
 if p_event not in ('MessageSent','MessageDelayed','MessageDeliveryFailed','MessageHeld','MessageBounced') or p_sha !~ '^[a-f0-9]{64}$'
  or p_at is null or p_at>clock_timestamp()+interval '5 minutes' or p_at<clock_timestamp()-interval '48 hours' then raise exception 'invalid_verified_event';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_event_id::text,43));
 select * into old from norva_postal_full.events where event_id=p_event_id;
 if found then return case when old.body_sha256=p_sha and old.job_id=p_id then 'duplicate' else 'conflict' end;end if;
 select * into r from norva_postal_full.receipts where id=p_id for update;
 if not found or (r.postal_message_id is not null and r.postal_message_id<>p_message_id) then return 'unbound';end if;
 -- A held callback may precede the terminal SMTP receipt. Bind its immutable id.
 if r.postal_message_id is null then update norva_postal_full.receipts set postal_message_id=p_message_id where id=p_id;end if;
 insert into norva_postal_full.events(event_id,job_id,body_sha256,event,event_at) values(p_event_id,p_id,p_sha,p_event,p_at);
 if p_event='MessageBounced' and r.recipient is not null then
  insert into public.cloud_email_suppressions(email,reason,source_event_id,source_email_id,active,first_seen_at,last_seen_at,postal_review_required_at)
  values(r.recipient,'postal_bounce_pending_review','postal:'||p_event_id,'postal:'||p_message_id,true,p_at,p_at,p_at)
  on conflict(email) do update set active=true,resolved_at=null,
    reason=case when public.cloud_email_suppressions.complaint_seen_at is not null then public.cloud_email_suppressions.reason else excluded.reason end,
    last_seen_at=greatest(public.cloud_email_suppressions.last_seen_at,p_at),postal_review_required_at=greatest(public.cloud_email_suppressions.postal_review_required_at,p_at),updated_at=clock_timestamp();
 end if;
 return 'applied';
end $$;
-- Postal has no native complaint event. Operator-verified ARF/JMRP evidence is
-- accepted only by the owner, never by service_role or the mail worker.
create function norva_postal_full.record_verified_complaint(p_id text,p_evidence_sha256 text) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
declare r norva_postal_full.receipts%rowtype;v_now timestamptz:=clock_timestamp();
begin
 if p_evidence_sha256 !~ '^[a-f0-9]{64}$' or p_evidence_sha256 is null then raise exception 'evidence_required';end if;
 select * into r from norva_postal_full.receipts where id=p_id and state='sent' for update;
 if not found or r.recipient is null then return false;end if;
 if exists(select 1 from norva_postal_full.events where job_id=p_id and body_sha256=p_evidence_sha256 and event='OperatorVerifiedComplaint') then return true;end if;
 insert into norva_postal_full.events(event_id,job_id,body_sha256,event,event_at) values(gen_random_uuid(),p_id,p_evidence_sha256,'OperatorVerifiedComplaint',v_now);
 insert into public.cloud_email_suppressions(email,reason,source_event_id,source_email_id,active,first_seen_at,last_seen_at,complaint_seen_at,postal_review_required_at)
 values(r.recipient,'postal_verified_complaint','postal-evidence:'||p_evidence_sha256,p_id,true,v_now,v_now,v_now,v_now)
 on conflict(email) do update set active=true,resolved_at=null,reason='postal_verified_complaint',complaint_seen_at=coalesce(public.cloud_email_suppressions.complaint_seen_at,v_now),
  last_seen_at=greatest(public.cloud_email_suppressions.last_seen_at,v_now),postal_review_required_at=greatest(public.cloud_email_suppressions.postal_review_required_at,v_now),updated_at=v_now;
 return true;
end $$;
revoke all on all functions in schema norva_postal_full from public,anon,authenticated,service_role,norva_postal_full_worker;
grant execute on function norva_postal_full.preflight(text,text,boolean,text),norva_postal_full.authorize(text,text,text,boolean,text),
 norva_postal_full.receipt(text,text,bigint,boolean),norva_postal_full.feedback(text,uuid,text,bigint,text,timestamptz) to norva_postal_full_worker;

CREATE OR REPLACE FUNCTION public.complete_postal_import_notification_delivery(p_delivery_key uuid, p_notification_ids uuid[], p_lease_token uuid, p_recipient_email text, p_http_status integer, p_postal_delivery_id text, p_response jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_expected integer := coalesce(cardinality(p_notification_ids), 0);
  v_matched integer;
  v_now timestamptz := clock_timestamp();
begin
  if not norva_postal_full.receipt_is_sent(p_postal_delivery_id,('norva-import-'||p_delivery_key::text)) then return false;end if;
  if v_expected < 1
     or p_http_status not between 200 and 299
     or nullif(btrim(p_postal_delivery_id), '') is null
     or nullif(lower(btrim(p_recipient_email)), '') is null then
    return false;
  end if;

  perform n.id
  from public.cloud_import_notifications n
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token
    and n.recipient_email = lower(btrim(p_recipient_email))
    and n.request_from is not null
    and n.request_reply_to is not null
    and n.request_subject is not null
    and n.request_html is not null
    and n.request_text is not null
    and n.request_tags is not null
    and n.prepared_at is not null
  for update;
  get diagnostics v_matched = row_count;

  if v_matched <> v_expected then return false; end if;

  update public.cloud_import_notifications n
  set status = 'sent',
      sent_at = v_now,
      payload = '{}'::jsonb,
      recipient_email = null,
      request_from = null,
      request_reply_to = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      request_tags = null,
      last_http_status = p_http_status,
      last_error = null,
      postal_delivery_id = btrim(p_postal_delivery_id),
      postal_response = '{}'::jsonb,
      lease_token = null,
      lease_expires_at = null,
      next_attempt_at = v_now,
      dead_lettered_at = null,
      updated_at = v_now
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token
    and n.recipient_email = lower(btrim(p_recipient_email));

  return true;
end;
$function$
;
revoke all on function public.complete_postal_import_notification_delivery(uuid,uuid[],uuid,text,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.complete_postal_import_notification_delivery(uuid,uuid[],uuid,text,integer,text,jsonb) to service_role;
CREATE OR REPLACE FUNCTION public.fail_postal_import_notification_delivery(p_delivery_key uuid, p_notification_ids uuid[], p_lease_token uuid, p_retryable boolean, p_http_status integer DEFAULT NULL::integer, p_response jsonb DEFAULT NULL::jsonb, p_error text DEFAULT NULL::text, p_max_attempts integer DEFAULT 8, p_base_backoff_seconds integer DEFAULT 120, p_max_backoff_seconds integer DEFAULT 21600)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_expected integer := coalesce(cardinality(p_notification_ids), 0);
  v_matched integer;
  v_attempt integer;
  v_delay integer;
  v_now timestamptz := clock_timestamp();
  v_terminal boolean;
begin
  if v_expected < 1 or p_max_attempts < 1 or p_base_backoff_seconds < 1
     or p_max_backoff_seconds < p_base_backoff_seconds then
    return 'stale_or_invalid';
  end if;

  perform n.id
  from public.cloud_import_notifications n
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token
  for update;
  get diagnostics v_matched = row_count;

  if v_matched <> v_expected then return 'stale_or_invalid'; end if;

  select max(n.attempt_count) into v_attempt
  from public.cloud_import_notifications n
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token;

  v_terminal := not coalesce(p_retryable, false) or v_attempt >= p_max_attempts;
  v_delay := least(
    p_max_backoff_seconds,
    floor(p_base_backoff_seconds * power(2::numeric, greatest(v_attempt - 1, 0)))::integer
      + floor(random() * greatest(p_base_backoff_seconds, 1))::integer
  );

  update public.cloud_import_notifications n
  set status = case when v_terminal then 'dead_letter' else 'pending' end,
      next_attempt_at = case when v_terminal then v_now else v_now + make_interval(secs => v_delay) end,
      last_http_status = p_http_status,
      last_error = left(coalesce(nullif(p_error, ''), 'import notification delivery failed'), 2000),
      postal_response = case when v_terminal then '{}'::jsonb else coalesce(p_response, '{}'::jsonb) end,
      payload = case when v_terminal then '{}'::jsonb else n.payload end,
      recipient_email = case when v_terminal then null else n.recipient_email end,
      request_from = case when v_terminal then null else n.request_from end,
      request_reply_to = case when v_terminal then null else n.request_reply_to end,
      request_subject = case when v_terminal then null else n.request_subject end,
      request_html = case when v_terminal then null else n.request_html end,
      request_text = case when v_terminal then null else n.request_text end,
      request_tags = case when v_terminal then null else n.request_tags end,
      lease_token = null,
      lease_expires_at = null,
      dead_lettered_at = case when v_terminal then v_now else null end,
      updated_at = v_now
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token;

  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end;
$function$
;
revoke all on function public.fail_postal_import_notification_delivery(uuid,uuid[],uuid,boolean,integer,jsonb,text,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.fail_postal_import_notification_delivery(uuid,uuid[],uuid,boolean,integer,jsonb,text,integer,integer,integer) to service_role;
CREATE OR REPLACE FUNCTION public.fail_postal_billing_receipt_delivery(p_delivery_key text, p_lease_token uuid, p_http_status integer, p_error text, p_response jsonb DEFAULT '{}'::jsonb, p_retryable boolean DEFAULT true, p_retry_after_seconds integer DEFAULT NULL::integer, p_max_attempts integer DEFAULT 12)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt integer;
  v_terminal boolean;
  v_delay_seconds integer;
  v_changed integer;
begin
  select o.attempt_count into v_attempt
  from public.cloud_billing_receipt_outbox o
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null
  for update;

  if not found then return 'lease_lost'; end if;

  v_terminal := not coalesce(p_retryable, false)
    or v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30));
  v_delay_seconds := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );

  update public.cloud_billing_receipt_outbox o
  set postal_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = left(coalesce(nullif(p_error, ''), 'delivery_failed'), 1000),
      exhausted_at = case when v_terminal then v_now else null end,
      next_attempt_at = case when v_terminal then o.next_attempt_at
                             else v_now + make_interval(secs => v_delay_seconds) end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null;
  get diagnostics v_changed = row_count;

  if v_changed <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$
;
revoke all on function public.fail_postal_billing_receipt_delivery(text,uuid,integer,text,jsonb,boolean,integer,integer) from public,anon,authenticated;
grant execute on function public.fail_postal_billing_receipt_delivery(text,uuid,integer,text,jsonb,boolean,integer,integer) to service_role;
CREATE OR REPLACE FUNCTION public.complete_postal_billing_receipt_delivery(p_delivery_key text, p_lease_token uuid, p_postal_delivery_id text, p_http_status integer, p_response jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_changed integer;
begin
  if not norva_postal_full.receipt_is_sent(p_postal_delivery_id,p_delivery_key::text) then return false;end if;
  if p_http_status not between 200 and 299
     or nullif(btrim(p_postal_delivery_id), '') is null then
    raise exception 'successful Postal status and email id are required';
  end if;

  update public.cloud_billing_receipt_outbox o
  set postal_delivery_id = btrim(p_postal_delivery_id),
      postal_response = public.norva_safe_billing_receipt_provider_response(
        coalesce(p_response, '{}'::jsonb)
      ),
      last_http_status = p_http_status,
      last_error = null,
      sent_at = clock_timestamp(),
      exhausted_at = null,
      quarantined_at = null,
      delivery_uncertain = false,
      lease_token = null,
      lease_expires_at = null,
      recipient_email = null,
      first_name = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$
;
revoke all on function public.complete_postal_billing_receipt_delivery(text,uuid,text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.complete_postal_billing_receipt_delivery(text,uuid,text,integer,jsonb) to service_role;
CREATE OR REPLACE FUNCTION public.fail_postal_billing_receipt_delivery_v2(p_delivery_key text, p_lease_token uuid, p_http_status integer, p_error text, p_response jsonb DEFAULT '{}'::jsonb, p_retryable boolean DEFAULT true, p_retry_after_seconds integer DEFAULT NULL::integer, p_max_attempts integer DEFAULT 12, p_ambiguous boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt integer;
  v_was_uncertain boolean;
  v_terminal boolean;
  v_delay_seconds integer;
  v_changed integer;
begin
  select o.attempt_count, o.delivery_uncertain
    into v_attempt, v_was_uncertain
  from public.cloud_billing_receipt_outbox o
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null
  for update;
  if not found then return 'lease_lost'; end if;

  v_was_uncertain := coalesce(v_was_uncertain, false) or coalesce(p_ambiguous, false);
  v_terminal := not coalesce(p_retryable, false)
    or (not v_was_uncertain
      and v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30)));
  v_delay_seconds := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );

  update public.cloud_billing_receipt_outbox o
  set postal_response = public.norva_safe_billing_receipt_provider_response(
        coalesce(p_response, '{}'::jsonb)
      ),
      last_http_status = p_http_status,
      last_error = public.norva_redact_billing_receipt_text(
        coalesce(nullif(p_error, ''), 'delivery_failed')
      ),
      delivery_uncertain = v_was_uncertain,
      exhausted_at = case when v_terminal then v_now else null end,
      next_attempt_at = case when v_terminal then o.next_attempt_at
                             else v_now + make_interval(secs => v_delay_seconds) end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$
;
revoke all on function public.fail_postal_billing_receipt_delivery_v2(text,uuid,integer,text,jsonb,boolean,integer,integer,boolean) from public,anon,authenticated;
grant execute on function public.fail_postal_billing_receipt_delivery_v2(text,uuid,integer,text,jsonb,boolean,integer,integer,boolean) to service_role;
CREATE OR REPLACE FUNCTION public.complete_postal_account_deletion_email_delivery(p_delivery_key text, p_lease_token uuid, p_postal_delivery_id text, p_http_status integer, p_response jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_changed integer;
begin
  if not norva_postal_full.receipt_is_sent(p_postal_delivery_id,p_delivery_key::text) then return false;end if;
  if p_http_status not between 200 and 299
     or nullif(btrim(p_postal_delivery_id), '') is null then
    raise exception 'successful Postal status and email id are required';
  end if;

  update public.cloud_account_deletion_email_outbox o
  set state = 'sent',
      postal_delivery_id = btrim(p_postal_delivery_id),
      postal_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = null,
      sent_at = clock_timestamp(),
      lease_token = null,
      lease_expires_at = null,
      -- Immediate data minimization after provider acceptance.
      recipient_email = null,
      request_html = null,
      request_text = null,
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$
;
revoke all on function public.complete_postal_account_deletion_email_delivery(text,uuid,text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.complete_postal_account_deletion_email_delivery(text,uuid,text,integer,jsonb) to service_role;
CREATE OR REPLACE FUNCTION public.fail_postal_account_deletion_email_delivery(p_delivery_key text, p_lease_token uuid, p_http_status integer, p_error text, p_response jsonb DEFAULT '{}'::jsonb, p_retryable boolean DEFAULT true, p_retry_after_seconds integer DEFAULT NULL::integer, p_max_attempts integer DEFAULT 12)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt integer;
  v_transport_started_at timestamptz;
  v_terminal boolean;
  v_idempotency_window_terminal boolean := false;
  v_delay_seconds integer;
  v_changed integer;
begin
  select o.attempt_count, o.transport_started_at
  into v_attempt, v_transport_started_at
  from public.cloud_account_deletion_email_outbox o
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token
  for update;
  if not found then return 'lease_lost'; end if;

  v_delay_seconds := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );
  v_idempotency_window_terminal := v_transport_started_at is not null
    and v_now + make_interval(secs => v_delay_seconds)
      >= v_transport_started_at + interval '23 hours';
  v_terminal := not coalesce(p_retryable, false)
    or v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30))
    or v_idempotency_window_terminal;

  update public.cloud_account_deletion_email_outbox o
  set state = case when v_terminal then 'dead_letter' else 'ready' end,
      postal_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = case
        when v_idempotency_window_terminal then 'idempotency_window_expired_manual_review'
        else left(coalesce(nullif(p_error, ''), 'delivery_failed'), 1000)
      end,
      exhausted_at = case when v_terminal then v_now else null end,
      next_attempt_at = case when v_terminal then o.next_attempt_at
                             else v_now + make_interval(secs => v_delay_seconds) end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$
;
revoke all on function public.fail_postal_account_deletion_email_delivery(text,uuid,integer,text,jsonb,boolean,integer,integer) from public,anon,authenticated;
grant execute on function public.fail_postal_account_deletion_email_delivery(text,uuid,integer,text,jsonb,boolean,integer,integer) to service_role;
CREATE OR REPLACE FUNCTION public.complete_postal_subtitle_email_delivery(p_delivery_id uuid, p_lease_token uuid, p_http_status integer, p_postal_delivery_id text, p_response jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_notification_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if not norva_postal_full.receipt_is_sent(p_postal_delivery_id,(select delivery_key from public.catalog_subtitle_email_deliveries where id=p_delivery_id)) then return false;end if;
  if p_http_status not between 200 and 299
     or nullif(btrim(p_postal_delivery_id), '') is null then
    return false;
  end if;

  update public.catalog_subtitle_email_deliveries d
  set status = 'sent', sent_at = v_now,
      last_http_status = p_http_status,
      postal_delivery_id = btrim(p_postal_delivery_id),
      postal_response = public.norva_safe_subtitle_email_provider_response(
        coalesce(p_response, '{}'::jsonb)
      ),
      recipient_email = null,
      request_from = null,
      request_reply_to = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      request_tags = null,
      title_label = null,
      source_id = null,
      series_id = null,
      last_error = null,
      dead_lettered_at = null,
      quarantined_at = null,
      delivery_uncertain = false,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where d.id = p_delivery_id
    and d.status = 'processing'
    and d.lease_token = p_lease_token
    and d.lease_expires_at > v_now
    and d.recipient_email is not null
    and d.request_from is not null
    and d.request_reply_to is not null
    and d.request_subject is not null
    and d.request_html is not null
    and d.request_text is not null
    and d.request_tags is not null
  returning d.notification_id into v_notification_id;

  if v_notification_id is null then return false; end if;

  update public.catalog_generated_subtitle_notifications n
  set status = 'sent', sent_at = v_now,
      email = '', title_label = null, source_id = null, series_id = null
  where n.id = v_notification_id and n.status = 'queued';
  return true;
end;
$function$
;
revoke all on function public.complete_postal_subtitle_email_delivery(uuid,uuid,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.complete_postal_subtitle_email_delivery(uuid,uuid,integer,text,jsonb) to service_role;
CREATE OR REPLACE FUNCTION public.fail_postal_subtitle_email_delivery(p_delivery_id uuid, p_lease_token uuid, p_retryable boolean, p_http_status integer DEFAULT NULL::integer, p_response jsonb DEFAULT NULL::jsonb, p_error text DEFAULT NULL::text, p_retry_after_seconds integer DEFAULT NULL::integer, p_max_attempts integer DEFAULT 12, p_base_backoff_seconds integer DEFAULT 60, p_max_backoff_seconds integer DEFAULT 21600, p_ambiguous boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_notification_id uuid;
  v_attempt integer;
  v_was_uncertain boolean;
  v_terminal boolean;
  v_delay integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_max_attempts < 1 or p_max_attempts > 50
     or p_base_backoff_seconds < 1 or p_base_backoff_seconds > 3600
     or p_max_backoff_seconds < p_base_backoff_seconds or p_max_backoff_seconds > 86400 then
    return 'stale_or_invalid';
  end if;

  select d.notification_id, d.attempt_count, d.delivery_uncertain
  into v_notification_id, v_attempt, v_was_uncertain
  from public.catalog_subtitle_email_deliveries d
  where d.id = p_delivery_id
    and d.status = 'processing'
    and d.lease_token = p_lease_token
    and d.lease_expires_at > v_now
  for update;

  if v_notification_id is null then return 'stale_or_invalid'; end if;

  v_was_uncertain := coalesce(v_was_uncertain, false) or coalesce(p_ambiguous, false);
  v_terminal := not coalesce(p_retryable, false)
    or (not v_was_uncertain and v_attempt >= p_max_attempts);
  v_delay := least(
    p_max_backoff_seconds::numeric,
    greatest(
      coalesce(greatest(p_retry_after_seconds, 0), 0)::numeric,
      floor(p_base_backoff_seconds * power(2::numeric, greatest(v_attempt - 1, 0)))
        + mod(
            abs(hashtextextended(p_delivery_id::text || ':' || v_attempt::text, 0)::numeric),
            greatest(p_base_backoff_seconds, 1)
          )
    )
  )::integer;

  update public.catalog_subtitle_email_deliveries d
  set status = case when v_terminal then 'dead_letter' else 'pending' end,
      next_attempt_at = case when v_terminal then v_now else v_now + make_interval(secs => v_delay) end,
      last_http_status = p_http_status,
      postal_response = public.norva_safe_subtitle_email_provider_response(
        coalesce(p_response, '{}'::jsonb)
      ),
      last_error = public.norva_redact_subtitle_email_text(
        coalesce(nullif(p_error, ''), 'subtitle email delivery failed')
      ),
      dead_lettered_at = case when v_terminal then v_now else null end,
      delivery_uncertain = v_was_uncertain,
      recipient_email = case when v_terminal then null else d.recipient_email end,
      request_from = case when v_terminal then null else d.request_from end,
      request_reply_to = case when v_terminal then null else d.request_reply_to end,
      request_subject = case when v_terminal then null else d.request_subject end,
      request_html = case when v_terminal then null else d.request_html end,
      request_text = case when v_terminal then null else d.request_text end,
      request_tags = case when v_terminal then null else d.request_tags end,
      title_label = case when v_terminal then null else d.title_label end,
      source_id = case when v_terminal then null else d.source_id end,
      series_id = case when v_terminal then null else d.series_id end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where d.id = p_delivery_id
    and d.status = 'processing'
    and d.lease_token = p_lease_token
    and d.lease_expires_at > v_now;

  if v_terminal then
    update public.catalog_generated_subtitle_notifications n
    set status = 'failed', sent_at = coalesce(n.sent_at, v_now),
        email = '', title_label = null, source_id = null, series_id = null
    where n.id = v_notification_id and n.status = 'queued';
    return 'dead_letter';
  end if;
  return 'retry_scheduled';
end;
$function$
;
revoke all on function public.fail_postal_subtitle_email_delivery(uuid,uuid,boolean,integer,jsonb,text,integer,integer,integer,integer,boolean) from public,anon,authenticated;
grant execute on function public.fail_postal_subtitle_email_delivery(uuid,uuid,boolean,integer,jsonb,text,integer,integer,integer,integer,boolean) to service_role;
CREATE OR REPLACE FUNCTION public.complete_postal_support_email_delivery(p_delivery_key text, p_lease_token uuid, p_postal_delivery_id text, p_http_status integer, p_response jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_changed integer;
begin
  if not norva_postal_full.receipt_is_sent(p_postal_delivery_id,p_delivery_key::text) then return false;end if;
  if p_http_status not between 200 and 299
     or nullif(btrim(coalesce(p_postal_delivery_id, '')), '') is null then
    raise exception 'successful Postal status and email id are required';
  end if;
  update public.cloud_support_email_outbox o
  set state = 'sent',
      postal_delivery_id = left(btrim(p_postal_delivery_id), 200),
      postal_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = null,
      sent_at = clock_timestamp(),
      lease_token = null,
      lease_expires_at = null,
      recipient_email = null,
      request_reply_to = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      payload_scrubbed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$
;
revoke all on function public.complete_postal_support_email_delivery(text,uuid,text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.complete_postal_support_email_delivery(text,uuid,text,integer,jsonb) to service_role;
CREATE OR REPLACE FUNCTION public.fail_postal_support_email_delivery(p_delivery_key text, p_lease_token uuid, p_http_status integer, p_error text, p_response jsonb DEFAULT '{}'::jsonb, p_retryable boolean DEFAULT true, p_retry_after_seconds integer DEFAULT NULL::integer, p_max_attempts integer DEFAULT 12)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt integer;
  v_transport_started_at timestamptz;
  v_delay integer;
  v_window_terminal boolean;
  v_terminal boolean;
  v_changed integer;
begin
  select o.attempt_count, o.transport_started_at
  into v_attempt, v_transport_started_at
  from public.cloud_support_email_outbox o
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token
  for update;
  if not found then return 'lease_lost'; end if;

  v_delay := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );
  v_window_terminal := v_transport_started_at is not null
    and v_now + make_interval(secs => v_delay)
      >= v_transport_started_at + interval '23 hours';
  v_terminal := not coalesce(p_retryable, false)
    or v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30))
    or v_window_terminal;

  update public.cloud_support_email_outbox o
  set state = case when v_terminal then 'dead_letter' else 'ready' end,
      postal_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = case when v_window_terminal
        then 'idempotency_window_expired_manual_review'
        else left(coalesce(nullif(p_error, ''), 'delivery_failed'), 1000) end,
      exhausted_at = case when v_terminal then v_now else null end,
      next_attempt_at = case when v_terminal then o.next_attempt_at
        else v_now + make_interval(secs => v_delay) end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$
;
revoke all on function public.fail_postal_support_email_delivery(text,uuid,integer,text,jsonb,boolean,integer,integer) from public,anon,authenticated;
grant execute on function public.fail_postal_support_email_delivery(text,uuid,integer,text,jsonb,boolean,integer,integer) to service_role;
CREATE OR REPLACE FUNCTION public.claim_postal_branded_email_deliveries(p_batch integer DEFAULT 4, p_lease_seconds integer DEFAULT 90, p_max_attempts integer DEFAULT 12)
 RETURNS TABLE(id uuid, delivery_key text, lease_token uuid, flow text, user_id uuid, is_marketing boolean, marker_kind text, marker_reference text, marker_stage smallint, recipient_email text, request_from text, request_reply_to text, request_subject text, request_html text, request_text text, request_tags jsonb, request_headers jsonb, attempt_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  update public.cloud_branded_email_outbox o
  set state = 'dead_letter', dead_lettered_at = v_now,
      last_error = 'ambiguous_delivery_after_idempotency_window',
      lease_token = null, lease_expires_at = null, updated_at = v_now
  where o.mail_provider='postal' and not exists(select 1 from norva_postal_queue.bindings b where b.outbox_id=o.id) and o.state in ('pending', 'processing')
    and o.transport_started_at <= v_now - interval '23 hours';

  return query
  with due as (
    select o.id from public.cloud_branded_email_outbox o
    where o.mail_provider='postal' and not exists(select 1 from norva_postal_queue.bindings b where b.outbox_id=o.id) and o.next_attempt_at <= v_now
      and (o.transport_started_at is null or o.transport_started_at > v_now - interval '23 hours')
      and ((o.state = 'pending' and o.attempt_count < greatest(1, least(coalesce(p_max_attempts,12),30)))
        or (o.state = 'processing' and o.lease_expires_at <= v_now))
    order by o.next_attempt_at, o.created_at
    limit greatest(1, least(coalesce(p_batch,4),20))
    for update skip locked
  ), claimed as (
    update public.cloud_branded_email_outbox o
    set state = 'processing', lease_token = gen_random_uuid(),
        lease_expires_at = v_now + make_interval(secs => greatest(30,least(coalesce(p_lease_seconds,90),300))),
        attempt_count = o.attempt_count + 1, last_attempt_at = v_now,
        updated_at = v_now
    from due where o.id = due.id returning o.*
  )
  select c.id, c.delivery_key, c.lease_token, c.flow, c.user_id,
         c.is_marketing, c.marker_kind, c.marker_reference, c.marker_stage,
         c.recipient_email, c.request_from, c.request_reply_to, c.request_subject,
         c.request_html, c.request_text, c.request_tags, c.request_headers,
         c.attempt_count
  from claimed c order by c.next_attempt_at, c.created_at;
end
$function$
;
revoke all on function public.claim_postal_branded_email_deliveries(integer,integer,integer) from public,anon,authenticated;
grant execute on function public.claim_postal_branded_email_deliveries(integer,integer,integer) to service_role;
CREATE OR REPLACE FUNCTION public.complete_postal_branded_email_delivery(p_id uuid, p_delivery_key text, p_lease_token uuid, p_postal_delivery_id text, p_http_status integer, p_response jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  o record;
  v_now timestamptz := clock_timestamp();
begin
  if not norva_postal_full.receipt_is_sent(p_postal_delivery_id,p_delivery_key::text) then return false;end if;
  if p_http_status not between 200 and 299 or nullif(btrim(p_postal_delivery_id),'') is null then
    raise exception 'successful Postal status and email id are required';
  end if;
  select * into o from public.cloud_branded_email_outbox x
  where x.mail_provider='postal' and x.id=p_id and x.delivery_key=p_delivery_key
    and x.state='processing' and x.lease_token=p_lease_token
  for update;
  if not found then return false; end if;

  update public.cloud_branded_email_outbox x
  set state='sent', postal_delivery_id=left(btrim(p_postal_delivery_id),200),
      postal_response=coalesce(p_response,'{}'::jsonb), last_http_status=p_http_status,
      last_error=null, sent_at=v_now, dead_lettered_at=null,
      lease_token=null, lease_expires_at=null, next_attempt_at=v_now,
      recipient_email=null, request_reply_to=null, request_subject=null,
      request_html=null, request_text=null, request_headers='{}'::jsonb,
      payload_scrubbed_at=v_now, updated_at=v_now
  where x.id=p_id and x.state='processing' and x.lease_token=p_lease_token;

  if o.marker_kind = 'welcome' then
    update public.cloud_entitlement_projection e
    set welcome_email_at=coalesce(e.welcome_email_at,v_now) where e.user_id=o.user_id;
  elsif o.marker_kind = 'dunning' then
    update public.cloud_entitlement_projection e
    set dunning_stage=greatest(coalesce(e.dunning_stage,0),o.marker_stage), dunning_last_at=v_now
    where e.user_id=o.user_id and e.status='past_due';
  elsif o.marker_kind = 'winback' then
    update public.cloud_entitlement_projection e
    set winback_email_at=coalesce(e.winback_email_at,v_now) where e.user_id=o.user_id;
  elsif o.marker_kind = 'abandoned' then
    update public.cloud_revolut_orders r
    set reminder_sent_at=coalesce(r.reminder_sent_at,v_now), reminder_claimed_at=null, updated_at=v_now
    where r.order_id=o.marker_reference and r.user_id=o.user_id;
  end if;

  update public.cloud_trial_reminder_deliveries d
  set delivered_at=coalesce(d.delivered_at,v_now)
  where d.email_delivery_id=o.id;
  update public.cloud_entitlement_projection e
  set trial_reminder_email_at=coalesce(e.trial_reminder_email_at,v_now)
  where exists (
    select 1 from public.cloud_trial_reminder_deliveries d
    where d.email_delivery_id=o.id and d.user_id=e.user_id and d.trial_ends_at=e.trial_ends_at
  );
  return true;
end
$function$
;
revoke all on function public.complete_postal_branded_email_delivery(uuid,text,uuid,text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.complete_postal_branded_email_delivery(uuid,text,uuid,text,integer,jsonb) to service_role;
CREATE OR REPLACE FUNCTION public.fail_postal_branded_email_delivery(p_id uuid, p_delivery_key text, p_lease_token uuid, p_http_status integer, p_error text, p_response jsonb DEFAULT '{}'::jsonb, p_retryable boolean DEFAULT true, p_retry_after_seconds integer DEFAULT NULL::integer, p_max_attempts integer DEFAULT 12)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt integer;
  v_terminal boolean;
  v_delay_seconds integer;
  v_changed integer;
begin
  select o.attempt_count into v_attempt
  from public.cloud_branded_email_outbox o
  where o.mail_provider='postal' and o.id = p_id
    and o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token
  for update;
  if not found then return 'lease_lost'; end if;

  v_terminal := not coalesce(p_retryable, false)
    or v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30));
  v_delay_seconds := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );

  update public.cloud_branded_email_outbox o
  set state = case when v_terminal then 'dead_letter' else 'pending' end,
      postal_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = left(coalesce(nullif(p_error, ''), 'delivery_failed'), 1000),
      dead_lettered_at = case when v_terminal then v_now else null end,
      next_attempt_at = case when v_terminal then o.next_attempt_at
                             else v_now + make_interval(secs => v_delay_seconds) end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.mail_provider='postal' and o.id = p_id
    and o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$
;
revoke all on function public.fail_postal_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer) from public,anon,authenticated;
grant execute on function public.fail_postal_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer) to service_role;
CREATE OR REPLACE FUNCTION public.fail_postal_branded_email_delivery(p_id uuid, p_delivery_key text, p_lease_token uuid, p_http_status integer, p_error text, p_response jsonb DEFAULT '{}'::jsonb, p_retryable boolean DEFAULT true, p_retry_after_seconds integer DEFAULT NULL::integer, p_max_attempts integer DEFAULT 12, p_ambiguous boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  o record;
  v_delay integer;
  v_window_terminal boolean;
  v_terminal boolean;
begin
  select * into o from public.cloud_branded_email_outbox x
  where x.mail_provider='postal' and x.id=p_id and x.delivery_key=p_delivery_key
    and x.state='processing' and x.lease_token=p_lease_token for update;
  if not found then return 'lease_lost'; end if;
  v_delay := greatest(coalesce(p_retry_after_seconds,0),
    least(21600,round(30*power(2::numeric,greatest(o.attempt_count-1,0)))::integer)
      + floor(random()*16)::integer);
  v_window_terminal := coalesce(p_ambiguous,false)
    and o.transport_started_at is not null
    and v_now + make_interval(secs=>v_delay) >= o.transport_started_at + interval '23 hours';
  v_terminal := not coalesce(p_retryable,false)
    or o.attempt_count >= greatest(1,least(coalesce(p_max_attempts,12),30))
    or v_window_terminal;
  update public.cloud_branded_email_outbox x
  set state=case when v_terminal then 'dead_letter' else 'pending' end,
      postal_response=coalesce(p_response,'{}'::jsonb), last_http_status=p_http_status,
      last_error=case when v_window_terminal then 'ambiguous_delivery_after_idempotency_window'
        else left(coalesce(nullif(p_error,''),'delivery_failed'),1000) end,
      dead_lettered_at=case when v_terminal then v_now else null end,
      next_attempt_at=case when v_terminal then x.next_attempt_at else v_now+make_interval(secs=>v_delay) end,
      -- A retryable 401/403 proves the request was not accepted. Once the
      -- credential/configuration is repaired it receives a fresh idempotency
      -- window. Ambiguous transport outcomes retain the original timestamp.
      transport_started_at=case
        when coalesce(p_retryable,false) and not coalesce(p_ambiguous,false) then null
        else x.transport_started_at
      end,
      lease_token=null, lease_expires_at=null, updated_at=v_now
  where x.id=p_id and x.state='processing' and x.lease_token=p_lease_token;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$
;
revoke all on function public.fail_postal_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer,boolean) from public,anon,authenticated;
grant execute on function public.fail_postal_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer,boolean) to service_role;
CREATE OR REPLACE FUNCTION public.defer_postal_branded_email_delivery(p_id uuid, p_delivery_key text, p_lease_token uuid, p_retry_after_seconds integer DEFAULT 60)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_changed integer;
begin
  update public.cloud_branded_email_outbox o
  set state='pending', attempt_count=greatest(0,o.attempt_count-1),
      transport_started_at=case when o.attempt_count<=1 then null else o.transport_started_at end,
      next_attempt_at=clock_timestamp()+make_interval(secs=>greatest(1,least(coalesce(p_retry_after_seconds,60),21600))),
      last_http_status=429, last_error='postal_queue_rate_limited_before_send',
      postal_response='{"name":"team_rate_limited"}'::jsonb,
      lease_token=null, lease_expires_at=null, updated_at=clock_timestamp()
  where o.mail_provider='postal' and o.id=p_id and o.delivery_key=p_delivery_key
    and o.state='processing' and o.lease_token=p_lease_token;
  get diagnostics v_changed=row_count;
  return v_changed=1;
end
$function$
;
revoke all on function public.defer_postal_branded_email_delivery(uuid,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.defer_postal_branded_email_delivery(uuid,text,uuid,integer) to service_role;
notify pgrst,'reload schema';
commit;
