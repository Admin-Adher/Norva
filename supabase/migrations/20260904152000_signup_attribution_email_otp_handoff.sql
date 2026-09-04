-- Preserve coarse signup attribution through the verified mobile email-code rail.
--
-- Location stays out of Auth metadata. The browser keeps it ephemerally in the
-- current tab, and the authenticated RPC remains limited to the caller's own
-- account during the existing 24-hour capture window.

alter table public.cloud_signup_attribution
  drop constraint if exists cloud_signup_attribution_signup_method_check;

alter table public.cloud_signup_attribution
  add constraint cloud_signup_attribution_signup_method_check
  check (signup_method in ('email_password', 'email_magic_link', 'email_otp', 'google', 'unknown'));

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
    when 'email_otp' then 'email_otp'
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

revoke all on function public.norva_capture_signup_attribution_from_auth()
  from public, anon, authenticated;

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
    when p_signup_method = 'email_otp' then 'email_otp'
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

-- Correct the method label only where the original bounded metadata still
-- proves the email-code rail. Country/region are never reconstructed.
update public.cloud_signup_attribution a
set signup_method = 'email_otp',
    updated_at = now()
from auth.users u
where u.id = a.user_id
  and a.signup_method = 'unknown'
  and u.raw_user_meta_data ->> 'norva_signup_method' = 'email_otp';

notify pgrst, 'reload schema';
