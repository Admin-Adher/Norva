-- Only NEW authoritative trials are notified. No historical replay/backfill.
begin;
create table public.cloud_trial_telegram_outbox (
  id bigint generated always as identity primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  provider text not null,
  plan_code text not null,
  started_at timestamptz not null,
  ends_at timestamptz not null,
  state text not null default 'pending' check (state in ('pending','processing','sent','dead_letter')),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  message_id bigint,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
alter table public.cloud_trial_telegram_outbox enable row level security;
revoke all on public.cloud_trial_telegram_outbox from public, anon, authenticated;
grant select on public.cloud_trial_telegram_outbox to service_role;
create index cloud_trial_telegram_pending on public.cloud_trial_telegram_outbox(next_attempt_at) where state in ('pending','processing');

create function public.norva_enqueue_trial_telegram() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_secret text; v_id bigint;
begin
  if new.status <> 'trialing' or new.trial_consumed_at is null
     or new.trial_ends_at is null or new.trial_ends_at <= clock_timestamp()
     or new.provider = 'manual' then return new; end if;
  -- A replay, transfer or refresh of an already known trial is not a new start.
  if tg_op = 'UPDATE' then
    if old.trial_consumed_at is not null then return new; end if;
  end if;
  if exists (select 1 from public.admin_internal_accounts where user_id = new.user_id) then return new; end if;
  insert into public.cloud_trial_telegram_outbox(user_id,provider,plan_code,started_at,ends_at)
  values(new.user_id,new.provider,new.plan_code,new.trial_consumed_at,new.trial_ends_at)
  on conflict(user_id) do nothing returning id into v_id;
  if v_id is not null then
    begin
      select decrypted_secret into v_secret from vault.decrypted_secrets where name='norva_cron_shared_secret' limit 1;
      if nullif(v_secret,'') is not null then
        perform net.http_post(url := 'https://api.norva.tv/functions/v1/norva-signup-notify/cron/drain',
          headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_secret),
          body := '{}'::jsonb, timeout_milliseconds := 5000);
      end if;
    exception when others then raise warning 'Trial Telegram wake failed SQLSTATE %', sqlstate;
    end;
  end if;
  return new;
exception when others then
  -- Never roll back an entitlement/payment because telemetry is unavailable.
  raise warning 'Trial Telegram enqueue failed SQLSTATE %', sqlstate;
  return new;
end $$;
revoke all on function public.norva_enqueue_trial_telegram() from public, anon, authenticated;
create trigger norva_trial_telegram_after_write after insert or update on public.cloud_entitlement_projection
for each row execute function public.norva_enqueue_trial_telegram();

create function public.claim_trial_telegram_deliveries() returns setof public.cloud_trial_telegram_outbox
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.cloud_trial_telegram_outbox set state='dead_letter', lease_token=null, lease_until=null,
    last_error='attempt_limit' where state in ('pending','processing') and attempt_count >= 12
    and coalesce(lease_until,'-infinity'::timestamptz) < now();
  return query with candidates as (
    select id from public.cloud_trial_telegram_outbox
    where state in ('pending','processing') and next_attempt_at <= now()
      and coalesce(lease_until,'-infinity'::timestamptz) < now() and attempt_count < 12
    order by id for update skip locked limit 5
  ) update public.cloud_trial_telegram_outbox o set state='processing', lease_token=gen_random_uuid(),
    lease_until=now()+interval '90 seconds', attempt_count=attempt_count+1
    from candidates c where o.id=c.id returning o.*;
end $$;

create function public.finish_trial_telegram_delivery(p_id bigint,p_lease uuid,p_message_id bigint,
  p_retryable boolean default true,p_retry_after integer default 60,p_error text default null) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_count integer;
begin
  update public.cloud_trial_telegram_outbox set
    state=case when p_message_id > 0 then 'sent' when not p_retryable or attempt_count >= 12 then 'dead_letter' else 'pending' end,
    message_id=case when p_message_id > 0 then p_message_id else null end,
    sent_at=case when p_message_id > 0 then now() else null end,
    next_attempt_at=now()+make_interval(secs=>greatest(30,least(21600,coalesce(p_retry_after,60)),least(21600,(30*power(2,attempt_count))::integer))),
    lease_token=null,lease_until=null,last_error=left(regexp_replace(coalesce(p_error,''),'[^a-zA-Z0-9_:-]','','g'),80)
    where id=p_id and state='processing' and lease_token=p_lease and lease_until>now();
  get diagnostics v_count = row_count;
  return v_count=1;
end $$;
revoke all on function public.claim_trial_telegram_deliveries(),
  public.finish_trial_telegram_delivery(bigint,uuid,bigint,boolean,integer,text) from public,anon,authenticated;
grant execute on function public.claim_trial_telegram_deliveries(),
  public.finish_trial_telegram_delivery(bigint,uuid,bigint,boolean,integer,text) to service_role;
create function public.trial_telegram_delivery_health() returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('pending',count(*) filter(where state='pending'),
    'processing',count(*) filter(where state='processing'),
    'dead_letter',count(*) filter(where state='dead_letter'),
    'sent_24h',count(*) filter(where state='sent' and sent_at>now()-interval '24 hours'),
    'oldest_pending_seconds',coalesce(extract(epoch from now()-min(created_at) filter(where state in ('pending','processing'))),0))
  from public.cloud_trial_telegram_outbox
$$;
revoke all on function public.trial_telegram_delivery_health() from public,anon,authenticated;
grant execute on function public.trial_telegram_delivery_health() to service_role;
commit;
