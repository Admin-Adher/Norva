begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.plan(5);

select extensions.is(
  (
    select count(*)::integer
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.prokind in ('f', 'p')
      and n.nspname in ('public', 'email_private', 'affiliate_private')
      and pg_get_functiondef(p.oid) like '%40001%'
      and not exists (
        select 1
        from pg_depend dependency
        where dependency.classid = 'pg_proc'::regclass
          and dependency.objid = p.oid
          and dependency.deptype = 'e'
      )
  ),
  0,
  'application routines no longer forge engine serialization failures'
);

select extensions.ok(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.prokind in ('f', 'p')
      and n.nspname in ('public', 'email_private', 'affiliate_private')
      and pg_get_functiondef(p.oid) like '%PT409%'
  ) > 0,
  'application conflicts are represented by the non-retryable PT409 contract'
);

select extensions.is(
  (
    select count(*)::integer
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'norva_settle_cloud_auto_refresh_source'
      and n.nspname = 'public'
      and pg_get_functiondef(p.oid) like '%PT409%'
  ),
  1,
  'the auto-refresh lease CAS routine is covered by the rewrite'
);

set local request.jwt.claim.role = 'service_role';
select extensions.throws_ok(
  $$select public.norva_settle_cloud_auto_refresh_source(
    '98990000-0000-4000-8000-000000000101',
    '98990000-0000-4000-8000-000000000001',
    'postgrest-conflict-proof', 1, 'success', now(), null, null
  )$$,
  'PT409',
  'cloud auto refresh lease is stale',
  'a real stale lease CAS returns PT409'
);
set local request.jwt.claim.role = '';

select extensions.is(
  (select count(*)::integer from public.cloud_sources
    where id = '98990000-0000-4000-8000-000000000101'),
  0,
  'the rejected stale CAS does not synthesize or repair the missing source'
);

select * from extensions.finish();
rollback;
