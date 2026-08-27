-- Reserve PostgreSQL's 40001 serialization_failure for errors emitted by the
-- database engine.  PostgREST 14.x executes requests through a retrying
-- transaction helper; an application-authored 40001 can therefore replay a
-- deterministic stale/CAS failure without a bound.  PT409 is PostgREST's
-- documented custom SQLSTATE for an HTTP 409 response and is not retryable.
--
-- This forward-only rewrite deliberately preserves function identity, owner,
-- ACL, SECURITY DEFINER, volatility and SET clauses through CREATE OR REPLACE.
-- Historical migration files remain immutable and fresh databases converge
-- when this migration is applied at the head.

begin;

do $deployment_role$
begin
  if current_user <> 'supabase_admin'
     or not coalesce((select role.rolsuper from pg_roles role where role.rolname = current_user), false) then
    raise exception 'application conflict SQLSTATE rewrite requires supabase_admin'
      using errcode = '42501';
  end if;
end
$deployment_role$;

select pg_advisory_xact_lock(hashtextextended(
  'norva:postgrest-application-conflict-sqlstate:v1',
  0
));

do $migration$
declare
  v_function record;
  v_definition text;
  v_rewritten text;
  v_changed_functions integer := 0;
  v_changed_occurrences integer := 0;
  v_occurrences integer;
  v_existing_pt409 integer;
  v_remaining integer;
begin
  for v_function in
    select p.oid,
           n.nspname,
           p.proname,
           pg_get_function_identity_arguments(p.oid) as identity_arguments
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
    order by n.nspname, p.proname, p.oid
  loop
    v_definition := pg_get_functiondef(v_function.oid);
    v_occurrences := (
      length(v_definition) - length(replace(v_definition, '40001', ''))
    ) / 5;
    v_rewritten := replace(v_definition, '40001', 'PT409');

    if v_occurrences <= 0 or v_rewritten = v_definition then
      raise exception 'application conflict SQLSTATE rewrite made no progress for %.%(%)',
        v_function.nspname,
        v_function.proname,
        v_function.identity_arguments
        using errcode = '55000';
    end if;

    execute v_rewritten;
    v_changed_functions := v_changed_functions + 1;
    v_changed_occurrences := v_changed_occurrences + v_occurrences;
  end loop;

  if v_changed_functions = 0 then
    select count(*)::integer
    into v_existing_pt409
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.prokind in ('f', 'p')
      and n.nspname in ('public', 'email_private', 'affiliate_private')
      and pg_get_functiondef(p.oid) like '%PT409%'
      and not exists (
        select 1
        from pg_depend dependency
        where dependency.classid = 'pg_proc'::regclass
          and dependency.objid = p.oid
          and dependency.deptype = 'e'
      );

    if v_existing_pt409 = 0
       or not exists (
         select 1
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname = 'norva_settle_cloud_auto_refresh_source'
           and pg_get_functiondef(p.oid) like '%PT409%'
       ) then
      raise exception 'application conflict SQLSTATE rewrite found no eligible Norva contract'
        using errcode = '55000';
    end if;

    raise notice 'application conflict SQLSTATE rewrite already complete: functions=%',
      v_existing_pt409;
  end if;

  select count(*)::integer
  into v_remaining
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
    );

  if v_remaining <> 0 then
    raise exception 'application conflict SQLSTATE rewrite left % function(s)', v_remaining
      using errcode = '55000';
  end if;

  raise notice 'application conflict SQLSTATE rewrite: functions=%, occurrences=%',
    v_changed_functions,
    v_changed_occurrences;
end
$migration$;

notify pgrst, 'reload schema';

commit;
