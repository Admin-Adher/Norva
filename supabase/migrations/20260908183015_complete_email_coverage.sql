-- Notification-only coverage. No payment, entitlement or credential mutation.
set lock_timeout='3s';
set statement_timeout='30s';

create function public.norva_pending_renewal_email_quotes(p_limit integer default 100)
returns table(user_id uuid,renews_at timestamptz,cycle_key text,amount_cents integer,currency text)
language sql stable security definer set search_path='' as $function$
 select q.user_id,q.renews_at,q.cycle_key,
  case when c.pending_effective_at is not null and c.pending_effective_at<=q.renews_at then null
   when c.discount_next_pct between 1 and 99 then greatest(50,round(c.amount_cents::numeric*(100-c.discount_next_pct)/100)::integer)
   else c.amount_cents end,
  'USD'::text
 from public.norva_pending_renewal_emails(p_limit) q
 join public.cloud_revolut_customers c on c.user_id=q.user_id;
$function$;
revoke all on function public.norva_pending_renewal_email_quotes(integer) from public,anon,authenticated;
grant execute on function public.norva_pending_renewal_email_quotes(integer) to service_role;
comment on function public.norva_pending_renewal_email_quotes(integer) is
 'Read-only current renewal quote using the same USD amount and one-time-discount floor as the billing worker. Pending plan transitions require reviewing the account; never invent their final amount.';

create function public.norva_enqueue_account_security_notice(p_user_id uuid,p_kind text,p_event_key text)
returns uuid language plpgsql security definer set search_path='' as $function$
declare v_email text;v_heading text;v_intro text;
begin
 if p_event_key is null or p_event_key !~ '^[a-z0-9:_-]{1,120}$' then
  raise exception 'invalid security event identity' using errcode='22023';
 end if;
 case p_kind
  when 'mfa_added' then v_heading:='Account security: verification method added';
   v_intro:='A new two-step verification method was verified and added to your Norva account.';
  when 'mfa_removed' then v_heading:='Account security: verification method removed';
   v_intro:='A two-step verification method was removed from your Norva account.';
  when 'identity_linked' then v_heading:='Account security: sign-in method linked';
   v_intro:='An additional sign-in method was linked to your Norva account.';
  when 'identity_unlinked' then v_heading:='Account security: sign-in method removed';
   v_intro:='A sign-in method was removed from your Norva account.';
  when 'phone_changed' then v_heading:='Account security: phone number changed';
   v_intro:='The verified phone number associated with your Norva account was changed.';
  else raise exception 'unsupported security event' using errcode='22023';
 end case;
 select lower(btrim(u.email)) into v_email from auth.users u
 where u.id=p_user_id and u.email_confirmed_at is not null and nullif(btrim(u.email),'') is not null;
 if v_email is null then return null;end if;
 return public.norva_enqueue_branded_email(v_email,'Norva - '||v_heading,v_heading,v_intro,
  'Review my account','https://norva.tv/account.html',
  'If this was not you, reset your password and contact support@norva.tv immediately.',
  'security_'||p_kind,'security:'||p_kind||':'||p_event_key,p_user_id);
end $function$;
revoke all on function public.norva_enqueue_account_security_notice(uuid,text,text) from public,anon,authenticated;
grant execute on function public.norva_enqueue_account_security_notice(uuid,text,text) to service_role;

create function public.norva_notify_mfa_factor_change()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
 if tg_op='DELETE' then
  if old.status='verified' then
   perform public.norva_enqueue_account_security_notice(old.user_id,'mfa_removed',old.id::text);
  end if;
  return old;
 elsif new.status='verified' and (tg_op='INSERT' or old.status is distinct from new.status) then
  perform public.norva_enqueue_account_security_notice(new.user_id,'mfa_added',new.id::text);
 end if;
 return new;
end $function$;
revoke all on function public.norva_notify_mfa_factor_change() from public,anon,authenticated;
create trigger norva_mfa_factor_notice_trg after insert or update of status or delete on auth.mfa_factors
for each row execute function public.norva_notify_mfa_factor_change();

create function public.norva_notify_identity_change()
returns trigger language plpgsql security definer set search_path='' as $function$
declare v_user uuid;
begin
 v_user:=case when tg_op='DELETE' then old.user_id else new.user_id end;
 -- Initial signup and cascading account deletion are not identity-link changes.
 if exists(select 1 from auth.users u where u.id=v_user and u.email_confirmed_at is not null)
 and (select count(*) from auth.identities i where i.user_id=v_user)>=(case when tg_op='DELETE' then 1 else 2 end) then
  perform public.norva_enqueue_account_security_notice(v_user,
   case when tg_op='DELETE' then 'identity_unlinked' else 'identity_linked' end,
   case when tg_op='DELETE' then old.id::text else new.id::text end);
 end if;
 if tg_op='DELETE' then return old;end if;
 return new;
end $function$;
revoke all on function public.norva_notify_identity_change() from public,anon,authenticated;
create trigger norva_identity_notice_trg after insert or delete on auth.identities
for each row execute function public.norva_notify_identity_change();

create function public.norva_notify_verified_phone_change()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
 if old.email_confirmed_at is not null and new.phone_confirmed_at is not null
 and nullif(new.phone,'') is not null and old.phone is distinct from new.phone then
  perform public.norva_enqueue_account_security_notice(new.id,'phone_changed',
   new.id::text||':'||md5(coalesce(new.phone,'')||':'||new.phone_confirmed_at::text));
 end if;
 return new;
end $function$;
revoke all on function public.norva_notify_verified_phone_change() from public,anon,authenticated;
create trigger norva_phone_notice_trg after update of phone,phone_confirmed_at on auth.users
for each row execute function public.norva_notify_verified_phone_change();

-- Production email delivery is distinct from a time-limited experiment. Entering
-- production requires fresh passing device evidence; an explicit later failure
-- still stops delivery. Trial cohorts and their 10% holdout are unchanged.
alter table public.behavioral_lifecycle_runtime drop constraint behavioral_lifecycle_runtime_audience_mode_check;
alter table public.behavioral_lifecycle_runtime add constraint behavioral_lifecycle_runtime_audience_mode_check
 check (audience_mode in ('internal_test','pilot','production'));
alter table public.behavioral_lifecycle_admin_audit drop constraint behavioral_lifecycle_admin_audit_action_check;
alter table public.behavioral_lifecycle_admin_audit add constraint behavioral_lifecycle_admin_audit_action_check
 check (action in ('runtime_stopped','runtime_started_internal_test','runtime_started_pilot','runtime_started_production',
 'import_readiness_recorded','journey_saved','journey_activated','journey_paused','journey_archived','step_updated','delivery_retried'));

-- Preserve current deployed definitions, owner, ACL and security mode. Every
-- replacement is restricted to a unique reviewed anchor and aborts on drift.
create function pg_temp.norva_patch_email_definition(p_signature regprocedure,p_old text,p_new text)
returns void language plpgsql as $function$
declare v_definition text:=replace(pg_get_functiondef(p_signature),chr(13),'');
begin
 if cardinality(string_to_array(v_definition,p_old))<>2 then
  raise exception 'email coverage function anchor changed: %',p_signature;
 end if;
 execute replace(v_definition,p_old,p_new);
end $function$;

-- A shared reservation cap covers winback, checkout and behavioral marketing.
-- Security, receipts and operational service messages are never suppressed.
create function public.norva_marketing_email_contact_allowed(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $function$
 select not exists(select 1 from public.cloud_branded_email_outbox o
   where o.user_id=p_user_id and o.is_marketing
    and (o.state in ('pending','processing') or (o.state='sent' and o.sent_at>now()-interval '24 hours')))
  and (select count(*) from public.cloud_branded_email_outbox o
    where o.user_id=p_user_id and o.is_marketing and o.state='sent' and o.sent_at>now()-interval '7 days')<2;
$function$;
revoke all on function public.norva_marketing_email_contact_allowed(uuid) from public,anon,authenticated;
grant execute on function public.norva_marketing_email_contact_allowed(uuid) to service_role;
select pg_temp.norva_patch_email_definition('public.norva_enqueue_lifecycle_email(uuid,text,text,text,text,text,text,text,text,jsonb,jsonb,boolean,text,text,smallint)',
 $old$  insert into public.cloud_branded_email_outbox as o ($old$,
 $new$  if p_marketing then
    perform pg_advisory_xact_lock(hashtextextended('norva:marketing-email:'||p_user_id::text,0));
    if not exists(select 1 from public.cloud_branded_email_outbox where dedupe_key=v_dedupe)
      and not public.norva_marketing_email_contact_allowed(p_user_id) then return null;end if;
  end if;
  insert into public.cloud_branded_email_outbox as o ($new$);
select pg_temp.norva_patch_email_definition('public.norva_claim_behavioral_deliveries(text,integer,integer)',
 $old$where o.channel = p_channel and o.status = 'pending'$old$,
 $new$where o.channel = p_channel and o.status = 'pending'
      and (not o.is_marketing or public.norva_marketing_email_contact_allowed(o.user_id))$new$);

select pg_temp.norva_patch_email_definition('public.admin_update_behavioral_lifecycle_runtime(boolean,text,text,text)',
 $old$v_mode not in ('internal_test', 'pilot')$old$,
 $new$v_mode not in ('internal_test', 'pilot', 'production')$new$);
select pg_temp.norva_patch_email_definition('public.admin_update_behavioral_lifecycle_runtime(boolean,text,text,text)',
 $old$when v_mode = 'internal_test' then 'START INTERNAL TEST'
    else 'START PILOT'$old$,
 $new$when v_mode = 'internal_test' then 'START INTERNAL TEST'
    when v_mode = 'production' then 'START PRODUCTION'
    else 'START PILOT'$new$);
select pg_temp.norva_patch_email_definition('public.admin_update_behavioral_lifecycle_runtime(boolean,text,text,text)',
 $old$and v_mode = 'pilot'
     and not coalesce(($old$,
 $new$and v_mode in ('pilot','production')
     and not coalesce(($new$);
select pg_temp.norva_patch_email_definition('public.admin_update_behavioral_lifecycle_runtime(boolean,text,text,text)',
 $old$select * into v_current
  from public.behavioral_lifecycle_runtime r$old$,
 $new$if not coalesce(p_emergency_stop,true) and v_mode='production' and exists (
    select 1 from public.behavioral_lifecycle_steps s join public.behavioral_lifecycle_journeys j using(journey_key)
    where j.status='active' and s.enabled and s.channel<>'email'
  ) then raise exception 'production audience is email-only' using errcode='22023';end if;

  select * into v_current
  from public.behavioral_lifecycle_runtime r$new$);
select pg_temp.norva_patch_email_definition('public.admin_update_behavioral_lifecycle_runtime(boolean,text,text,text)',
 $old$when v_mode = 'internal_test' then 'runtime_started_internal_test'
    else 'runtime_started_pilot'$old$,
 $new$when v_mode = 'internal_test' then 'runtime_started_internal_test'
    when v_mode = 'production' then 'runtime_started_production'
    else 'runtime_started_pilot'$new$);

select pg_temp.norva_patch_email_definition('public.norva_behavioral_journey_relevant(uuid,text,timestamptz)',
 $old$        else false
      end$old$,
 $new$        when 'production' then
          not exists(select 1 from public.admin_internal_accounts a where a.user_id=s.user_id)
          and ('*'=any(j.country_allowlist) or s.country_code=any(j.country_allowlist))
          and coalesce((select g.status='passed' from public.behavioral_lifecycle_import_readiness g
            order by g.checked_at desc,g.id desc limit 1),false)
        else false
      end$new$);
select pg_temp.norva_patch_email_definition('public.admin_update_behavioral_lifecycle_journey(text,text,integer,integer,text[],text,integer,integer,integer,integer,integer,integer,text,text,text,integer,numeric)',
 $old$or p_holdout_percent <> 10$old$,
 $new$or (p_holdout_percent <> 10 and not (p_holdout_percent=0 and exists(
       select 1 from public.behavioral_lifecycle_runtime where audience_mode='production')))$new$);
select pg_temp.norva_patch_email_definition('public.admin_update_behavioral_lifecycle_journey(text,text,integer,integer,text[],text,integer,integer,integer,integer,integer,integer,text,text,text,integer,numeric)',
 $old$where upper(btrim(x)) ~ '^[A-Z]{2}$';$old$,
 $new$where upper(btrim(x)) ~ '^[A-Z]{2}$';
  if p_country_allowlist=array['*']::text[] and exists(
    select 1 from public.behavioral_lifecycle_runtime where audience_mode='production'
  ) then v_countries:=array['*']::text[];end if;$new$);
select pg_temp.norva_patch_email_definition('public.admin_behavioral_lifecycle_overview(integer)',
 $old$and s.country_code = any(j.country_allowlist)$old$,
 $new$and ('*'=any(j.country_allowlist) or s.country_code=any(j.country_allowlist))$new$);
select pg_temp.norva_patch_email_definition('public.norva_behavioral_delivery_eligible(uuid,timestamptz)',
 $old$and st.enabled$old$,
 $new$and st.enabled
      and (o.channel='email' or not exists(select 1 from public.behavioral_lifecycle_runtime
        where audience_mode='production'))$new$);

-- New email steps are prepared but inert until the separately audited runtime
-- activation. Existing steps and other channels are not changed by migration.
insert into public.behavioral_lifecycle_steps(journey_key,step_key,ordinal,channel,delay_minutes,
 title,body,cta_label,deep_link,ttl_seconds,collapse_key,enabled,is_marketing,requires_new_content)
values
 ('catalog_ready_no_first_play','day_one_email',4,'email',1440,
  'Your catalogue is ready to watch','Your source is connected. Open your catalogue, choose a title and start your first watch on Norva.',
  'Open my catalogue','/app.html#home',172800,'lifecycle-catalog-ready-no-first-play',false,false,false),
 ('continue_watching','day_three_email',3,'email',4320,
  'Continue your watch on Norva','Your progress is saved. Open Norva to continue a title you started.',
  'Continue watching','/app.html#home/resume',259200,'lifecycle-continue-watching',false,true,false),
 ('continue_watching','new_content_week_email',4,'email',10080,
  'Your catalogue has something new','Your catalogue has changed since your last watch. Open Norva to explore what is new.',
  'Explore my catalogue','/app.html#home',259200,'lifecycle-continue-watching',false,true,true);
