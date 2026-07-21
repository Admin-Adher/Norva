-- Resend delivery observability, durable idempotency and local suppression safety.
--
-- Resend only retains email activity for a limited period.  This ledger keeps the
-- minimum operational evidence Norva needs to measure deliverability, reconcile
-- complaints/bounces and diagnose an individual send without storing message
-- bodies, click URLs, user agents or IP addresses.

create table if not exists public.cloud_email_delivery_events (
  event_id text primary key,
  event_type text not null,
  provider_email_id text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  from_email text,
  to_emails text[] not null default '{}'::text[],
  tags jsonb not null default '{}'::jsonb,
  diagnostic_data jsonb not null default '{}'::jsonb,
  constraint cloud_email_delivery_events_event_id_present
    check (nullif(btrim(event_id), '') is not null),
  constraint cloud_email_delivery_events_email_id_present
    check (nullif(btrim(provider_email_id), '') is not null),
  constraint cloud_email_delivery_events_type_known check (
    event_type = any (array[
      'email.sent', 'email.delivered', 'email.delivery_delayed',
      'email.bounced', 'email.complained', 'email.failed',
      'email.suppressed', 'email.opened', 'email.clicked'
    ])
  ),
  constraint cloud_email_delivery_events_tags_object
    check (jsonb_typeof(tags) = 'object'),
  constraint cloud_email_delivery_events_diagnostic_object
    check (jsonb_typeof(diagnostic_data) = 'object')
);

comment on table public.cloud_email_delivery_events is
  'Service-only, append-only Resend delivery event ledger. No bodies, links, IPs or user agents are retained.';

create index if not exists cloud_email_delivery_events_email_idx
  on public.cloud_email_delivery_events (provider_email_id, occurred_at desc);
create index if not exists cloud_email_delivery_events_type_time_idx
  on public.cloud_email_delivery_events (event_type, occurred_at desc);

alter table public.cloud_email_delivery_events enable row level security;
revoke all on table public.cloud_email_delivery_events from public, anon, authenticated;
grant all on table public.cloud_email_delivery_events to service_role;

-- One monotonic projection per Resend email.  Individual timestamps are merged
-- independently because webhook delivery is at-least-once and not ordered.
create table if not exists public.cloud_email_delivery_status (
  provider_email_id text primary key,
  from_email text,
  to_emails text[] not null default '{}'::text[],
  tags jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  delivered_at timestamptz,
  delivery_delayed_at timestamptz,
  bounced_at timestamptz,
  complained_at timestamptz,
  failed_at timestamptz,
  suppressed_at timestamptz,
  last_opened_at timestamptz,
  last_clicked_at timestamptz,
  latest_event_type text not null,
  latest_event_at timestamptz not null,
  latest_diagnostic_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_email_delivery_status_email_id_present
    check (nullif(btrim(provider_email_id), '') is not null),
  constraint cloud_email_delivery_status_tags_object
    check (jsonb_typeof(tags) = 'object'),
  constraint cloud_email_delivery_status_diagnostic_object
    check (jsonb_typeof(latest_diagnostic_data) = 'object')
);

comment on table public.cloud_email_delivery_status is
  'Monotonic per-message Resend delivery projection, safe under duplicate and out-of-order webhooks.';

create index if not exists cloud_email_delivery_status_latest_idx
  on public.cloud_email_delivery_status (latest_event_at desc);

alter table public.cloud_email_delivery_status enable row level security;
revoke all on table public.cloud_email_delivery_status from public, anon, authenticated;
grant all on table public.cloud_email_delivery_status to service_role;

create table if not exists public.cloud_email_suppressions (
  email text primary key,
  reason text not null,
  source_event_id text,
  source_email_id text,
  active boolean not null default true,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_email_suppressions_normalized_email check (
    email = lower(btrim(email))
    and length(email) between 3 and 320
    and position('@' in email) > 1
  ),
  constraint cloud_email_suppressions_reason_present
    check (nullif(btrim(reason), '') is not null),
  constraint cloud_email_suppressions_resolution check (
    (active and resolved_at is null) or (not active and resolved_at is not null)
  )
);

comment on table public.cloud_email_suppressions is
  'Local safety mirror for permanent bounces, complaints and provider suppressions. Service role only.';

alter table public.cloud_email_suppressions enable row level security;
revoke all on table public.cloud_email_suppressions from public, anon, authenticated;
grant all on table public.cloud_email_suppressions to service_role;

create or replace function public.norva_record_resend_email_event(
  p_event_id text,
  p_event_type text,
  p_provider_email_id text,
  p_occurred_at timestamptz,
  p_from_email text,
  p_to_emails text[],
  p_tags jsonb,
  p_diagnostic_data jsonb
) returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_inserted integer := 0;
  v_email text;
  v_reason text;
  v_to_emails text[] := array(
    select distinct lower(btrim(value))
    from unnest(coalesce(p_to_emails, '{}'::text[])) as value
    where length(lower(btrim(value))) between 3 and 320
      and position('@' in lower(btrim(value))) > 1
  );
  v_tags jsonb := case when jsonb_typeof(coalesce(p_tags, '{}'::jsonb)) = 'object'
    then coalesce(p_tags, '{}'::jsonb) else '{}'::jsonb end;
  v_diagnostic jsonb := case when jsonb_typeof(coalesce(p_diagnostic_data, '{}'::jsonb)) = 'object'
    then coalesce(p_diagnostic_data, '{}'::jsonb) else '{}'::jsonb end;
begin
  if coalesce(p_tags ->> 'app', '') <> 'norva'
     or lower(coalesce(p_from_email, '')) !~ '(^|<)[^<>@[:space:]]+@norva\.tv>?$' then
    raise exception 'foreign Resend event rejected';
  end if;

  if p_event_type <> all (array[
    'email.sent', 'email.delivered', 'email.delivery_delayed',
    'email.bounced', 'email.complained', 'email.failed',
    'email.suppressed', 'email.opened', 'email.clicked'
  ]) then
    raise exception 'unsupported Resend event type: %', p_event_type;
  end if;

  if nullif(btrim(coalesce(p_event_id, '')), '') is null
     or nullif(btrim(coalesce(p_provider_email_id, '')), '') is null
     or p_occurred_at is null then
    raise exception 'event id, provider email id and occurred_at are required';
  end if;

  insert into public.cloud_email_delivery_events (
    event_id, event_type, provider_email_id, occurred_at,
    from_email, to_emails, tags, diagnostic_data
  ) values (
    btrim(p_event_id), p_event_type, btrim(p_provider_email_id), p_occurred_at,
    nullif(btrim(coalesce(p_from_email, '')), ''), v_to_emails,
    v_tags, v_diagnostic
  )
  on conflict (event_id) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return false;
  end if;

  insert into public.cloud_email_delivery_status (
    provider_email_id, from_email, to_emails, tags,
    sent_at, delivered_at, delivery_delayed_at, bounced_at,
    complained_at, failed_at, suppressed_at, last_opened_at,
    last_clicked_at, latest_event_type, latest_event_at,
    latest_diagnostic_data
  ) values (
    btrim(p_provider_email_id), nullif(btrim(coalesce(p_from_email, '')), ''),
    v_to_emails, v_tags,
    case when p_event_type = 'email.sent' then p_occurred_at end,
    case when p_event_type = 'email.delivered' then p_occurred_at end,
    case when p_event_type = 'email.delivery_delayed' then p_occurred_at end,
    case when p_event_type = 'email.bounced' then p_occurred_at end,
    case when p_event_type = 'email.complained' then p_occurred_at end,
    case when p_event_type = 'email.failed' then p_occurred_at end,
    case when p_event_type = 'email.suppressed' then p_occurred_at end,
    case when p_event_type = 'email.opened' then p_occurred_at end,
    case when p_event_type = 'email.clicked' then p_occurred_at end,
    p_event_type, p_occurred_at, v_diagnostic
  )
  on conflict (provider_email_id) do update set
    from_email = case
      when excluded.latest_event_at >= cloud_email_delivery_status.latest_event_at
        then coalesce(excluded.from_email, cloud_email_delivery_status.from_email)
      else cloud_email_delivery_status.from_email end,
    to_emails = case
      when excluded.latest_event_at >= cloud_email_delivery_status.latest_event_at
        then excluded.to_emails else cloud_email_delivery_status.to_emails end,
    tags = cloud_email_delivery_status.tags || excluded.tags,
    sent_at = greatest(cloud_email_delivery_status.sent_at, excluded.sent_at),
    delivered_at = greatest(cloud_email_delivery_status.delivered_at, excluded.delivered_at),
    delivery_delayed_at = greatest(cloud_email_delivery_status.delivery_delayed_at, excluded.delivery_delayed_at),
    bounced_at = greatest(cloud_email_delivery_status.bounced_at, excluded.bounced_at),
    complained_at = greatest(cloud_email_delivery_status.complained_at, excluded.complained_at),
    failed_at = greatest(cloud_email_delivery_status.failed_at, excluded.failed_at),
    suppressed_at = greatest(cloud_email_delivery_status.suppressed_at, excluded.suppressed_at),
    last_opened_at = greatest(cloud_email_delivery_status.last_opened_at, excluded.last_opened_at),
    last_clicked_at = greatest(cloud_email_delivery_status.last_clicked_at, excluded.last_clicked_at),
    latest_event_type = case
      when excluded.latest_event_at >= cloud_email_delivery_status.latest_event_at
        then excluded.latest_event_type else cloud_email_delivery_status.latest_event_type end,
    latest_event_at = greatest(cloud_email_delivery_status.latest_event_at, excluded.latest_event_at),
    latest_diagnostic_data = case
      when excluded.latest_event_at >= cloud_email_delivery_status.latest_event_at
        then excluded.latest_diagnostic_data else cloud_email_delivery_status.latest_diagnostic_data end,
    updated_at = now();

  -- A bounce is suppressible only when Resend classified it Permanent.
  -- Transient/Undetermined bounces remain delivery telemetry. Complaints and
  -- provider suppressions are locally suppressible until operator resolution.
  if p_event_type = any (array['email.complained', 'email.suppressed'])
     or (p_event_type = 'email.bounced' and lower(coalesce(v_diagnostic ->> 'type', '')) = 'permanent') then
    v_reason := coalesce(
      nullif(v_diagnostic ->> 'type', ''),
      nullif(v_diagnostic ->> 'reason', ''),
      replace(p_event_type, 'email.', '')
    );

    foreach v_email in array v_to_emails loop
      insert into public.cloud_email_suppressions (
        email, reason, source_event_id, source_email_id,
        active, first_seen_at, last_seen_at, resolved_at
      ) values (
        v_email, left(v_reason, 200), btrim(p_event_id),
        btrim(p_provider_email_id), true, p_occurred_at, p_occurred_at, null
      )
      on conflict (email) do update set
        reason = excluded.reason,
        source_event_id = excluded.source_event_id,
        source_email_id = excluded.source_email_id,
        active = true,
        first_seen_at = least(cloud_email_suppressions.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(cloud_email_suppressions.last_seen_at, excluded.last_seen_at),
        resolved_at = null,
        updated_at = now();

      -- Deliverability and consent are different facts. A bounce/suppression
      -- blocks effective sends but does not rewrite the user's historical opt-in.
      -- A complaint is the one provider event that represents an explicit
      -- recipient rejection and therefore revokes marketing consent.
      if p_event_type = 'email.complained' then
        update public.cloud_marketing_email_preferences p
        set marketing_email_opt_in = false,
            unsubscribed_at = coalesce(p.unsubscribed_at, p_occurred_at),
            unsubscribed_source = left('resend_webhook:' || p_event_type, 200),
            updated_at = now()
        from auth.users u
        where p.user_id = u.id
          and lower(btrim(coalesce(u.email, ''))) = v_email
          and (
            p.marketing_email_opt_in
            or p.unsubscribed_at is null
            or p.unsubscribed_source is distinct from left('resend_webhook:' || p_event_type, 200)
          );
      end if;
    end loop;
  end if;

  return true;
end;
$function$;

revoke all on function public.norva_record_resend_email_event(
  text, text, text, timestamptz, text, text[], jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.norva_record_resend_email_event(
  text, text, text, timestamptz, text, text[], jsonb, jsonb
) to service_role;

-- A contact on the local delivery suppression list cannot become eligible for a
-- marketing send through a stale preference write. Resolution remains an
-- explicit service-role operation.
create or replace function public.norva_marketing_email_allowed(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
    from public.cloud_marketing_email_preferences p
    join auth.users u on u.id = p.user_id
    where p.user_id = p_user_id
      and p.marketing_email_opt_in is true
      and p.opted_in_at is not null
      and nullif(btrim(p.opted_in_source), '') is not null
      and p.unsubscribed_at is null
      and not exists (
        select 1 from public.admin_internal_accounts a where a.user_id = p_user_id
      )
      and not exists (
        select 1
        from public.cloud_email_suppressions s
        where s.email = lower(btrim(coalesce(u.email, '')))
          and s.active
      )
  );
$function$;

revoke all on function public.norva_marketing_email_allowed(uuid) from public, anon, authenticated;
grant execute on function public.norva_marketing_email_allowed(uuid) to service_role;

create or replace view public.cloud_email_delivery_daily
with (security_invoker = true)
as
select
  date_trunc('day', coalesce(sent_at, latest_event_at))::date as delivery_date,
  count(*)::bigint as messages,
  count(*) filter (where sent_at is not null)::bigint as sent,
  count(*) filter (where delivered_at is not null)::bigint as delivered,
  count(*) filter (where bounced_at is not null)::bigint as bounced,
  count(*) filter (where complained_at is not null)::bigint as complained,
  count(*) filter (where failed_at is not null)::bigint as failed,
  count(*) filter (where suppressed_at is not null)::bigint as suppressed,
  count(*) filter (where last_opened_at is not null)::bigint as opened,
  count(*) filter (where last_clicked_at is not null)::bigint as clicked
from public.cloud_email_delivery_status
group by 1;

revoke all on public.cloud_email_delivery_daily from public, anon, authenticated;
grant select on public.cloud_email_delivery_daily to service_role;

create or replace function public.norva_prune_resend_delivery_events()
returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_deleted bigint;
begin
  -- Raw webhook evidence is useful for incident investigation but contains
  -- recipient addresses and subjects, so keep it for only six months.
  delete from public.cloud_email_delivery_events
  where received_at < now() - interval '180 days';
  get diagnostics v_deleted = row_count;

  -- The compact per-message projection supports a full year of deliverability
  -- comparisons without retaining recipient-level history indefinitely.
  delete from public.cloud_email_delivery_status
  where latest_event_at < now() - interval '400 days';

  -- Resolved suppressions have no operational purpose after the cooling-off
  -- period. Active suppressions remain until an explicit resolution.
  delete from public.cloud_email_suppressions
  where not active
    and resolved_at < now() - interval '180 days';

  return v_deleted;
end;
$function$;

revoke all on function public.norva_prune_resend_delivery_events() from public, anon, authenticated;
grant execute on function public.norva_prune_resend_delivery_events() to service_role;

do $block$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule(
      'norva-resend-delivery-prune',
      '40 3 * * *',
      'select public.norva_prune_resend_delivery_events();'
    );
  end if;
exception when undefined_table or invalid_schema_name or insufficient_privilege then
  raise notice 'pg_cron unavailable; schedule norva_prune_resend_delivery_events manually';
end;
$block$;

notify pgrst, 'reload schema';
