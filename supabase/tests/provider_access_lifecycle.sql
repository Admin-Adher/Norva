begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.no_plan();

select extensions.is(
  (
    select count(*)::integer
    from public.admin_feature_flags flag
    where flag.key in (
      'provider_access_v1_enabled',
      'provider_access_auto_detection_v1_enabled',
      'provider_access_notifications_v1_enabled',
      'provider_access_visibility_v1_enabled',
      'provider_credential_transition_v1_enabled',
      'provider_replacement_v1_enabled'
    ) and not flag.enabled
  ),
  6,
  'all six provider lifecycle flags ship OFF'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.cloud_sources', 'SELECT')
  and not has_table_privilege('authenticated', 'public.cloud_media_items', 'SELECT')
  and not has_table_privilege('authenticated', 'public.cloud_titles', 'SELECT')
  and not has_table_privilege('authenticated', 'public.cloud_favorites', 'SELECT')
  and not has_table_privilege('authenticated', 'public.cloud_watch_history', 'SELECT'),
  'authenticated cannot bypass lifecycle through base catalog/history tables'
);

select extensions.ok(
  has_table_privilege('service_role', 'public.cloud_catalog_visible_sources', 'SELECT')
  and has_table_privilege('service_role', 'public.cloud_catalog_visible_titles', 'SELECT')
  and has_table_privilege('service_role', 'public.cloud_catalog_visible_favorites', 'SELECT')
  and has_table_privilege('service_role', 'public.cloud_catalog_visible_watch_history', 'SELECT')
  and not has_table_privilege('authenticated', 'public.cloud_catalog_visible_sources', 'SELECT')
  and not has_table_privilege('authenticated', 'public.cloud_source_management_sources', 'SELECT'),
  'visible and management views are service-role only'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.norva_source_catalog_visible_internal(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.norva_source_catalog_visible_internal(uuid,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_user_detail(uuid)',
    'EXECUTE'
  ),
  'the raw visibility predicate stays internal while the admin-gated fiche remains callable'
);

select extensions.ok(
  position(
    'cloud_source_management_sources'
    in pg_get_functiondef('public.admin_user_detail(uuid)'::regprocedure)
  ) > 0
  and position(
    'cloud_catalog_visible_media_items'
    in pg_get_functiondef('public.admin_user_detail(uuid)'::regprocedure)
  ) > 0
  and position(
    'cloud_catalog_visible_title_variants'
    in pg_get_functiondef('public.admin_user_detail(uuid)'::regprocedure)
  ) > 0
  and position(
    'cloud_catalog_visible_titles'
    in pg_get_functiondef('public.admin_user_detail(uuid)'::regprocedure)
  ) > 0,
  'admin_user_detail is bound to management and catalog-visible projections'
);

select extensions.ok(
  position(
    'norva_public_source_sync_error_category'
    in pg_get_functiondef('public.admin_user_detail(uuid)'::regprocedure)
  ) > 0
  and pg_get_functiondef(
    'public.admin_user_detail(uuid)'::regprocedure
  ) !~* '''sync_error''[[:space:]]*,[[:space:]]*management[.]sync_error',
  'admin_user_detail categorizes sync errors instead of returning provider text'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.norva_public_source_sync_error_category(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.norva_public_source_sync_error_category(text)',
    'EXECUTE'
  ),
  'the sync-error categorizer remains an internal service helper'
);

select extensions.is(
  public.norva_public_source_sync_error_category(
    '[458] account_busy username=private password=private'
  ),
  'PROVIDER_BUSY',
  'public sync-error category preserves only the stable busy classification'
);

select extensions.is(
  public.norva_public_source_sync_error_category(
    '[403] subscription expired username=private password=private'
  ),
  'PROVIDER_ACCESS_EXPIRED',
  'expiry classification takes precedence over its authentication symptom'
);

select extensions.is(
  public.norva_public_source_sync_error_category(null),
  null::text,
  'missing sync errors remain null'
);

select extensions.ok(
  to_regprocedure(
    'public.search_media_items(uuid,text,text,integer,boolean)'
  ) is not null
  and to_regprocedure(
    'public.search_media_items(uuid,text,text,integer)'
  ) is null
  and position(
    'cloud_catalog_visible_media_items'
    in pg_get_functiondef(
      'public.search_media_items(uuid,text,text,integer,boolean)'::regprocedure
    )
  ) > 0
  and pg_get_functiondef(
    'public.search_media_items(uuid,text,text,integer,boolean)'::regprocedure
  ) !~* 'from[[:space:]]+public[.]cloud_media_items([[:space:]]|$)',
  'the exact norva-catalog fuzzy-search overload uses the central visible-media projection'
);

select extensions.ok(
  to_regprocedure(
    'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'
  ) is not null
  and position(
    'cloud_catalog_visible_media_items'
    in pg_get_functiondef(
      'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'::regprocedure
    )
  ) > 0
  and pg_get_functiondef(
    'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'::regprocedure
  ) !~* 'from[[:space:]]+public[.]cloud_media_items([[:space:]]|$)'
  and pg_get_functiondef(
    'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'::regprocedure
  ) !~* '[.]is_dedup_primary'
  and position(
    'norva_visible_catalog_exceeds'
    in pg_get_functiondef(
      'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'::regprocedure
    )
  ) > 0
  and position(
    'catalog_item_estimate'
    in pg_get_functiondef(
      'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'::regprocedure
    )
  ) = 0,
  'the exact norva-catalog grid overload uses the central visible-media projection'
);

select extensions.ok(
  to_regprocedure(
    'public.norva_visible_catalog_exceeds(uuid,text,integer)'
  ) is not null
  and position(
    'cloud_catalog_visible_media_items'
    in pg_get_functiondef(
      'public.norva_visible_catalog_exceeds(uuid,text,integer)'::regprocedure
    )
  ) > 0
  and pg_get_functiondef(
    'public.norva_visible_catalog_exceeds(uuid,text,integer)'::regprocedure
  ) !~* 'from[[:space:]]+public[.]cloud_media_items([[:space:]]|$)'
  and has_function_privilege(
    'service_role',
    'public.norva_visible_catalog_exceeds(uuid,text,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.norva_visible_catalog_exceeds(uuid,text,integer)',
    'EXECUTE'
  ),
  'large-catalog routing is a bounded service-only visible-row probe'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.search_media_items(uuid,text,text,integer,boolean)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.search_media_items(uuid,text,text,integer,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)',
    'EXECUTE'
  ),
  'catalog media RPCs remain service-role only'
);

select extensions.is(
  (
    select count(*)::integer
    from information_schema.columns column_contract
    where column_contract.table_schema = 'public'
      and column_contract.table_name in (
        'cloud_catalog_visible_sources',
        'cloud_source_management_sources'
      )
      and column_contract.column_name = 'config_ciphertext'
  ),
  0,
  'sanitized source views never expose config_ciphertext'
);

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
) values
(
  '92000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'provider-lifecycle-a@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
),
(
  '92000000-0000-4000-8000-000000000002',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'provider-lifecycle-b@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
),
(
  '92000000-0000-4000-8000-000000000003',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'provider-lifecycle-epoch@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

select extensions.is(
  (
    select count(*)::integer
    from public.cloud_user_catalog_visibility_epochs epoch
    where epoch.user_id = '92000000-0000-4000-8000-000000000003'
  ),
  0,
  'an account with no catalog starts at the implicit immutable epoch baseline'
);

set local role service_role;
select extensions.is(
  public.norva_user_catalog_visibility_epoch(
    '92000000-0000-4000-8000-000000000003'
  ),
  1::bigint,
  'the missing-row epoch reads as immutable baseline 1'
);
reset role;

select extensions.is(
  public.norva_bump_user_catalog_visibility_epoch(
    '92000000-0000-4000-8000-000000000003'
  ),
  2::bigint,
  'the first catalog mutation advances the implicit epoch baseline from 1 to 2'
);

insert into public.cloud_account_profiles (
  id, user_id, name, is_default
) values
  (
    '92000000-0000-4000-8000-000000000011',
    '92000000-0000-4000-8000-000000000001',
    'Lifecycle A',
    true
  ),
  (
    '92000000-0000-4000-8000-000000000012',
    '92000000-0000-4000-8000-000000000002',
    'Lifecycle B',
    true
  );

insert into public.cloud_sources (
  id,
  user_id,
  source_type,
  display_name,
  config_ciphertext,
  config_hint,
  sync_status,
  catalog_version
) values
  (
    '92000000-0000-4000-8000-000000000101',
    '92000000-0000-4000-8000-000000000001',
    'xtream',
    'Source A',
    'encrypted-a',
    '{"serverHost":"a.example.invalid","username":"fixture-a"}'::jsonb,
    'ready',
    1
  ),
  (
    '92000000-0000-4000-8000-000000000102',
    '92000000-0000-4000-8000-000000000001',
    'xtream',
    'Source B staging',
    'encrypted-b',
    '{"serverHost":"b.example.invalid","username":"fixture-b"}'::jsonb,
    'ready',
    1
  ),
  (
    '92000000-0000-4000-8000-000000000201',
    '92000000-0000-4000-8000-000000000002',
    'xtream',
    'Other tenant source',
    'encrypted-other',
    '{"serverHost":"other.example.invalid","username":"fixture-other"}'::jsonb,
    'ready',
    1
  );

-- Seed catalog rows before the catalog-generation rollout.  Once contracted,
-- raw legacy writes are deliberately fenced and the fixture must use a worker
-- RPC instead.
insert into public.cloud_media_items (
  id,user_id,source_id,item_type,external_id,title,dedup_key,
  is_dedup_primary,poster_url,metadata,rating_num
) values
  ('92000000-0000-4000-8000-000000000401',
   '92000000-0000-4000-8000-000000000001',
   '92000000-0000-4000-8000-000000000101','movie','movie-a','Visible movie A',
    'tmdb:920301',true,'https://images.invalid/a.jpg',
    '{"providerTmdbId":"920301"}'::jsonb,9);

select extensions.throws_ok(
  $sql$
    update public.cloud_source_lifecycle
    set replacement_root_id = '92000000-0000-4000-8000-000000000201'
    where source_id = '92000000-0000-4000-8000-000000000102'
  $sql$,
  '23503',
  'replacement root must belong to lifecycle owner',
  'lifecycle roots cannot cross tenants'
);

select extensions.throws_ok(
  $sql$
    update public.cloud_source_provider_access
    set provider_access_status = 'revoked'
    where source_id = '92000000-0000-4000-8000-000000000101'
  $sql$,
  '23514',
  'new row for relation "cloud_source_provider_access" violates check constraint "cloud_source_provider_access_provider_access_status_check"',
  'non-canonical Provider Access states are rejected'
);

insert into public.cloud_source_access_cycles (
  id, user_id, source_id, started_on, term_value, term_unit, origin, status
) values (
  '92000000-0000-4000-8000-000000000701',
  '92000000-0000-4000-8000-000000000002',
  '92000000-0000-4000-8000-000000000201',
  current_date,
  1,
  'month',
  'user_entered',
  'active'
);

select extensions.throws_ok(
  $sql$
    insert into public.cloud_source_access_cycles (
      user_id, source_id, term_value, term_unit, origin, status
    ) values (
      '92000000-0000-4000-8000-000000000002',
      '92000000-0000-4000-8000-000000000201',
      null,
      'month',
      'provider_reported',
      'ended'
    )
  $sql$,
  '23514',
  'new row for relation "cloud_source_access_cycles" violates check constraint "cloud_source_access_cycles_term_ck"',
  'cycle term_value and term_unit reject the NULL three-valued-logic bypass'
);

select extensions.throws_ok(
  $sql$
    insert into public.cloud_source_access_cycles (
      user_id, source_id, started_on, origin, status
    ) values (
      '92000000-0000-4000-8000-000000000002',
      '92000000-0000-4000-8000-000000000201',
      current_date,
      'provider_reported',
      'active'
    )
  $sql$,
  '23505',
  'duplicate key value violates unique constraint "cloud_source_access_cycles_one_active_uidx"',
  'only one active access cycle exists per source'
);

select extensions.throws_ok(
  $sql$
    insert into public.cloud_source_transitions (
      id, user_id, transition_kind, old_source_id,
      candidate_secret_ref, idempotency_key
    ) values (
      '92000000-0000-4000-8000-000000000609',
      '92000000-0000-4000-8000-000000000002',
      'credential',
      '92000000-0000-4000-8000-000000000201',
      'vault:disabled-candidate',
      'credential-disabled'
    )
  $sql$,
  '55000',
  'provider credential transition feature is disabled',
  'feature flag OFF fails closed before creating a CREDENTIAL transition'
);

-- A flag-on fixture must traverse the same bounded, durable rollout gates as
-- production.  Do not mutate rollout rows directly: that would hide a missing
-- migration stage and make the replacement tests certify an impossible state.
set local role service_role;
select public.norva_backfill_provider_access_foundation(100);
select public.norva_backfill_provider_access_foundation(100);
update public.cloud_source_lifecycle lifecycle
set lifecycle_state = 'staging',
    catalog_visibility = 'hidden',
    replacement_root_id = '92000000-0000-4000-8000-000000000101',
    replaces_source_id = '92000000-0000-4000-8000-000000000101'
where lifecycle.source_id = '92000000-0000-4000-8000-000000000102';
insert into public.cloud_media_items (
  id,user_id,source_id,item_type,external_id,title,dedup_key,
  is_dedup_primary,poster_url,metadata,rating_num
) values
  ('92000000-0000-4000-8000-000000000402',
   '92000000-0000-4000-8000-000000000001',
   '92000000-0000-4000-8000-000000000102','movie','movie-b','Staging movie B',
   'tmdb:920301',false,'https://images.invalid/b.jpg',
   '{"providerTmdbId":"920301"}'::jsonb,8),
  ('92000000-0000-4000-8000-000000000403',
   '92000000-0000-4000-8000-000000000001',
   '92000000-0000-4000-8000-000000000102','movie','movie-b-low-quality',
   'Staging movie B low quality','tmdb:920301',false,null,'{}'::jsonb,1)
;
select public.norva_backfill_source_provider_account_affinities(100);
select public.norva_backfill_source_provider_account_affinities(100);
select public.norva_discover_catalog_generation_backfill_sources(100);
do $fixture_catalog_generation_backfill$
declare
  v_result jsonb;
begin
  for v_iteration in 1..64 loop
    v_result := public.norva_backfill_catalog_generation_batch(
      'provider-access-lifecycle-fixture',500,120
    );
    exit when not coalesce((v_result ->> 'claimed')::boolean,false);
  end loop;
  if exists (
       select 1
       from public.cloud_catalog_generation_backfill_sources
       where state <> 'complete'
     ) then
    raise exception 'fixture catalog-generation backfill did not converge';
  end if;
end
$fixture_catalog_generation_backfill$;
select public.norva_discover_catalog_generation_backfill_sources(100);
set local statement_timeout = '30s';
do $fixture_catalog_generation_validate$
declare
  v_result jsonb;
begin
  for v_iteration in 1..32 loop
    v_result := public.norva_validate_catalog_generation_constraints(2);
    exit when (v_result ->> 'remaining')::integer = 0;
  end loop;
  if (v_result ->> 'remaining')::integer <> 0 then
    raise exception 'fixture catalog-generation constraints were not validated';
  end if;
end
$fixture_catalog_generation_validate$;
select public.norva_contract_catalog_generation_rollout(
  'catalog-generation-writer-v2-live-clear-batch'
);
-- This online constraint deliberately ships NOT VALID.  The flag gate must
-- not be bypassed; the synthetic rollout validates it before activation.
reset role;
alter table public.provider_account_activity
  validate constraint provider_account_activity_opaque_key_ck;
set local role service_role;
select public.norva_register_active_catalog_refresh_worker(
  'provider-access-lifecycle-fixture',
  'credential-transition-worker-v3-active-catalog-refresh',
  'active-catalog-refresh-checkpoint-prune-v1'
);
reset role;

update public.admin_feature_flags
set enabled = true
where key = 'provider_credential_transition_v1_enabled';

select extensions.throws_ok(
  $sql$
    insert into public.cloud_source_transitions (
      id, user_id, transition_kind, old_source_id, idempotency_key
    ) values (
      '92000000-0000-4000-8000-000000000603',
      '92000000-0000-4000-8000-000000000002',
      'credential',
      '92000000-0000-4000-8000-000000000201',
      'credential-missing-secret'
    )
  $sql$,
  '23514',
  'credential candidate secret reference is required',
  'a CREDENTIAL transition cannot exist without an isolated candidate secret'
);

select extensions.throws_ok(
  $sql$
    insert into public.cloud_source_transitions (
      id, user_id, transition_kind, old_source_id,
      candidate_secret_ref, idempotency_key
    ) values (
      '92000000-0000-4000-8000-000000000604',
      '92000000-0000-4000-8000-000000000001',
      'credential',
      '92000000-0000-4000-8000-000000000102',
      'vault:candidate-staging-source',
      'credential-on-staging-source'
    )
  $sql$,
  '23514',
  'credential source A must remain ACTIVE/VISIBLE',
  'a staging replacement candidate cannot concurrently own a CREDENTIAL transition'
);

insert into public.cloud_source_transitions (
  id,
  user_id,
  transition_kind,
  old_source_id,
  state,
  idempotency_key,
  candidate_secret_ref
) values (
  '92000000-0000-4000-8000-000000000602',
  '92000000-0000-4000-8000-000000000002',
  'credential',
  '92000000-0000-4000-8000-000000000201',
  'validating',
  'credential-null-safe',
  'vault:credential-candidate'
);

select extensions.throws_ok(
  $sql$
    update public.cloud_source_transitions
    set state = 'ready_to_switch',
        readiness_check_id = '92000000-0000-4000-8000-000000000801',
        readiness_passed_at = now()
    where id = '92000000-0000-4000-8000-000000000602'
  $sql$,
  '23514',
  'invalid CREDENTIAL transition: validating -> ready_to_switch',
  'CREDENTIAL cannot skip the canonical STAGING and IMPORTING states'
);

update public.cloud_source_transitions
set state = 'staging'
where id = '92000000-0000-4000-8000-000000000602';

update public.cloud_source_transitions
set state = 'importing'
where id = '92000000-0000-4000-8000-000000000602';

select extensions.throws_ok(
  $sql$
    update public.cloud_source_transitions
    set state = 'ready_to_switch',
        previous_secret_ref = 'vault:credential-rollback',
        readiness_check_id = '92000000-0000-4000-8000-000000000801',
        readiness_passed_at = now()
    where id = '92000000-0000-4000-8000-000000000602'
  $sql$,
  '23514',
  'CREDENTIAL transition requires SAME_CATALOG',
  'a NULL identity decision cannot bypass the transition guard'
);

insert into public.cloud_source_identity_assessments (
  id,
  user_id,
  transition_id,
  algorithm_version,
  sample_size_old,
  sample_size_new,
  overlap_count,
  similarity_score,
  automatic_decision,
  final_decision,
  decision_origin,
  decided_at
) values (
  '92000000-0000-4000-8000-000000000811',
  '92000000-0000-4000-8000-000000000002',
  '92000000-0000-4000-8000-000000000602',
  'identity-v1',
  32,
  32,
  32,
  1,
  'same_catalog',
  'same_catalog',
  'automatic',
  now()
);

select extensions.throws_ok(
  $sql$
    update public.cloud_source_identity_assessments
    set similarity_score = 0.5
    where id = '92000000-0000-4000-8000-000000000811'
  $sql$,
  '23514',
  'final identity assessment is immutable',
  'final identity evidence cannot be rewritten after decision'
);

update public.cloud_source_transitions
set identity_decision = 'same_catalog',
    decision_origin = 'automatic',
    previous_secret_ref = 'vault:credential-rollback'
where id = '92000000-0000-4000-8000-000000000602';

select extensions.throws_ok(
  $sql$
    update public.cloud_source_transitions
    set state = 'ready_to_switch',
        readiness_check_id = '92000000-0000-4000-8000-000000000801',
        readiness_passed_at = now()
    where id = '92000000-0000-4000-8000-000000000602'
  $sql$,
  '55000',
  'catalog background owner candidate is not ready',
  'a raw CREDENTIAL promotion cannot bypass the certified owner workflow'
);

update public.cloud_source_transitions
set state = 'failed'
where id = '92000000-0000-4000-8000-000000000602';

select extensions.throws_ok(
  $sql$
    update public.cloud_source_transitions
    set updated_at = updated_at
    where id = '92000000-0000-4000-8000-000000000602'
  $sql$,
  '23514',
  'terminal transition is immutable',
  'terminal transitions reject even a no-op update'
);

select extensions.throws_ok(
  $sql$
    insert into public.cloud_source_lifecycle_events (
      user_id, source_id, transition_id, event_kind, idempotency_key
    ) values (
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000101',
      '92000000-0000-4000-8000-000000000602',
      'cross-tenant-transition',
      'cross-tenant-transition'
    )
  $sql$,
  '23503',
  'insert or update on table "cloud_source_lifecycle_events" violates foreign key constraint "cloud_source_lifecycle_events_transition_owner_fk"',
  'event transition references are tenant-composite'
);

select extensions.throws_ok(
  $sql$
    insert into public.cloud_source_lifecycle_events (
      user_id, source_id, access_cycle_id, event_kind, idempotency_key
    ) values (
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000101',
      '92000000-0000-4000-8000-000000000701',
      'cross-tenant-cycle',
      'cross-tenant-cycle'
    )
  $sql$,
  '23503',
  'insert or update on table "cloud_source_lifecycle_events" violates foreign key constraint "cloud_source_lifecycle_events_cycle_owner_fk"',
  'event access-cycle references are tenant-composite'
);

update public.admin_feature_flags
set enabled = case
  when key = 'provider_replacement_v1_enabled' then true
  else false
end
where key in (
  'provider_credential_transition_v1_enabled',
  'provider_replacement_v1_enabled'
);

select extensions.throws_ok(
  $sql$
    insert into public.cloud_source_transitions (
      user_id,
      transition_kind,
      old_source_id,
      candidate_source_id,
      state,
      identity_decision,
      decision_origin,
      idempotency_key,
      reversal_of_transition_id
    ) values (
      '92000000-0000-4000-8000-000000000001',
      'replacement',
      '92000000-0000-4000-8000-000000000101',
      '92000000-0000-4000-8000-000000000102',
      'validating',
      'different_catalog',
      'automatic',
      'cross-tenant-reversal',
      '92000000-0000-4000-8000-000000000602'
    )
  $sql$,
  '23503',
  'insert or update on table "cloud_source_transitions" violates foreign key constraint "cloud_source_transitions_reversal_owner_fk"',
  'reversal references are tenant-composite'
);

select extensions.ok(
  (
    select old_item.is_dedup_primary and not candidate_item.is_dedup_primary
    from public.cloud_media_items old_item
    join public.cloud_media_items candidate_item
      on candidate_item.dedup_key = old_item.dedup_key
     and candidate_item.user_id = old_item.user_id
     and candidate_item.item_type = old_item.item_type
    where old_item.id = '92000000-0000-4000-8000-000000000401'
      and candidate_item.id = '92000000-0000-4000-8000-000000000402'
  ),
  'regression fixture keeps the global primary on A while B is its sibling'
);

select extensions.is(
  public.norva_visible_catalog_exceeds(
    '92000000-0000-4000-8000-000000000001',
    'movie',
    1
  ),
  false,
  'staging B does not make a one-row visible catalog exceed its routing threshold'
);

select extensions.is(
  (
    select count(*)::integer
    from public.search_media_items(
      '92000000-0000-4000-8000-000000000001',
      'movie',
      'movie',
      50,
      false
    ) result
    where result.source_id = '92000000-0000-4000-8000-000000000102'
  ),
  0,
  'fuzzy-search RPC never returns staging B media'
);

select extensions.is(
  (
    select count(*)::integer
    from public.search_media_items(
      '92000000-0000-4000-8000-000000000001',
      'movie',
      'movie',
      50,
      false
    ) result
    where result.source_id = '92000000-0000-4000-8000-000000000101'
  ),
  1,
  'fuzzy-search RPC still returns visible A media'
);

select extensions.is(
  (
    select count(*)::integer
    from jsonb_array_elements(
      public.list_media_items_deduped(
        p_user => '92000000-0000-4000-8000-000000000001',
        p_item_type => 'movie',
        p_limit => 60,
        p_offset => 0
      ) -> 'items'
    ) result(item)
    where result.item ->> 'source_id'
      = '92000000-0000-4000-8000-000000000102'
  ),
  0,
  'deduped-grid RPC never returns staging B media'
);

select extensions.is(
  (
    select count(*)::integer
    from jsonb_array_elements(
      public.list_media_items_deduped(
        p_user => '92000000-0000-4000-8000-000000000001',
        p_item_type => 'movie',
        p_limit => 60,
        p_offset => 0
      ) -> 'items'
    ) result(item)
    where result.item ->> 'source_id'
      = '92000000-0000-4000-8000-000000000101'
  ),
  1,
  'deduped-grid RPC still returns visible A media'
);

insert into public.cloud_titles (
  id,
  user_id,
  item_type,
  identity_key,
  identity_source,
  provider_tmdb_id,
  title
) values (
  '92000000-0000-4000-8000-000000000301',
  '92000000-0000-4000-8000-000000000001',
  'movie',
  'tmdb:920301',
  'provider_tmdb',
  '920301',
  'Shared logical title'
);

insert into public.cloud_title_variants (
  id,
  user_id,
  title_id,
  source_id,
  media_item_id,
  item_type,
  external_id,
  raw_title,
  language
) values
  (
    '92000000-0000-4000-8000-000000000311',
    '92000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000301',
    '92000000-0000-4000-8000-000000000101',
    '92000000-0000-4000-8000-000000000401',
    'movie',
    'movie-a',
    'Visible movie A',
    'vostfr'
  ),
  (
    '92000000-0000-4000-8000-000000000312',
    '92000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000301',
    '92000000-0000-4000-8000-000000000102',
    '92000000-0000-4000-8000-000000000402',
    'movie',
    'movie-b',
    'Staging movie B',
    'multi'
  );

insert into public.cloud_title_file_language_observations (
  user_id,
  title_id,
  variant_id,
  file_external_id,
  audio_languages,
  subtitle_languages,
  audio_observed,
  subtitle_observed,
  audio_verified_at
) values
  (
    '92000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000301',
    '92000000-0000-4000-8000-000000000311',
    'movie-a',
    array['fr'],
    array['fr'],
    true,
    true,
    now()
  ),
  (
    '92000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000301',
    '92000000-0000-4000-8000-000000000312',
    'movie-b',
    array['en'],
    array['en'],
    true,
    true,
    now()
  );

insert into public.cloud_live_logical_channels (
  id, user_id, source_id, logical_id, logical_key, title
) values (
  '92000000-0000-4000-8000-000000000501',
  '92000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000102',
  'logical-b',
  'logical-key-b',
  'Staging live B'
);

insert into public.cloud_live_variants (
  id,
  user_id,
  source_id,
  logical_channel_id,
  logical_id,
  stream_id,
  external_id,
  title
) values (
  '92000000-0000-4000-8000-000000000511',
  '92000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000102',
  '92000000-0000-4000-8000-000000000501',
  'logical-b',
  'stream-b',
  'live-b',
  'Staging live B'
);

select extensions.is(
  (select count(*)::integer from public.cloud_catalog_visible_sources
   where id = '92000000-0000-4000-8000-000000000102'),
  0,
  'staging B is absent from visible sources'
);
select extensions.is(
  (select count(*)::integer from public.cloud_source_management_sources
   where id = '92000000-0000-4000-8000-000000000102'),
  0,
  'staging B is absent from management/bootstrap sources'
);
select extensions.is(
  (select count(*)::integer from public.cloud_catalog_visible_media_items
   where source_id = '92000000-0000-4000-8000-000000000102'),
  0,
  'staging B media are invisible'
);
select extensions.is(
  (select count(*)::integer from public.cloud_catalog_visible_title_variants
   where source_id = '92000000-0000-4000-8000-000000000102'),
  0,
  'staging B title variants are invisible'
);
select extensions.is(
  (select count(*)::integer from public.cloud_catalog_visible_live_logical_channels
   where source_id = '92000000-0000-4000-8000-000000000102'),
  0,
  'staging B live logical channels are invisible'
);
select extensions.is(
  (select count(*)::integer from public.cloud_catalog_visible_live_variants
   where source_id = '92000000-0000-4000-8000-000000000102'),
  0,
  'staging B live variants are invisible'
);

select extensions.is(
  (
    select visible_source_ids
    from public.cloud_catalog_visible_titles
    where id = '92000000-0000-4000-8000-000000000301'
  ),
  array['92000000-0000-4000-8000-000000000101'::uuid],
  'title rollup contains only visible source A'
);
select extensions.is(
  (
    select file_audio_languages
    from public.cloud_catalog_visible_titles
    where id = '92000000-0000-4000-8000-000000000301'
  ),
  array['fr'],
  'visible title audio languages exclude staging B observations'
);
select extensions.is(
  (
    select file_subtitle_languages
    from public.cloud_catalog_visible_titles
    where id = '92000000-0000-4000-8000-000000000301'
  ),
  array['fr'],
  'visible title subtitle languages exclude staging B observations'
);

insert into public.admin_enrichment_accounts (user_id, label)
values (
  '92000000-0000-4000-8000-000000000001',
  'provider-lifecycle-driver'
)
on conflict (user_id) do update set label = excluded.label;

update public.cloud_sources
set sync_error = case id
  when '92000000-0000-4000-8000-000000000101'::uuid
    then '[403] invalid credentials username=provider-owner password=provider-secret'
  when '92000000-0000-4000-8000-000000000201'::uuid
    then '[504] gateway timeout https://other.invalid/?password=other-secret'
  else sync_error
end
where id in (
  '92000000-0000-4000-8000-000000000101',
  '92000000-0000-4000-8000-000000000201'
);

insert into public.admin_dashboard_cache (
  id, sources, coverage, refreshed_at
) values (
  1,
  '[
    {
      "source_id":"92000000-0000-4000-8000-000000000101",
      "owner_email":"provider-lifecycle-a@example.invalid",
      "display_name":"Source A",
      "sync_error":"cached password=driver-cache-secret",
      "media_items":1,
      "variants":1,
      "movie_titles":1,
      "series_titles":0,
      "incomplete":false
    },
    {
      "source_id":"92000000-0000-4000-8000-000000000102",
      "owner_email":"provider-lifecycle-a@example.invalid",
      "display_name":"Source B staging",
      "media_items":1,
      "variants":1,
      "movie_titles":1,
      "series_titles":0,
      "incomplete":false
    }
  ]'::jsonb,
  '[
    {
      "owner_email":"provider-lifecycle-a@example.invalid",
      "panel":"Source A",
      "item_type":"movie",
      "total":1,
      "resolved":1
    },
    {
      "owner_email":"provider-lifecycle-a@example.invalid",
      "panel":"Source B staging",
      "item_type":"movie",
      "total":1,
      "resolved":1
    }
  ]'::jsonb,
  now()
)
on conflict (id) do update
set sources = excluded.sources,
    coverage = excluded.coverage,
    refreshed_at = excluded.refreshed_at;

select set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '92000000-0000-4000-8000-000000000001',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select extensions.is(
  (
    select count(*)::integer
    from jsonb_array_elements(
      public.admin_user_detail(
        '92000000-0000-4000-8000-000000000001'
      ) -> 'sources'
    ) source_entry
    where source_entry ->> 'source_id'
      = '92000000-0000-4000-8000-000000000102'
  ),
  0,
  'driver admin detail filters cached staging B by the current management projection'
);

select extensions.is(
  (
    select count(*)::integer
    from jsonb_array_elements(
      public.admin_user_detail(
        '92000000-0000-4000-8000-000000000001'
      ) -> 'enrichment'
    ) coverage_entry
    where coverage_entry ->> 'panel' = 'Source B staging'
  ),
  0,
  'driver admin detail never returns cached enrichment for a hidden staging panel'
);

select extensions.is(
  (
    select source_entry ->> 'sync_error'
    from jsonb_array_elements(
      public.admin_user_detail(
        '92000000-0000-4000-8000-000000000001'
      ) -> 'sources'
    ) source_entry
    where source_entry ->> 'source_id'
      = '92000000-0000-4000-8000-000000000101'
  ),
  'PROVIDER_CREDENTIALS_REJECTED',
  'driver admin detail returns only a stable sync-error category'
);

select extensions.ok(
  position(
    'provider-secret'
    in public.admin_user_detail(
      '92000000-0000-4000-8000-000000000001'
    )::text
  ) = 0
  and position(
    'driver-cache-secret'
    in public.admin_user_detail(
      '92000000-0000-4000-8000-000000000001'
    )::text
  ) = 0,
  'driver admin detail cannot relay raw management or cached provider errors'
);

select extensions.is(
  jsonb_array_length(
    public.admin_user_detail(
      '92000000-0000-4000-8000-000000000002'
    ) -> 'sources'
  ),
  1,
  'the admin SECURITY DEFINER fiche applies visibility to another tenant without impersonation'
);

select extensions.is(
  (
    select source_entry ->> 'sync_error'
    from jsonb_array_elements(
      public.admin_user_detail(
        '92000000-0000-4000-8000-000000000002'
      ) -> 'sources'
    ) source_entry
    where source_entry ->> 'source_id'
      = '92000000-0000-4000-8000-000000000201'
  ),
  'PROVIDER_TEMPORARILY_UNAVAILABLE',
  'non-driver admin detail returns only a stable sync-error category'
);

select extensions.ok(
  position(
    'other-secret'
    in public.admin_user_detail(
      '92000000-0000-4000-8000-000000000002'
    )::text
  ) = 0,
  'non-driver admin detail cannot relay a raw provider error'
);

reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '92000000-0000-4000-8000-000000000001',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select extensions.is(
  public.norva_source_catalog_visible(
    '92000000-0000-4000-8000-000000000101',
    '92000000-0000-4000-8000-000000000001'
  ),
  true,
  'authenticated owner may check its visible source'
);
select extensions.is(
  public.norva_source_catalog_visible(
    '92000000-0000-4000-8000-000000000201',
    '92000000-0000-4000-8000-000000000002'
  ),
  false,
  'authenticated helper calls fail closed across tenants'
);

reset role;

update public.cloud_source_provider_access
set provider_access_status = 'expired_confirmed',
    provider_access_hidden_at = now()
where source_id = '92000000-0000-4000-8000-000000000101';

select extensions.is(
  public.norva_source_catalog_visible(
    '92000000-0000-4000-8000-000000000101',
    '92000000-0000-4000-8000-000000000001'
  ),
  true,
  'Provider Access data does not hide a source while both visibility flags are OFF'
);

update public.admin_feature_flags
set enabled = true
where key in ('provider_access_v1_enabled', 'provider_access_visibility_v1_enabled');

select extensions.is(
  public.norva_source_catalog_visible(
    '92000000-0000-4000-8000-000000000101',
    '92000000-0000-4000-8000-000000000001'
  ),
  false,
  'controlled flag enablement hides a confirmed-expired source'
);
select extensions.is(
  (
    select catalog_visible
    from public.cloud_source_management_sources
    where id = '92000000-0000-4000-8000-000000000101'
  ),
  false,
  'management retains active provider-hidden A and marks it not catalog-visible'
);

update public.cloud_source_provider_access
set provider_access_status = 'active',
    provider_access_hidden_at = null,
    provider_access_restored_at = now()
where source_id = '92000000-0000-4000-8000-000000000101';

insert into public.cloud_source_transitions (
  id,
  user_id,
  transition_kind,
  old_source_id,
  candidate_source_id,
  state,
  identity_decision,
  decision_origin,
  idempotency_key
) values (
  '92000000-0000-4000-8000-000000000601',
  '92000000-0000-4000-8000-000000000001',
  'replacement',
  '92000000-0000-4000-8000-000000000101',
  '92000000-0000-4000-8000-000000000102',
  'validating',
  'different_catalog',
  'automatic',
  'replace-a-with-b'
);

insert into public.cloud_source_identity_assessments (
  id,
  user_id,
  transition_id,
  algorithm_version,
  sample_size_old,
  sample_size_new,
  overlap_count,
  similarity_score,
  automatic_decision,
  final_decision,
  decision_origin,
  decided_at
) values (
  '92000000-0000-4000-8000-000000000812',
  '92000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000601',
  'identity-v1',
  32,
  32,
  32,
  1,
  'same_catalog',
  'same_catalog',
  'automatic',
  now()
);

update public.cloud_source_transitions
set state = 'staging'
where id = '92000000-0000-4000-8000-000000000601';
update public.cloud_source_transitions
set state = 'importing'
where id = '92000000-0000-4000-8000-000000000601';

select extensions.throws_ok(
  $sql$
    update public.cloud_source_transitions
    set state = 'ready_to_switch',
        readiness_check_id = '92000000-0000-4000-8000-000000000802',
        readiness_passed_at = now()
    where id = '92000000-0000-4000-8000-000000000601'
  $sql$,
  '23514',
  'final identity assessment does not match transition decision',
  'READY_TO_SWITCH requires a finalized assessment matching the transition decision'
);

insert into public.cloud_source_identity_assessments (
  id,
  user_id,
  transition_id,
  algorithm_version,
  sample_size_old,
  sample_size_new,
  overlap_count,
  similarity_score,
  automatic_decision,
  final_decision,
  decision_origin,
  decided_at
) values (
  '92000000-0000-4000-8000-000000000814',
  '92000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000601',
  'identity-v2',
  32,
  32,
  0,
  0,
  'different_catalog',
  'different_catalog',
  'automatic',
  now()
);

select extensions.throws_ok(
  $sql$
    update public.cloud_source_transitions
    set state = 'ready_to_switch',
        readiness_check_id = '92000000-0000-4000-8000-000000000802',
        readiness_passed_at = now()
    where id = '92000000-0000-4000-8000-000000000601'
  $sql$,
  '23514',
  'replacement catalog version proof is required before READY_TO_SWITCH',
  'replacement readiness cannot omit its expected catalog version'
);

update public.cloud_source_transitions
set expected_catalog_version = 1
where id = '92000000-0000-4000-8000-000000000601';

update public.cloud_source_transitions
set state = 'ready_to_switch',
    readiness_check_id = '92000000-0000-4000-8000-000000000802',
    readiness_passed_at = now()
where id = '92000000-0000-4000-8000-000000000601';

select extensions.is(
  (select revision from public.cloud_source_transitions
   where id = '92000000-0000-4000-8000-000000000601'),
  4::bigint,
  'replacement state machine increments its optimistic revision'
);

update public.cloud_source_provider_access
set provider_access_status = 'restoring',
    provider_access_hidden_at = now(),
    provider_access_restored_at = null
where source_id = '92000000-0000-4000-8000-000000000102';

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select extensions.lives_ok(
  $sql$
    select * from public.upsert_cloud_watch_history_causal(
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000011',
      null,
      'movie',
      'movie-b',
      null,
      'Legacy orphan B',
      18,
      120,
      false,
      '{}'::jsonb,
      now()
    )
  $sql$,
  'legacy null-source history fixture is accepted'
);

select extensions.is(
  (
    select count(*)::integer
    from public.get_cloud_watch_history_item_visible(
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000011',
      '92000000-0000-4000-8000-000000000102',
      'movie',
      'movie-b'
    )
  ),
  0,
  'a hidden requested source cannot borrow a null-source history fallback'
);

select extensions.is(
  (
    select count(*)::integer
    from public.get_cloud_watch_history_item_visible(
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000011',
      null,
      'movie',
      'movie-b'
    )
  ),
  1,
  'the bounded source-less legacy lookup remains available without a requested source'
);

select extensions.throws_ok(
  $sql$
    select * from public.upsert_cloud_favorite_visible(
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000011',
      '92000000-0000-4000-8000-000000000102',
      'movie',
      'movie-b',
      'Hidden B',
      '{}'::jsonb
    )
  $sql$,
  '55000',
  'source catalog is not visible',
  'favorite writes revalidate staging visibility atomically'
);

select extensions.throws_ok(
  $sql$
    select * from public.upsert_cloud_watch_history_causal(
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000011',
      '92000000-0000-4000-8000-000000000102',
      'movie',
      'movie-b',
      null,
      'Hidden B',
      30,
      120,
      false,
      '{}'::jsonb,
      now()
    )
  $sql$,
  '55000',
  'source catalog is not visible',
  'history writes revalidate staging visibility atomically'
);

select extensions.throws_ok(
  $sql$
    select * from public.claim_cloud_playback_session(
      '92000000-0000-4000-8000-000000000901',
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000102',
      null,
      'movie',
      'movie-b',
      'direct',
      'ready',
      repeat('1', 64),
      repeat('b', 64),
      null,
      '{}'::jsonb,
      now() + interval '10 minutes'
    )
  $sql$,
  '55000',
  'source catalog is not visible',
  'playback session claim rejects staging B under its transaction locks'
);

reset role;
update public.admin_feature_flags
set enabled = false
where key = 'provider_replacement_v1_enabled';
set local role service_role;

select extensions.throws_ok(
  $sql$
    update public.cloud_source_transitions
    set state = 'committing'
    where id = '92000000-0000-4000-8000-000000000601'
  $sql$,
  '55000',
  'provider replacement transition feature is disabled',
  'flag OFF also blocks direct nonterminal replacement progression in the DB machine'
);

select extensions.throws_ok(
  $sql$
    select public.norva_promote_source_replacement(
      '92000000-0000-4000-8000-000000000601',
      '92000000-0000-4000-8000-000000000001',
      'promotion-a-b',
      0,
      4
    )
  $sql$,
  '55000',
  'provider replacement feature is disabled',
  'promotion is fail closed while its feature flag is OFF'
);

reset role;
update public.admin_feature_flags
set enabled = true
where key = 'provider_replacement_v1_enabled';
set local role service_role;

select extensions.throws_ok(
  $sql$
    select public.norva_promote_source_replacement(
      '92000000-0000-4000-8000-000000000601',
      '92000000-0000-4000-8000-000000000001',
      'promotion-stale-transition',
      0,
      3
    )
  $sql$,
  '40001',
  'stale transition revision',
  'promotion rejects a stale transition CAS without partial writes'
);

select extensions.throws_ok(
  $sql$
    select public.norva_promote_source_replacement(
      '92000000-0000-4000-8000-000000000601',
      '92000000-0000-4000-8000-000000000001',
      'promotion-stale-source',
      1,
      4
    )
  $sql$,
  '40001',
  'promotion source revision does not match transition snapshot',
  'promotion rejects a caller revision that differs from the transition snapshot'
);

select extensions.throws_ok(
  $sql$
    do $block$
    begin
      update public.cloud_sources
      set config_ciphertext = 'encrypted-b-mutated-after-readiness'
      where id = '92000000-0000-4000-8000-000000000102';
      perform public.norva_promote_source_replacement(
        '92000000-0000-4000-8000-000000000601',
        '92000000-0000-4000-8000-000000000001',
        'promotion-stale-candidate',
        0,
        4
      );
    end
    $block$
  $sql$,
  '23514',
  'source B is not the expected hidden staging candidate',
  'promotion rejects a candidate config revision changed after readiness'
);

select extensions.throws_ok(
  $sql$
    select public.norva_promote_source_replacement(
      '92000000-0000-4000-8000-000000000601',
      '92000000-0000-4000-8000-000000000001',
      'promotion-a-b',
      0,
      4
    )
  $sql$,
  '55000',
  'source B Provider Access is not restorable at promotion',
  'promotion rejects hidden RESTORING B without restoration proof'
);

reset role;
update public.cloud_source_provider_access
set provider_access_status = 'unknown',
    provider_access_hidden_at = null,
    provider_access_restored_at = null
where source_id = '92000000-0000-4000-8000-000000000102';
set local role service_role;

select extensions.lives_ok(
  $sql$
    select * from public.upsert_cloud_favorite_visible(
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000011',
      '92000000-0000-4000-8000-000000000101',
      'movie',
      'movie-a',
      'Visible A',
      '{}'::jsonb
    )
  $sql$,
  'favorite write succeeds for visible A'
);

select extensions.lives_ok(
  $sql$
    select * from public.upsert_cloud_watch_history_causal(
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000011',
      '92000000-0000-4000-8000-000000000101',
      'movie',
      'movie-a',
      null,
      'Visible A',
      30,
      120,
      false,
      '{}'::jsonb,
      now()
    )
  $sql$,
  'history write succeeds for visible A'
);

select * from public.upsert_cloud_watch_history_causal(
  '92000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000011',
  null,
  'movie',
  'movie-a',
  null,
  'Source-less renewal fallback',
  15,
  120,
  false,
  '{}'::jsonb,
  now() - interval '1 minute'
);

select extensions.is(
  (
    select progress_seconds
    from public.get_cloud_watch_history_item_visible(
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000011',
      '92000000-0000-4000-8000-000000000101',
      'movie',
      'movie-a'
    )
  ),
  30,
  'visible exact-source history wins over the source-less fallback'
);

select extensions.is(
  (
    public.norva_promote_source_replacement(
      '92000000-0000-4000-8000-000000000601',
      '92000000-0000-4000-8000-000000000001',
      'promotion-a-b',
      0,
      4
    ) ->> 'state'
  ),
  'COMPLETED',
  'A to B promotion completes atomically'
);

select extensions.is(
  (
    select count(*)::integer
    from public.cloud_source_lifecycle lifecycle
    where lifecycle.user_id = '92000000-0000-4000-8000-000000000001'
      and lifecycle.replacement_root_id = '92000000-0000-4000-8000-000000000101'
      and lifecycle.lifecycle_state = 'active'
      and lifecycle.catalog_visibility = 'visible'
  ),
  1,
  'lineage has exactly one active/visible source after promotion'
);
select extensions.is(
  (
    select source_id
    from public.cloud_source_lifecycle lifecycle
    where lifecycle.user_id = '92000000-0000-4000-8000-000000000001'
      and lifecycle.replacement_root_id = '92000000-0000-4000-8000-000000000101'
      and lifecycle.lifecycle_state = 'active'
      and lifecycle.catalog_visibility = 'visible'
  ),
  '92000000-0000-4000-8000-000000000102'::uuid,
  'B is the sole active/visible lineage source'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '92000000-0000-4000-8000-000000000001',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select extensions.is(
  (
    select (source_entry ->> 'media_items')::integer
    from jsonb_array_elements(
      public.admin_user_detail(
        '92000000-0000-4000-8000-000000000001'
      ) -> 'sources'
    ) source_entry
    where source_entry ->> 'source_id'
      = '92000000-0000-4000-8000-000000000101'
  ),
  0,
  'driver admin detail retains replaced A for management but zeroes hidden catalog counts'
);

select extensions.is(
  (
    select count(*)::integer
    from jsonb_array_elements(
      public.admin_user_detail(
        '92000000-0000-4000-8000-000000000001'
      ) -> 'enrichment'
    ) coverage_entry
    where coverage_entry ->> 'panel' = 'Source A'
  ),
  0,
  'driver admin detail removes replaced A enrichment from the cached user-facing fiche'
);

select extensions.is(
  (
    select count(*)::integer
    from jsonb_array_elements(
      public.admin_user_detail(
        '92000000-0000-4000-8000-000000000001'
      ) -> 'enrichment'
    ) coverage_entry
    where coverage_entry ->> 'panel' = 'Source B staging'
  ),
  1,
  'driver admin detail admits cached enrichment only after B is currently visible'
);

reset role;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select extensions.is(
  (
    select transition.rollback_until = lifecycle.rollback_until
    from public.cloud_source_transitions transition
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.source_id = transition.old_source_id
    where transition.id = '92000000-0000-4000-8000-000000000601'
  ),
  true,
  'transition and replaced A persist the same rollback_until'
);
select extensions.is(
  (
    select (promotion_result ->> 'visibilityEpoch')::bigint
    from public.cloud_source_transitions
    where id = '92000000-0000-4000-8000-000000000601'
  ),
  public.norva_user_catalog_visibility_epoch(
    '92000000-0000-4000-8000-000000000001'
  ),
  'promotion result returns the account-wide monotone visibility epoch'
);

select extensions.is(
  public.norva_promote_source_replacement(
    '92000000-0000-4000-8000-000000000601',
    '92000000-0000-4000-8000-000000000001',
    'promotion-a-b',
    0,
    4
  ),
  (
    select promotion_result
    from public.cloud_source_transitions
    where id = '92000000-0000-4000-8000-000000000601'
  ),
  'same idempotency key and original revisions replay the stable JSON result'
);

select extensions.throws_ok(
  $sql$
    select public.norva_promote_source_replacement(
      '92000000-0000-4000-8000-000000000601',
      '92000000-0000-4000-8000-000000000001',
      'different-key',
      0,
      4
    )
  $sql$,
  '22023',
  'completed transition cannot be replayed with different promotion inputs',
  'a completed transition refuses a different promotion key'
);

select extensions.is(
  public.norva_source_catalog_visible(
    '92000000-0000-4000-8000-000000000101',
    '92000000-0000-4000-8000-000000000001'
  ),
  false,
  'source A is hidden after promotion'
);
select extensions.is(
  (
    select count(*)::integer
    from public.get_cloud_watch_history_item_visible(
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000011',
      '92000000-0000-4000-8000-000000000101',
      'movie',
      'movie-a'
    )
  ),
  0,
  'a hidden requested source returns no history row and never falls back to source_id NULL'
);
select extensions.is(
  (
    select progress_seconds
    from public.get_cloud_watch_history_item_visible(
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000011',
      '92000000-0000-4000-8000-000000000102',
      'movie',
      'movie-a'
    )
  ),
  15,
  'a visible requested source may use the bounded source-less renewal fallback'
);
select extensions.is(
  public.norva_source_catalog_visible(
    '92000000-0000-4000-8000-000000000102',
    '92000000-0000-4000-8000-000000000001'
  ),
  true,
  'source B is visible after promotion'
);
select extensions.is(
  (
    select visible_source_ids
    from public.cloud_catalog_visible_titles
    where id = '92000000-0000-4000-8000-000000000301'
  ),
  array['92000000-0000-4000-8000-000000000102'::uuid],
  'visible title rollup switches from A to B without an A plus B state'
);
select extensions.is(
  (
    select count(distinct source_id)::integer
    from public.cloud_catalog_visible_media_items
    where user_id = '92000000-0000-4000-8000-000000000001'
  ),
  1,
  'visible media exposes one physical source after promotion'
);
select extensions.is(
  (
    select min(source_id::text)::uuid
    from public.cloud_catalog_visible_media_items
    where user_id = '92000000-0000-4000-8000-000000000001'
  ),
  '92000000-0000-4000-8000-000000000102'::uuid,
  'visible media exposes B and not A after promotion'
);

select extensions.ok(
  (
    with result as (
      select public.list_media_items_deduped(
        p_user => '92000000-0000-4000-8000-000000000001',
        p_item_type => 'movie',
        p_limit => 60,
        p_offset => 0
      ) as payload
    )
    select
      jsonb_array_length(payload -> 'items') = 1
      and payload #>> '{items,0,source_id}'
        = '92000000-0000-4000-8000-000000000102'
      and payload #>> '{items,0,external_id}' = 'movie-b'
      and (payload ->> 'films')::integer = 1
      and payload -> 'total' = 'null'::jsonb
    from result
  ),
  'default grid elects visible B even while hidden A retains the global primary flag'
);

insert into public.cloud_media_items (
  user_id,
  source_id,
  item_type,
  external_id,
  title
)
select
  '92000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000101',
  'movie',
  'hidden-heavy-' || series.n,
  'Hidden A heavy row ' || series.n
from generate_series(1, 4) series(n);

select extensions.ok(
  (
    select count(*) = 5
    from public.cloud_media_items media
    where media.user_id = '92000000-0000-4000-8000-000000000001'
      and media.source_id = '92000000-0000-4000-8000-000000000101'
      and media.item_type = 'movie'
  )
  and (
    select count(*) = 2
    from public.cloud_catalog_visible_media_items media
    where media.user_id = '92000000-0000-4000-8000-000000000001'
      and media.item_type = 'movie'
  ),
  'hidden-A-heavy fixture has five base rows but only two visible B rows'
);

select extensions.is(
  public.norva_visible_catalog_exceeds(
    '92000000-0000-4000-8000-000000000001',
    'movie',
    2
  ),
  false,
  'hidden A rows cannot force the visible catalog into large-account routing'
);

select extensions.ok(
  (
    with result as (
      select public.list_media_items_deduped(
        p_user => '92000000-0000-4000-8000-000000000001',
        p_item_type => 'movie',
        p_source => '92000000-0000-4000-8000-000000000102',
        p_limit => 60,
        p_offset => 0
      ) as payload
    )
    select
      jsonb_array_length(payload -> 'items') = 2
      and (payload ->> 'films')::integer = 1
      and (payload ->> 'total')::integer = 1
    from result
  ),
  'filtered grid keeps its exact-total contract when only hidden A is heavy'
);
select extensions.is(
  (select count(*)::integer from public.cloud_catalog_visible_favorites
   where source_id = '92000000-0000-4000-8000-000000000101'),
  0,
  'favorites tied to replaced A are hidden atomically'
);
select extensions.is(
  (select count(*)::integer from public.cloud_catalog_visible_watch_history
   where source_id = '92000000-0000-4000-8000-000000000101'),
  0,
  'history tied to replaced A is hidden atomically'
);

select extensions.throws_ok(
  $sql$
    insert into public.cloud_source_transitions (
      id, user_id, transition_kind, old_source_id, candidate_source_id,
      identity_decision, decision_origin, idempotency_key,
      expected_catalog_version, reversal_of_transition_id
    ) values (
      '92000000-0000-4000-8000-000000000607',
      '92000000-0000-4000-8000-000000000001',
      'replacement',
      '92000000-0000-4000-8000-000000000102',
      '92000000-0000-4000-8000-000000000101',
      'different_catalog',
      'automatic',
      'self-reversal',
      1,
      '92000000-0000-4000-8000-000000000607'
    )
  $sql$,
  '23514',
  'a transition cannot reverse itself',
  'reversal_of_transition_id cannot self-reference'
);

select extensions.throws_ok(
  $sql$
    insert into public.cloud_source_transitions (
      id, user_id, transition_kind, old_source_id, candidate_source_id,
      identity_decision, decision_origin, idempotency_key,
      expected_catalog_version, reversal_of_transition_id
    ) values (
      '92000000-0000-4000-8000-000000000608',
      '92000000-0000-4000-8000-000000000001',
      'replacement',
      '92000000-0000-4000-8000-000000000101',
      '92000000-0000-4000-8000-000000000102',
      'different_catalog',
      'automatic',
      'non-inverting-reversal',
      1,
      '92000000-0000-4000-8000-000000000601'
    )
  $sql$,
  '23514',
  'reversal must invert one completed replacement',
  'a compensating transition must invert the original A and B endpoints'
);

insert into public.cloud_source_transitions (
  id, user_id, transition_kind, old_source_id, candidate_source_id,
  identity_decision, decision_origin, idempotency_key,
  expected_catalog_version, reversal_of_transition_id
) values (
  '92000000-0000-4000-8000-000000000606',
  '92000000-0000-4000-8000-000000000001',
  'replacement',
  '92000000-0000-4000-8000-000000000102',
  '92000000-0000-4000-8000-000000000101',
  'different_catalog',
  'automatic',
  'reverse-b-to-a',
  1,
  '92000000-0000-4000-8000-000000000601'
);

insert into public.cloud_source_identity_assessments (
  id, user_id, transition_id, algorithm_version,
  sample_size_old, sample_size_new, overlap_count, similarity_score,
  automatic_decision, final_decision, decision_origin, decided_at
) values (
  '92000000-0000-4000-8000-000000000813',
  '92000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000606',
  'identity-reversal-v1',
  32,
  32,
  0,
  0,
  'different_catalog',
  'different_catalog',
  'automatic',
  now()
);

update public.cloud_source_transitions
set state = 'staging'
where id = '92000000-0000-4000-8000-000000000606';
update public.cloud_source_transitions
set state = 'importing'
where id = '92000000-0000-4000-8000-000000000606';
update public.cloud_source_transitions
set state = 'ready_to_switch',
    readiness_check_id = '92000000-0000-4000-8000-000000000803',
    readiness_passed_at = now()
where id = '92000000-0000-4000-8000-000000000606';

select extensions.throws_ok(
  $sql$
    update public.cloud_source_transitions
    set reversal_of_transition_id = null
    where id = '92000000-0000-4000-8000-000000000606'
  $sql$,
  '23514',
  'transition identity is immutable',
  'reversal_of_transition_id is immutable once the compensation exists'
);

select extensions.throws_ok(
  $sql$
    select public.norva_promote_source_replacement(
      '92000000-0000-4000-8000-000000000606',
      '92000000-0000-4000-8000-000000000001',
      'reverse-promotion-b-a',
      1,
      3
    )
  $sql$,
  '55000',
  'reverse promotion requires the compensating promotion RPC',
  'the forward promotion RPC fails closed for compensating transitions'
);

update public.cloud_source_transitions
set state = 'cancelled'
where id = '92000000-0000-4000-8000-000000000606';

select extensions.is(
  (select state from public.cloud_source_transitions
   where id = '92000000-0000-4000-8000-000000000601'),
  'completed',
  'cancelling a compensation never mutates the completed original transition'
);

select extensions.throws_ok(
  $sql$
    delete from public.cloud_source_transitions
    where id = '92000000-0000-4000-8000-000000000606'
  $sql$,
  '23514',
  'source transitions cannot be deleted',
  'transition audit records cannot be deleted to bypass terminal immutability'
);

select extensions.throws_ok(
  $sql$
    select * from public.claim_cloud_playback_session(
      '92000000-0000-4000-8000-000000000902',
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000101',
      null,
      'movie',
      'movie-a',
      'direct',
      'ready',
      repeat('2', 64),
      repeat('c', 64),
      null,
      '{}'::jsonb,
      now() + interval '10 minutes'
    )
  $sql$,
  '55000',
  'source catalog is not visible',
  'no new playback session can be born on A after promotion'
);

select extensions.lives_ok(
  $sql$
    select * from public.claim_cloud_playback_session(
      '92000000-0000-4000-8000-000000000903',
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000102',
      null,
      'movie',
      'movie-b',
      'direct',
      'ready',
      repeat('3', 64),
      repeat('d', 64),
      null,
      '{}'::jsonb,
      now() + interval '10 minutes'
    )
  $sql$,
  'playback claim succeeds on active B after promotion'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.norva_promote_source_replacement(uuid,uuid,text,bigint,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.norva_promote_source_replacement(uuid,uuid,text,bigint,bigint)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.upsert_cloud_favorite_visible(uuid,uuid,uuid,text,text,text,jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.get_cloud_watch_history_item_visible(uuid,uuid,uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.get_cloud_watch_history_item_visible(uuid,uuid,uuid,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.claim_cloud_playback_session(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,jsonb,timestamptz)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.get_cloud_watch_history_item_visible(uuid,uuid,uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.get_cloud_watch_history_item_visible(uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ),
  'promotion and guarded mutation/session/history RPCs are service-role only'
);

select * from extensions.finish();
rollback;
