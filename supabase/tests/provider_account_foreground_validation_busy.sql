begin;

create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  '74000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'provider-foreground-validation@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.cloud_sources (
  id,
  user_id,
  source_type,
  display_name,
  config_hint
) values (
  '74000000-0000-4000-8000-000000000002',
  '74000000-0000-4000-8000-000000000001',
  'xtream',
  'Foreground validation fixture',
  '{"serverHost":"provider-foreground.invalid","username":"fixture-user"}'::jsonb
);

select public.provider_account_touch_by_user(
  '74000000-0000-4000-8000-000000000001',
  'presence'
);

select extensions.is(
  public.provider_account_busy('provider-foreground.invalid/fixture-user'),
  true,
  'generic background gate remains blocked by fresh presence'
);
select extensions.is(
  public.provider_account_busy_for_foreground_validation(
    'provider-foreground.invalid/fixture-user'
  ),
  false,
  'foreground validation ignores only fresh presence'
);

select public.provider_account_touch_many(
  array['provider-foreground.invalid/fixture-user'],
  'language-validation'
);

select extensions.is(
  (select kind from public.provider_account_activity
   where account_key = 'provider-foreground.invalid/fixture-user'),
  'language-validation',
  'language validation activity immediately replaces weak presence'
);
select extensions.is(
  public.provider_account_busy('provider-foreground.invalid/fixture-user'),
  true,
  'language validation keeps generic background work away from the mono-account slot'
);
select extensions.is(
  public.provider_account_busy_for_foreground_validation(
    'provider-foreground.invalid/fixture-user'
  ),
  false,
  'foreground validation ignores its own fresh language-validation activity'
);

select public.provider_account_touch_many(
  array['provider-foreground.invalid/fixture-user'],
  'gateway'
);

create temporary table foreground_real_activity_snapshot as
select kind, last_seen_at
from public.provider_account_activity
where account_key = 'provider-foreground.invalid/fixture-user';

select public.provider_account_touch_many(
  array['provider-foreground.invalid/fixture-user'],
  'language-validation'
);

select extensions.is(
  (select kind from public.provider_account_activity
   where account_key = 'provider-foreground.invalid/fixture-user'),
  (select kind from foreground_real_activity_snapshot),
  'language validation cannot overwrite fresh real provider activity'
);
select extensions.is(
  (select last_seen_at from public.provider_account_activity
   where account_key = 'provider-foreground.invalid/fixture-user'),
  (select last_seen_at from foreground_real_activity_snapshot),
  'rejected language validation cannot refresh the real activity timestamp'
);
select extensions.is(
  public.provider_account_busy_for_foreground_validation(
    'provider-foreground.invalid/fixture-user'
  ),
  true,
  'fresh real provider activity still blocks foreground validation'
);

insert into public.provider_account_activity(account_key, last_seen_at, kind)
values (
  'provider-foreground.invalid/stale-real',
  statement_timestamp() - interval '6 minutes',
  'gateway'
);
select public.provider_account_touch_many(
  array['provider-foreground.invalid/stale-real'],
  'language-validation'
);
select extensions.is(
  (select kind from public.provider_account_activity
   where account_key = 'provider-foreground.invalid/stale-real'),
  'language-validation',
  'language validation replaces a stale real activity row'
);

select public.provider_account_touch_many(
  array['provider-foreground.invalid/stale-real'],
  'raw'
);
select extensions.is(
  (select kind from public.provider_account_activity
   where account_key = 'provider-foreground.invalid/stale-real'),
  'raw',
  'real activity immediately overrides language validation activity'
);

update public.provider_account_activity
set kind = 'gateway', last_seen_at = statement_timestamp()
where account_key = 'provider-foreground.invalid/fixture-user';

create temporary table foreground_activity_snapshot as
select kind, last_seen_at
from public.provider_account_activity
where account_key = 'provider-foreground.invalid/fixture-user';

select public.provider_account_touch_by_user(
  '74000000-0000-4000-8000-000000000001',
  'presence'
);

select extensions.is(
  (select kind from public.provider_account_activity
   where account_key = 'provider-foreground.invalid/fixture-user'),
  (select kind from foreground_activity_snapshot),
  'presence cannot overwrite a fresh real activity kind'
);
select extensions.is(
  (select last_seen_at from public.provider_account_activity
   where account_key = 'provider-foreground.invalid/fixture-user'),
  (select last_seen_at from foreground_activity_snapshot),
  'presence cannot refresh the timestamp of a fresh real activity'
);

insert into public.provider_account_activity(account_key, last_seen_at, kind)
select 'provider-foreground.invalid/' || coalesce(kind, 'null-kind'),
       statement_timestamp(),
       kind
from (
  values ('session'::text), ('gateway'), ('raw'), ('probe'), ('future-kind'), (null)
) as kinds(kind)
on conflict (account_key) do update
  set last_seen_at = excluded.last_seen_at, kind = excluded.kind;

select extensions.ok(
  (select bool_and(
     public.provider_account_busy_for_foreground_validation(account_key)
   )
   from (
     values
       ('provider-foreground.invalid/session'),
       ('provider-foreground.invalid/gateway'),
       ('provider-foreground.invalid/raw'),
       ('provider-foreground.invalid/probe'),
       ('provider-foreground.invalid/future-kind'),
       ('provider-foreground.invalid/null-kind')
   ) as keys(account_key)),
  'fresh session, gateway, raw, probe, unknown and null kinds all block foreground validation'
);

update public.provider_account_activity
set kind = 'gateway', last_seen_at = statement_timestamp() - interval '6 minutes'
where account_key = 'provider-foreground.invalid/fixture-user';
select extensions.is(
  public.provider_account_busy_for_foreground_validation(
    'provider-foreground.invalid/fixture-user'
  ),
  false,
  'stale real activity no longer blocks foreground validation'
);

select public.provider_account_touch_by_user(
  '74000000-0000-4000-8000-000000000001',
  'presence'
);
select extensions.is(
  (select kind from public.provider_account_activity
   where account_key = 'provider-foreground.invalid/fixture-user'),
  'presence',
  'presence replaces stale real activity'
);
select extensions.ok(
  (select last_seen_at > statement_timestamp() - interval '5 seconds'
   from public.provider_account_activity
   where account_key = 'provider-foreground.invalid/fixture-user'),
  'presence replacement is fresh'
);

select public.provider_account_touch_by_user(
  '74000000-0000-4000-8000-000000000001',
  'session'
);
select extensions.is(
  (select kind from public.provider_account_activity
   where account_key = 'provider-foreground.invalid/fixture-user'),
  'session',
  'real activity immediately replaces presence'
);

select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.provider_account_busy_for_foreground_validation(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.provider_account_busy_for_foreground_validation(text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.provider_account_busy_for_foreground_validation(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.provider_account_touch_many(text[],text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.provider_account_touch_many(text[],text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.provider_account_touch_many(text[],text)',
    'EXECUTE'
  ),
  'activity priority and foreground validation RPCs are executable only by service_role'
);

select extensions.is(
  public.claim_provider_account_language_validation(
    repeat('a', 64),
    'foreground-validation-test-owner',
    900
  ),
  true,
  'language validation atomically reserves an idle provider account'
);

select extensions.throws_ok(
  $sql$
    select * from public.claim_cloud_playback_session(
      '74000000-0000-4000-8000-000000000003',
      '74000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000002',
      null,
      'movie',
      'foreground-validation-fixture',
      'direct',
      'ready',
      repeat('b', 64),
      repeat('a', 64),
      null,
      '{}'::jsonb,
      statement_timestamp() + interval '10 minutes'
    )
  $sql$,
  '55P03',
  'provider language validation in progress',
  'playback cannot claim the mono-slot while validation owns its account lease'
);

select extensions.is(
  public.release_provider_account_language_validation(
    repeat('a', 64),
    'foreground-validation-test-owner'
  ),
  true,
  'the exact validation owner releases its account lease'
);

select extensions.lives_ok(
  $sql$
    select * from public.claim_cloud_playback_session(
      '74000000-0000-4000-8000-000000000004',
      '74000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000002',
      null,
      'movie',
      'foreground-validation-fixture',
      'direct',
      'ready',
      repeat('b', 64),
      repeat('a', 64),
      null,
      '{}'::jsonb,
      statement_timestamp() + interval '10 minutes'
    )
  $sql$,
  'playback claim succeeds after the validation lease is released'
);

select extensions.is(
  public.claim_provider_account_language_validation(
    repeat('a', 64),
    'second-foreground-validation-owner',
    900
  ),
  false,
  'language validation cannot claim an account with an active playback session'
);

select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.claim_provider_account_language_validation(text,text,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.release_provider_account_language_validation(text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.claim_provider_account_language_validation(text,text,integer)',
    'EXECUTE'
  ),
  'account validation lease RPCs are service-role only'
);

select * from extensions.finish();
rollback;
