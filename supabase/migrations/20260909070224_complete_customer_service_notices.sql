-- Event-driven service notices. No prices, payments, entitlements or consent are changed.
set lock_timeout = '3s';
set statement_timeout = '30s';
create schema norva_notices;
revoke all on schema norva_notices from public, anon, authenticated;
grant usage on schema norva_notices to service_role, supabase_auth_admin;
alter default privileges in schema norva_notices revoke execute on functions from public;

create table norva_notices.runtime (
 singleton boolean primary key default true check (singleton),
 security_enabled boolean not null default false,
 incidents_enabled boolean not null default false,
 prices_enabled boolean not null default false,
 activated_at timestamptz
);
insert into norva_notices.runtime(singleton) values(true);
alter table norva_notices.runtime enable row level security;
grant select on norva_notices.runtime to supabase_auth_admin;
create policy auth_hook_runtime on norva_notices.runtime for select to supabase_auth_admin using (true);

-- Only GoTrue can record password results. Never store a password, token or IP.
create table norva_notices.password_attempts (
 user_id uuid primary key references auth.users(id) on delete cascade,
 window_started_at timestamptz not null,
 failures integer not null default 0 check (failures between 0 and 5),
 verified_at timestamptz,
 last_notice_at timestamptz
);
alter table norva_notices.password_attempts enable row level security;
grant select, insert, update, delete on norva_notices.password_attempts to supabase_auth_admin;
create policy auth_hook_attempts on norva_notices.password_attempts to supabase_auth_admin using (true) with check (true);

create function norva_notices.password_verification_attempt(event jsonb)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='200ms' as $fn$
declare v_user uuid; v_valid boolean; v_now timestamptz:=clock_timestamp();
begin
 if not (select security_enabled from norva_notices.runtime where singleton) then
  return '{"decision":"continue"}'::jsonb;
 end if;
 v_user:=(event->>'user_id')::uuid;
 if jsonb_typeof(event->'valid') is distinct from 'boolean' then return '{"decision":"continue"}'::jsonb;end if;
 v_valid:=(event->>'valid')::boolean;
 insert into norva_notices.password_attempts as a(user_id,window_started_at,failures)
 values(v_user,v_now,case when v_valid then 0 else 1 end)
 on conflict(user_id) do update set
  window_started_at=case when a.window_started_at<v_now-interval '15 minutes' then v_now else a.window_started_at end,
  failures=case when v_valid then 0 when a.window_started_at<v_now-interval '15 minutes' then 1 else least(5,a.failures+1) end,
  verified_at=case when v_valid and a.failures>=5 and a.window_started_at>=v_now-interval '15 minutes'
   and (a.last_notice_at is null or a.last_notice_at<v_now-interval '24 hours') then v_now
   when not v_valid then a.verified_at else null end;
 return '{"decision":"continue"}'::jsonb;
exception when others then
 -- Notification accounting must never reject a valid login. No credentials in logs.
 raise log 'Norva password notice observation failed [%]',sqlstate;
 return '{"decision":"continue"}'::jsonb;
end $fn$;
revoke all on function norva_notices.password_verification_attempt(jsonb) from public,anon,authenticated,service_role;
grant execute on function norva_notices.password_verification_attempt(jsonb) to supabase_auth_admin;

-- A correct password alone is not a completed sign-in. Consume the candidate
-- only when GoTrue commits its authoritative login audit event.
create function norva_notices.on_confirmed_login()
returns trigger language plpgsql security invoker set search_path='' set lock_timeout='200ms' as $fn$
declare v_user uuid; v_email text; v_verified timestamptz; v_now timestamptz:=clock_timestamp();
begin
 if new.payload->>'action'<>'login' then return new;end if;
 if not (select security_enabled from norva_notices.runtime where singleton) then return new;end if;
 v_user:=(new.payload->>'actor_id')::uuid;
 update norva_notices.password_attempts set verified_at=null,last_notice_at=v_now
 where user_id=v_user and verified_at>=v_now-interval '60 seconds'
  and (last_notice_at is null or last_notice_at<v_now-interval '24 hours')
 returning window_started_at into v_verified;
 if not found then return new;end if;
 select email into v_email from auth.users where id=v_user and email_confirmed_at is not null;
 if nullif(btrim(v_email),'') is null then return new;end if;
 perform public.norva_enqueue_branded_email(v_email,'Norva - Check this unusual sign-in',
  'Security: check this sign-in',
  'Your Norva account was signed in to after at least five unsuccessful password attempts within 15 minutes.<br><br>'||
  'If this was you, no action is needed. If you do not recognise this activity, reset your password and review your connected devices.'||
  '<br><br>Observed at '||to_char(v_now at time zone 'UTC','YYYY-MM-DD HH24:MI')||' UTC.',
  'Review my account','https://norva.tv/account.html',
  'Norva will never ask you to share your password or verification code. For help, contact support@norva.tv.',
  'security_suspicious_login','security:risk:'||new.id::text,v_user);
 return new;
exception when others then
 raise log 'Norva confirmed login notice failed [%]',sqlstate;
 return new;
end $fn$;
revoke all on function norva_notices.on_confirmed_login() from public,anon,authenticated,service_role;
grant execute on function norva_notices.on_confirmed_login() to supabase_auth_admin;
grant execute on function public.norva_enqueue_branded_email(text,text,text,text,text,text,text,text,text,uuid) to supabase_auth_admin;
create trigger norva_suspicious_login_notice_trg after insert on auth.audit_log_entries
for each row when (new.payload->>'action'='login') execute function norva_notices.on_confirmed_login();

create table norva_notices.incident_observations (
 service text primary key check(service in ('gateway','relay')),
 last_observed_at timestamptz not null,
 failing_since timestamptz,
 healthy_since timestamptz,
 incident_id uuid
);
create table norva_notices.incidents (
 id uuid primary key default gen_random_uuid(),
 service text not null check(service in ('gateway','relay')),
 started_at timestamptz not null,
 confirmed_at timestamptz not null,
 resolved_at timestamptz
);
create unique index one_open_service_incident on norva_notices.incidents(service) where resolved_at is null;
create table norva_notices.incident_recipients (
 incident_id uuid references norva_notices.incidents(id),
 user_id uuid references auth.users(id) on delete cascade,
 notice_id uuid not null references public.cloud_branded_email_outbox(id),
 recovery_id uuid references public.cloud_branded_email_outbox(id),
 primary key(incident_id,user_id)
);
alter table norva_notices.incident_observations enable row level security;
alter table norva_notices.incidents enable row level security;
alter table norva_notices.incident_recipients enable row level security;

create function norva_notices.observe_incident(p_service text,p_down boolean)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_now timestamptz:=clock_timestamp(); v_obs norva_notices.incident_observations%rowtype;
 v_inc norva_notices.incidents%rowtype; r record; v_id uuid; v_queued integer:=0; v_recovered integer:=0;
begin
 if auth.uid() is not null then raise exception 'service only' using errcode='42501';end if;
 if p_service not in ('gateway','relay') or p_down is null then raise exception 'invalid health observation';end if;
 if not (select incidents_enabled from norva_notices.runtime where singleton) then return '{"enabled":false}'::jsonb;end if;
 perform pg_advisory_xact_lock(hashtextextended('norva:customer-incident:'||p_service,0));
 select * into v_obs from norva_notices.incident_observations where service=p_service for update;
 -- Calls within a minute cannot manufacture consecutive monitoring evidence.
 if found and v_obs.last_observed_at>v_now-interval '1 minute' then return '{"throttled":true}'::jsonb;end if;
 insert into norva_notices.incident_observations(service,last_observed_at) values(p_service,v_now)
 on conflict(service) do update set last_observed_at=excluded.last_observed_at;
 if p_down then
  if v_obs.failing_since is null or v_obs.last_observed_at<v_now-interval '25 minutes' then
   update norva_notices.incident_observations set failing_since=v_now,healthy_since=null where service=p_service;
  else
   update norva_notices.incident_observations set healthy_since=null where service=p_service;
   if v_obs.incident_id is null and v_obs.failing_since<=v_now-interval '10 minutes' then
    insert into norva_notices.incidents(service,started_at,confirmed_at) values(p_service,v_obs.failing_since,v_now) returning * into v_inc;
    update norva_notices.incident_observations set incident_id=v_inc.id where service=p_service;
   end if;
  end if;
 elsif v_obs.incident_id is not null then
  if v_obs.healthy_since is null or v_obs.last_observed_at<v_now-interval '25 minutes' then
   update norva_notices.incident_observations set healthy_since=v_now where service=p_service;
  elsif v_obs.healthy_since<=v_now-interval '10 minutes' then
   update norva_notices.incidents set resolved_at=v_now where id=v_obs.incident_id and resolved_at is null;
   update norva_notices.incident_observations set incident_id=null,failing_since=null,healthy_since=null where service=p_service;
  end if;
 else
  update norva_notices.incident_observations set failing_since=null,healthy_since=null where service=p_service;
 end if;
 select * into v_inc from norva_notices.incidents where service=p_service and resolved_at is null;
 if found and p_down then
  -- Only users of the affected playback path during this incident. No all-user
  -- audience, provider credentials, provider failures or stale source counters.
  for r in
   select u.id,u.email from auth.users u join (
    select user_id from public.cloud_gateway_sessions where p_service='gateway' and updated_at>=v_inc.started_at-interval '10 minutes'
    union
    select user_id from public.cloud_playback_sessions where p_service='relay' and mode='relay' and updated_at>=v_inc.started_at-interval '10 minutes'
   ) affected on affected.user_id=u.id
   where u.email_confirmed_at is not null and nullif(btrim(u.email),'') is not null
    and not exists(select 1 from norva_notices.incident_recipients x where x.incident_id=v_inc.id and x.user_id=u.id)
   order by u.id limit 100
  loop
   v_id:=public.norva_enqueue_branded_email(r.email,'Norva - Playback service update','Support: playback service update',
    'We detected a disruption affecting a Norva playback service used by your account. Some playback attempts may have been interrupted.'||
    '<br><br>You do not need to delete or import your source again. We will notify you when our checks confirm recovery.'||
    '<br><br>Incident detected at '||to_char(v_inc.started_at at time zone 'UTC','YYYY-MM-DD HH24:MI')||' UTC.',
    'Open Norva','https://norva.tv/app.html#home','Your catalogue and subscription are unchanged. For help, contact support@norva.tv.',
    'service_incident','service:incident:'||v_inc.id||':'||r.id,r.id);
   insert into norva_notices.incident_recipients(incident_id,user_id,notice_id) values(v_inc.id,r.id,v_id);
   v_queued:=v_queued+1;
  end loop;
 end if;
 -- Cancel an unsent outage message after recovery. A processing delivery may
 -- already have reached Postal: wait for its acknowledgement before recovery.
 update public.cloud_branded_email_outbox o set state='canceled',recipient_email=null,request_reply_to=null,
  request_subject=null,request_html=null,request_text=null,request_headers='{}',payload_scrubbed_at=v_now,
  last_error='incident_resolved_before_delivery',updated_at=v_now
 from norva_notices.incident_recipients recipient join norva_notices.incidents i on i.id=recipient.incident_id
 where i.service=p_service and i.resolved_at is not null and o.id=recipient.notice_id and o.state='pending' and o.attempt_count=0;
 for r in
  select x.*,u.email,i.resolved_at from norva_notices.incident_recipients x
  join norva_notices.incidents i on i.id=x.incident_id
  join public.cloud_branded_email_outbox o on o.id=x.notice_id
  join auth.users u on u.id=x.user_id
  where i.service=p_service and i.resolved_at is not null and i.resolved_at>v_now-interval '7 days'
   and x.recovery_id is null and o.state='sent' and u.email_confirmed_at is not null
  order by i.resolved_at,x.user_id limit 100
 loop
  v_id:=public.norva_enqueue_branded_email(r.email,'Norva - Playback service restored','Support: playback service restored',
   'Our consecutive service checks now confirm recovery from the playback disruption we told you about.'||
   '<br><br>You can open Norva and try your content again. If a problem continues, contact support so we can help with your specific source.'||
   '<br><br>Recovery confirmed at '||to_char(r.resolved_at at time zone 'UTC','YYYY-MM-DD HH24:MI')||' UTC.',
   'Open my catalogue','https://norva.tv/app.html#home','Thank you for your patience. Your sources do not need to be imported again.',
   'service_recovered','service:recovered:'||r.incident_id||':'||r.user_id,r.user_id);
  update norva_notices.incident_recipients set recovery_id=v_id where incident_id=r.incident_id and user_id=r.user_id;
  v_recovered:=v_recovered+1;
 end loop;
 return jsonb_build_object('enabled',true,'queued',v_queued,'recoveries',v_recovered);
end $fn$;
revoke all on function norva_notices.observe_incident(text,boolean) from public,anon,authenticated;
grant execute on function norva_notices.observe_incident(text,boolean) to service_role;
create function public.norva_observe_customer_incident(p_service text,p_down boolean)
returns jsonb language sql security invoker set search_path='' as $fn$
 select norva_notices.observe_incident(p_service,p_down);
$fn$;
revoke all on function public.norva_observe_customer_incident(text,boolean) from public,anon,authenticated;
grant execute on function public.norva_observe_customer_incident(text,boolean) to service_role;

create table norva_notices.price_events (
 id uuid primary key default gen_random_uuid(),
 user_id uuid references auth.users(id) on delete cascade,
 old_amount_cents integer not null,
 new_amount_cents integer not null,
 period text not null,
 effective_at timestamptz not null,
 reason text not null,
 created_at timestamptz not null default now(),
 notice_id uuid references public.cloud_branded_email_outbox(id)
);
alter table norva_notices.price_events enable row level security;

create function norva_notices.on_customer_price_change()
returns trigger language plpgsql security definer set search_path='' as $fn$
declare v_date timestamptz; v_email text; v_new integer; v_reason text; v_id uuid; v_notice uuid;
begin
 if auth.uid() is not null and auth.uid()<>new.user_id and not public.is_admin() then
  raise exception 'not authorized' using errcode='42501';
 end if;
 if not (select prices_enabled from norva_notices.runtime where singleton) then return new;end if;
 -- Catalogue prices govern new purchases only. Existing users keep their price.
 -- User-requested checkout/plan changes already have their own confirmations.
 if new.pending_order_id is null and new.pending_plan=new.plan and new.pending_period=new.period
  and new.pending_amount_cents is distinct from old.pending_amount_cents
  and new.pending_amount_cents is distinct from new.amount_cents and new.pending_effective_at>now() then
  v_new:=new.pending_amount_cents;v_date:=new.pending_effective_at;v_reason:='scheduled_recurring_price';
 elsif new.amount_cents is distinct from old.amount_cents and new.plan=old.plan and new.period=old.period
  and old.pending_order_id is null then
  v_new:=new.amount_cents;v_reason:=case when old.base_amount_cents=new.amount_cents and old.promo_cycles_left=1 then 'promotion_completed' else 'recurring_price_updated' end;
 end if;
 if v_new is null or v_new not between 1 and 9999999 or old.amount_cents not between 1 and 9999999 then return new;end if;
 select coalesce(v_date,e.current_period_end),u.email into v_date,v_email
 from public.cloud_entitlement_projection e join auth.users u on u.id=e.user_id
 where e.user_id=new.user_id and e.provider='revolut' and e.status='active'
  and u.email_confirmed_at is not null;
 if v_date is null or v_date<=now() or nullif(btrim(v_email),'') is null then return new;end if;
 insert into norva_notices.price_events(user_id,old_amount_cents,new_amount_cents,period,effective_at,reason)
 values(new.user_id,old.amount_cents,v_new,new.period,v_date,v_reason) returning id into v_id;
 v_notice:=public.norva_enqueue_branded_email(v_email,'Norva - Your subscription price update','Your subscription price update',
  case when v_reason='promotion_completed' then 'Your promotional periods have now been used. The regular price agreed when you subscribed applies to your next renewal.'
   else 'The recurring price recorded for your Norva subscription has changed. Here are the details for your account.' end||
  '<br><br>Previous recurring price: <strong>USD '||to_char(old.amount_cents/100.0,'FM9999990.00')||'</strong>'||
  '<br>New recurring price: <strong>USD '||to_char(v_new/100.0,'FM9999990.00')||'</strong> per '||case new.period when 'annual' then 'year' else 'month' end||
  '<br>Scheduled renewal: <strong>'||to_char(v_date at time zone 'UTC','YYYY-MM-DD HH24:MI')||' UTC</strong>.'||
  '<br><br>Any eligible one-time discount is applied separately. You can review or cancel renewal from your account before this date.',
  'Manage my subscription','https://norva.tv/account.html','Review your subscription details in your account. For help, contact support@norva.tv.',
  'billing_price_change','billing:price:'||v_id,new.user_id);
 update norva_notices.price_events set notice_id=v_notice where id=v_id;
 return new;
end $fn$;
revoke all on function norva_notices.on_customer_price_change() from public,anon,authenticated,service_role;
create trigger norva_customer_price_notice_trg after update of amount_cents,pending_amount_cents on public.cloud_revolut_customers
for each row execute function norva_notices.on_customer_price_change();

-- Add the real protected circuits to the existing admin inventory without
-- adding editable campaign controls to security or billing.
do $patch$
declare v_def text:=replace(pg_get_functiondef('public.admin_marketing_system_automations()'::regprocedure),chr(13),'');
 v_anchor text:='return jsonb_build_array(';
begin
 if cardinality(string_to_array(v_def,v_anchor))<>2 then raise exception 'system inventory definition drift';end if;
 execute replace(v_def,v_anchor,$new$return jsonb_build_array(
  jsonb_build_object('id','suspicious-login','name','Connexion suspecte','trigger','Connexion réussie après 5 échecs de mot de passe en 15 minutes','channels',jsonb_build_array('E-mail'),'channel_states',jsonb_build_array(jsonb_build_object('channel','E-mail','enabled',(select security_enabled from norva_notices.runtime where singleton))),'state','transactional','control','protected','description','Signal GoTrue confirmé côté serveur. Un message au maximum par compte et par 24 heures. Les échecs seuls et les révocations de jetons ordinaires ne déclenchent rien.'),
  jsonb_build_object('id','service-incidents','name','Incident et rétablissement','trigger','Deux contrôles consécutifs du service de lecture, espacés de 10 minutes minimum','channels',jsonb_build_array('E-mail'),'channel_states',jsonb_build_array(jsonb_build_object('channel','E-mail','enabled',(select incidents_enabled from norva_notices.runtime where singleton))),'state','transactional','control','protected','description','Utilisateurs du chemin de lecture concerné uniquement. Rétablissement adressé aux destinataires de l’alerte initiale. Alertes internes Telegram conservées.'),
  jsonb_build_object('id','price-change','name','Changement de prix','trigger','Évolution réelle du prix récurrent ou fin des périodes promotionnelles','channels',jsonb_build_array('E-mail'),'channel_states',jsonb_build_array(jsonb_build_object('channel','E-mail','enabled',(select prices_enabled from norva_notices.runtime where singleton))),'state','transactional','control','protected','description','Ancien et nouveau prix en USD, périodicité, date de renouvellement et accès à la gestion. Une modification du catalogue commercial ne contacte pas les abonnés qui conservent leur prix.'),
$new$);
end $patch$;
notify pgrst,'reload schema';
