-- Lifecycle delivery hardening.
--
-- Reuse the minutely branded-email outbox/worker for welcome, dunning and
-- consent-gated marketing. The rendered Resend request is immutable; business
-- markers are advanced only in complete_branded_email_delivery(), after a 2xx
-- response carrying an email id. The schema is deliberately generic enough for
-- billing event emails, but this migration does not attach any billing-store
-- trigger (avoids duplicate sends while Web/Revolut producers are calibrated).

alter table public.cloud_branded_email_outbox
  add column if not exists is_marketing boolean not null default false,
  add column if not exists request_headers jsonb not null default '{}'::jsonb,
  add column if not exists marker_kind text,
  add column if not exists marker_reference text,
  add column if not exists marker_stage smallint,
  add column if not exists transport_started_at timestamptz,
  add column if not exists payload_scrubbed_at timestamptz;

alter table public.cloud_trial_reminder_deliveries
  add column if not exists delivered_at timestamptz;

alter table public.cloud_branded_email_outbox
  alter column request_reply_to drop not null,
  alter column request_subject drop not null;

alter table public.cloud_branded_email_outbox
  drop constraint if exists cloud_branded_email_outbox_state_check,
  drop constraint if exists cloud_branded_email_tags_check,
  drop constraint if exists cloud_branded_email_payload_check;

alter table public.cloud_branded_email_outbox
  add constraint cloud_branded_email_outbox_state_check
    check (state in ('pending', 'processing', 'sent', 'canceled', 'dead_letter')),
  add constraint cloud_branded_email_marker_check check (
    marker_kind is null
    or marker_kind in ('welcome', 'dunning', 'winback', 'abandoned', 'billing_event')
  ),
  add constraint cloud_branded_email_marker_stage_check check (
    (marker_kind = 'dunning' and marker_stage between 1 and 3)
    or (marker_kind is distinct from 'dunning' and marker_stage is null)
  ),
  add constraint cloud_branded_email_headers_check check (
    jsonb_typeof(request_headers) = 'object'
  ),
  add constraint cloud_branded_email_tags_check check (
    jsonb_typeof(request_tags) = 'array'
    and jsonb_array_length(request_tags) = 3
    and request_tags -> 0 = jsonb_build_object('name','app','value','norva')
    and request_tags -> 1 = jsonb_build_object(
      'name','category','value',case when is_marketing then 'marketing' else 'transactional' end
    )
    and request_tags -> 2 = jsonb_build_object('name','flow','value',flow)
  ),
  add constraint cloud_branded_email_payload_check check (
    (state in ('pending', 'processing')
      and recipient_email is not null and request_reply_to is not null
      and request_subject is not null and request_html is not null and request_text is not null)
    or state = 'dead_letter'
    or (state in ('sent', 'canceled')
      and recipient_email is null and request_reply_to is null
      and request_subject is null and request_html is null and request_text is null
      and request_headers = '{}'::jsonb)
  );

-- Minimize older successful rows to the new standard immediately.
update public.cloud_branded_email_outbox
set request_reply_to = null,
    request_subject = null,
    request_headers = '{}'::jsonb,
    payload_scrubbed_at = coalesce(payload_scrubbed_at, clock_timestamp())
where state = 'sent';

comment on column public.cloud_branded_email_outbox.marker_kind is
  'Business acknowledgement applied atomically only after Resend acceptance.';
comment on column public.cloud_branded_email_outbox.request_headers is
  'Frozen Resend headers; marketing rows carry RFC8058 List-Unsubscribe headers.';

create or replace function public.norva_enqueue_lifecycle_email(
  p_user_id uuid,
  p_flow text,
  p_dedupe_key text,
  p_recipient_email text,
  p_request_from text,
  p_request_reply_to text,
  p_request_subject text,
  p_request_html text,
  p_request_text text,
  p_request_tags jsonb,
  p_request_headers jsonb default '{}'::jsonb,
  p_marketing boolean default false,
  p_marker_kind text default null,
  p_marker_reference text default null,
  p_marker_stage smallint default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_id uuid := gen_random_uuid();
  v_existing record;
  v_email text := lower(btrim(coalesce(p_recipient_email, '')));
  v_auth_email text;
  v_flow text := lower(btrim(coalesce(p_flow, '')));
  v_dedupe text := lower(btrim(coalesce(p_dedupe_key, '')));
  v_marker text := nullif(lower(btrim(coalesce(p_marker_kind, ''))), '');
  v_headers jsonb := coalesce(p_request_headers, '{}'::jsonb);
begin
  select lower(btrim(u.email)) into v_auth_email
  from auth.users u where u.id = p_user_id;

  if p_user_id is null or v_auth_email is null or v_email <> v_auth_email
     or exists (select 1 from public.admin_internal_accounts a where a.user_id = p_user_id)
     or v_email !~ '^[^@[:space:]<>]+@[^@[:space:]<>]+$'
     or length(v_email) > 320
     or v_flow !~ '^[a-z0-9_]{1,50}$'
     or v_dedupe !~ '^[a-z0-9:_-]{1,200}$'
     or nullif(btrim(coalesce(p_request_from, '')), '') is null
     or nullif(btrim(coalesce(p_request_reply_to, '')), '') is null
     or nullif(btrim(coalesce(p_request_subject, '')), '') is null
     or length(p_request_subject) > 500
     or nullif(coalesce(p_request_html, ''), '') is null
     or length(p_request_html) > 200000
     or nullif(coalesce(p_request_text, ''), '') is null
     or length(p_request_text) > 50000
     or jsonb_typeof(p_request_tags) is distinct from 'array'
     or jsonb_array_length(p_request_tags) <> 3
     or p_request_tags -> 0 <> jsonb_build_object('name','app','value','norva')
     or p_request_tags -> 1 <> jsonb_build_object(
       'name','category','value',case when p_marketing then 'marketing' else 'transactional' end
     )
     or p_request_tags -> 2 <> jsonb_build_object('name','flow','value',v_flow)
     or jsonb_typeof(v_headers) is distinct from 'object'
     or v_headers - 'List-Unsubscribe' - 'List-Unsubscribe-Post' <> '{}'::jsonb then
    raise exception 'invalid_lifecycle_email_payload';
  end if;

  if p_marketing then
    if not public.norva_marketing_email_allowed(p_user_id)
       or nullif(v_headers->>'List-Unsubscribe', '') is null
       or v_headers->>'List-Unsubscribe-Post' <> 'List-Unsubscribe=One-Click' then
      raise exception 'lifecycle_marketing_not_allowed';
    end if;
  elsif v_headers <> '{}'::jsonb then
    raise exception 'transactional_lifecycle_headers_not_allowed';
  end if;

  if (v_marker = 'welcome' and v_flow <> 'welcome')
     or (v_marker = 'dunning' and (v_flow <> 'payment_failed' or p_marker_stage not between 1 and 3))
     or (v_marker = 'winback' and (v_flow <> 'winback' or not p_marketing))
     or (v_marker = 'abandoned' and (v_flow <> 'checkout_abandoned' or not p_marketing
         or nullif(btrim(coalesce(p_marker_reference, '')), '') is null))
     or (v_marker = 'billing_event' and p_marketing)
     or v_marker not in ('welcome', 'dunning', 'winback', 'abandoned', 'billing_event') then
    raise exception 'invalid_lifecycle_marker';
  end if;

  insert into public.cloud_branded_email_outbox as o (
    id, delivery_key, dedupe_key, user_id, flow, state, is_marketing,
    recipient_email, request_from, request_reply_to, request_subject,
    request_html, request_text, request_tags, request_headers,
    marker_kind, marker_reference, marker_stage, next_attempt_at
  ) values (
    v_id, 'norva-branded-' || v_id::text, v_dedupe, p_user_id, v_flow, 'pending', p_marketing,
    v_email, btrim(p_request_from), lower(btrim(p_request_reply_to)), btrim(p_request_subject),
    p_request_html, p_request_text, p_request_tags, v_headers,
    v_marker, nullif(btrim(coalesce(p_marker_reference, '')), ''), p_marker_stage,
    clock_timestamp()
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning o.id, o.state, o.flow, o.user_id, o.is_marketing into v_existing;

  if not found then
    select o.id, o.state, o.flow, o.user_id, o.is_marketing into v_existing
    from public.cloud_branded_email_outbox o where o.dedupe_key = v_dedupe;
  end if;
  if v_existing.id is null then raise exception 'lifecycle_email_enqueue_failed'; end if;
  if v_existing.user_id is distinct from p_user_id
     or v_existing.flow <> v_flow
     or v_existing.is_marketing is distinct from p_marketing then
    raise exception 'lifecycle_dedupe_key_conflict';
  end if;

  return jsonb_build_object(
    'id', v_existing.id,
    'state', v_existing.state,
    'deduped', v_existing.id <> v_id
  );
end
$function$;

-- Final eligibility/consent gate immediately before the provider request.
-- A no-longer-relevant row is canceled and scrubbed, never silently sent.
create or replace function public.authorize_branded_email_delivery(
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
      select 1 from public.cloud_entitlement_projection e
      where e.user_id = o.user_id and e.welcome_email_at is null
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

-- The lifecycle-aware worker returns additional OUT columns compared with the
-- base durable worker installed by 20260721235400. PostgreSQL cannot change a
-- function's table return type through CREATE OR REPLACE, so replace the
-- signature explicitly while preserving the same input contract.
drop function if exists public.claim_branded_email_deliveries(integer, integer, integer);

create function public.claim_branded_email_deliveries(
  p_batch integer default 4,
  p_lease_seconds integer default 90,
  p_max_attempts integer default 12
) returns table (
  id uuid, delivery_key text, lease_token uuid, flow text, user_id uuid,
  is_marketing boolean, marker_kind text, marker_reference text, marker_stage smallint,
  recipient_email text, request_from text, request_reply_to text, request_subject text,
  request_html text, request_text text, request_tags jsonb, request_headers jsonb,
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  update public.cloud_branded_email_outbox o
  set state = 'dead_letter', dead_lettered_at = v_now,
      last_error = 'ambiguous_delivery_after_idempotency_window',
      lease_token = null, lease_expires_at = null, updated_at = v_now
  where o.state in ('pending', 'processing')
    and o.transport_started_at <= v_now - interval '23 hours';

  return query
  with due as (
    select o.id from public.cloud_branded_email_outbox o
    where o.next_attempt_at <= v_now
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
$function$;

create or replace function public.complete_branded_email_delivery(
  p_id uuid, p_delivery_key text, p_lease_token uuid, p_resend_email_id text,
  p_http_status integer, p_response jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  o record;
  v_now timestamptz := clock_timestamp();
begin
  if p_http_status not between 200 and 299 or nullif(btrim(p_resend_email_id),'') is null then
    raise exception 'successful Resend status and email id are required';
  end if;
  select * into o from public.cloud_branded_email_outbox x
  where x.id=p_id and x.delivery_key=p_delivery_key
    and x.state='processing' and x.lease_token=p_lease_token
  for update;
  if not found then return false; end if;

  update public.cloud_branded_email_outbox x
  set state='sent', resend_email_id=left(btrim(p_resend_email_id),200),
      resend_response=coalesce(p_response,'{}'::jsonb), last_http_status=p_http_status,
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
$function$;

create or replace function public.fail_branded_email_delivery(
  p_id uuid, p_delivery_key text, p_lease_token uuid, p_http_status integer,
  p_error text, p_response jsonb default '{}'::jsonb, p_retryable boolean default true,
  p_retry_after_seconds integer default null, p_max_attempts integer default 12,
  p_ambiguous boolean default false
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  o record;
  v_delay integer;
  v_window_terminal boolean;
  v_terminal boolean;
begin
  select * into o from public.cloud_branded_email_outbox x
  where x.id=p_id and x.delivery_key=p_delivery_key
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
      resend_response=coalesce(p_response,'{}'::jsonb), last_http_status=p_http_status,
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
$function$;

create or replace function public.defer_branded_email_delivery(
  p_id uuid, p_delivery_key text, p_lease_token uuid, p_retry_after_seconds integer default 60
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare v_changed integer;
begin
  update public.cloud_branded_email_outbox o
  set state='pending', attempt_count=greatest(0,o.attempt_count-1),
      transport_started_at=case when o.attempt_count<=1 then null else o.transport_started_at end,
      next_attempt_at=clock_timestamp()+make_interval(secs=>greatest(1,least(coalesce(p_retry_after_seconds,60),21600))),
      last_http_status=429, last_error='resend_team_rate_limited_before_send',
      resend_response='{"name":"team_rate_limited"}'::jsonb,
      lease_token=null, lease_expires_at=null, updated_at=clock_timestamp()
  where o.id=p_id and o.delivery_key=p_delivery_key
    and o.state='processing' and o.lease_token=p_lease_token;
  get diagnostics v_changed=row_count;
  return v_changed=1;
end
$function$;

create or replace function public.prune_branded_email_outbox()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare v_deleted integer;
begin
  update public.cloud_branded_email_outbox o
  set recipient_email=null, request_reply_to=null, request_subject=null,
      request_html=null, request_text=null, request_headers='{}'::jsonb,
      resend_response='{}'::jsonb, payload_scrubbed_at=clock_timestamp(), updated_at=clock_timestamp()
  where o.state='dead_letter' and o.dead_lettered_at < clock_timestamp()-interval '14 days'
    and o.payload_scrubbed_at is null;
  delete from public.cloud_branded_email_outbox o
  where (o.state='sent' and o.sent_at < clock_timestamp()-interval '90 days')
     or (o.state='dead_letter' and o.dead_lettered_at < clock_timestamp()-interval '90 days')
     or (o.state='canceled' and o.updated_at < clock_timestamp()-interval '90 days');
  get diagnostics v_deleted=row_count;
  return v_deleted;
end
$function$;

revoke all on function public.norva_enqueue_lifecycle_email(uuid,text,text,text,text,text,text,text,text,jsonb,jsonb,boolean,text,text,smallint),
  public.authorize_branded_email_delivery(uuid,text,uuid),
  public.claim_branded_email_deliveries(integer,integer,integer),
  public.fail_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer,boolean),
  public.defer_branded_email_delivery(uuid,text,uuid,integer)
  from public, anon, authenticated;
grant execute on function public.norva_enqueue_lifecycle_email(uuid,text,text,text,text,text,text,text,text,jsonb,jsonb,boolean,text,text,smallint),
  public.authorize_branded_email_delivery(uuid,text,uuid),
  public.claim_branded_email_deliveries(integer,integer,integer),
  public.fail_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer,boolean),
  public.defer_branded_email_delivery(uuid,text,uuid,integer)
  to service_role;

-- Recreate the J-3/J-1 producer without advancing either delivery state or the
-- shared projection marker at enqueue time. The worker acknowledgement above
-- finalizes both in one transaction.
create or replace function public.norva_send_trial_ending_reminders(p_days_before int)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $function$
declare
  r record; v_claimed uuid; v_delivery uuid; v_count integer:=0;
  v_when text; v_subject text; v_heading text; v_intro text;
  v_cta_label text; v_cta_url text; v_footer text; v_dedupe text;
begin
  if p_days_before not in (1,3) then return 0; end if;
  v_when:=case when p_days_before=1 then 'tomorrow' else 'in 3 days' end;
  for r in
    select e.user_id,e.provider,e.trial_ends_at,u.email
    from public.cloud_entitlement_projection e join auth.users u on u.id=e.user_id
    where e.status='trialing' and e.provider in ('revolut','manual','system')
      and e.trial_ends_at is not null
      and (e.trial_ends_at at time zone 'UTC')::date=(clock_timestamp() at time zone 'UTC')::date+p_days_before
      and nullif(btrim(u.email::text),'') is not null
      and not exists(select 1 from public.admin_internal_accounts a where a.user_id=e.user_id)
    order by e.trial_ends_at,e.user_id for update of e skip locked
  loop
    v_claimed:=null;
    insert into public.cloud_trial_reminder_deliveries(user_id,trial_ends_at,days_before,provider)
    values(r.user_id,r.trial_ends_at,p_days_before,r.provider)
    on conflict(user_id,trial_ends_at,days_before) do nothing returning user_id into v_claimed;
    if v_claimed is null then continue; end if;
    if r.provider='revolut' then
      v_subject:='Your Norva free trial ends '||v_when;
      v_heading:=case when p_days_before=1 then 'Your trial ends tomorrow' else 'Your trial ends in 3 days' end;
      v_intro:='Your Norva free trial ends '||v_when||'. Your subscription will renew automatically when the trial ends, so your access continues without interruption. Nothing to do if you want to keep watching. You can cancel before renewal and you will not be charged.';
      v_cta_label:='Manage my plan'; v_cta_url:='https://norva.tv/subscription.html';
      v_footer:='Cancel anytime from Settings before the trial ends. Questions? support@norva.tv.';
    else
      v_subject:='Your Norva trial access ends '||v_when;
      v_heading:=case when p_days_before=1 then 'Your trial access ends tomorrow' else 'Your trial access ends in 3 days' end;
      v_intro:='Your Norva trial access ends '||v_when||'. This trial will not renew automatically and no automatic charge will be made. Choose a plan if you would like to keep watching after it ends.';
      v_cta_label:='See plans'; v_cta_url:='https://norva.tv/subscribe.html';
      v_footer:='No automatic charge will be made for this trial. Questions? support@norva.tv.';
    end if;
    v_dedupe:='trial_ending:'||encode(digest(r.user_id::text||':'||r.trial_ends_at::text||':'||p_days_before::text,'sha256'),'hex');
    v_delivery:=public.norva_enqueue_branded_email(r.email::text,v_subject,v_heading,v_intro,
      v_cta_label,v_cta_url,v_footer,'trial_ending',v_dedupe,r.user_id);
    update public.cloud_trial_reminder_deliveries d set email_delivery_id=v_delivery
    where d.user_id=r.user_id and d.trial_ends_at=r.trial_ends_at and d.days_before=p_days_before;
    v_count:=v_count+1;
  end loop;
  return v_count;
end
$function$;

notify pgrst, 'reload schema';
