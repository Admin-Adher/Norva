-- Privacy-bounded signup attribution for the Admin CRM.
--
-- Trust boundaries:
--   * values describe product analytics only, never authorization, billing,
--     residence, tax or fraud evidence;
--   * the official Norva client receives a coarse Cloudflare edge estimate and
--     hands it to an authenticated capture RPC. This handoff is useful for aggregate product
--     analytics but is not cryptographically server-attested;
--   * no raw IP address, full User-Agent, referrer, pairing code or auth token
--     is stored;
--   * city/region are hidden from Admin at 90 days and physically erased by a
--     15-minute retention job; country and product origin remain until deletion;
--   * billing country remains separate in cloud_entitlement_projection.

create table if not exists public.cloud_signup_attribution (
  user_id uuid primary key references auth.users(id) on delete cascade,
  signed_up_at timestamptz not null,
  signup_platform text not null default 'unknown'
    check (signup_platform in ('web', 'mobile_android', 'unknown')),
  signup_surface text not null default 'unknown'
    check (signup_surface in ('account', 'subscription', 'tv_pairing', 'unknown')),
  signup_method text not null default 'unknown'
    check (signup_method in ('email_password', 'email_magic_link', 'google', 'unknown')),
  capture_stage text not null default 'pending'
    check (capture_stage in ('signup_request', 'auth_return', 'pending', 'historical_backfill')),
  attribution_integrity text not null default 'none'
    check (attribution_integrity in ('client_handoff', 'none')),
  country_code text
    check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  region_code text
    check (region_code is null or (char_length(region_code) between 1 and 16
      and region_code ~ '^[A-Za-z0-9-]+$')),
  region_name text
    check (region_name is null or char_length(region_name) between 1 and 96),
  city text
    check (city is null or char_length(city) between 1 and 96),
  location_source text not null default 'none'
    check (location_source in ('cloudflare_edge', 'none')),
  fine_location_expires_at timestamptz,
  captured_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.cloud_signup_attribution is
  'Signup product analytics with client-handoff integrity. No raw IP. City/region are masked at 90 days and then purged.';
comment on column public.cloud_signup_attribution.signup_platform is
  'Screen that performed account creation: web browser or Android phone WebView. Android TV pairs and cannot create an account.';
comment on column public.cloud_signup_attribution.signup_surface is
  'Journey leading to creation. tv_pairing means creation happened on the companion browser/phone during TV pairing.';
comment on column public.cloud_signup_attribution.location_source is
  'Original source reported by the official client. cloudflare_edge is approximate network context, not residence or billing country.';
comment on column public.cloud_signup_attribution.attribution_integrity is
  'client_handoff means the value passed through the client and is not server-attested; analytics only.';

alter table public.cloud_signup_attribution enable row level security;
revoke all on table public.cloud_signup_attribution from public, anon, authenticated;
grant select, insert, update, delete on table public.cloud_signup_attribution to service_role;

-- Reserved fine-location keys must never persist in Auth metadata, including
-- when a modified client tries to inject them directly. Product-origin labels
-- remain so the AFTER INSERT trigger can snapshot them without an UPDATE.
create or replace function public.norva_sanitize_signup_metadata()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb)
    - array[
      'norva_signup_country_code',
      'norva_signup_region_code',
      'norva_signup_region_name',
      'norva_signup_city',
      'norva_signup_location_source',
      'norva_signup_client_locale',
      'norva_signup_client_timezone',
      'norva_signup_edge_timezone'
    ]::text[];
  return new;
exception when others then
  -- Never block Auth. The official client does not send these keys, so this
  -- branch is defensive for incompatible/custom clients only.
  return new;
end;
$function$;

revoke all on function public.norva_sanitize_signup_metadata() from public, anon, authenticated;

drop trigger if exists norva_sanitize_signup_metadata_before_insert on auth.users;
create trigger norva_sanitize_signup_metadata_before_insert
before insert on auth.users
for each row execute function public.norva_sanitize_signup_metadata();

drop trigger if exists norva_sanitize_signup_metadata_before_update on auth.users;
create trigger norva_sanitize_signup_metadata_before_update
before update of raw_user_meta_data on auth.users
for each row execute function public.norva_sanitize_signup_metadata();

create or replace function public.norva_capture_signup_attribution_from_auth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_platform text;
  v_surface text;
  v_method text;
  v_has_context boolean;
begin
  v_platform := case v_meta ->> 'norva_signup_platform'
    when 'web' then 'web'
    when 'mobile_android' then 'mobile_android'
    else 'unknown'
  end;
  v_surface := case v_meta ->> 'norva_signup_surface'
    when 'account' then 'account'
    when 'subscription' then 'subscription'
    when 'tv_pairing' then 'tv_pairing'
    else 'unknown'
  end;
  v_method := case v_meta ->> 'norva_signup_method'
    when 'email_password' then 'email_password'
    when 'email_magic_link' then 'email_magic_link'
    when 'google' then 'google'
    else 'unknown'
  end;

  v_has_context := v_platform <> 'unknown'
    or v_surface <> 'unknown'
    or v_method <> 'unknown';

  insert into public.cloud_signup_attribution (
    user_id, signed_up_at, signup_platform, signup_surface, signup_method,
    capture_stage, attribution_integrity, country_code, region_code,
    region_name, city, location_source, fine_location_expires_at,
    captured_at, updated_at
  ) values (
    new.id, new.created_at, v_platform, v_surface, v_method,
    case when v_has_context then 'signup_request' else 'pending' end,
    case when v_has_context then 'client_handoff' else 'none' end,
    null, null, null, null, 'none', null,
    case when v_has_context then now() else null end,
    now()
  )
  on conflict (user_id) do nothing;
  return new;
exception when others then
  -- Attribution is observability. It must never prevent account creation.
  raise warning 'Norva signup attribution capture failed for user %: %', new.id, sqlerrm;
  return new;
end;
$function$;

revoke all on function public.norva_capture_signup_attribution_from_auth() from public, anon, authenticated;

-- Install the trigger before the historical snapshot. A concurrent signup is
-- therefore captured either by the trigger or by the backfill, never by neither.
drop trigger if exists norva_capture_signup_attribution_after_insert on auth.users;
create trigger norva_capture_signup_attribution_after_insert
after insert on auth.users
for each row execute function public.norva_capture_signup_attribution_from_auth();

-- Existing users cannot be attributed retroactively with confidence. Mark them
-- explicitly instead of relabelling them from a later device or locale.
insert into public.cloud_signup_attribution (
  user_id, signed_up_at, capture_stage
)
select u.id, u.created_at, 'historical_backfill'
from auth.users u
on conflict (user_id) do nothing;

create index if not exists cloud_signup_attribution_signed_up_idx
  on public.cloud_signup_attribution (signed_up_at desc);
create index if not exists cloud_signup_attribution_platform_idx
  on public.cloud_signup_attribution (signup_platform, signed_up_at desc);
create index if not exists cloud_signup_attribution_country_idx
  on public.cloud_signup_attribution (country_code, signed_up_at desc)
  where country_code is not null;
create index if not exists cloud_signup_attribution_fine_expiry_idx
  on public.cloud_signup_attribution (fine_location_expires_at)
  where fine_location_expires_at is not null;

-- OAuth and native Google create auth.users before Norva can attach product
-- context. The authenticated return may fill only its own still-pending row.
create or replace function public.capture_signup_attribution(
  p_signup_platform text default null,
  p_signup_surface text default null,
  p_signup_method text default null,
  p_country_code text default null,
  p_region_code text default null,
  p_region_name text default null,
  p_city text default null,
  p_location_source text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_created_at timestamptz;
  v_row public.cloud_signup_attribution%rowtype;
  v_platform text;
  v_surface text;
  v_method text;
  v_country text;
  v_region_code text;
  v_region_name text;
  v_city text;
  v_location_source text;
  v_has_context boolean;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select u.created_at into v_created_at
  from auth.users u
  where u.id = v_user_id;

  if v_created_at is null then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  if v_created_at < now() - interval '24 hours' then
    select * into v_row
    from public.cloud_signup_attribution
    where user_id = v_user_id;
    return jsonb_build_object(
      'updated', false,
      'reason', 'capture_window_closed',
      'attribution', to_jsonb(v_row)
    );
  end if;

  insert into public.cloud_signup_attribution (
    user_id, signed_up_at, capture_stage
  ) values (
    v_user_id, v_created_at, 'pending'
  )
  on conflict (user_id) do nothing;

  select * into v_row
  from public.cloud_signup_attribution
  where user_id = v_user_id
  for update;

  if v_row.capture_stage not in ('pending', 'signup_request')
      or (v_row.capture_stage = 'signup_request' and v_row.location_source <> 'none') then
    return jsonb_build_object(
      'updated', false,
      'reason', 'already_captured',
      'attribution', to_jsonb(v_row)
    );
  end if;

  v_platform := case
    when v_row.signup_platform <> 'unknown' then v_row.signup_platform
    when p_signup_platform = 'web' then 'web'
    when p_signup_platform = 'mobile_android' then 'mobile_android'
    else 'unknown'
  end;
  v_surface := case
    when v_row.signup_surface <> 'unknown' then v_row.signup_surface
    when p_signup_surface = 'account' then 'account'
    when p_signup_surface = 'subscription' then 'subscription'
    when p_signup_surface = 'tv_pairing' then 'tv_pairing'
    else 'unknown'
  end;
  v_method := case
    when v_row.signup_method <> 'unknown' then v_row.signup_method
    when p_signup_method = 'email_password' then 'email_password'
    when p_signup_method = 'email_magic_link' then 'email_magic_link'
    when p_signup_method = 'google' then 'google'
    else 'unknown'
  end;

  v_location_source := case
    when p_location_source = 'cloudflare_edge' then 'cloudflare_edge'
    else 'none'
  end;
  if v_location_source = 'cloudflare_edge' then
    v_country := upper(nullif(btrim(coalesce(p_country_code, '')), ''));
    if v_country !~ '^[A-Z]{2}$' then v_country := null; end if;
    v_region_code := nullif(left(btrim(coalesce(p_region_code, '')), 16), '');
    if v_region_code is not null and v_region_code !~ '^[A-Za-z0-9-]+$' then
      v_region_code := null;
    end if;
    v_region_name := nullif(left(btrim(coalesce(p_region_name, '')), 96), '');
    v_city := nullif(left(btrim(coalesce(p_city, '')), 96), '');
    if v_country is null and v_region_code is null and v_region_name is null and v_city is null then
      v_location_source := 'none';
    end if;
  end if;

  v_has_context := v_platform <> 'unknown'
    or v_surface <> 'unknown'
    or v_method <> 'unknown'
    or v_location_source <> 'none';
  if not v_has_context then
    return jsonb_build_object(
      'updated', false,
      'reason', 'no_context',
      'attribution', to_jsonb(v_row)
    );
  end if;
  if v_location_source = 'none' then
    if v_row.capture_stage = 'pending' then
      update public.cloud_signup_attribution
      set signup_platform = v_platform,
          signup_surface = v_surface,
          signup_method = v_method,
          attribution_integrity = 'client_handoff',
          captured_at = coalesce(captured_at, now()),
          updated_at = now()
      where user_id = v_user_id
        and capture_stage = 'pending'
      returning * into v_row;
      return jsonb_build_object(
        'updated', true,
        'reason', 'partial_pending_location',
        'attribution', to_jsonb(v_row)
      );
    end if;
    return jsonb_build_object(
      'updated', false,
      'reason', 'no_new_context',
      'attribution', to_jsonb(v_row)
    );
  end if;

  update public.cloud_signup_attribution
  set signup_platform = v_platform,
      signup_surface = v_surface,
      signup_method = v_method,
      capture_stage = 'auth_return',
      attribution_integrity = 'client_handoff',
      country_code = v_country,
      region_code = v_region_code,
      region_name = v_region_name,
      city = v_city,
      location_source = v_location_source,
      fine_location_expires_at = case
        when v_region_code is not null or v_region_name is not null or v_city is not null
          then now() + interval '90 days'
        else null
      end,
      captured_at = now(),
      updated_at = now()
  where user_id = v_user_id
    and capture_stage in ('pending', 'signup_request')
  returning * into v_row;

  return jsonb_build_object(
    'updated', true,
    'reason', 'captured',
    'attribution', to_jsonb(v_row)
  );
end;
$function$;

revoke all on function public.capture_signup_attribution(
  text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.capture_signup_attribution(
  text, text, text, text, text, text, text, text
) to authenticated;

create or replace function public.admin_signup_attribution_batch(p_user_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if coalesce(array_length(p_user_ids, 1), 0) > 10000 then
    raise exception 'too many user ids' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(
    to_jsonb(a) || jsonb_build_object(
      'region_code', case when a.fine_location_expires_at <= now() then null else a.region_code end,
      'region_name', case when a.fine_location_expires_at <= now() then null else a.region_name end,
      'city', case when a.fine_location_expires_at <= now() then null else a.city end,
      'fine_location_expired', coalesce(a.fine_location_expires_at <= now(), false)
    )
    order by a.signed_up_at desc
  ), '[]'::jsonb)
  into v_rows
  from public.cloud_signup_attribution a
  where a.user_id = any(coalesce(p_user_ids, array[]::uuid[]));
  return v_rows;
end;
$function$;

revoke all on function public.admin_signup_attribution_batch(uuid[]) from public, anon, authenticated;
grant execute on function public.admin_signup_attribution_batch(uuid[]) to authenticated;

create or replace function public.admin_signup_attribution_detail(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return (
    select to_jsonb(a) || jsonb_build_object(
      'region_code', case when a.fine_location_expires_at <= now() then null else a.region_code end,
      'region_name', case when a.fine_location_expires_at <= now() then null else a.region_name end,
      'city', case when a.fine_location_expires_at <= now() then null else a.city end,
      'fine_location_expired', coalesce(a.fine_location_expires_at <= now(), false)
    )
    from public.cloud_signup_attribution a
    where a.user_id = p_user_id
  );
end;
$function$;

revoke all on function public.admin_signup_attribution_detail(uuid) from public, anon, authenticated;
grant execute on function public.admin_signup_attribution_detail(uuid) to authenticated;

create or replace function public.norva_prune_signup_fine_location()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
begin
  update public.cloud_signup_attribution
  set region_code = null,
      region_name = null,
      city = null,
      fine_location_expires_at = null,
      updated_at = now()
  where fine_location_expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.norva_prune_signup_fine_location() from public, anon, authenticated;
grant execute on function public.norva_prune_signup_fine_location() to service_role;

-- Retention is a product/privacy guarantee: fail the migration if pg_cron cannot
-- install the job instead of silently leaving fine location unpruned.
select cron.schedule(
  'norva-signup-fine-location-prune',
  '*/15 * * * *',
  'select public.norva_prune_signup_fine_location();'
);

notify pgrst, 'reload schema';
