-- Confirmed-signup welcome independent from subscription entitlements.
-- Ships disabled. Enabling must set eligible_since to the current activation
-- time; never backdate it to create a historical welcome campaign.
begin;
-- Fail rather than overwrite an independently changed mature authorization.
do $baseline$
declare v_hash text;
begin
  select md5(replace(prosrc,chr(13),'')) into v_hash from pg_proc
  where oid=to_regprocedure('public.authorize_branded_email_delivery_pre_behavioral(uuid,text,uuid)');
  if v_hash is not null and v_hash <> 'cf3b362e4a2de85cf2eea25c52a4735d' then
    raise exception 'welcome authorization baseline drift';
  end if;
end;
$baseline$;

create table public.lifecycle_signup_welcome_runtime (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  eligible_since timestamptz not null default clock_timestamp()
);
insert into public.lifecycle_signup_welcome_runtime(singleton) values (true);
alter table public.lifecycle_signup_welcome_runtime enable row level security;
revoke all on public.lifecycle_signup_welcome_runtime from public, anon, authenticated, service_role;
grant select on public.lifecycle_signup_welcome_runtime to service_role;

create table public.lifecycle_signup_welcomes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  confirmed_at timestamptz not null,
  sent_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.lifecycle_signup_welcomes enable row level security;
revoke all on public.lifecycle_signup_welcomes from public, anon, authenticated, service_role;
grant select on public.lifecycle_signup_welcomes to service_role;

create function public.norva_signup_welcome_eligible(p_user_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (
    select 1 from public.lifecycle_signup_welcomes w
    join auth.users u on u.id = w.user_id
    cross join public.lifecycle_signup_welcome_runtime r
    where w.user_id = p_user_id and w.sent_at is null
      and r.singleton and r.enabled
      and u.email_confirmed_at is not null
      and u.email_confirmed_at >= r.eligible_since
      and u.created_at >= r.eligible_since
      and nullif(btrim(u.email), '') is not null
      and not exists (select 1 from public.admin_internal_accounts a where a.user_id = u.id)
      and not exists (select 1 from public.cloud_entitlement_projection e
        where e.user_id = u.id and e.welcome_email_at is not null)
  );
$function$;
revoke all on function public.norva_signup_welcome_eligible(uuid) from public, anon, authenticated;
grant execute on function public.norva_signup_welcome_eligible(uuid) to service_role;

create function public.norva_pending_signup_welcomes(p_limit integer default 100)
returns table(user_id uuid) language plpgsql security definer set search_path = ''
as $function$
begin
  if p_limit not between 1 and 100 then raise exception 'invalid welcome batch'; end if;
  insert into public.lifecycle_signup_welcomes(user_id, confirmed_at)
  select u.id, u.email_confirmed_at from auth.users u
  cross join public.lifecycle_signup_welcome_runtime r
  where r.singleton and r.enabled
    and u.created_at >= r.eligible_since
    and u.email_confirmed_at >= greatest(r.eligible_since, clock_timestamp() - interval '72 hours')
    and nullif(btrim(u.email), '') is not null
    and not exists (select 1 from public.admin_internal_accounts a where a.user_id = u.id)
    and not exists (select 1 from public.cloud_entitlement_projection e
      where e.user_id = u.id and e.welcome_email_at is not null)
    and not exists (select 1 from public.lifecycle_signup_welcomes w where w.user_id = u.id)
  order by u.email_confirmed_at, u.id
  limit p_limit
  on conflict do nothing;

  return query select w.user_id from public.lifecycle_signup_welcomes w
  where public.norva_signup_welcome_eligible(w.user_id)
    and w.confirmed_at >= clock_timestamp() - interval '72 hours'
    -- Any existing delivery, including dead-letter/canceled, is an operator
    -- recovery decision; never manufacture a second idempotency key.
    and not exists (select 1 from public.cloud_branded_email_outbox o
      where o.user_id = w.user_id and o.marker_kind = 'welcome')
  order by w.confirmed_at, w.user_id limit p_limit;
end;
$function$;
revoke all on function public.norva_pending_signup_welcomes(integer) from public, anon, authenticated;
grant execute on function public.norva_pending_signup_welcomes(integer) to service_role;

-- Completion remains the existing leased provider-acknowledgement RPC. Its
-- successful state transition records a separate durable signup marker,
-- atomically in the same transaction, without creating any entitlement.
create function public.norva_record_signup_welcome_sent()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  if new.marker_kind = 'welcome' and new.state = 'sent'
     and old.state is distinct from 'sent' then
    insert into public.lifecycle_signup_welcomes(user_id, confirmed_at, sent_at)
    select u.id, u.email_confirmed_at, coalesce(new.sent_at, clock_timestamp())
    from auth.users u where u.id = new.user_id and u.email_confirmed_at is not null
    on conflict (user_id) do update
      set sent_at = coalesce(public.lifecycle_signup_welcomes.sent_at, excluded.sent_at);
  end if;
  return new;
end;
$function$;
revoke all on function public.norva_record_signup_welcome_sent() from public, anon, authenticated, service_role;
create trigger norva_signup_welcome_sent
after update of state on public.cloud_branded_email_outbox
for each row execute function public.norva_record_signup_welcome_sent();

-- Preserve the outer behavioral wrapper and all non-welcome authorization.
create or replace function public.authorize_branded_email_delivery_pre_behavioral(
  p_id uuid,
  p_delivery_key text,
  p_lease_token uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  o record;
  v_allowed boolean := true;
begin
  select * into o from public.cloud_branded_email_outbox x
  where x.id = p_id and x.delivery_key = p_delivery_key
    and x.state = 'processing' and x.lease_token = p_lease_token
  for update;
  if not found then return false; end if;

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

  if v_allowed then
    -- A database claim is only a lease. Start the provider idempotency window
    -- at the final authorization CAS immediately before network I/O.
    update public.cloud_branded_email_outbox x
    set transport_started_at = coalesce(x.transport_started_at, clock_timestamp()),
        updated_at = clock_timestamp()
    where x.id = p_id and x.delivery_key = p_delivery_key
      and x.state = 'processing' and x.lease_token = p_lease_token;
    return found;
  end if;
  update public.cloud_branded_email_outbox x
  set state = 'canceled', last_error = 'eligibility_or_consent_revoked_before_send',
      lease_token = null, lease_expires_at = null,
      recipient_email = null, request_reply_to = null, request_subject = null,
      request_html = null, request_text = null, request_headers = '{}'::jsonb,
      payload_scrubbed_at = clock_timestamp(), updated_at = clock_timestamp()
  where x.id = p_id and x.state = 'processing' and x.lease_token = p_lease_token;
  return false;
end
$function$;

revoke all on function public.authorize_branded_email_delivery_pre_behavioral(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.authorize_branded_email_delivery_pre_behavioral(uuid,text,uuid) to service_role;
commit;
