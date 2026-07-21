-- Durable bridge from authoritative billing journals to the branded email outbox.
-- Provider/action code records one immutable cloud_entitlement_events row; this
-- trigger transactionally captures a minimal, non-PII email intent. The Edge
-- lifecycle producer later renders and freezes the exact multipart request.

create table if not exists public.cloud_lifecycle_billing_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_provider text not null,
  source_event_id text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'pending',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_attempt_at timestamptz,
  last_error text,
  lease_token uuid,
  lease_expires_at timestamptz,
  outbox_id uuid references public.cloud_branded_email_outbox(id) on delete cascade,
  queued_at timestamptz,
  dead_lettered_at timestamptz,
  payload_scrubbed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint cloud_lifecycle_billing_intents_source_check check (
    source_provider ~ '^[a-z0-9_:-]{1,50}$'
    and length(source_event_id) between 1 and 300
  ),
  constraint cloud_lifecycle_billing_intents_type_check check (event_type in (
    'cancellation_confirmed', 'subscription_resumed',
    'plan_change_scheduled', 'plan_change_applied',
    'payment_recovered', 'access_expired', 'refund_confirmed'
  )),
  constraint cloud_lifecycle_billing_intents_state_check check (
    state in ('pending','processing','queued','canceled','dead_letter')
  ),
  constraint cloud_lifecycle_billing_intents_payload_check check (
    jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192
  ),
  constraint cloud_lifecycle_billing_intents_attempt_check check (
    attempt_count between 0 and 30
  ),
  constraint cloud_lifecycle_billing_intents_lease_check check (
    (state = 'processing' and lease_token is not null and lease_expires_at is not null)
    or (state <> 'processing' and lease_token is null and lease_expires_at is null)
  ),
  constraint cloud_lifecycle_billing_intents_queue_check check (
    (state = 'queued' and outbox_id is not null and queued_at is not null)
    or state <> 'queued'
  ),
  unique (source_provider, source_event_id, event_type)
);

create index if not exists cloud_lifecycle_billing_intents_due_idx
  on public.cloud_lifecycle_billing_intents (next_attempt_at, created_at)
  where state in ('pending','processing');

alter table public.cloud_lifecycle_billing_intents enable row level security;
revoke all on table public.cloud_lifecycle_billing_intents from public, anon, authenticated;
grant all on table public.cloud_lifecycle_billing_intents to service_role;

create or replace function public.norva_insert_lifecycle_billing_intent(
  p_user_id uuid,
  p_source_provider text,
  p_source_event_id text,
  p_event_type text,
  p_payload jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare v_id uuid;
begin
  insert into public.cloud_lifecycle_billing_intents as i (
    user_id, source_provider, source_event_id, event_type, payload
  ) values (
    p_user_id,
    lower(btrim(p_source_provider)),
    btrim(p_source_event_id),
    lower(btrim(p_event_type)),
    jsonb_strip_nulls(coalesce(p_payload, '{}'::jsonb))
  )
  on conflict (source_provider, source_event_id, event_type) do update
    set updated_at = i.updated_at
  returning i.id into v_id;
  return v_id;
end
$function$;

-- One entitlement event can intentionally produce two emails (for example a
-- recovered renewal that also applies a scheduled plan change); the unique key
-- includes the normalized event_type so both remain exactly-once.
create or replace function public.norva_capture_lifecycle_billing_intent()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_source_id text := coalesce(nullif(btrim(new.provider_event_id), ''), new.id::text);
  v_raw_type text := upper(btrim(new.event_type));
  v_type text;
  v_payload jsonb := '{}'::jsonb;
  v_previous_status text := lower(coalesce(new.payload #>> '{_norva,previous_status}', ''));
  v_previous_plan text := lower(coalesce(new.payload #>> '{_norva,previous_plan}', ''));
  v_next_plan text := lower(coalesce(new.payload #>> '{_norva,next_plan}', ''));
begin
  -- Native Norva/Revolut events already carry their normalized contract.
  v_type := case v_raw_type
    when 'CANCELLATION_CONFIRMED' then 'cancellation_confirmed'
    when 'SUBSCRIPTION_RESUMED' then 'subscription_resumed'
    when 'PLAN_CHANGE_SCHEDULED' then 'plan_change_scheduled'
    when 'PLAN_CHANGE_APPLIED' then 'plan_change_applied'
    when 'PAYMENT_RECOVERED' then 'payment_recovered'
    when 'ACCESS_EXPIRED' then 'access_expired'
    when 'REFUND_CONFIRMED' then 'refund_confirmed'
    else null
  end;
  if v_type is not null then
    -- Freeze only fields used by the corresponding renderer. Never copy an
    -- arbitrary provider/action payload into the email pipeline.
    v_payload := case v_type
      when 'cancellation_confirmed' then jsonb_strip_nulls(jsonb_build_object(
        'effective_at', new.payload ->> 'effective_at'))
      when 'subscription_resumed' then jsonb_strip_nulls(jsonb_build_object(
        'renews_at', new.payload ->> 'renews_at'))
      when 'plan_change_scheduled' then jsonb_strip_nulls(jsonb_build_object(
        'plan_label', new.payload ->> 'plan_label',
        'effective_at', new.payload ->> 'effective_at'))
      when 'plan_change_applied' then jsonb_strip_nulls(jsonb_build_object(
        'plan_label', new.payload ->> 'plan_label'))
      when 'payment_recovered' then jsonb_strip_nulls(jsonb_build_object(
        'next_billing_at', new.payload ->> 'next_billing_at'))
      when 'refund_confirmed' then jsonb_strip_nulls(jsonb_build_object(
        'amount_cents', new.payload -> 'amount_cents',
        'currency', new.payload ->> 'currency',
        'reference', new.payload ->> 'reference'))
      else '{}'::jsonb
    end;
    perform public.norva_insert_lifecycle_billing_intent(
      new.user_id, lower(new.provider), v_source_id, v_type, v_payload
    );
    return new;
  end if;

  -- RevenueCat is also the Web Billing journal. Normalize only events whose
  -- semantics are authoritative; no inference from the mutable projection.
  if new.provider <> 'revenuecat' then return new; end if;

  if v_raw_type in ('CANCELLATION','SUBSCRIPTION_PAUSED') then
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'effective_at', coalesce(
        new.payload #>> '{_norva,current_period_end}',
        new.payload ->> 'expiration_at_ms'
      )
    ));
    perform public.norva_insert_lifecycle_billing_intent(
      new.user_id, 'revenuecat', v_source_id, 'cancellation_confirmed', v_payload
    );
  elsif v_raw_type = 'UNCANCELLATION' then
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'renews_at', coalesce(
        new.payload #>> '{_norva,current_period_end}',
        new.payload ->> 'expiration_at_ms'
      )
    ));
    perform public.norva_insert_lifecycle_billing_intent(
      new.user_id, 'revenuecat', v_source_id, 'subscription_resumed', v_payload
    );
  elsif v_raw_type = 'PRODUCT_CHANGE' then
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'plan_label', coalesce(new.payload ->> 'new_product_id', 'your new Norva plan'),
      'effective_at', new.payload ->> 'expiration_at_ms'
    ));
    perform public.norva_insert_lifecycle_billing_intent(
      new.user_id, 'revenuecat', v_source_id, 'plan_change_scheduled', v_payload
    );
  elsif v_raw_type = 'EXPIRATION' then
    perform public.norva_insert_lifecycle_billing_intent(
      new.user_id, 'revenuecat', v_source_id, 'access_expired', '{}'::jsonb
    );
  elsif v_raw_type in ('RENEWAL','INITIAL_PURCHASE','REFUND_REVERSED') then
    if v_previous_status in ('past_due','grace') then
      v_payload := jsonb_strip_nulls(jsonb_build_object(
        'next_billing_at', new.payload #>> '{_norva,current_period_end}'
      ));
      perform public.norva_insert_lifecycle_billing_intent(
        new.user_id, 'revenuecat', v_source_id, 'payment_recovered', v_payload
      );
    end if;
    if v_previous_status in ('active','cancelled_at_period_end')
       and v_previous_plan <> '' and v_next_plan <> '' and v_previous_plan <> v_next_plan then
      perform public.norva_insert_lifecycle_billing_intent(
        new.user_id, 'revenuecat', v_source_id, 'plan_change_applied',
        jsonb_build_object('plan_label', v_next_plan)
      );
    end if;
  end if;
  return new;
end
$function$;

drop trigger if exists norva_capture_lifecycle_billing_intent
  on public.cloud_entitlement_events;
create trigger norva_capture_lifecycle_billing_intent
after insert on public.cloud_entitlement_events
for each row execute function public.norva_capture_lifecycle_billing_intent();

-- User-initiated Revolut cancel/resume must update access and write the immutable
-- source event in one transaction. This closes the dual-write crash window where
-- the UI saw a 503 after the projection had already changed.
create or replace function public.norva_apply_revolut_account_action(
  p_user_id uuid,
  p_action text,
  p_event_id text,
  p_event_at timestamptz default clock_timestamp()
) returns table(status text, access_until timestamptz, event_id text, applied boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_projection public.cloud_entitlement_projection%rowtype;
  v_status text;
  v_until timestamptz;
  v_back_to text;
  v_existing_event text;
begin
  if p_action not in ('cancel','resume')
     or nullif(btrim(p_event_id),'') is null or length(p_event_id)>300 then
    raise exception 'invalid_revolut_account_action';
  end if;
  if exists (select 1 from public.admin_internal_accounts a where a.user_id=p_user_id) then
    raise exception 'internal_account_billing_disabled';
  end if;

  select * into v_projection from public.cloud_entitlement_projection p
  where p.user_id=p_user_id for update;
  if not found or v_projection.provider <> 'revolut' then
    raise exception 'no_revolut_subscription';
  end if;

  if p_action='cancel' then
    if v_projection.status='cancelled_at_period_end' then
      select e.provider_event_id into v_existing_event
      from public.cloud_entitlement_events e
      where e.user_id=p_user_id and e.provider='revolut'
        and e.event_type='CANCELLATION_CONFIRMED'
      order by e.processed_at desc nulls last,e.created_at desc limit 1;
      if v_existing_event is null then
        insert into public.cloud_entitlement_events(
          user_id,provider,provider_event_id,event_type,payload,processed_at
        ) values (
          p_user_id,'revolut',p_event_id,'CANCELLATION_CONFIRMED',
          jsonb_strip_nulls(jsonb_build_object('effective_at',v_projection.current_period_end)),p_event_at
        );
        v_existing_event:=p_event_id;
      end if;
      return query select v_projection.status,v_projection.current_period_end,v_existing_event,false;
      return;
    end if;
    if v_projection.status='trialing' then
      v_status:='cancelled_at_period_end';
      v_until:=coalesce(v_projection.trial_ends_at,p_event_at);
    elsif v_projection.status='active' then
      v_status:='cancelled_at_period_end';
      v_until:=v_projection.current_period_end;
    elsif v_projection.status in ('past_due','grace') then
      v_status:='expired';
      v_until:=null;
    else
      raise exception 'nothing_to_cancel';
    end if;
    update public.cloud_entitlement_projection p
    set status=v_status,current_period_end=coalesce(v_until,p.current_period_end),
        last_event_at=p_event_at
    where p.user_id=p_user_id;
    insert into public.cloud_entitlement_events(
      user_id,provider,provider_event_id,event_type,payload,processed_at
    ) values (
      p_user_id,'revolut',p_event_id,'CANCELLATION_CONFIRMED',
      jsonb_strip_nulls(jsonb_build_object('effective_at',v_until)),p_event_at
    );
    return query select v_status,v_until,p_event_id,true;
    return;
  end if;

  -- resume
  if v_projection.status <> 'cancelled_at_period_end' then
    select e.provider_event_id into v_existing_event
    from public.cloud_entitlement_events e
    where e.user_id=p_user_id and e.provider='revolut'
      and e.event_type='SUBSCRIPTION_RESUMED'
    order by e.processed_at desc nulls last,e.created_at desc limit 1;
    if v_existing_event is not null and v_projection.status in ('trialing','active') then
      return query select v_projection.status,v_projection.current_period_end,v_existing_event,false;
      return;
    end if;
    raise exception 'no_pending_cancellation';
  end if;
  if v_projection.current_period_end is null or v_projection.current_period_end <= p_event_at then
    raise exception 'subscription_already_ended';
  end if;
  v_back_to:=case when v_projection.trial_ends_at>p_event_at then 'trialing' else 'active' end;
  update public.cloud_entitlement_projection p
  set status=v_back_to,last_event_at=p_event_at where p.user_id=p_user_id;
  insert into public.cloud_entitlement_events(
    user_id,provider,provider_event_id,event_type,payload,processed_at
  ) values (
    p_user_id,'revolut',p_event_id,'SUBSCRIPTION_RESUMED',
    jsonb_build_object('renews_at',v_projection.current_period_end),p_event_at
  );
  return query select v_back_to,v_projection.current_period_end,p_event_id,true;
end
$function$;

create or replace function public.claim_lifecycle_billing_intents(
  p_batch integer default 25,
  p_lease_seconds integer default 90,
  p_max_attempts integer default 12
) returns table (
  id uuid, lease_token uuid, user_id uuid, source_provider text,
  source_event_id text, event_type text, payload jsonb, attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare v_now timestamptz := clock_timestamp();
begin
  update public.cloud_lifecycle_billing_intents i
  set state='canceled', last_error='internal_account_excluded',
      payload='{}'::jsonb, payload_scrubbed_at=v_now,
      lease_token=null, lease_expires_at=null, updated_at=v_now
  where i.state in ('pending','processing')
    and exists (select 1 from public.admin_internal_accounts a where a.user_id=i.user_id);

  update public.cloud_lifecycle_billing_intents i
  set state='dead_letter', dead_lettered_at=v_now,
      last_error='billing_intent_attempts_exhausted',
      lease_token=null,lease_expires_at=null,updated_at=v_now
  where i.state='processing' and i.lease_expires_at <= v_now
    and i.attempt_count >= greatest(1,least(coalesce(p_max_attempts,12),30));

  return query
  with due as (
    select i.id from public.cloud_lifecycle_billing_intents i
    where i.next_attempt_at <= v_now
      and ((i.state='pending' and i.attempt_count < greatest(1,least(coalesce(p_max_attempts,12),30)))
        or (i.state='processing' and i.lease_expires_at <= v_now
          and i.attempt_count < greatest(1,least(coalesce(p_max_attempts,12),30))))
    order by i.next_attempt_at, i.created_at, i.id
    limit greatest(1,least(coalesce(p_batch,25),100))
    for update skip locked
  ), claimed as (
    update public.cloud_lifecycle_billing_intents i
    set state='processing', lease_token=gen_random_uuid(),
        lease_expires_at=v_now+make_interval(secs=>greatest(30,least(coalesce(p_lease_seconds,90),300))),
        attempt_count=i.attempt_count+1, last_attempt_at=v_now, updated_at=v_now
    from due where i.id=due.id returning i.*
  )
  select c.id,c.lease_token,c.user_id,c.source_provider,c.source_event_id,
         c.event_type,c.payload,c.attempt_count
  from claimed c order by c.next_attempt_at,c.created_at,c.id;
end
$function$;

create or replace function public.complete_lifecycle_billing_intent(
  p_id uuid, p_lease_token uuid, p_outbox_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare v_changed integer;
begin
  update public.cloud_lifecycle_billing_intents i
  set state='queued', outbox_id=p_outbox_id, queued_at=clock_timestamp(),
      payload='{}'::jsonb,payload_scrubbed_at=clock_timestamp(),
      last_error=null, lease_token=null, lease_expires_at=null, updated_at=clock_timestamp()
  where i.id=p_id and i.state='processing' and i.lease_token=p_lease_token
    and exists (
      select 1 from public.cloud_branded_email_outbox o
      where o.id=p_outbox_id and o.user_id=i.user_id and o.flow=i.event_type
    );
  get diagnostics v_changed=row_count;
  return v_changed=1;
end
$function$;

create or replace function public.fail_lifecycle_billing_intent(
  p_id uuid, p_lease_token uuid, p_error text, p_retryable boolean default true,
  p_max_attempts integer default 12
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  i record; v_now timestamptz:=clock_timestamp(); v_terminal boolean; v_delay integer;
begin
  select * into i from public.cloud_lifecycle_billing_intents x
  where x.id=p_id and x.state='processing' and x.lease_token=p_lease_token for update;
  if not found then return 'lease_lost'; end if;
  v_terminal := not coalesce(p_retryable,false)
    or i.attempt_count >= greatest(1,least(coalesce(p_max_attempts,12),30));
  v_delay := least(21600,round(30*power(2::numeric,greatest(i.attempt_count-1,0)))::integer)
    + floor(random()*16)::integer;
  update public.cloud_lifecycle_billing_intents x
  set state=case when v_terminal then 'dead_letter' else 'pending' end,
      dead_lettered_at=case when v_terminal then v_now else null end,
      next_attempt_at=case when v_terminal then x.next_attempt_at else v_now+make_interval(secs=>v_delay) end,
      last_error=left(coalesce(nullif(p_error,''),'billing_intent_enqueue_failed'),1000),
      lease_token=null,lease_expires_at=null,updated_at=v_now
  where x.id=p_id and x.state='processing' and x.lease_token=p_lease_token;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$;

create or replace function public.prune_lifecycle_billing_intents()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare v_deleted integer;
begin
  update public.cloud_lifecycle_billing_intents i
  set payload='{}'::jsonb,payload_scrubbed_at=clock_timestamp(),updated_at=clock_timestamp()
  where i.state='dead_letter' and i.dead_lettered_at < clock_timestamp()-interval '14 days'
    and i.payload_scrubbed_at is null;
  delete from public.cloud_lifecycle_billing_intents i
  where (i.state='queued' and i.queued_at < clock_timestamp()-interval '90 days')
     or (i.state='dead_letter' and i.dead_lettered_at < clock_timestamp()-interval '90 days')
     or (i.state='canceled' and i.updated_at < clock_timestamp()-interval '90 days');
  get diagnostics v_deleted=row_count;
  return v_deleted;
end
$function$;

revoke all on function public.norva_insert_lifecycle_billing_intent(uuid,text,text,text,jsonb),
  public.norva_apply_revolut_account_action(uuid,text,text,timestamptz),
  public.claim_lifecycle_billing_intents(integer,integer,integer),
  public.complete_lifecycle_billing_intent(uuid,uuid,uuid),
  public.fail_lifecycle_billing_intent(uuid,uuid,text,boolean,integer),
  public.prune_lifecycle_billing_intents()
  from public,anon,authenticated;
revoke all on function public.norva_capture_lifecycle_billing_intent()
  from public,anon,authenticated;
grant execute on function public.norva_insert_lifecycle_billing_intent(uuid,text,text,text,jsonb),
  public.norva_apply_revolut_account_action(uuid,text,text,timestamptz),
  public.claim_lifecycle_billing_intents(integer,integer,integer),
  public.complete_lifecycle_billing_intent(uuid,uuid,uuid),
  public.fail_lifecycle_billing_intent(uuid,uuid,text,boolean,integer),
  public.prune_lifecycle_billing_intents()
  to service_role;

notify pgrst, 'reload schema';
