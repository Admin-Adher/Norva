-- Unknown/default UTC is not device evidence. No audience activation.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $baseline$
declare row record; actual text;
begin
  if not exists(select 1 from public.behavioral_lifecycle_runtime where singleton and emergency_stop)
     or exists(select 1 from public.behavioral_lifecycle_journeys where status<>'draft' or rollout_percent<>0) then
    raise exception 'Review active journeys before timezone migration';
  end if;
  for row in select * from (values
    ('public.norva_register_push_token(uuid,text,text,text,text,text,text)','6588a6990946e1e9d241e3f3e98ce0d2'),
    ('public.norva_seed_behavioral_lifecycle_jobs(integer)','953b3ae0c6c6b6f441a86241584cec2f'),
    ('public.norva_behavioral_delivery_eligible(uuid,timestamptz)','ccb72b228835da87c01579813c38bf1d')
  ) as expected(signature,hash)
  loop
    select md5(replace(prosrc,chr(13),'')) into actual from pg_proc where oid=to_regprocedure(row.signature);
    if actual is distinct from row.hash then raise exception 'Timezone function baseline drift: %',row.signature; end if;
  end loop;
end;
$baseline$;
alter table public.behavioral_lifecycle_user_state
  add column timezone_source text not null default 'unknown'
    check(timezone_source in ('unknown','device','legacy_device')),
  add column timezone_observed_at timestamptz;
-- Only non-default, valid timezone reports matching an actual versioned token
-- can establish legacy provenance. No inference from country or IP address.
update public.behavioral_lifecycle_user_state s
set timezone_source='legacy_device', timezone_observed_at=t.seen_at
from (
 select user_id, timezone, max(last_seen_at) as seen_at
 from public.cloud_push_tokens
 where app_version is not null and timezone not in ('UTC','Etc/UTC','GMT','Etc/GMT')
   and exists(select 1 from pg_catalog.pg_timezone_names z where z.name=timezone)
 group by user_id,timezone
) t
where s.user_id=t.user_id and s.timezone=t.timezone;

create function public.norva_behavioral_timezone_verified(p_user_id uuid)
returns boolean language sql stable security definer set search_path=''
as $function$
 select exists (
  select 1 from public.behavioral_lifecycle_user_state s
  where s.user_id=p_user_id and s.timezone_source in ('device','legacy_device')
    and s.timezone_observed_at >= clock_timestamp()-interval '45 days'
    and s.timezone_observed_at <= clock_timestamp()+interval '5 minutes'
    and exists(select 1 from pg_catalog.pg_timezone_names z where z.name=s.timezone)
 );
$function$;
revoke all on function public.norva_behavioral_timezone_verified(uuid) from public,anon,authenticated;
grant execute on function public.norva_behavioral_timezone_verified(uuid) to service_role;

create or replace function public.norva_register_push_token(
  p_user_id uuid,
  p_token text,
  p_platform text,
  p_permission_state text,
  p_timezone text,
  p_locale text,
  p_app_version text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(
    nullif(auth.jwt() ->> 'role', ''),
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), 'none'),
    ''
  );
  v_platform text := lower(btrim(coalesce(p_platform, 'android')));
  v_permission text := lower(btrim(coalesce(p_permission_state, 'unknown')));
  v_timezone text := btrim(coalesce(p_timezone, ''));
  v_timezone_verified boolean := false;
  v_locale text := nullif(btrim(coalesce(p_locale, '')), '');
  v_version text := nullif(btrim(coalesce(p_app_version, '')), '');
  v_registered_at timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if p_user_id is null or nullif(btrim(coalesce(p_token, '')), '') is null
     or char_length(p_token) > 4096 then
    raise exception 'invalid push token' using errcode = '22023';
  end if;
  if v_platform not in ('android', 'ios', 'web') then v_platform := 'android'; end if;
  if v_permission not in ('unknown', 'prompt', 'granted', 'denied') then v_permission := 'unknown'; end if;
  v_timezone_verified := exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone);
  if not v_timezone_verified then
    v_timezone := 'UTC';
  end if;
  if v_locale !~ '^[A-Za-z0-9_-]{2,35}$' then v_locale := null; end if;
  if v_version !~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$' then v_version := null; end if;
  select u.created_at into v_registered_at from auth.users u where u.id = p_user_id;
  if v_registered_at is null then
    raise exception 'push token owner missing' using errcode = '23503';
  end if;

  insert into public.cloud_push_tokens (
    token, user_id, platform, permission_state, permission_updated_at,
    timezone, locale, app_version, updated_at, last_seen_at
  ) values (
    p_token, p_user_id, v_platform, v_permission, v_now,
    v_timezone, v_locale, v_version, v_now, v_now
  )
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        permission_state = excluded.permission_state,
        permission_updated_at = excluded.permission_updated_at,
        timezone = excluded.timezone,
        locale = excluded.locale,
        app_version = excluded.app_version,
        updated_at = v_now,
        last_seen_at = v_now;

  insert into public.behavioral_lifecycle_user_state (
    user_id, registered_at, signup_platform, locale, timezone, app_version, updated_at, timezone_source, timezone_observed_at
  ) values (
    p_user_id, v_registered_at,
    case when v_platform = 'android' then 'mobile_android' else case when v_platform = 'web' then 'web' else 'unknown' end end,
    v_locale, v_timezone, v_version, v_now,
    case when v_timezone_verified then 'device' else 'unknown' end,
    case when v_timezone_verified then v_now else null end
  )
  on conflict (user_id) do update
    set signup_platform = case
          when excluded.signup_platform <> 'unknown' then excluded.signup_platform
          else public.behavioral_lifecycle_user_state.signup_platform
        end,
        locale = coalesce(excluded.locale, public.behavioral_lifecycle_user_state.locale),
        timezone = case when v_timezone_verified then excluded.timezone else public.behavioral_lifecycle_user_state.timezone end,
        timezone_source = case when v_timezone_verified then 'device' else public.behavioral_lifecycle_user_state.timezone_source end,
        timezone_observed_at = case when v_timezone_verified then v_now else public.behavioral_lifecycle_user_state.timezone_observed_at end,
        app_version = coalesce(excluded.app_version, public.behavioral_lifecycle_user_state.app_version),
        updated_at = v_now;

  return jsonb_build_object('ok', true, 'permission_state', v_permission);
end;
$function$;

create or replace function public.norva_seed_behavioral_lifecycle_jobs(
  p_batch integer default 500
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(
    nullif(auth.jwt() ->> 'role', ''),
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), 'none'),
    ''
  );
  v_inserted integer := 0;
  v_holdout integer := 0;
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;

  with eligible as (
    select
      s.user_id, j.journey_key, j.version, j.rollout_percent, j.holdout_percent,
      j.cooldown_days,
      j.quiet_start_hour, j.quiet_end_hour, st.step_key, st.ordinal, st.channel,
      st.delay_minutes, st.title, st.body, st.cta_label, st.deep_link,
      st.ttl_seconds, st.collapse_key, st.is_marketing, st.requires_new_content,
      s.timezone,
      public.norva_behavioral_trigger_at(s.user_id, j.journey_key) as triggered_at,
      public.norva_behavioral_bucket(
        s.user_id, j.journey_key || ':rollout:' || j.version::text
      ) as rollout_bucket,
      public.norva_behavioral_bucket(
        s.user_id, j.journey_key || ':holdout'
      ) as holdout_bucket
    from public.behavioral_lifecycle_user_state s
    join public.behavioral_lifecycle_journeys j
      on j.status = 'active' and j.rollout_percent > 0
    join public.behavioral_lifecycle_steps st
      on st.journey_key = j.journey_key and st.enabled
    where public.norva_behavioral_journey_relevant(
      s.user_id, j.journey_key, clock_timestamp()
    )
      and (st.channel = 'in_app' or public.norva_behavioral_timezone_verified(s.user_id))
      and public.norva_behavioral_bucket(
        s.user_id, j.journey_key || ':rollout:' || j.version::text
      ) < j.rollout_percent * 100
  ), candidates as (
    select e.*
    from eligible e
    where e.triggered_at is not null
      and not exists (
        select 1
        from public.behavioral_lifecycle_outbox o
        where o.dedupe_key = e.journey_key || ':' || e.version::text || ':' ||
          e.user_id::text || ':' || e.step_key || ':' ||
          extract(epoch from e.triggered_at)::bigint::text
      )
    order by e.is_marketing, e.triggered_at, e.user_id, e.ordinal
    limit greatest(1, least(coalesce(p_batch, 500), 5000))
  ), timed as (
    select c.*,
      case
        when c.holdout_bucket < c.holdout_percent * 100 then 'holdout'
        else 'treatment'
      end as arm,
      case
        when c.channel = 'in_app' then c.triggered_at + make_interval(mins => c.delay_minutes)
        else public.norva_behavioral_next_allowed_at(
          c.triggered_at + make_interval(mins => c.delay_minutes),
          c.timezone, c.quiet_start_hour, c.quiet_end_hour
        )
      end as base_allowed_at
    from candidates c
  ), prepared as (
    select t.*,
      greatest(
        t.base_allowed_at,
        coalesce((
          select max(coalesce(o.delivered_at, o.provider_accepted_at))
            + make_interval(days => t.cooldown_days)
          from public.behavioral_lifecycle_outbox o
          where o.user_id = t.user_id
            and o.journey_key = t.journey_key
            and o.triggered_at < t.triggered_at
            and o.status in ('provider_accepted', 'delivered', 'opened')
        ), t.base_allowed_at)
      ) as allowed_at
    from timed t
  ), inserted as (
    insert into public.behavioral_lifecycle_outbox (
      dedupe_key, user_id, journey_key, step_key, config_version, channel,
      status, experiment_arm, title, body, cta_label, deep_link,
      ttl_seconds, collapse_key, is_marketing, requires_new_content,
      triggered_at, scheduled_for, expires_at, next_attempt_at
    )
    select
      p.journey_key || ':' || p.version::text || ':' || p.user_id::text || ':' ||
        p.step_key || ':' || extract(epoch from p.triggered_at)::bigint::text,
      p.user_id, p.journey_key, p.step_key, p.version, p.channel,
      case when p.arm = 'holdout' then 'holdout' else 'pending' end,
      p.arm, p.title, p.body, p.cta_label, p.deep_link,
      p.ttl_seconds, p.collapse_key, p.is_marketing, p.requires_new_content,
      p.triggered_at, p.allowed_at,
      p.allowed_at + make_interval(secs => p.ttl_seconds), p.allowed_at
    from prepared p
    on conflict (dedupe_key) do nothing
    returning status
  )
  select count(*), count(*) filter (where status = 'holdout')
  into v_inserted, v_holdout
  from inserted;

  return jsonb_build_object('inserted', v_inserted, 'holdout', v_holdout);
end;
$function$;

create or replace function public.norva_behavioral_delivery_eligible(
  p_delivery_id uuid,
  p_now timestamptz default clock_timestamp()
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select
      o.experiment_arm = 'treatment'
      and o.config_version = j.version
      and st.enabled
      and (o.channel = 'in_app' or public.norva_behavioral_timezone_verified(o.user_id))
      and o.scheduled_for <= coalesce(p_now, clock_timestamp())
      and o.expires_at > coalesce(p_now, clock_timestamp())
      and public.norva_behavioral_journey_relevant(
        o.user_id, o.journey_key, coalesce(p_now, clock_timestamp())
      )
      and (
        not o.requires_new_content
        or (s.last_new_content_at is not null and s.last_new_content_at > s.resume_anchor_at)
      )
      and (
        not o.is_marketing
        or o.channel <> 'email'
        or public.norva_marketing_email_allowed(o.user_id)
      )
    from public.behavioral_lifecycle_outbox o
    join public.behavioral_lifecycle_journeys j on j.journey_key = o.journey_key
    join public.behavioral_lifecycle_steps st
      on st.journey_key = o.journey_key and st.step_key = o.step_key
    join public.behavioral_lifecycle_user_state s on s.user_id = o.user_id
    where o.id = p_delivery_id
  ), false)
$function$;
-- This endpoint is independent of push availability and cannot be invoked
-- directly by a browser for another account. Edge derives p_user_id from Auth.
create function public.norva_record_lifecycle_timezone(p_user_id uuid, p_timezone text)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  v_timezone text := btrim(coalesce(p_timezone,''));
  v_now timestamptz := clock_timestamp();
begin
  if coalesce(nullif(auth.jwt()->>'role',''),
      nullif(current_setting('request.jwt.claim.role',true),''),
      nullif(current_setting('role',true),'none'),'') <> 'service_role' then
    raise exception 'service_role required' using errcode='42501';
  end if;
  if char_length(v_timezone)>64 or not exists(
      select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    return jsonb_build_object('ok',false,'reason','unknown_timezone');
  end if;
  if not exists(select 1 from auth.users where id=p_user_id) then
    return jsonb_build_object('ok',false,'reason','account_unavailable');
  end if;
  insert into public.behavioral_lifecycle_user_state(
    user_id,registered_at,timezone,timezone_source,timezone_observed_at)
  select id,created_at,v_timezone,'device',v_now from auth.users where id=p_user_id
  on conflict(user_id) do update set timezone=excluded.timezone,timezone_source='device',
    timezone_observed_at=excluded.timezone_observed_at,updated_at=v_now
  where public.behavioral_lifecycle_user_state.timezone is distinct from excluded.timezone
    or public.behavioral_lifecycle_user_state.timezone_source='unknown'
    or public.behavioral_lifecycle_user_state.timezone_observed_at is null
    or public.behavioral_lifecycle_user_state.timezone_observed_at < v_now-interval '1 hour';
  return jsonb_build_object('ok',true);
end;
$function$;
revoke all on function public.norva_record_lifecycle_timezone(uuid,text) from public,anon,authenticated;
grant execute on function public.norva_record_lifecycle_timezone(uuid,text) to service_role;
commit;
