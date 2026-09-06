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
-- @BRANDED_PREDICATE@

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
