begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.plan(5);

insert into public.cloud_provider_access_rollout(singleton)
values (true)
on conflict (singleton) do nothing;

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
    where p.proname = 'norva_set_provider_access_rollout_stage'
      and n.nspname = 'public'
      and pg_get_functiondef(p.oid) like '%PT409%'
  ),
  1,
  'the progressive rollout CAS routine is covered by the rewrite'
);

set local request.jwt.claim.role = 'service_role';
select extensions.throws_ok(
  format(
    'select public.norva_set_provider_access_rollout_stage(%s,%L,%L,%L)',
    (select revision - 1 from public.cloud_provider_access_rollout where singleton),
    (select stage from public.cloud_provider_access_rollout where singleton),
    'Intentional stale CAS proof for the non-retryable conflict contract.',
    'postgrest-conflict-proof'
  ),
  'PT409',
  'stale rollout revision',
  'a real stale rollout CAS returns PT409'
);
set local request.jwt.claim.role = '';

select extensions.is(
  (select count(*)::integer from public.cloud_provider_access_rollout where singleton),
  1,
  'the rejected stale CAS leaves the singleton intact'
);

select * from extensions.finish();
rollback;
