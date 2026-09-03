-- PostgreSQL runtime proof for the behavioral lifecycle engine.
--
-- Run only against the disposable database built with
-- behavioral-lifecycle.bootstrap.sql. Every fixture mutation is rolled back.
-- No provider, Edge Function, email or push request is performed.

\set ON_ERROR_STOP on

begin;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('norva.test_is_admin', 'true', true);

do $assert$
begin
  if (select count(*) from public.behavioral_lifecycle_journeys) <> 4 then
    raise exception 'expected four lifecycle journeys';
  end if;
  if exists (
    select 1 from public.behavioral_lifecycle_journeys
    where status <> 'draft' or rollout_percent <> 0 or holdout_percent <> 10
      or experiment_variable <> 'baseline'
  ) then
    raise exception 'journeys did not ship fail-closed';
  end if;
  if not (select emergency_stop from public.behavioral_lifecycle_runtime where singleton) then
    raise exception 'global emergency stop did not ship enabled';
  end if;
  if exists (select 1 from public.behavioral_lifecycle_outbox)
     or exists (select 1 from public.behavioral_lifecycle_funnel_events)
     or exists (select 1 from public.behavioral_lifecycle_experiment_versions)
     or exists (select 1 from public.behavioral_lifecycle_import_readiness) then
    raise exception 'migration manufactured historical deliveries or events';
  end if;
end
$assert$;

-- Outbound copy is a data boundary too. Static service messages may explain
-- generic M3U/Xtream fields, but they may not interpolate or hard-code private
-- addresses, credential values, payment data or freshness claims without the
-- server-side new-content predicate.
do $assert$
declare
  v_step public.behavioral_lifecycle_steps%rowtype;
begin
  if exists (
    select 1
    from public.behavioral_lifecycle_steps st
    where not public.norva_behavioral_step_copy_safe(
      st.journey_key, st.title, st.body, st.cta_label,
      st.deep_link, st.requires_new_content
    )
  ) then
    raise exception 'a seeded lifecycle step failed the outbound-copy gate';
  end if;

  if not public.norva_behavioral_step_copy_safe(
    'import_unresolved', 'Review your source',
    'Choose M3U for a playlist link, or Xtream for a server address, username and password.',
    'Review source', '/app.html#settings/sources', false
  ) then
    raise exception 'generic credential guidance was incorrectly rejected';
  end if;

  if public.norva_behavioral_step_copy_safe(
    'import_unresolved', 'Review your source',
    'Open https://provider.example/get.php?username=alice&password=secret.',
    'Review source', '/app.html#settings/sources', false
  ) or public.norva_behavioral_step_copy_safe(
    'import_unresolved', 'Review your source',
    'Your password is secret and your token: abc123.',
    'Review source', '/app.html#settings/sources', false
  ) or public.norva_behavioral_step_copy_safe(
    'no_source', 'Complete setup',
    'Use card number 4111 1111 1111 1111 to continue.',
    'Connect source', '/app.html#settings/sources', false
  ) or public.norva_behavioral_step_copy_safe(
    'continue_watching', 'New episodes are ready',
    'See what changed in your catalogue.',
    'Open Norva', '/app.html#home', false
  ) or public.norva_behavioral_step_copy_safe(
    'catalog_ready_no_first_play', 'Your catalogue is ready',
    'Choose something to watch.',
    'Start watching', '/app.html#settings/sources', false
  ) then
    raise exception 'unsafe lifecycle copy or destination passed the outbound-copy gate';
  end if;

  if not public.norva_behavioral_step_copy_safe(
    'continue_watching', 'New content is waiting',
    'Your catalogue has changed since your last watch.',
    'Open Norva', '/app.html#home', true
  ) then
    raise exception 'freshness-gated copy was incorrectly rejected';
  end if;

  begin
    update public.behavioral_lifecycle_steps
    set body = 'Private source: provider.example/get.php'
    where journey_key = 'no_source' and step_key = 'context_help'
    returning * into strict v_step;
    raise exception 'the step table accepted unsafe copy';
  exception
    when check_violation then null;
  end;
end
$assert$;

-- The management surface must reject accidental activation without an exact
-- typed phrase.
do $assert$
begin
  begin
    perform public.admin_update_behavioral_lifecycle_runtime(
      false, 'internal_test', 'WRONG', 'Runtime integration rejection proof.'
    );
    raise exception 'runtime accepted an invalid typed confirmation';
  exception
    when sqlstate '22023' then null;
  end;

  begin
    perform public.admin_update_behavioral_lifecycle_journey(
      'no_source', 'active', 100, 10, array['IN','BD'], 'WRONG',
      null, null, null, null, null, null,
      'Journey integration rejection proof.'
    );
    raise exception 'journey accepted an invalid typed confirmation';
  exception
    when sqlstate '22023' then null;
  end;

  begin
    perform public.admin_update_behavioral_lifecycle_journey(
      'no_source', 'draft', 0, 10, array['IN','BD'], null,
      14, 2, 3, 2, 21, 9,
      'Daily push hard-ceiling rejection proof.'
    );
    raise exception 'journey accepted more than one lifecycle push per day';
  exception
    when sqlstate '22023' then null;
  end;

  begin
    perform public.admin_update_behavioral_lifecycle_journey(
      'no_source', 'draft', 0, 10, array['IN','BD'], null,
      14, 1, 4, 2, 21, 9,
      'Weekly push hard-ceiling rejection proof.'
    );
    raise exception 'journey accepted more than three lifecycle pushes per week';
  exception
    when sqlstate '22023' then null;
  end;

  begin
    perform public.admin_update_behavioral_lifecycle_journey(
      'no_source', 'draft', 0, 10, array['IN','BD'], null,
      14, 1, 3, 3, 21, 9,
      'Weekly email hard-ceiling rejection proof.'
    );
    raise exception 'journey accepted more than two lifecycle emails per week';
  exception
    when sqlstate '22023' then null;
  end;
end
$assert$;

-- This account predates activation. Even if it later becomes an internal test
-- account, the activation boundary must prevent a retrospective blast.
insert into auth.users (id, email, created_at)
values (
  '00000000-0000-0000-0000-000000000010',
  'legacy-internal@example.test',
  clock_timestamp() - interval '30 days'
);
insert into public.admin_internal_accounts (user_id)
values ('00000000-0000-0000-0000-000000000010');

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000001', 'admin@example.test');
insert into public.admin_internal_accounts (user_id)
values ('00000000-0000-0000-0000-000000000001');
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000001',
  true
);

-- A production-country pilot has an independent product-readiness gate. It
-- cannot open on prose, a stale release label or a partial import test. The
-- attestation is append-only, content-addressed and safe to retry exactly.
do $assert$
declare
  v_first jsonb;
  v_retry jsonb;
begin
  begin
    perform public.admin_update_behavioral_lifecycle_runtime(
      false, 'pilot', 'START PILOT',
      'Pilot must fail without staging import evidence.'
    );
    raise exception 'pilot opened without import-readiness evidence';
  exception
    when sqlstate '55000' then null;
  end;

  begin
    perform public.admin_record_behavioral_import_readiness(
      'norva-1.3.17', repeat('a', 40), '1.3.17', repeat('1', 64),
      true, false, false, true, true, 'VERIFY IMPORT READINESS'
    );
    raise exception 'partial evidence accepted a passing confirmation';
  exception
    when sqlstate '22023' then null;
  end;

  perform public.admin_record_behavioral_import_readiness(
    'norva-1.3.17', repeat('a', 40), '1.3.17', repeat('1', 64),
    true, false, false, true, true, 'RECORD IMPORT FAILURE'
  );
  begin
    perform public.admin_update_behavioral_lifecycle_runtime(
      false, 'pilot', 'START PILOT',
      'Pilot must fail after a recorded staging failure.'
    );
    raise exception 'pilot opened on failed import-readiness evidence';
  exception
    when sqlstate '55000' then null;
  end;

  v_first := public.admin_record_behavioral_import_readiness(
    'norva-1.3.17', repeat('a', 40), '1.3.17', repeat('2', 64),
    true, true, true, true, true, 'VERIFY IMPORT READINESS'
  );
  v_retry := public.admin_record_behavioral_import_readiness(
    'norva-1.3.17', repeat('a', 40), '1.3.17', repeat('2', 64),
    true, true, true, true, true, 'VERIFY IMPORT READINESS'
  );
  if v_first->>'id' is distinct from v_retry->>'id'
     or (select count(*) from public.behavioral_lifecycle_import_readiness) <> 2 then
    raise exception 'import-readiness retry was not idempotent';
  end if;

  begin
    perform public.admin_record_behavioral_import_readiness(
      'norva-other-release', repeat('a', 40), '1.3.17', repeat('2', 64),
      true, true, true, true, true, 'VERIFY IMPORT READINESS'
    );
    raise exception 'one evidence digest was rebound to another release';
  exception
    when sqlstate '23505' then null;
  end;

  perform public.admin_update_behavioral_lifecycle_runtime(
    false, 'pilot', 'START PILOT',
    'Fresh complete import evidence opens only the pilot runtime gate.'
  );
  if not exists (
    select 1 from public.behavioral_lifecycle_runtime
    where singleton and not emergency_stop and audience_mode = 'pilot'
  ) then
    raise exception 'fresh passing import evidence did not open the pilot gate';
  end if;
  perform public.admin_update_behavioral_lifecycle_runtime(
    true, 'internal_test', 'EMERGENCY STOP',
    'Return to a stopped internal-test state after gate proof.'
  );
end
$assert$;

do $configure$
declare
  v_key text;
begin
  foreach v_key in array array[
    'no_source', 'import_unresolved',
    'catalog_ready_no_first_play', 'continue_watching'
  ] loop
    perform public.admin_update_behavioral_lifecycle_journey(
      v_key, 'active', 100, 10, array['IN','BD'], 'ACTIVATE ' || v_key,
      null, null, null, null, null, null,
      'Local PostgreSQL lifecycle integration proof.'
    );
  end loop;
  perform public.admin_update_behavioral_lifecycle_runtime(
    false, 'internal_test', 'START INTERNAL TEST',
    'Local PostgreSQL internal-test runtime proof.'
  );
end
$configure$;

-- The same evidence is rechecked on every pilot eligibility decision. Opening
-- the runtime is not a permanent bypass: once the 14-day proof expires, real
-- deliveries close automatically even if an operator forgot to stop runtime.
insert into auth.users (id, email, created_at)
values (
  '00000000-0000-0000-0000-000000000020',
  'pilot-gate@example.test',
  clock_timestamp()
);
insert into public.cloud_signup_attribution (
  user_id, signed_up_at, signup_platform, country_code
)
select id, created_at, 'mobile_android', 'IN'
from auth.users
where id = '00000000-0000-0000-0000-000000000020';

select public.admin_update_behavioral_lifecycle_runtime(
  false, 'pilot', 'START PILOT',
  'Verify that pilot relevance closes when import evidence expires.'
);

do $assert$
begin
  if not public.norva_behavioral_journey_relevant(
       '00000000-0000-0000-0000-000000000020', 'no_source', clock_timestamp()
     ) then
    raise exception 'fresh import evidence did not allow a relevant pilot account';
  end if;
  if public.norva_behavioral_journey_relevant(
       '00000000-0000-0000-0000-000000000020', 'no_source',
       clock_timestamp() + interval '15 days'
     ) then
    raise exception 'expired import evidence still allowed pilot relevance';
  end if;
end
$assert$;

select public.admin_update_behavioral_lifecycle_runtime(
  true, 'internal_test', 'EMERGENCY STOP',
  'Return to stopped mode after import-evidence expiry proof.'
);
select public.admin_update_behavioral_lifecycle_runtime(
  false, 'internal_test', 'START INTERNAL TEST',
  'Resume the isolated PostgreSQL integration scenarios.'
);
delete from auth.users
where id = '00000000-0000-0000-0000-000000000020';

do $assert$
begin
  if exists (
    select 1
    from public.behavioral_lifecycle_steps st
    group by st.journey_key
    having count(distinct st.collapse_key) <> 1
       or min(st.collapse_key) <> ('lifecycle-' || replace(st.journey_key, '_', '-'))
  ) then
    raise exception 'a lifecycle journey does not own one canonical collapse key';
  end if;
end
$assert$;

do $assert$
begin
  if (select count(*) from public.behavioral_lifecycle_experiment_versions) <> 4
     or exists (
       select 1 from public.behavioral_lifecycle_experiment_versions
       where experiment_variable <> 'baseline'
         or jsonb_array_length(step_snapshot->'structure') = 0
     ) then
    raise exception 'initial activation did not create four immutable baseline snapshots';
  end if;
end
$assert$;

do $assert$
begin
  if (public.norva_seed_behavioral_lifecycle_jobs(500)->>'inserted')::integer <> 0 then
    raise exception 'pre-activation account entered a fresh cohort';
  end if;
end
$assert$;

-- Find stable UUIDs rather than hard-coding assumptions about the MD5 bucket.
-- One account is treatment for all four journeys; one is permanent holdout for
-- no_source. Both are created after the fresh activation boundary.
create temporary table lifecycle_test_identities (
  role text primary key,
  user_id uuid not null unique
);

insert into lifecycle_test_identities (role, user_id)
select 'treatment', candidate
from (
  select md5('lifecycle-treatment-' || i::text)::uuid as candidate
  from generate_series(1, 10000) i
) candidates
where public.norva_behavioral_bucket(candidate, 'no_source:holdout') >= 1000
  and public.norva_behavioral_bucket(candidate, 'import_unresolved:holdout') >= 1000
  and public.norva_behavioral_bucket(candidate, 'catalog_ready_no_first_play:holdout') >= 1000
  and public.norva_behavioral_bucket(candidate, 'continue_watching:holdout') >= 1000
limit 1;

insert into lifecycle_test_identities (role, user_id)
select 'holdout', candidate
from (
  select md5('lifecycle-holdout-' || i::text)::uuid as candidate
  from generate_series(1, 10000) i
) candidates
where public.norva_behavioral_bucket(candidate, 'no_source:holdout') < 1000
limit 1;

insert into auth.users (id, email)
select user_id, role || '@example.test' from lifecycle_test_identities;
insert into public.admin_internal_accounts (user_id)
select user_id from lifecycle_test_identities;
insert into public.cloud_signup_attribution (
  user_id, signed_up_at, signup_platform, country_code
)
select i.user_id, u.created_at, 'mobile_android', 'IN'
from lifecycle_test_identities i
join auth.users u on u.id = i.user_id;
insert into public.cloud_profiles (id, locale)
select user_id, 'en-IN' from lifecycle_test_identities;

do $assert$
declare
  v_seed jsonb;
  v_treatment uuid := (
    select user_id from lifecycle_test_identities where role = 'treatment'
  );
  v_holdout uuid := (
    select user_id from lifecycle_test_identities where role = 'holdout'
  );
begin
  v_seed := public.norva_seed_behavioral_lifecycle_jobs(500);
  if (v_seed->>'inserted')::integer <> 6
     or (v_seed->>'holdout')::integer <> 3 then
    raise exception 'unexpected no_source seed result: %', v_seed;
  end if;
  if (select count(*) from public.behavioral_lifecycle_outbox
      where user_id = v_treatment and journey_key = 'no_source'
        and status = 'pending' and experiment_arm = 'treatment') <> 3 then
    raise exception 'treatment account did not receive exactly three queued steps';
  end if;
  if (select count(*) from public.behavioral_lifecycle_outbox
      where user_id = v_holdout and journey_key = 'no_source'
        and status = 'holdout' and experiment_arm = 'holdout') <> 3 then
    raise exception 'permanent holdout was not applied consistently to every step';
  end if;
  if (public.norva_seed_behavioral_lifecycle_jobs(500)->>'inserted')::integer <> 0 then
    raise exception 'idempotent seeding created duplicate deliveries';
  end if;
end
$assert$;

-- Make only the immediate in-app treatment row due. The fixture does not alter
-- production timing defaults; it moves this one disposable delivery forward.
update public.behavioral_lifecycle_outbox
set scheduled_for = clock_timestamp() - interval '1 second',
    next_attempt_at = clock_timestamp() - interval '1 second',
    expires_at = clock_timestamp() + interval '1 day'
where user_id = (
    select user_id from lifecycle_test_identities where role = 'treatment'
  )
  and journey_key = 'no_source' and step_key = 'context_help';

do $assert$
declare
  v_user uuid := (
    select user_id from lifecycle_test_identities where role = 'treatment'
  );
  v_delivery uuid;
begin
  if public.norva_materialize_behavioral_in_app(100) <> 1 then
    raise exception 'in-app delivery did not materialize exactly once';
  end if;
  select id into strict v_delivery
  from public.behavioral_lifecycle_outbox
  where user_id = v_user and journey_key = 'no_source'
    and step_key = 'context_help';
  if not exists (
    select 1 from public.cloud_content_events
    where id = v_delivery and kind = 'behavioral_lifecycle'
      and payload->>'delivery_id' = v_delivery::text
  ) then
    raise exception 'in-app delivery was not linked to the notification inbox';
  end if;
  if not public.norva_record_behavioral_delivery_event(v_user, v_delivery, 'opened')
     or not public.norva_record_behavioral_delivery_event(v_user, v_delivery, 'opened') then
    raise exception 'in-app open acknowledgement was rejected';
  end if;
  if (select status from public.behavioral_lifecycle_outbox where id = v_delivery) <> 'opened'
     or (select count(*) from public.behavioral_lifecycle_funnel_events
         where delivery_id = v_delivery and event_name = 'message_opened') <> 1
     or (select count(*) from public.behavioral_lifecycle_delivery_events
         where delivery_id = v_delivery and event_kind = 'opened') <> 1 then
    raise exception 'in-app open was not idempotently measured';
  end if;
end
$assert$;

-- Opt in first, then make an import fail. The email is explicitly marked as a
-- marketing test row so revocation can prove cancellation and scrubbing.
insert into public.cloud_marketing_email_preferences (
  user_id, marketing_email_opt_in, opted_in_at, opted_in_source
)
select user_id, true, clock_timestamp(), 'integration_test'
from lifecycle_test_identities where role = 'treatment';
update public.behavioral_lifecycle_steps
set is_marketing = true
where journey_key = 'import_unresolved' and step_key = 'day_one_email';

do $assert$
declare
  v_user uuid := (
    select user_id from lifecycle_test_identities where role = 'treatment'
  );
  v_family text;
  v_seed jsonb;
begin
  -- Exercise every bounded family used by the HTTP/UI mapping. The database
  -- must keep only the classification, never a raw response or private URL.
  foreach v_family in array array[
    'credentials', 'missing_credentials', 'endpoint_not_found', 'timeout',
    'provider_busy', 'rate_limited', 'playlist_format', 'invalid_input',
    'payload_too_large', 'provider_unreachable', 'infrastructure', 'unknown'
  ] loop
    if not public.norva_capture_behavioral_source_attempt(
      v_user, 'm3u', 'failed', v_family, 'mobile_android', '1.3.16',
      md5('lifecycle-failure-family-' || v_family)::uuid
    ) then
      raise exception 'source attempt was not captured for %', v_family;
    end if;
    if (select last_failure_family from public.behavioral_lifecycle_user_state
        where user_id = v_user) <> v_family then
      raise exception 'bounded failure family % was not projected', v_family;
    end if;
  end loop;
  -- Keep timeout as the final context used by the notification payload proof.
  perform public.norva_capture_behavioral_source_attempt(
    v_user, 'm3u', 'failed', 'timeout', 'mobile_android', '1.3.16',
    '10000000-0000-0000-0000-000000000001'
  );
  if exists (
    select 1 from public.behavioral_lifecycle_outbox
    where user_id = v_user and journey_key = 'no_source'
      and status in ('pending','processing','email_queued')
  ) then
    raise exception 'no_source deliveries survived the first source attempt';
  end if;
  if (select last_failure_family from public.behavioral_lifecycle_user_state
      where user_id = v_user) <> 'timeout' then
    raise exception 'bounded import failure family was not projected';
  end if;
  v_seed := public.norva_seed_behavioral_lifecycle_jobs(500);
  if (v_seed->>'inserted')::integer <> 3 then
    raise exception 'import_unresolved did not seed three treatment steps: %', v_seed;
  end if;
end
$assert$;

-- The in-app import reminder contains only bounded diagnostic context. It must
-- never copy a provider address, credential or content identifier into the
-- user-visible inbox payload.
update public.behavioral_lifecycle_outbox
set scheduled_for = clock_timestamp() - interval '1 second',
    next_attempt_at = clock_timestamp() - interval '1 second',
    expires_at = clock_timestamp() + interval '1 day'
where user_id = (
    select user_id from lifecycle_test_identities where role = 'treatment'
  )
  and journey_key = 'import_unresolved' and step_key = 'error_help';

do $assert$
declare
  v_user uuid := (
    select user_id from lifecycle_test_identities where role = 'treatment'
  );
  v_payload jsonb;
begin
  if public.norva_materialize_behavioral_in_app(100) <> 1 then
    raise exception 'contextual import help did not materialize exactly once';
  end if;
  select e.payload into strict v_payload
  from public.cloud_content_events e
  join public.behavioral_lifecycle_outbox o on o.id = e.id
  where o.user_id = v_user and o.journey_key = 'import_unresolved'
    and o.step_key = 'error_help';
  if v_payload->>'failure_family' <> 'timeout'
     or v_payload->>'source_type' <> 'm3u'
     or v_payload->>'deep_link' <> '/app.html#settings/sources'
     or v_payload ?| array[
       'provider_url', 'playlist_url', 'username', 'password', 'content_id', 'raw_payload'
     ] then
    raise exception 'import help payload leaked or lost bounded context: %', v_payload;
  end if;
end
$assert$;

-- A denied/unknown permission is never interpreted as reachable merely because
-- an FCM token exists.
select public.norva_register_push_token(
  (select user_id from lifecycle_test_identities where role = 'treatment'),
  'fixture-token-denied', 'android', 'denied',
  (
    select name from pg_catalog.pg_timezone_names
    where extract(hour from clock_timestamp() at time zone name) between 10 and 19
    order by name limit 1
  ),
  'en-IN', '1.3.16'
);
update public.behavioral_lifecycle_outbox
set scheduled_for = clock_timestamp() - interval '1 second',
    next_attempt_at = clock_timestamp() - interval '1 second',
    expires_at = clock_timestamp() + interval '1 day'
where user_id = (
    select user_id from lifecycle_test_identities where role = 'treatment'
  )
  and journey_key = 'import_unresolved' and step_key = 'two_hour_push';
create temporary table lifecycle_denied_claim as
select * from public.norva_claim_behavioral_deliveries('push', 1, 90);

do $assert$
declare
  c lifecycle_denied_claim%rowtype;
  v_auth jsonb;
begin
  select * into strict c from lifecycle_denied_claim;
  v_auth := public.norva_authorize_behavioral_push(c.id, c.lease_token);
  if coalesce((v_auth->>'authorized')::boolean, true)
     or v_auth->>'reason' <> 'permission_unavailable' then
    raise exception 'denied permission was treated as reachable: %', v_auth;
  end if;
  if (select status from public.behavioral_lifecycle_outbox where id = c.id) <> 'suppressed' then
    raise exception 'permission-unavailable push was not suppressed';
  end if;
end
$assert$;

update public.cloud_marketing_email_preferences
set marketing_email_opt_in = false,
    unsubscribed_at = clock_timestamp(),
    unsubscribed_source = 'integration_test'
where user_id = (
  select user_id from lifecycle_test_identities where role = 'treatment'
);

do $assert$
declare
  v_user uuid := (
    select user_id from lifecycle_test_identities where role = 'treatment'
  );
begin
  if exists (
    select 1 from public.behavioral_lifecycle_outbox
    where user_id = v_user and journey_key = 'import_unresolved'
      and step_key = 'day_one_email'
      and status in ('pending','processing','email_queued')
  ) then
    raise exception 'marketing-email revocation did not cancel queued work';
  end if;
  if (select count(*) from public.behavioral_lifecycle_funnel_events
      where user_id = v_user and event_name = 'email_unsubscribed') <> 1 then
    raise exception 'email unsubscribe event was not measured once';
  end if;
end
$assert$;

-- A marketing email that was re-queued after consent disappeared must still
-- fail its final authorization. Claiming is not permission to send.
update public.behavioral_lifecycle_outbox
set status = 'pending', canceled_at = null, last_error_family = null,
    scheduled_for = clock_timestamp() - interval '1 second',
    next_attempt_at = clock_timestamp() - interval '1 second',
    expires_at = clock_timestamp() + interval '1 day',
    lease_token = null, lease_expires_at = null
where user_id = (
    select user_id from lifecycle_test_identities where role = 'treatment'
  )
  and journey_key = 'import_unresolved' and step_key = 'day_one_email';
create temporary table lifecycle_no_consent_email_claim as
select * from public.norva_claim_behavioral_deliveries('email', 1, 90);

do $assert$
declare
  c lifecycle_no_consent_email_claim%rowtype;
  v_auth jsonb;
begin
  select * into strict c from lifecycle_no_consent_email_claim;
  v_auth := public.norva_authorize_behavioral_email_enqueue(c.id, c.lease_token);
  if coalesce((v_auth->>'authorized')::boolean, true)
     or v_auth->>'reason' <> 'eligibility_revoked'
     or (select status from public.behavioral_lifecycle_outbox where id = c.id) <> 'canceled' then
    raise exception 'marketing email survived absent/revoked consent: %', v_auth;
  end if;
end
$assert$;

-- Re-arm the previously suppressed reminder only inside this rolled-back test,
-- claim it, then let a successful import land before final authorization. The
-- authoritative conversion must cancel the lease and prevent transport.
select public.norva_register_push_token(
  (select user_id from lifecycle_test_identities where role = 'treatment'),
  'fixture-token-denied', 'android', 'granted',
  (
    select name from pg_catalog.pg_timezone_names
    where extract(hour from clock_timestamp() at time zone name) between 10 and 19
    order by name limit 1
  ),
  'en-IN', '1.3.16'
);
update public.behavioral_lifecycle_outbox
set status = 'pending', canceled_at = null, last_error_family = null,
    scheduled_for = clock_timestamp() - interval '1 second',
    next_attempt_at = clock_timestamp() - interval '1 second',
    expires_at = clock_timestamp() + interval '1 day',
    lease_token = null, lease_expires_at = null
where user_id = (
    select user_id from lifecycle_test_identities where role = 'treatment'
  )
  and journey_key = 'import_unresolved' and step_key = 'two_hour_push';
create temporary table lifecycle_import_race_claim as
select * from public.norva_claim_behavioral_deliveries('push', 1, 90);

-- A ready source is authoritative import success and must replace the unresolved
-- journey with catalogue-ready behavior.
insert into public.cloud_sources (
  id, user_id, source_type, sync_status, last_synced_at
)
select
  '20000000-0000-0000-0000-000000000001', user_id,
  'm3u', 'ready', clock_timestamp()
from lifecycle_test_identities where role = 'treatment';

do $assert$
declare
  c lifecycle_import_race_claim%rowtype;
  v_user uuid := (
    select user_id from lifecycle_test_identities where role = 'treatment'
  );
  v_auth jsonb;
  v_seed jsonb;
begin
  select * into strict c from lifecycle_import_race_claim;
  v_auth := public.norva_authorize_behavioral_push(c.id, c.lease_token);
  if coalesce((v_auth->>'authorized')::boolean, true)
     or v_auth->>'reason' <> 'claim_missing'
     or (select status from public.behavioral_lifecycle_outbox where id = c.id) <> 'canceled'
     or (select transport_started_at from public.behavioral_lifecycle_outbox where id = c.id) is not null then
    raise exception 'import success did not win the pre-send authorization race: %', v_auth;
  end if;
  if not public.norva_behavioral_state_relevant(v_user, 'catalog_ready_no_first_play')
     or public.norva_behavioral_state_relevant(v_user, 'import_unresolved') then
    raise exception 'ready source did not transition between journeys';
  end if;
  if exists (
    select 1
    from public.cloud_content_events e
    join public.behavioral_lifecycle_outbox o on o.id = e.id
    where o.user_id = v_user
      and o.journey_key in ('no_source', 'import_unresolved')
      and e.kind = 'behavioral_lifecycle'
  ) then
    raise exception 'converted in-app reminders remained visible in the notification inbox';
  end if;
  if exists (
    select 1
    from public.behavioral_lifecycle_outbox o
    where o.user_id = v_user
      and o.journey_key in ('no_source', 'import_unresolved')
      and o.channel = 'in_app'
      and o.status in ('delivered', 'opened')
      and not exists (
        select 1
        from public.behavioral_lifecycle_funnel_events f
        where f.delivery_id = o.id
          and f.event_name = 'message_cancelled_after_conversion'
      )
  ) then
    raise exception 'converted in-app reminder removal was not auditable';
  end if;
  v_seed := public.norva_seed_behavioral_lifecycle_jobs(500);
  if (v_seed->>'inserted')::integer <> 3 then
    raise exception 'catalogue-ready journey did not seed three steps: %', v_seed;
  end if;
end
$assert$;

-- Replace the denied device state with an explicit grant and prove the race in
-- which Android receipt arrives before the worker stores FCM acceptance.
select public.norva_register_push_token(
  (select user_id from lifecycle_test_identities where role = 'treatment'),
  'fixture-token-denied', 'android', 'granted',
  (
    select name from pg_catalog.pg_timezone_names
    where extract(hour from clock_timestamp() at time zone name) between 10 and 19
    order by name limit 1
  ),
  'en-IN', '1.3.16'
);
update public.behavioral_lifecycle_outbox
set scheduled_for = clock_timestamp() - interval '1 second',
    next_attempt_at = clock_timestamp() - interval '1 second',
    expires_at = clock_timestamp() + interval '1 day'
where user_id = (
    select user_id from lifecycle_test_identities where role = 'treatment'
  )
  and journey_key = 'catalog_ready_no_first_play'
  and step_key = 'four_hour_push';
create temporary table lifecycle_granted_claim as
select * from public.norva_claim_behavioral_deliveries('push', 1, 90);

do $assert$
declare
  c lifecycle_granted_claim%rowtype;
  v_user uuid := (
    select user_id from lifecycle_test_identities where role = 'treatment'
  );
  v_auth jsonb;
  v_complete text;
begin
  select * into strict c from lifecycle_granted_claim;
  v_auth := public.norva_authorize_behavioral_push(c.id, c.lease_token);
  if not coalesce((v_auth->>'authorized')::boolean, false)
     or jsonb_array_length(v_auth->'tokens') <> 1 then
    raise exception 'permission-granted push was not authorized: %', v_auth;
  end if;
  if not public.norva_record_behavioral_delivery_event(v_user, c.id, 'delivered') then
    raise exception 'fast Android receipt was rejected';
  end if;
  if (select status from public.behavioral_lifecycle_outbox where id = c.id) <> 'processing' then
    raise exception 'fast receipt stole the active worker lease';
  end if;
  v_complete := public.norva_complete_behavioral_push(
    c.id, c.lease_token, 1, 0, 0, true, null
  );
  if v_complete <> 'delivered' then
    raise exception 'FCM completion did not fold the fast receipt: %', v_complete;
  end if;
  if not public.norva_record_behavioral_delivery_event(v_user, c.id, 'opened')
     or not public.norva_record_behavioral_delivery_event(v_user, c.id, 'opened') then
    raise exception 'push open acknowledgement failed';
  end if;
  if (select count(*) from public.behavioral_lifecycle_delivery_events
      where delivery_id = c.id and event_kind = 'opened') <> 1 then
    raise exception 'push open replay was not deduplicated';
  end if;
end
$assert$;

-- Permission can be revoked after a worker claims a due push. Final
-- authorization re-reads the device state and suppresses the message.
update public.behavioral_lifecycle_outbox
set provider_accepted_at = clock_timestamp() - interval '2 days',
    transport_started_at = clock_timestamp() - interval '2 days'
where user_id = (
    select user_id from lifecycle_test_identities where role = 'treatment'
  )
  and journey_key = 'catalog_ready_no_first_play'
  and step_key = 'four_hour_push';
update public.behavioral_lifecycle_outbox
set scheduled_for = clock_timestamp() - interval '1 second',
    next_attempt_at = clock_timestamp() - interval '1 second',
    expires_at = clock_timestamp() + interval '1 day'
where user_id = (
    select user_id from lifecycle_test_identities where role = 'treatment'
  )
  and journey_key = 'catalog_ready_no_first_play'
  and step_key = 'day_two_push';
create temporary table lifecycle_revoked_after_claim as
select * from public.norva_claim_behavioral_deliveries('push', 1, 90);
update public.cloud_push_tokens
set permission_state = 'denied', updated_at = clock_timestamp()
where token = 'fixture-token-denied';

do $assert$
declare
  c lifecycle_revoked_after_claim%rowtype;
  v_auth jsonb;
begin
  select * into strict c from lifecycle_revoked_after_claim;
  v_auth := public.norva_authorize_behavioral_push(c.id, c.lease_token);
  if coalesce((v_auth->>'authorized')::boolean, true)
     or v_auth->>'reason' <> 'permission_unavailable'
     or (select status from public.behavioral_lifecycle_outbox where id = c.id) <> 'suppressed'
     or (select transport_started_at from public.behavioral_lifecycle_outbox where id = c.id) is not null then
    raise exception 'post-claim permission revocation did not stop push: %', v_auth;
  end if;
end
$assert$;

select public.norva_register_push_token(
  (select user_id from lifecycle_test_identities where role = 'treatment'),
  'fixture-token-denied', 'android', 'granted',
  (
    select name from pg_catalog.pg_timezone_names
    where extract(hour from clock_timestamp() at time zone name) between 10 and 19
    order by name limit 1
  ),
  'en-IN', '1.3.16'
);

insert into public.cloud_playback_events (
  id, user_id, source_id, event_type
)
select
  '30000000-0000-0000-0000-000000000001', user_id,
  '20000000-0000-0000-0000-000000000001', 'first_frame'
from lifecycle_test_identities where role = 'treatment';

do $assert$
declare
  v_user uuid := (
    select user_id from lifecycle_test_identities where role = 'treatment'
  );
begin
  if exists (
    select 1 from public.behavioral_lifecycle_outbox
    where user_id = v_user and journey_key = 'catalog_ready_no_first_play'
      and status in ('pending','processing','email_queued')
  ) then
    raise exception 'first frame did not cancel catalogue-ready reminders';
  end if;
  if (select count(*) from public.behavioral_lifecycle_funnel_events
      where user_id = v_user and event_name = 'first_play') <> 1 then
    raise exception 'first frame was not measured once';
  end if;
end
$assert$;

-- Resume availability is recomputed from durable watch history without copying
-- the content id into lifecycle state.
insert into public.cloud_watch_history (
  id, user_id, source_id, item_type, item_id,
  progress_seconds, duration_seconds, completed, watched_at
)
select
  '40000000-0000-0000-0000-000000000001', user_id,
  '20000000-0000-0000-0000-000000000001', 'movie', 'private-content-id',
  120, 3600, false, clock_timestamp()
from lifecycle_test_identities where role = 'treatment';

do $assert$
declare
  v_user uuid := (
    select user_id from lifecycle_test_identities where role = 'treatment'
  );
  v_seed jsonb;
begin
  if not (select resume_available from public.behavioral_lifecycle_user_state
          where user_id = v_user) then
    raise exception 'resumable watch history was not projected';
  end if;
  v_seed := public.norva_seed_behavioral_lifecycle_jobs(500);
  if (v_seed->>'inserted')::integer <> 2 then
    raise exception 'continue-watching did not seed two steps: %', v_seed;
  end if;
  if (select deep_link from public.behavioral_lifecycle_outbox
      where user_id = v_user and journey_key = 'continue_watching'
        and step_key = 'two_day_push') <> '/app.html#home/resume' then
    raise exception 'continue-watching did not target the safe resume route';
  end if;
end
$assert$;

-- Eight failed attempts become a dead letter. A typed admin retry is allowed
-- only while the same journey remains relevant and unexpired.
update public.behavioral_lifecycle_outbox
set scheduled_for = clock_timestamp() - interval '1 second',
    next_attempt_at = clock_timestamp() - interval '1 second',
    expires_at = clock_timestamp() + interval '1 day',
    attempt_count = 7
where user_id = (
    select user_id from lifecycle_test_identities where role = 'treatment'
  )
  and journey_key = 'continue_watching' and step_key = 'two_day_push';
create temporary table lifecycle_dead_claim as
select * from public.norva_claim_behavioral_deliveries('push', 1, 90);

do $assert$
declare
  c lifecycle_dead_claim%rowtype;
begin
  select * into strict c from lifecycle_dead_claim;
  if public.norva_complete_behavioral_push(
      c.id, c.lease_token, 0, 1, 0, true, 'transport_error'
    ) <> 'dead_letter' then
    raise exception 'eighth transport failure did not dead-letter';
  end if;
  if not public.admin_retry_behavioral_lifecycle_delivery(
    c.id, 'RETRY ' || c.id::text, 'Local dead-letter retry integration proof.'
  ) then
    raise exception 'typed retry rejected a still-relevant delivery';
  end if;
  if (select status from public.behavioral_lifecycle_outbox where id = c.id) <> 'pending'
     or not exists (
       select 1 from public.behavioral_lifecycle_admin_audit
       where action = 'delivery_retried' and after_state->>'delivery_id' = c.id::text
     ) then
    raise exception 'dead-letter retry was not restored and audited';
  end if;
end
$assert$;

-- A timezone change after claim is also re-evaluated at the final gate. Then
-- simulate several offline days: once the TTL is past, the deferred push is
-- canceled rather than delivered in a stale burst when the device returns.
select public.norva_register_push_token(
  (select user_id from lifecycle_test_identities where role = 'treatment'),
  'fixture-token-denied', 'android', 'granted',
  (
    select name from pg_catalog.pg_timezone_names
    where extract(hour from clock_timestamp() at time zone name) between 10 and 19
    order by name limit 1
  ),
  'en-IN', '1.3.16'
);
update public.behavioral_lifecycle_outbox
set status = 'pending', last_error_family = null,
    scheduled_for = clock_timestamp() - interval '1 second',
    next_attempt_at = clock_timestamp() - interval '1 second',
    expires_at = clock_timestamp() + interval '1 day',
    attempt_count = 0, dead_lettered_at = null,
    lease_token = null, lease_expires_at = null
where user_id = (
    select user_id from lifecycle_test_identities where role = 'treatment'
  )
  and journey_key = 'continue_watching' and step_key = 'two_day_push';
create temporary table lifecycle_timezone_claim as
select * from public.norva_claim_behavioral_deliveries('push', 1, 90);
select public.norva_register_push_token(
  (select user_id from lifecycle_test_identities where role = 'treatment'),
  'fixture-token-denied', 'android', 'granted',
  (
    select name from pg_catalog.pg_timezone_names
    where extract(hour from clock_timestamp() at time zone name) >= 21
       or extract(hour from clock_timestamp() at time zone name) < 9
    order by name limit 1
  ),
  'en-IN', '1.3.16'
);

do $assert$
declare
  c lifecycle_timezone_claim%rowtype;
  v_auth jsonb;
begin
  select * into strict c from lifecycle_timezone_claim;
  v_auth := public.norva_authorize_behavioral_push(c.id, c.lease_token);
  if coalesce((v_auth->>'authorized')::boolean, true)
     or v_auth->>'reason' <> 'deferred'
     or (select status from public.behavioral_lifecycle_outbox where id = c.id) <> 'pending'
     or (select last_error_family from public.behavioral_lifecycle_outbox where id = c.id) <> 'quiet_hours'
     or (select next_attempt_at from public.behavioral_lifecycle_outbox where id = c.id)
        <= clock_timestamp() then
    raise exception 'post-claim timezone change did not defer push: %', v_auth;
  end if;

  update public.behavioral_lifecycle_outbox
  set scheduled_for = clock_timestamp() - interval '3 days',
      expires_at = clock_timestamp() - interval '2 days',
      next_attempt_at = clock_timestamp() - interval '2 days'
  where id = c.id;
  perform public.norva_behavioral_lifecycle_tick(500, 500);
  if (select status from public.behavioral_lifecycle_outbox where id = c.id) <> 'canceled'
     or (select last_error_family from public.behavioral_lifecycle_outbox where id = c.id) <> 'ttl_expired'
     or (select transport_started_at from public.behavioral_lifecycle_outbox where id = c.id) is not null then
    raise exception 'expired offline push was not canceled without transport';
  end if;
end
$assert$;

insert into public.cloud_playback_events (
  id, user_id, source_id, event_type
)
select
  '30000000-0000-0000-0000-000000000002', user_id,
  '20000000-0000-0000-0000-000000000001', 'resume'
from lifecycle_test_identities where role = 'treatment';

do $assert$
declare
  v_user uuid := (
    select user_id from lifecycle_test_identities where role = 'treatment'
  );
begin
  if exists (
    select 1 from public.behavioral_lifecycle_outbox
    where user_id = v_user and journey_key = 'continue_watching'
      and status in ('pending','processing','email_queued')
  ) then
    raise exception 'playback resume did not cancel pending reminders';
  end if;
  if (select count(*) from public.behavioral_lifecycle_funnel_events
      where user_id = v_user and event_name = 'playback_resumed') <> 1 then
    raise exception 'playback resume was not measured once';
  end if;
  if exists (
    select 1
    from public.behavioral_lifecycle_user_state s
    where s.user_id = v_user
      and to_jsonb(s) ? 'item_id'
  ) then
    raise exception 'lifecycle projection retained a content identifier';
  end if;
end
$assert$;

-- Raw product signals can overlap (for example, a saved resume position while
-- the provider connection is broken). Only the highest-priority active journey
-- may remain relevant, and a lower-priority delivery already queued must be
-- canceled before transport.
insert into auth.users (id, email, created_at)
values (
  '70000000-0000-0000-0000-000000000001',
  'priority-overlap@example.test',
  clock_timestamp()
);
insert into public.admin_internal_accounts (user_id)
values ('70000000-0000-0000-0000-000000000001');
update public.behavioral_lifecycle_user_state
set signup_platform = 'mobile_android',
    country_code = 'IN',
    timezone = 'Asia/Kolkata',
    first_source_attempt_at = clock_timestamp(),
    last_source_attempt_at = clock_timestamp(),
    source_attempt_count = 1,
    last_source_type = 'm3u',
    last_source_outcome = 'failed',
    last_failure_family = 'timeout',
    import_issue_started_at = clock_timestamp(),
    import_issue_origin = 'attempt'
where user_id = '70000000-0000-0000-0000-000000000001';
insert into public.cloud_watch_history (
  id, user_id, item_type, item_id, progress_seconds, duration_seconds,
  completed, watched_at
) values (
  '70000000-0000-0000-0000-000000000101',
  '70000000-0000-0000-0000-000000000001',
  'movie', 'private-priority-fixture', 120, 3600, false,
  clock_timestamp() - interval '3 days'
);

do $assert$
declare
  v_user constant uuid := '70000000-0000-0000-0000-000000000001';
  v_resume timestamptz;
  v_version integer;
begin
  if not public.norva_behavioral_state_relevant(v_user, 'import_unresolved')
     or not public.norva_behavioral_state_relevant(v_user, 'continue_watching') then
    raise exception 'overlap fixture did not expose both raw product states';
  end if;
  if not public.norva_behavioral_journey_relevant(v_user, 'import_unresolved')
     or public.norva_behavioral_journey_relevant(v_user, 'continue_watching') then
    raise exception 'journey priority did not keep the upstream import repair only';
  end if;

  perform public.norva_seed_behavioral_lifecycle_jobs(500);
  if not exists (
       select 1 from public.behavioral_lifecycle_outbox
       where user_id = v_user and journey_key = 'import_unresolved'
     ) or exists (
       select 1 from public.behavioral_lifecycle_outbox
       where user_id = v_user and journey_key = 'continue_watching'
     ) then
    raise exception 'seeding contaminated the priority fixture with two journeys';
  end if;

  select resume_anchor_at into strict v_resume
  from public.behavioral_lifecycle_user_state where user_id = v_user;
  select version into strict v_version
  from public.behavioral_lifecycle_journeys where journey_key = 'continue_watching';
  insert into public.behavioral_lifecycle_outbox (
    id, dedupe_key, user_id, journey_key, step_key, config_version, channel,
    status, experiment_arm, title, body, cta_label, deep_link, ttl_seconds,
    collapse_key, triggered_at, scheduled_for, expires_at, next_attempt_at
  ) values (
    '70000000-0000-0000-0000-000000000011',
    'priority-conflict-continue-0001', v_user, 'continue_watching',
    'two_day_push', v_version, 'push', 'pending', 'treatment',
    'Continue watching', 'Your progress is saved.', 'Continue',
    '/app.html#home/resume', 86400, 'lifecycle-continue-watching', v_resume,
    clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 day',
    clock_timestamp() - interval '1 minute'
  );
  perform public.norva_behavioral_lifecycle_tick(500, 500);
  if (select status from public.behavioral_lifecycle_outbox
      where id = '70000000-0000-0000-0000-000000000011') <> 'canceled' then
    raise exception 'lower-priority queued journey survived the final relevance gate';
  end if;
end
$assert$;

-- The 1/day, 3/week push ceilings and 2/week email ceiling are account-wide,
-- not per journey. Operational work must also be claimed before marketing work.
insert into auth.users (id, email, created_at)
values (
  '70000000-0000-0000-0000-000000000002',
  'frequency-proof@example.test',
  clock_timestamp()
);

do $assert$
declare
  v_user constant uuid := '70000000-0000-0000-0000-000000000002';
  v_now timestamptz := clock_timestamp();
  v_version integer;
  v_allowed timestamptz;
  v_expected timestamptz;
  v_claim record;
begin
  select version into strict v_version
  from public.behavioral_lifecycle_journeys where journey_key = 'no_source';

  insert into public.behavioral_lifecycle_outbox (
    dedupe_key, user_id, journey_key, step_key, config_version, channel,
    status, experiment_arm, title, body, cta_label, deep_link, ttl_seconds,
    collapse_key, triggered_at, scheduled_for, expires_at, next_attempt_at,
    provider_accepted_at, accepted_count
  ) values (
    'frequency-proof-push-01-70000000', v_user, 'no_source', 'day_one_push',
    v_version, 'push', 'provider_accepted', 'treatment', 'Frequency proof',
    'Frequency proof body.', 'Open Norva', '/app.html#settings/sources',
    86400, 'lifecycle-no-source', v_now - interval '1 hour',
    v_now - interval '1 hour', v_now + interval '14 days', v_now,
    v_now - interval '1 hour', 1
  );
  select provider_accepted_at + interval '24 hours' into strict v_expected
  from public.behavioral_lifecycle_outbox
  where dedupe_key = 'frequency-proof-push-01-70000000';
  v_allowed := public.norva_behavioral_frequency_allowed_at(
    v_user, 'push', 'no_source', v_now
  );
  if v_allowed <> v_expected then
    raise exception 'daily account-wide push ceiling failed: % <> %', v_allowed, v_expected;
  end if;

  insert into public.behavioral_lifecycle_outbox (
    dedupe_key, user_id, journey_key, step_key, config_version, channel,
    status, experiment_arm, title, body, cta_label, deep_link, ttl_seconds,
    collapse_key, triggered_at, scheduled_for, expires_at, next_attempt_at,
    provider_accepted_at, accepted_count
  ) values
    ('frequency-proof-push-02-70000000', v_user, 'no_source', 'day_one_push',
     v_version, 'push', 'provider_accepted', 'treatment', 'Frequency proof',
     'Frequency proof body.', 'Open Norva', '/app.html#settings/sources',
     86400, 'lifecycle-no-source', v_now - interval '2 days',
     v_now - interval '2 days', v_now + interval '14 days', v_now,
     v_now - interval '2 days', 1),
    ('frequency-proof-push-03-70000000', v_user, 'no_source', 'day_one_push',
     v_version, 'push', 'provider_accepted', 'treatment', 'Frequency proof',
     'Frequency proof body.', 'Open Norva', '/app.html#settings/sources',
     86400, 'lifecycle-no-source', v_now - interval '4 days',
     v_now - interval '4 days', v_now + interval '14 days', v_now,
     v_now - interval '4 days', 1);
  select min(provider_accepted_at) + interval '7 days' into strict v_expected
  from public.behavioral_lifecycle_outbox
  where user_id = v_user and channel = 'push' and provider_accepted_at >= v_now - interval '7 days';
  v_allowed := public.norva_behavioral_frequency_allowed_at(
    v_user, 'push', 'import_unresolved', v_now
  );
  if v_allowed <> v_expected then
    raise exception 'weekly cross-journey push ceiling failed: % <> %', v_allowed, v_expected;
  end if;

  insert into public.behavioral_lifecycle_outbox (
    dedupe_key, user_id, journey_key, step_key, config_version, channel,
    status, experiment_arm, title, body, cta_label, deep_link, ttl_seconds,
    collapse_key, triggered_at, scheduled_for, expires_at, next_attempt_at,
    provider_accepted_at, accepted_count
  ) values
    ('frequency-proof-email-01-70000000', v_user, 'no_source', 'day_three_email',
     v_version, 'email', 'provider_accepted', 'treatment', 'Frequency proof',
     'Frequency proof body.', 'Open Norva', '/app.html#settings/sources',
     86400, 'lifecycle-no-source', v_now - interval '1 day',
     v_now - interval '1 day', v_now + interval '14 days', v_now,
     v_now - interval '1 day', 1),
    ('frequency-proof-email-02-70000000', v_user, 'no_source', 'day_three_email',
     v_version, 'email', 'provider_accepted', 'treatment', 'Frequency proof',
     'Frequency proof body.', 'Open Norva', '/app.html#settings/sources',
     86400, 'lifecycle-no-source', v_now - interval '2 days',
     v_now - interval '2 days', v_now + interval '14 days', v_now,
     v_now - interval '2 days', 1);
  select min(provider_accepted_at) + interval '7 days' into strict v_expected
  from public.behavioral_lifecycle_outbox
  where user_id = v_user and channel = 'email' and provider_accepted_at >= v_now - interval '7 days';
  v_allowed := public.norva_behavioral_frequency_allowed_at(
    v_user, 'email', 'catalog_ready_no_first_play', v_now
  );
  if v_allowed <> v_expected then
    raise exception 'weekly cross-journey email ceiling failed: % <> %', v_allowed, v_expected;
  end if;

  update public.behavioral_lifecycle_outbox
  set next_attempt_at = v_now + interval '1 day'
  where channel = 'push' and status = 'pending';
  insert into public.behavioral_lifecycle_outbox (
    id, dedupe_key, user_id, journey_key, step_key, config_version, channel,
    status, experiment_arm, title, body, cta_label, deep_link, ttl_seconds,
    collapse_key, is_marketing, triggered_at, scheduled_for, expires_at,
    next_attempt_at
  ) values
    ('70000000-0000-0000-0000-000000000021',
     'priority-claim-operational-70000000', v_user, 'no_source', 'day_one_push',
     v_version, 'push', 'pending', 'treatment', 'Operational proof',
     'Operational proof body.', 'Open Norva', '/app.html#settings/sources',
     86400, 'lifecycle-no-source', false, v_now - interval '1 hour',
     v_now - interval '1 hour', v_now + interval '1 day', v_now - interval '1 minute'),
    ('70000000-0000-0000-0000-000000000022',
     'priority-claim-marketing-70000000', v_user, 'no_source', 'day_one_push',
     v_version, 'push', 'pending', 'treatment', 'Marketing proof',
     'Marketing proof body.', 'Open Norva', '/app.html#settings/sources',
     86400, 'lifecycle-no-source', true, v_now - interval '1 hour',
     v_now - interval '1 hour', v_now + interval '1 day', v_now - interval '1 minute');
  select * into strict v_claim
  from public.norva_claim_behavioral_deliveries('push', 1, 90);
  if v_claim.id <> '70000000-0000-0000-0000-000000000021'::uuid then
    raise exception 'marketing delivery was claimed before operational work: %', v_claim.id;
  end if;
  update public.behavioral_lifecycle_outbox
  set status = 'canceled', canceled_at = v_now,
      lease_token = null, lease_expires_at = null
  where id in (
    '70000000-0000-0000-0000-000000000021',
    '70000000-0000-0000-0000-000000000022'
  );
end
$assert$;

-- A fresh trigger for the same journey cannot bypass the configured 7–14 day
-- cooldown after a previously accepted reminder.
insert into auth.users (id, email, created_at)
values (
  '70000000-0000-0000-0000-000000000003',
  'cooldown-proof@example.test',
  clock_timestamp()
);
insert into public.admin_internal_accounts (user_id)
values ('70000000-0000-0000-0000-000000000003');
update public.behavioral_lifecycle_journeys
set activated_at = clock_timestamp() - interval '1 day'
where journey_key = 'import_unresolved';
update public.behavioral_lifecycle_user_state
set signup_platform = 'mobile_android',
    country_code = 'IN',
    timezone = 'Asia/Kolkata',
    first_source_attempt_at = clock_timestamp() - interval '2 hours',
    last_source_attempt_at = clock_timestamp() - interval '2 hours',
    source_attempt_count = 1,
    last_source_type = 'xtream',
    last_source_outcome = 'failed',
    last_failure_family = 'timeout',
    import_issue_started_at = clock_timestamp() - interval '2 hours',
    import_issue_origin = 'attempt'
where user_id = '70000000-0000-0000-0000-000000000003';

do $assert$
declare
  v_user constant uuid := '70000000-0000-0000-0000-000000000003';
  v_initial_trigger timestamptz;
  v_new_trigger timestamptz;
  v_accepted_at timestamptz := clock_timestamp();
  v_cooldown integer;
begin
  select import_issue_started_at into strict v_initial_trigger
  from public.behavioral_lifecycle_user_state where user_id = v_user;
  select cooldown_days into strict v_cooldown
  from public.behavioral_lifecycle_journeys where journey_key = 'import_unresolved';
  perform public.norva_seed_behavioral_lifecycle_jobs(500);
  update public.behavioral_lifecycle_outbox
  set status = 'provider_accepted', provider_accepted_at = v_accepted_at,
      accepted_count = 1, lease_token = null, lease_expires_at = null
  where user_id = v_user and journey_key = 'import_unresolved'
    and step_key = 'two_hour_push' and triggered_at = v_initial_trigger;
  if not found then raise exception 'cooldown fixture did not seed its first trigger'; end if;

  v_new_trigger := clock_timestamp() - interval '1 minute';
  update public.behavioral_lifecycle_user_state
  set import_issue_started_at = v_new_trigger,
      last_source_attempt_at = v_new_trigger,
      updated_at = clock_timestamp()
  where user_id = v_user;
  perform public.norva_seed_behavioral_lifecycle_jobs(500);
  if (select count(*) from public.behavioral_lifecycle_outbox
      where user_id = v_user and journey_key = 'import_unresolved'
        and triggered_at = v_new_trigger) <> 3 then
    raise exception 'fresh cooldown trigger did not seed exactly one journey sequence';
  end if;
  if exists (
    select 1 from public.behavioral_lifecycle_outbox
    where user_id = v_user and journey_key = 'import_unresolved'
      and triggered_at = v_new_trigger
      and scheduled_for < v_accepted_at + make_interval(days => v_cooldown)
  ) then
    raise exception 'fresh trigger bypassed the journey cooldown';
  end if;
end
$assert$;

-- Experiment reporting uses only mature, non-internal cohorts from the current
-- journey version. It must preserve treatment/holdout attribution for later
-- business conversions without accepting client-provided attribution data.
insert into auth.users (id, email, created_at) values
  ('71000000-0000-0000-0000-000000000001', 'experiment-t1@example.test', clock_timestamp() - interval '10 days'),
  ('71000000-0000-0000-0000-000000000002', 'experiment-t2@example.test', clock_timestamp() - interval '10 days'),
  ('71000000-0000-0000-0000-000000000003', 'experiment-h1@example.test', clock_timestamp() - interval '10 days'),
  ('71000000-0000-0000-0000-000000000004', 'experiment-h2@example.test', clock_timestamp() - interval '10 days');

update public.behavioral_lifecycle_user_state
set signup_platform = 'mobile_android', country_code = 'IN', app_version = '1.3.16'
where user_id::text like '71000000-0000-0000-0000-00000000000%';

do $assert$
declare
  v_anchor timestamptz := clock_timestamp() - interval '8 days';
  v_now timestamptz := clock_timestamp();
  v_version integer;
  v_window jsonb;
  v_safety jsonb;
  v_milestones jsonb;
  v_decision jsonb;
  v_trial record;
begin
  -- Isolate this proof from earlier queue fixtures while still exercising the
  -- version that the admin overview treats as current. This test-only version
  -- and activation time shift are rolled back and avoid wall-clock waits.
  update public.behavioral_lifecycle_journeys
  set version = version + 100,
      activated_at = v_anchor - interval '1 minute'
  where journey_key = 'no_source'
  returning version into strict v_version;
  delete from public.behavioral_lifecycle_experiment_versions
  where journey_key = 'no_source';
  insert into public.behavioral_lifecycle_experiment_versions (
    journey_key, config_version, experiment_variable, hypothesis,
    primary_metric, window_hours, target_relative_lift_pct,
    unsubscribe_lift_guardrail_pp, provider_rejection_guardrail_pp,
    step_snapshot, activated_at, activated_by
  )
  select j.journey_key, v_version, j.experiment_variable,
         j.experiment_hypothesis, j.exit_event, j.experiment_window_hours,
         j.target_relative_lift_pct, j.unsubscribe_lift_guardrail_pp,
         j.provider_rejection_guardrail_pp,
         public.norva_behavioral_step_experiment_snapshot(j.journey_key),
         v_anchor - interval '1 minute',
         '00000000-0000-0000-0000-000000000001'::uuid
  from public.behavioral_lifecycle_journeys j
  where j.journey_key = 'no_source';

  insert into public.behavioral_lifecycle_outbox (
    id, dedupe_key, user_id, journey_key, step_key, config_version, channel,
    status, experiment_arm, title, body, cta_label, deep_link, ttl_seconds,
    collapse_key, triggered_at, scheduled_for, expires_at, next_attempt_at,
    transport_started_at, provider_accepted_at, last_error_family
  ) values
    ('71000000-0000-0000-0000-000000000101', 'experiment-t1-day-one-push',
     '71000000-0000-0000-0000-000000000001', 'no_source', 'day_one_push',
     v_version, 'push', 'provider_accepted', 'treatment', 'Experiment proof',
     'Treatment measurement proof.', 'Open Norva', '/app.html#settings/sources',
     86400, 'lifecycle-no-source', v_anchor, v_anchor, v_anchor + interval '14 days',
     v_now, v_anchor + interval '1 hour', v_anchor + interval '1 hour', null),
    ('71000000-0000-0000-0000-000000000102', 'experiment-t2-day-one-push',
     '71000000-0000-0000-0000-000000000002', 'no_source', 'day_one_push',
     v_version, 'push', 'dead_letter', 'treatment', 'Experiment proof',
     'Treatment rejection proof.', 'Open Norva', '/app.html#settings/sources',
     86400, 'lifecycle-no-source', v_anchor, v_anchor, v_anchor + interval '14 days',
     v_now, v_anchor + interval '1 hour', null, 'provider_rejected'),
    ('71000000-0000-0000-0000-000000000103', 'experiment-h1-day-one-push',
     '71000000-0000-0000-0000-000000000003', 'no_source', 'day_one_push',
     v_version, 'push', 'holdout', 'holdout', 'Experiment proof',
     'Permanent holdout proof.', 'Open Norva', '/app.html#settings/sources',
     86400, 'lifecycle-no-source', v_anchor, v_anchor, v_anchor + interval '14 days',
     v_now, null, null, null),
    ('71000000-0000-0000-0000-000000000104', 'experiment-h2-day-one-push',
     '71000000-0000-0000-0000-000000000004', 'no_source', 'day_one_push',
     v_version, 'push', 'holdout', 'holdout', 'Experiment proof',
     'Permanent holdout proof.', 'Open Norva', '/app.html#settings/sources',
     86400, 'lifecycle-no-source', v_anchor, v_anchor, v_anchor + interval '14 days',
     v_now, null, null, null);

  perform public.norva_insert_behavioral_funnel_event(
    'experiment-t1-source-attempted',
    '71000000-0000-0000-0000-000000000001', 'source_attempted', 'no_source',
    '71000000-0000-0000-0000-000000000101', v_anchor + interval '12 hours'
  );
  perform public.norva_insert_behavioral_funnel_event(
    'experiment-h1-source-attempted',
    '71000000-0000-0000-0000-000000000003', 'source_attempted', 'no_source',
    '71000000-0000-0000-0000-000000000103', v_anchor + interval '48 hours'
  );

  v_window := public.norva_behavioral_experiment_window(
    'no_source', v_version, 24, v_anchor - interval '1 minute', v_now
  );
  if (v_window->>'treatment_users')::integer <> 2
     or (v_window->>'treatment_conversions')::integer <> 1
     or (v_window->>'holdout_users')::integer <> 2
     or (v_window->>'holdout_conversions')::integer <> 0
     or (v_window->>'absolute_lift_pp')::numeric <> 50 then
    raise exception '24-hour mature experiment window is incorrect: %', v_window;
  end if;

  v_window := public.norva_behavioral_experiment_window(
    'no_source', v_version, 72, v_anchor - interval '1 minute', v_now
  );
  if (v_window->>'treatment_users')::integer <> 2
     or (v_window->>'treatment_conversions')::integer <> 1
     or (v_window->>'holdout_users')::integer <> 2
     or (v_window->>'holdout_conversions')::integer <> 1
     or (v_window->>'absolute_lift_pp')::numeric <> 0 then
    raise exception '72-hour mature experiment window is incorrect: %', v_window;
  end if;

  v_window := public.norva_behavioral_experiment_window(
    'no_source', v_version, 168, v_anchor - interval '1 minute', v_now
  );
  if (v_window->>'treatment_users')::integer <> 2
     or (v_window->>'treatment_conversions')::integer <> 1
     or (v_window->>'holdout_users')::integer <> 2
     or (v_window->>'holdout_conversions')::integer <> 1 then
    raise exception 'seven-day mature experiment window is incorrect: %', v_window;
  end if;

  v_safety := public.norva_behavioral_experiment_safety(
    'no_source', v_version, v_anchor - interval '1 minute', v_now
  );
  if (v_safety->>'duplicate_dedupe_keys')::integer <> 0
     or (v_safety->>'transport_started')::integer <> 2
     or (v_safety->>'provider_rejected')::integer <> 1
     or (v_safety->>'provider_rejection_rate_pct')::numeric <> 50
     or (v_safety->>'sent_after_conversion')::integer <> 0 then
    raise exception 'experiment safety counters are incorrect: %', v_safety;
  end if;

  v_milestones := public.norva_behavioral_experiment_milestones(
    'no_source', v_version, v_now
  );
  if v_milestones->>'day_7_status' <> 'ready'
     or v_milestones->>'day_14_status' <> 'pending' then
    raise exception 'J+7/J+14 reporting readiness is incorrect: %', v_milestones;
  end if;

  v_decision := public.norva_behavioral_experiment_decision(
    'no_source', v_version, v_now
  );
  if v_decision->>'status' <> 'observation_ready'
     or (v_decision->>'statistical_significance_assessed')::boolean
     or v_decision->'plan'->>'variable' <> 'baseline' then
    raise exception 'J+7 directional decision is incorrect: %', v_decision;
  end if;
  v_decision := public.norva_behavioral_experiment_decision(
    'no_source', v_version, v_anchor + interval '15 days'
  );
  if v_decision->>'status' <> 'target_not_met'
     or v_decision->'provider_comparison'->>'status' <> 'establishing_baseline' then
    raise exception 'J+14 baseline decision is incorrect: %', v_decision;
  end if;

  perform public.norva_insert_behavioral_funnel_event(
    'experiment-t2-trial-started',
    '71000000-0000-0000-0000-000000000002', 'trial_started', null, null,
    v_anchor + interval '3 days'
  );
  select journey_key, delivery_id, experiment_arm into strict v_trial
  from public.behavioral_lifecycle_funnel_events
  where event_key = 'experiment-t2-trial-started';
  if v_trial.journey_key <> 'no_source'
     or v_trial.delivery_id <> '71000000-0000-0000-0000-000000000102'::uuid
     or v_trial.experiment_arm <> 'treatment' then
    raise exception 'trial conversion lost its bounded lifecycle attribution: %', row_to_json(v_trial);
  end if;
end
$assert$;

-- An unsubscribe belongs to the latest lifecycle marketing email whose
-- transport started. A newer pending draft is canceled but cannot claim the
-- event or expose an incorrect journey-level guardrail.
insert into auth.users (id, email, created_at)
values (
  '71000000-0000-0000-0000-000000000005',
  'unsubscribe-attribution@example.test', clock_timestamp() - interval '3 days'
);
insert into public.cloud_marketing_email_preferences (
  user_id, marketing_email_opt_in, opted_in_at, opted_in_source
) values (
  '71000000-0000-0000-0000-000000000005', true,
  clock_timestamp() - interval '2 days', 'integration_fixture'
);

do $assert$
declare
  v_now timestamptz := clock_timestamp();
  v_version integer;
  v_event record;
begin
  select version into strict v_version
  from public.behavioral_lifecycle_journeys where journey_key = 'no_source';
  insert into public.behavioral_lifecycle_outbox (
    id, dedupe_key, user_id, journey_key, step_key, config_version, channel,
    status, experiment_arm, title, body, cta_label, deep_link, ttl_seconds,
    collapse_key, is_marketing, triggered_at, scheduled_for, expires_at,
    next_attempt_at, transport_started_at, provider_accepted_at
  ) values
    ('71000000-0000-0000-0000-000000000105', 'unsubscribe-sent-email-proof',
     '71000000-0000-0000-0000-000000000005', 'no_source', 'day_three_email',
     v_version, 'email', 'provider_accepted', 'treatment', 'Email proof',
     'Attribution after transport.', 'Open Norva', '/app.html#settings/sources',
     86400, 'lifecycle-no-source', true, v_now - interval '2 hours',
     v_now - interval '2 hours', v_now + interval '13 days', v_now,
     v_now - interval '1 hour', v_now - interval '1 hour'),
    ('71000000-0000-0000-0000-000000000106', 'unsubscribe-pending-email-proof',
     '71000000-0000-0000-0000-000000000005', 'no_source', 'day_three_email',
     v_version, 'email', 'pending', 'treatment', 'Pending proof',
     'Pending messages cannot claim an unsubscribe.', 'Open Norva',
     '/app.html#settings/sources', 86400, 'lifecycle-no-source', true,
     v_now - interval '30 minutes', v_now + interval '1 day',
     v_now + interval '14 days', v_now + interval '1 day', null, null);

  update public.cloud_marketing_email_preferences
  set marketing_email_opt_in = false, unsubscribed_at = v_now,
      unsubscribed_source = 'integration_fixture', updated_at = v_now
  where user_id = '71000000-0000-0000-0000-000000000005';

  select journey_key, delivery_id, experiment_arm into strict v_event
  from public.behavioral_lifecycle_funnel_events
  where user_id = '71000000-0000-0000-0000-000000000005'
    and event_name = 'email_unsubscribed';
  if v_event.journey_key <> 'no_source'
     or v_event.delivery_id <> '71000000-0000-0000-0000-000000000105'::uuid
     or v_event.experiment_arm <> 'treatment'
     or (select status from public.behavioral_lifecycle_outbox
         where id = '71000000-0000-0000-0000-000000000106') <> 'canceled' then
    raise exception 'unsubscribe attribution or pending cancellation is incorrect: %', row_to_json(v_event);
  end if;
end
$assert$;

-- Experiment activation is fail-closed: the first version is a baseline, then
-- PostgreSQL compares immutable step snapshots and accepts at most one declared
-- message variable. Operational/structural resets must be labeled baseline.
do $assert$
declare
  v_version integer;
begin
  -- An earlier consent fixture temporarily marks the guide email as marketing;
  -- restore the seeded structure before proving an isolated delay delta.
  update public.behavioral_lifecycle_steps
  set is_marketing = false
  where journey_key = 'import_unresolved' and step_key = 'day_one_email';
  perform public.admin_update_behavioral_lifecycle_journey(
    p_journey_key => 'import_unresolved',
    p_status => 'paused',
    p_rollout_percent => 100,
    p_holdout_percent => 10,
    p_country_allowlist => array['IN','BD'],
    p_reason => 'Pause before isolated experiment-variable proof.'
  );
  perform public.admin_update_behavioral_lifecycle_step(
    'import_unresolved', 'two_hour_push', 'push', 121,
    'Your source still needs attention',
    'Return to Norva to review the M3U or Xtream details and retry safely.',
    'Review source', '/app.html#settings/sources', 86400,
    true, false, false, 'Change only the delay for experiment proof.'
  );

  begin
    perform public.admin_update_behavioral_lifecycle_journey(
      p_journey_key => 'import_unresolved',
      p_status => 'active',
      p_rollout_percent => 100,
      p_holdout_percent => 10,
      p_country_allowlist => array['IN','BD'],
      p_confirmation => 'ACTIVATE import_unresolved',
      p_reason => 'Reject a variable declaration that does not match the snapshot.',
      p_experiment_variable => 'copy',
      p_experiment_hypothesis => 'Changing only the copy should improve successful imports within 72 hours.',
      p_experiment_window_hours => 72,
      p_target_relative_lift_pct => 10
    );
    raise exception 'journey accepted a mismatched experiment variable';
  exception
    when sqlstate '22023' then null;
  end;

  perform public.admin_update_behavioral_lifecycle_journey(
    p_journey_key => 'import_unresolved',
    p_status => 'active',
    p_rollout_percent => 100,
    p_holdout_percent => 10,
    p_country_allowlist => array['IN','BD'],
    p_confirmation => 'ACTIVATE import_unresolved',
    p_reason => 'Activate the isolated delay experiment proof.',
    p_experiment_variable => 'delay',
    p_experiment_hypothesis => 'A one-minute delay adjustment improves successful imports within 72 hours.',
    p_experiment_window_hours => 72,
    p_target_relative_lift_pct => 10
  );
  select version into strict v_version
  from public.behavioral_lifecycle_journeys
  where journey_key = 'import_unresolved';
  if not exists (
    select 1
    from public.behavioral_lifecycle_experiment_versions
    where journey_key = 'import_unresolved'
      and config_version = v_version
      and experiment_variable = 'delay'
      and target_relative_lift_pct = 10
  ) then
    raise exception 'isolated delay experiment was not snapshotted';
  end if;

  perform public.admin_update_behavioral_lifecycle_journey(
    p_journey_key => 'import_unresolved',
    p_status => 'paused',
    p_rollout_percent => 100,
    p_holdout_percent => 10,
    p_country_allowlist => array['IN','BD'],
    p_reason => 'Pause before multi-variable rejection proof.'
  );
  perform public.admin_update_behavioral_lifecycle_step(
    'import_unresolved', 'two_hour_push', 'push', 122,
    'Your import still needs attention',
    'Return to Norva to review the M3U or Xtream details and retry safely.',
    'Review source', '/app.html#settings/sources', 86400,
    true, false, false, 'Change delay and copy for rejection proof.'
  );
  begin
    perform public.admin_update_behavioral_lifecycle_journey(
      p_journey_key => 'import_unresolved',
      p_status => 'active',
      p_rollout_percent => 100,
      p_holdout_percent => 10,
      p_country_allowlist => array['IN','BD'],
      p_confirmation => 'ACTIVATE import_unresolved',
      p_reason => 'Reject simultaneous delay and copy changes.',
      p_experiment_variable => 'delay',
      p_experiment_hypothesis => 'A second delay adjustment improves successful imports within 72 hours.',
      p_experiment_window_hours => 72,
      p_target_relative_lift_pct => 10
    );
    raise exception 'journey accepted more than one experiment variable';
  exception
    when sqlstate '22023' then null;
  end;
  if (select version from public.behavioral_lifecycle_journeys
      where journey_key = 'import_unresolved') <> v_version then
    raise exception 'rejected multi-variable experiment changed the active version';
  end if;
end
$assert$;

-- Quiet-hours arithmetic is checked at deterministic instants, including an
-- offset timezone. This avoids a test that depends on the wall clock.
do $assert$
begin
  if public.norva_behavioral_next_allowed_at(
       '2026-09-03 22:30:00+00'::timestamptz, 'UTC', 21::smallint, 9::smallint
     ) <> '2026-09-04 09:00:00+00'::timestamptz then
    raise exception 'UTC quiet-hours release is incorrect';
  end if;
  if public.norva_behavioral_next_allowed_at(
       '2026-09-03 18:00:00+00'::timestamptz, 'Asia/Kolkata', 21::smallint, 9::smallint
     ) <> '2026-09-04 03:30:00+00'::timestamptz then
    raise exception 'Asia/Kolkata quiet-hours release is incorrect';
  end if;
end
$assert$;

-- A global stop revokes every unsent delivery and records an immutable audit
-- entry. Already opened rows remain historical evidence.
select public.admin_update_behavioral_lifecycle_runtime(
  true, 'internal_test', 'EMERGENCY STOP',
  'Local PostgreSQL emergency-stop integration proof.'
);

do $assert$
begin
  if not (select emergency_stop from public.behavioral_lifecycle_runtime where singleton)
     or exists (
       select 1 from public.behavioral_lifecycle_outbox
       where status in ('pending','processing','email_queued')
         and transport_started_at is null
     )
     or not exists (
       select 1 from public.behavioral_lifecycle_admin_audit
       where action = 'runtime_stopped'
     ) then
    raise exception 'global emergency stop is not fail-closed and audited';
  end if;
end
$assert$;

select 'BEHAVIORAL_LIFECYCLE_INTEGRATION_OK' as result;

rollback;
