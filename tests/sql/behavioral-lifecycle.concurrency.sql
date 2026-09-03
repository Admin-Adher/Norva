-- Two-worker PostgreSQL concurrency proof for lifecycle claims.
--
-- Run against the disposable database built by behavioral-lifecycle.bootstrap.sql
-- plus the lifecycle migration. dblink opens two independent PostgreSQL sessions;
-- worker one keeps its row locks during pg_sleep while worker two must SKIP LOCKED.

\set ON_ERROR_STOP on

select set_config('request.jwt.claim.role', 'service_role', false);

delete from public.behavioral_lifecycle_outbox
where dedupe_key like 'concurrency-proof:%';
delete from auth.users
where id = '90000000-0000-0000-0000-000000000001';

insert into auth.users (id, email)
values (
  '90000000-0000-0000-0000-000000000001',
  'concurrency@example.test'
);

insert into public.behavioral_lifecycle_outbox (
  dedupe_key, user_id, journey_key, step_key, config_version, channel,
  status, experiment_arm, title, body, cta_label, deep_link,
  ttl_seconds, collapse_key, is_marketing, requires_new_content,
  triggered_at, scheduled_for, expires_at, next_attempt_at
)
select
  'concurrency-proof:' || i::text,
  '90000000-0000-0000-0000-000000000001',
  'no_source', 'day_one_push',
  (select version from public.behavioral_lifecycle_journeys where journey_key = 'no_source'),
  'push', 'pending', 'treatment',
  'Concurrency proof', 'Disposable worker claim.', 'Open Norva',
  '/app.html#settings/sources', 3600, 'lifecycle-no-source',
  false, false, clock_timestamp(),
  clock_timestamp() - interval '1 second',
  clock_timestamp() + interval '1 hour',
  clock_timestamp() - interval '1 second'
from generate_series(1, 4) i;

-- Bind both workers to the exact PostgreSQL instance under test. A connection
-- string containing only dbname silently falls back to the platform default
-- socket/port (for example the system cluster on 5432) when this file runs in
-- pg_virtualenv. Carry the active server port and role explicitly so a clean-room
-- run cannot exercise a different local cluster.
select dblink_connect(
  'lifecycle_worker_1',
  format(
    'host=%L port=%L dbname=%L user=%L',
    btrim(split_part(current_setting('unix_socket_directories'), ',', 1)),
    current_setting('port'), current_database(), current_user
  )
);
select dblink_connect(
  'lifecycle_worker_2',
  format(
    'host=%L port=%L dbname=%L user=%L',
    btrim(split_part(current_setting('unix_socket_directories'), ',', 1)),
    current_setting('port'), current_database(), current_user
  )
);

select dblink_send_query(
  'lifecycle_worker_1',
  $query$
    with role_context as materialized (
      select set_config('request.jwt.claim.role', 'service_role', false)
    ), claimed as materialized (
      select c.*
      from role_context
      cross join lateral public.norva_claim_behavioral_deliveries('push', 2, 90) c
      where c.id in (
        select id from public.behavioral_lifecycle_outbox
        where dedupe_key like 'concurrency-proof:%'
      )
    ), held as materialized (
      select pg_sleep(3) from claimed limit 1
    )
    select c.id::text, c.lease_token::text
    from claimed c cross join held
  $query$
);

-- Give worker one time to enter the hold after acquiring its two row locks.
select pg_sleep(0.5);

create temporary table lifecycle_worker_2_claims as
select id::uuid, lease_token::uuid
from dblink(
  'lifecycle_worker_2',
  $query$
    with role_context as materialized (
      select set_config('request.jwt.claim.role', 'service_role', false)
    )
    select c.id::text, c.lease_token::text
    from role_context
    cross join lateral public.norva_claim_behavioral_deliveries('push', 2, 90) c
    where c.id in (
      select id from public.behavioral_lifecycle_outbox
      where dedupe_key like 'concurrency-proof:%'
    )
  $query$
) as result(id text, lease_token text);

create temporary table lifecycle_worker_1_claims as
select id::uuid, lease_token::uuid
from dblink_get_result('lifecycle_worker_1')
  as result(id text, lease_token text);

do $assert$
begin
  if (select count(*) from lifecycle_worker_1_claims) <> 2
     or (select count(*) from lifecycle_worker_2_claims) <> 2 then
    raise exception 'workers did not split four claims into two disjoint batches';
  end if;
  if exists (
    select 1
    from lifecycle_worker_1_claims a
    join lifecycle_worker_2_claims b using (id)
  ) then
    raise exception 'two concurrent workers claimed the same delivery';
  end if;
  if (
    select count(distinct lease_token)
    from (
      select lease_token from lifecycle_worker_1_claims
      union all
      select lease_token from lifecycle_worker_2_claims
    ) claims
  ) <> 4 then
    raise exception 'claim lease token was reused';
  end if;
  if (select count(*) from public.behavioral_lifecycle_outbox
      where dedupe_key like 'concurrency-proof:%'
        and status = 'processing' and attempt_count = 1
        and lease_token is not null and lease_expires_at > clock_timestamp()) <> 4 then
    raise exception 'claimed rows do not retain four valid independent leases';
  end if;
end
$assert$;

select dblink_disconnect('lifecycle_worker_1');
select dblink_disconnect('lifecycle_worker_2');

delete from public.behavioral_lifecycle_outbox
where dedupe_key like 'concurrency-proof:%';
delete from auth.users
where id = '90000000-0000-0000-0000-000000000001';

select 'BEHAVIORAL_LIFECYCLE_CONCURRENCY_OK' as result;
