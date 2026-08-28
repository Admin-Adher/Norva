begin;

create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

insert into public.provider_account_activity(account_key, last_seen_at, kind)
values
  (
    encode(extensions.digest('catalog-refresh.invalid/presence', 'sha256'), 'hex'),
    statement_timestamp(),
    'presence'
  ),
  (
    encode(extensions.digest('catalog-refresh.invalid/gateway', 'sha256'), 'hex'),
    statement_timestamp(),
    'gateway'
  ),
  (
    encode(extensions.digest('catalog-refresh.invalid/session', 'sha256'), 'hex'),
    statement_timestamp(),
    'session'
  ),
  (
    encode(extensions.digest('catalog-refresh.invalid/language', 'sha256'), 'hex'),
    statement_timestamp(),
    'language-validation'
  ),
  (
    encode(extensions.digest('catalog-refresh.invalid/self', 'sha256'), 'hex'),
    statement_timestamp(),
    'catalog-refresh'
  ),
  (
    encode(extensions.digest('catalog-refresh.invalid/stale', 'sha256'), 'hex'),
    statement_timestamp() - interval '6 minutes',
    'gateway'
  )
on conflict (account_key) do update
set last_seen_at = excluded.last_seen_at,
    kind = excluded.kind;

select extensions.is(
  public.provider_account_busy_for_catalog_refresh('catalog-refresh.invalid/presence'),
  false,
  'passive application presence does not block a user-initiated catalogue refresh'
);

select extensions.ok(
  public.provider_account_busy_for_catalog_refresh('catalog-refresh.invalid/gateway')
  and public.provider_account_busy_for_catalog_refresh('catalog-refresh.invalid/session')
  and public.provider_account_busy_for_catalog_refresh('catalog-refresh.invalid/language'),
  'gateway, playback session, and language validation activity all retain provider priority'
);

select extensions.is(
  public.provider_account_busy_for_catalog_refresh('catalog-refresh.invalid/stale'),
  false,
  'stale real activity no longer blocks catalogue refresh'
);

select extensions.is(
  public.provider_account_busy_for_catalog_refresh('catalog-refresh.invalid/self'),
  false,
  'a released catalogue metadata page does not block its own next continuation'
);

select public.provider_account_touch_many(
  array['catalog-refresh.invalid/raw-touch'],
  'catalog-refresh'
);
select extensions.ok(
  exists (
    select 1
    from public.provider_account_activity
    where account_key = encode(
      extensions.digest('catalog-refresh.invalid/raw-touch', 'sha256'),
      'hex'
    )
      and kind = 'catalog-refresh'
  )
  and not exists (
    select 1
    from public.provider_account_activity
    where account_key = 'catalog-refresh.invalid/raw-touch'
  ),
  'real gateway raw keys are normalized into the opaque 64-hex activity ledger'
);

select public.provider_account_touch_many(
  array[encode(extensions.digest('catalog-refresh.invalid/priority-gateway', 'sha256'), 'hex')],
  'gateway'
);
select public.provider_account_touch_many(
  array[encode(extensions.digest('catalog-refresh.invalid/priority-gateway', 'sha256'), 'hex')],
  'catalog-refresh'
);
select extensions.is(
  (select kind from public.provider_account_activity
   where account_key = encode(extensions.digest('catalog-refresh.invalid/priority-gateway', 'sha256'), 'hex')),
  'gateway',
  'catalogue reporting cannot downgrade a fresh gateway holder'
);

select public.provider_account_touch_many(
  array[encode(extensions.digest('catalog-refresh.invalid/priority-language', 'sha256'), 'hex')],
  'language-validation'
);
select public.provider_account_touch_many(
  array[encode(extensions.digest('catalog-refresh.invalid/priority-language', 'sha256'), 'hex')],
  'catalog-refresh'
);
select extensions.is(
  (select kind from public.provider_account_activity
   where account_key = encode(extensions.digest('catalog-refresh.invalid/priority-language', 'sha256'), 'hex')),
  'language-validation',
  'catalogue reporting cannot downgrade fresh foreground validation'
);

select public.provider_account_touch_many(
  array[encode(extensions.digest('catalog-refresh.invalid/priority-upgrade', 'sha256'), 'hex')],
  'catalog-refresh'
);
select public.provider_account_touch_many(
  array[encode(extensions.digest('catalog-refresh.invalid/priority-upgrade', 'sha256'), 'hex')],
  'language-validation'
);
select extensions.is(
  (select kind from public.provider_account_activity
   where account_key = encode(extensions.digest('catalog-refresh.invalid/priority-upgrade', 'sha256'), 'hex')),
  'language-validation',
  'foreground validation atomically upgrades catalogue activity'
);

select public.provider_account_touch_many(
  array[encode(extensions.digest('catalog-refresh.invalid/priority-presence', 'sha256'), 'hex')],
  'catalog-refresh'
);
select public.provider_account_touch_many(
  array[encode(extensions.digest('catalog-refresh.invalid/priority-presence', 'sha256'), 'hex')],
  'presence'
);
select extensions.is(
  (select kind from public.provider_account_activity
   where account_key = encode(extensions.digest('catalog-refresh.invalid/priority-presence', 'sha256'), 'hex')),
  'catalog-refresh',
  'passive presence cannot downgrade a fresh catalogue holder'
);

select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.provider_account_busy_for_catalog_refresh(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.provider_account_busy_for_catalog_refresh(text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.provider_account_busy_for_catalog_refresh(text)',
    'EXECUTE'
  ),
  'catalogue refresh busy scope remains service-only'
);

select * from extensions.finish();
rollback;
