begin;
set local lock_timeout = '2s';
set local statement_timeout = '5min';

-- Phase 3: durable, service-owned credential transitions.  This migration is
-- deliberately fail closed.  It does not enable any feature flag and it never
-- stores a credential outside a ciphertext column.

create or replace function public.norva_credential_transition_fingerprint_guard()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE'
     and new.request_fingerprint is distinct from old.request_fingerprint then
    raise exception 'transition request fingerprint is immutable'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (
       (old.candidate_catalog_generation_id is not null
        and new.candidate_catalog_generation_id is distinct from old.candidate_catalog_generation_id)
       or (old.previous_catalog_generation_id is not null
        and new.previous_catalog_generation_id is distinct from old.previous_catalog_generation_id)
     ) then
    raise exception 'transition catalog generation proof is immutable'
      using errcode = '23514';
  end if;
  return new;
end
$function$;

create table public.cloud_source_catalog_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  source_id uuid not null,
  transition_id uuid,
  config_revision bigint not null check (config_revision >= 0),
  state text not null check (
    state in (
      'building', 'ready', 'active', 'retained', 'failed', 'purging', 'purged'
    )
  ),
  manifest_sealing boolean not null default false,
  revision bigint not null default 0 check (revision >= 0),
  manifest_counts jsonb not null default '{}'::jsonb check (
    jsonb_typeof(manifest_counts) = 'object'
    and octet_length(manifest_counts::text) <= 2048
  ),
  manifest_checksum text check (
    manifest_checksum is null or manifest_checksum ~ '^[0-9a-f]{64}$'
  ),
  identity_evidence jsonb not null default '{}'::jsonb check (
    jsonb_typeof(identity_evidence) = 'object'
    and octet_length(identity_evidence::text) <= 32768
  ),
  gateway_complete_at timestamptz,
  title_projection_refresh_run_id uuid,
  title_projection_inventory_completed_at timestamptz,
  title_projection_refreshed_at timestamptz,
  ready_at timestamptz,
  activated_at timestamptz,
  retained_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (source_id, id),
  unique (id, transition_id),
  constraint cloud_source_catalog_generations_proof_ck check (
    (state = 'building' and manifest_checksum is null
      and gateway_complete_at is null and ready_at is null)
    or (state = 'ready' and manifest_checksum is not null
      and gateway_complete_at is not null and ready_at is not null)
    or state in ('active', 'retained', 'failed', 'purging', 'purged')
  )
);

create unique index cloud_source_catalog_generations_one_active_uidx
  on public.cloud_source_catalog_generations (source_id)
  where state = 'active';

create unique index cloud_source_catalog_generations_transition_uidx
  on public.cloud_source_catalog_generations (transition_id)
  where transition_id is not null;

-- The rollout state is deliberately a singleton.  Expansion only installs
-- nullable columns, compatibility views, and write guards.  No migration
-- advances this row beyond `expanded`; backfill, validation, and contract are
-- explicit service-owned operations in later migrations.
create table public.cloud_catalog_generation_rollout (
  singleton boolean primary key default true check (singleton),
  phase text not null default 'expanded' check (
    phase in ('expanded', 'backfilling', 'validated', 'contracted')
  ),
  discovery_cursor uuid,
  discovery_complete boolean not null default false,
  discovered_sources bigint not null default 0 check (discovered_sources >= 0),
  completed_sources bigint not null default 0 check (completed_sources >= 0),
  expanded_at timestamptz not null default clock_timestamp(),
  backfill_started_at timestamptz,
  backfill_completed_at timestamptz,
  constraints_validated_at timestamptz,
  contracted_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint cloud_catalog_generation_rollout_order_ck check (
    (backfill_completed_at is null or backfill_started_at is not null)
    and (constraints_validated_at is null or backfill_completed_at is not null)
    and (contracted_at is null or constraints_validated_at is not null)
  )
);

insert into public.cloud_catalog_generation_rollout(singleton) values (true);

create table public.cloud_source_catalog_heads (
  source_id uuid primary key,
  user_id uuid not null,
  active_generation_id uuid not null,
  head_revision bigint not null default 0 check (head_revision >= 0),
  updated_at timestamptz not null default now(),
  constraint cloud_source_catalog_heads_generation_fk
    foreign key (source_id, active_generation_id)
    references public.cloud_source_catalog_generations(source_id, id)
    on update cascade on delete restrict
);

create table public.cloud_source_catalog_generation_categories (
  generation_id uuid not null,
  user_id uuid not null,
  source_id uuid not null,
  category_kind text not null check (category_kind in ('live', 'vod', 'series')),
  category_ordinal integer not null check (category_ordinal between 0 and 1000000),
  provider_category_id text not null check (
    btrim(provider_category_id) <> '' and length(provider_category_id) <= 255
    and provider_category_id !~ '[[:cntrl:]]'
  ),
  category_name text not null check (
    btrim(category_name) <> '' and length(category_name) <= 512
    and category_name !~ '[[:cntrl:]]'
  ),
  streams_complete boolean not null default false,
  staged_item_count integer check (staged_item_count is null or staged_item_count >= 0),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (generation_id, category_kind, category_ordinal),
  unique (generation_id, category_kind, provider_category_id),
  constraint cloud_source_generation_categories_generation_owner_fk
    foreign key (user_id, generation_id)
    references public.cloud_source_catalog_generations(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_generation_categories_source_generation_fk
    foreign key (source_id, generation_id)
    references public.cloud_source_catalog_generations(source_id, id)
    on update cascade on delete restrict
);

create table public.cloud_source_catalog_generation_episode_copy (
  generation_id uuid primary key,
  user_id uuid not null,
  source_id uuid not null,
  previous_generation_id uuid not null,
  state text not null default 'pending' check (state in ('pending', 'complete')),
  membership_parent_cursor text,
  membership_episode_cursor text,
  inventory_parent_cursor text,
  memberships_copied bigint not null default 0 check (memberships_copied >= 0),
  inventory_rows_copied bigint not null default 0 check (inventory_rows_copied >= 0),
  memberships_skipped bigint not null default 0 check (memberships_skipped >= 0),
  inventory_rows_skipped bigint not null default 0 check (inventory_rows_skipped >= 0),
  revision bigint not null default 0 check (revision >= 0),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint cloud_source_generation_episode_copy_generation_owner_fk
    foreign key (user_id, generation_id)
    references public.cloud_source_catalog_generations(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_generation_episode_copy_previous_generation_fk
    foreign key (source_id, previous_generation_id)
    references public.cloud_source_catalog_generations(source_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_generation_episode_copy_complete_ck check (
    state = 'pending' or completed_at is not null
  )
);

create table public.cloud_source_catalog_generation_category_lists (
  generation_id uuid not null,
  user_id uuid not null,
  source_id uuid not null,
  category_kind text not null check (category_kind in ('live', 'vod', 'series')),
  expected_category_count integer not null check (
    expected_category_count between 0 and 1000000
  ),
  listing_complete boolean not null default false,
  completed_at timestamptz,
  primary key (generation_id, category_kind),
  constraint cloud_source_generation_category_lists_generation_owner_fk
    foreign key (user_id, generation_id)
    references public.cloud_source_catalog_generations(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_generation_category_lists_source_generation_fk
    foreign key (source_id, generation_id)
    references public.cloud_source_catalog_generations(source_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_generation_category_lists_complete_ck check (
    listing_complete = (completed_at is not null)
  )
);

-- Category metadata is not an inventory boundary: providers may return
-- uncategorized/orphan streams.  These three rows prove that each unfiltered
-- parent inventory action was exhausted and record its authoritative count.
create table public.cloud_source_catalog_generation_inventory_actions (
  generation_id uuid not null,
  user_id uuid not null,
  source_id uuid not null,
  action_kind text not null check (action_kind in ('live', 'vod', 'series')),
  staged_item_count bigint not null check (staged_item_count >= 0),
  action_complete boolean not null default false,
  completed_at timestamptz,
  primary key (generation_id, action_kind),
  constraint cloud_source_generation_inventory_actions_generation_owner_fk
    foreign key (user_id, generation_id)
    references public.cloud_source_catalog_generations(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_generation_inventory_actions_source_generation_fk
    foreign key (source_id, generation_id)
    references public.cloud_source_catalog_generations(source_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_generation_inventory_actions_complete_ck check (
    not action_complete or completed_at is not null
  )
);

-- Existing sources are intentionally not scanned here.  The online rollout
-- discovers them in bounded primary-key pages, then bootstraps one source at a
-- time.  Sources created after expansion are bootstrapped by the trigger below.

create or replace function public.norva_ensure_source_catalog_head(
  p_source_id uuid,
  p_user_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_generation_id uuid := gen_random_uuid();
  v_revision bigint;
  v_source public.cloud_sources%rowtype;
begin
  if p_source_id is null or p_user_id is null then
    raise exception 'source catalog head owner is required' using errcode = '22004';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('catalog-head:' || p_source_id::text, 0)
  );
  select head.active_generation_id into v_generation_id
  from public.cloud_source_catalog_heads head
  where head.source_id = p_source_id and head.user_id = p_user_id;
  if found then return v_generation_id; end if;

  select source.* into v_source
  from public.cloud_sources source
  where source.id = p_source_id and source.user_id = p_user_id
  for key share;
  if not found then
    raise exception 'source catalog head owner mismatch' using errcode = '23503';
  end if;
  select lifecycle.config_revision into v_revision
  from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id = p_source_id and lifecycle.user_id = p_user_id;
  if v_revision is null then
    raise exception 'source lifecycle must exist before catalog generation bootstrap'
      using errcode = '23503';
  end if;
  select generation.id into v_generation_id
  from public.cloud_source_catalog_generations generation
  where generation.source_id = p_source_id
    and generation.user_id = p_user_id
    and generation.state = 'active'
  for update;
  if not found then
    v_generation_id := gen_random_uuid();
    insert into public.cloud_source_catalog_generations (
      id, user_id, source_id, config_revision, state,
      manifest_counts, manifest_checksum, gateway_complete_at,
      ready_at, activated_at
    ) values (
      v_generation_id, p_user_id, p_source_id, v_revision, 'active',
      '{}'::jsonb,
      encode(extensions.digest('genesis:' || p_source_id::text, 'sha256'), 'hex'),
      case when v_source.sync_status = 'ready' and v_source.last_synced_at is not null
        then v_source.last_synced_at end,
      case when v_source.sync_status = 'ready' and v_source.last_synced_at is not null
        then v_source.last_synced_at end,
      coalesce(v_source.created_at, now())
    );
  end if;
  insert into public.cloud_source_catalog_heads (
    source_id, user_id, active_generation_id
  ) values (p_source_id, p_user_id, v_generation_id);
  return v_generation_id;
end
$function$;

revoke all on function public.norva_ensure_source_catalog_head(uuid,uuid)
  from public, anon, authenticated;

create or replace function public.norva_bootstrap_source_catalog_generation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform public.norva_ensure_source_catalog_head(new.id, new.user_id);
  return new;
end
$function$;

-- Expand only: no catalogue row is rewritten, no legacy uniqueness is
-- removed, and generation_id stays physically nullable until the explicit
-- contract operation.  NOT VALID constraints protect all new/changed rows
-- without scanning existing catalogues.  The nullable columns are installed by
-- the 20260823110000..110600 units and their NOT VALID constraints/triggers
-- by the 20260823120100..120800 units;
-- this long transaction therefore never holds a lock on a traffic table.

create or replace function public.norva_credential_candidate_hint_safe(p_hint jsonb)
returns boolean language sql immutable parallel safe set search_path = '' as $function$
  select p_hint is not null and jsonb_typeof(p_hint) = 'object'
    and octet_length(p_hint::text) <= 1024
    and (select count(*) = 3 and bool_and(key in ('sourceType','serverHost','hasPassword'))
         from jsonb_object_keys(p_hint) key)
    and p_hint ->> 'sourceType' = 'xtream'
    and jsonb_typeof(p_hint -> 'hasPassword') = 'boolean'
    and (p_hint ->> 'hasPassword')::boolean
    -- URL.host is intentionally persisted without scheme, path or userinfo.
    -- A non-default Xtream port is part of provider-account identity, so a
    -- single bounded :port suffix is accepted and range checked.
    and octet_length(coalesce(p_hint ->> 'serverHost','')) between 1 and 259
    and coalesce(p_hint ->> 'serverHost','')
      ~ '^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?$'
    and p_hint ->> 'serverHost' !~ '[/@]'
    and case
      when position(':' in (p_hint ->> 'serverHost')) = 0 then true
      else split_part(p_hint ->> 'serverHost', ':', 2)::integer between 1 and 65535
    end
$function$;

create table public.cloud_source_transition_secrets (
  transition_id uuid primary key,
  user_id uuid not null,
  source_id uuid not null,
  candidate_config_ciphertext text,
  previous_config_ciphertext text,
  candidate_config_hint jsonb,
  previous_config_hint jsonb,
  retain_until timestamptz not null default (now() + interval '30 days'),
  swap_applied_at timestamptz,
  candidate_refresh_proof_id uuid,
  candidate_refresh_healthy_at timestamptz,
  compensation_started_at timestamptz,
  compensation_reason_code text check (
    compensation_reason_code is null
    or compensation_reason_code in (
      'candidate_refresh_failed',
      'candidate_auth_rejected',
      'candidate_catalog_unhealthy',
      'operator_requested'
    )
  ),
  previous_config_restored_at timestamptz,
  rollback_refresh_proof_id uuid,
  rollback_refresh_healthy_at timestamptz,
  cleared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_source_transition_secrets_ciphertexts_ck check (
    (
      cleared_at is null
      and candidate_config_ciphertext is not null
      and previous_config_ciphertext is not null
      and public.norva_credential_candidate_hint_safe(candidate_config_hint)
      and jsonb_typeof(previous_config_hint) = 'object'
      and octet_length(previous_config_hint::text) <= 32768
      and btrim(candidate_config_ciphertext) <> ''
      and btrim(previous_config_ciphertext) <> ''
      and octet_length(candidate_config_ciphertext) <= 131072
      and octet_length(previous_config_ciphertext) <= 131072
    )
    or (
      cleared_at is not null
      and candidate_config_ciphertext is null
      and previous_config_ciphertext is null
      and candidate_config_hint is null
      and previous_config_hint is null
    )
  ),
  constraint cloud_source_transition_secrets_refresh_proof_ck check (
    (candidate_refresh_healthy_at is null) = (candidate_refresh_proof_id is null)
    and (rollback_refresh_healthy_at is null) = (rollback_refresh_proof_id is null)
  ),
  constraint cloud_source_transition_secrets_compensation_ck check (
    (compensation_started_at is null) = (compensation_reason_code is null)
    and (
      previous_config_restored_at is null
      or compensation_started_at is not null
    )
    and (
      rollback_refresh_healthy_at is null
      or previous_config_restored_at is not null
    )
  )
);

create unique index cloud_source_transition_secrets_owner_transition_uidx
  on public.cloud_source_transition_secrets (user_id, transition_id);

create or replace function public.norva_credential_job_progress_safe(
  p_progress jsonb
) returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $function$
declare
  v_key text;
begin
  if p_progress is null or jsonb_typeof(p_progress) <> 'object'
     or octet_length(p_progress::text) > 8192
     or not p_progress ?& array[
       'action','version','typeIndex','categoryOrdinal','itemOffset',
       'categoryPageCursor','categoriesDone','itemCursor',
       'processedCategories','processedItems'
     ]
     or coalesce(p_progress ->> 'action','') not in (
       'live_categories', 'vod_categories', 'series_categories',
       'live_streams', 'vod_streams', 'series_streams',
       'episode_state_copy', 'complete'
     )
     or coalesce(p_progress ->> 'version', '') !~ '^[1-9][0-9]{0,2}$'
     or coalesce(p_progress ->> 'typeIndex', '') !~ '^[0-9]{1,2}$'
     or coalesce(p_progress ->> 'categoryOrdinal', '') !~ '^[0-9]{1,9}$'
     or coalesce(p_progress ->> 'itemOffset', '') !~ '^[0-9]{1,12}$'
     or coalesce(p_progress ->> 'processedCategories', '') !~ '^[0-9]{1,9}$'
     or coalesce(p_progress ->> 'processedItems', '') !~ '^[0-9]{1,15}$'
     or coalesce(jsonb_typeof(p_progress -> 'categoriesDone'),'') <> 'boolean'
     or (case when coalesce(p_progress ->> 'typeIndex','') ~ '^[0-9]{1,2}$'
       then (p_progress ->> 'typeIndex')::integer else -1 end) <> (case p_progress ->> 'action'
       when 'live_categories' then 0 when 'vod_categories' then 1
       when 'series_categories' then 2 when 'live_streams' then 3
       when 'vod_streams' then 4 when 'series_streams' then 5
       when 'episode_state_copy' then 6 when 'complete' then 7 else -1 end)
     or ((p_progress ->> 'action') in ('live_categories','vod_categories','series_categories')
       and coalesce(p_progress ->> 'itemCursor','') <> '')
     or ((p_progress ->> 'action') in ('live_streams','vod_streams','series_streams')
       and coalesce(p_progress ->> 'categoryPageCursor','') <> '')
     or ((p_progress ->> 'action') in ('episode_state_copy','complete')
       and (coalesce(p_progress ->> 'categoryPageCursor','') <> ''
         or coalesce(p_progress ->> 'itemCursor','') <> ''))
     or ((p_progress ->> 'action') = 'complete'
       and not (p_progress ->> 'categoriesDone')::boolean)
     or length(coalesce(p_progress ->> 'categoryPageCursor', '')) > 1024
     or length(coalesce(p_progress ->> 'itemCursor', '')) > 1024
     or concat_ws('', p_progress ->> 'categoryPageCursor',
       p_progress ->> 'itemCursor') ~* '[[:cntrl:]]|://|@|password|username|access_token|api_key' then
    return false;
  end if;
  for v_key in select jsonb_object_keys(p_progress) loop
    if v_key not in (
      'action', 'version', 'typeIndex', 'categoryOrdinal', 'itemOffset',
      'categoryPageCursor', 'categoriesDone', 'itemCursor',
      'processedCategories', 'processedItems'
    ) then return false; end if;
  end loop;
  return true;
end
$function$;

create table public.cloud_source_credential_transition_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  transition_id uuid not null,
  source_id uuid not null,
  catalog_generation_id uuid,
  expected_source_revision bigint not null check (expected_source_revision >= 0),
  job_kind text not null check (
    job_kind in (
      'validate_candidate', 'build_candidate_generation',
      'post_switch_verify', 'rollback_refresh',
      'promote_generation_titles', 'purge_terminal_generation'
    )
  ),
  state text not null default 'pending' check (
    state in ('pending', 'processing', 'completed', 'dead')
  ),
  attempt_count integer not null default 0 check (attempt_count between 0 and 25),
  max_attempts integer not null default 5 check (max_attempts between 1 and 25),
  lease_sequence integer not null default 0 check (lease_sequence >= 0),
  checkpoint_revision bigint not null default 0 check (checkpoint_revision >= 0),
  title_projection_refresh_run_id uuid,
  title_inventory_observed_count bigint check (
    title_inventory_observed_count is null
    or title_inventory_observed_count >= 0
  ),
  title_pruned_variant_count bigint check (
    title_pruned_variant_count is null or title_pruned_variant_count >= 0
  ),
  title_inventory_completed_at timestamptz,
  title_prune_completed_at timestamptz,
  progress jsonb not null default '{"action":"live_categories","version":1,"typeIndex":0,"categoryOrdinal":0,"itemOffset":0,"categoryPageCursor":"","categoriesDone":false,"itemCursor":"","processedCategories":0,"processedItems":0}'::jsonb
    check (public.norva_credential_job_progress_safe(progress)),
  available_at timestamptz not null default now(),
  lease_owner text check (
    lease_owner is null or (btrim(lease_owner) <> '' and length(lease_owner) <= 160)
  ),
  lease_until timestamptz,
  last_error_code text check (
    last_error_code is null
    or last_error_code in (
      'network_timeout',
      'provider_unavailable',
      'auth_rejected',
      'rate_limited',
      'invalid_payload',
      'catalog_unhealthy',
       'internal_error',
       'lease_expired',
       'transition_cancelled'
    )
  ),
  completed_at timestamptz,
  dead_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_source_credential_jobs_generation_fk
    foreign key (source_id, catalog_generation_id)
    references public.cloud_source_catalog_generations(source_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_credential_jobs_lease_ck check (
    (state = 'processing' and lease_owner is not null and lease_until is not null)
    or (state <> 'processing' and lease_owner is null and lease_until is null)
  ),
  constraint cloud_source_credential_jobs_terminal_ck check (
    (state = 'completed' and completed_at is not null and dead_at is null)
    or (state = 'dead' and dead_at is not null and completed_at is null)
    or (state in ('pending', 'processing') and completed_at is null and dead_at is null)
  )
);

create unique index cloud_source_credential_jobs_one_active_kind_uidx
  on public.cloud_source_credential_transition_jobs (transition_id, job_kind)
  where state in ('pending', 'processing');

create index cloud_source_credential_jobs_claim_idx
  on public.cloud_source_credential_transition_jobs (
    state, available_at, lease_until, created_at, id
  );

create table public.cloud_source_catalog_generation_title_promotions (
  generation_id uuid primary key,
  user_id uuid not null,
  source_id uuid not null,
  title_cursor uuid,
  phase text not null default 'pending'
    check (phase in ('pending', 'complete')),
  processed_titles bigint not null default 0 check (processed_titles >= 0),
  snapshot_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint cloud_source_title_promotions_generation_owner_fk
    foreign key (user_id, generation_id)
    references public.cloud_source_catalog_generations(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_title_promotions_generation_source_fk
    foreign key (source_id, generation_id)
    references public.cloud_source_catalog_generations(source_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_title_promotions_terminal_ck check (
    (phase = 'pending' and completed_at is null)
    or (phase = 'complete' and completed_at is not null)
  )
);

create table public.cloud_source_catalog_generation_candidate_titles (
  generation_id uuid not null,
  title_id uuid not null,
  transition_id uuid not null,
  user_id uuid not null,
  source_id uuid not null,
  item_type text not null check (item_type in ('movie', 'series')),
  identity_key text not null check (btrim(identity_key) <> ''),
  identity_source text not null check (
    identity_source in ('provider_tmdb', 'provider_imdb', 'normalized')
  ),
  provider_tmdb_id text,
  provider_imdb_id text,
  match_status text not null check (
    match_status in (
      'provider_unverified', 'provider_verified', 'matched',
      'weak', 'unmatched', 'manual'
    )
  ),
  title text not null check (btrim(title) <> ''),
  original_title text,
  release_year integer,
  poster_url text,
  backdrop_url text,
  -- The generation payload is durable for as long as this generation can own
  -- a visible variant.  cloud_titles is only a shared FK shell and therefore
  -- cannot safely carry source/generation-specific display state.
  metadata jsonb not null default '{}'::jsonb,
  -- Full provider/TMDB payload retained for the post-terminal global catalogue
  -- mirror.  `metadata` is the public/effective payload and may intentionally
  -- follow the legacy self-thin representation; never reconstruct either from
  -- the shared shell during promotion.
  catalog_metadata jsonb not null default '{}'::jsonb,
  genre_category text,
  genre_payload jsonb,
  genre_buckets text[] not null default array['autres']::text[],
  rating_num numeric,
  year_backfill_attempted_at timestamptz,
  revalidate_attempted_at timestamptz,
  search_match_attempted_at timestamptz,
  -- Set by the active, snapshot-fenced projector after the credential head
  -- switch.  A partial index makes the terminal zero-remaining proof O(1)
  -- once every staged payload has been refreshed.
  post_switch_refreshed boolean not null default false,
  -- Stable per-generation ordering key.  The visible overlay can merge the
  -- physical and unpromoted branches without hydrating every title before a
  -- bounded ORDER/LIMIT, and promotion copies the same value to the shell.
  synced_at timestamptz not null default now(),
  -- Immutable catalogue-arrival order copied from the shared FK shell.  It is
  -- intentionally distinct from created_at (the projection/ledger insertion
  -- time) so recent-title selectors can merge physical and candidate payloads
  -- with one stable total key without scanning either branch.
  catalog_created_at timestamptz not null,
  -- Only a shell created by this exact INSERT may be garbage-collected.  A
  -- pre-existing/shared shell is never inferred from identity or timestamps.
  shell_created boolean not null,
  shell_token uuid check (
    (shell_created and shell_token is not null)
    or (not shell_created and shell_token is null)
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (generation_id, title_id),
  unique (generation_id, item_type, identity_key),
  constraint cloud_source_candidate_titles_generation_owner_fk
    foreign key (user_id, generation_id)
    references public.cloud_source_catalog_generations(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_candidate_titles_generation_source_fk
    foreign key (source_id, generation_id)
    references public.cloud_source_catalog_generations(source_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_candidate_titles_generation_transition_fk
    foreign key (generation_id, transition_id)
    references public.cloud_source_catalog_generations(id, transition_id)
    on update cascade on delete restrict,
  constraint cloud_source_candidate_titles_transition_owner_fk
    foreign key (user_id, transition_id)
    references public.cloud_source_transitions(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_candidate_titles_title_fk
    foreign key (user_id, title_id)
    references public.cloud_titles(user_id, id)
    on update cascade on delete cascade
);

create index cloud_source_candidate_titles_title_generation_idx
  on public.cloud_source_catalog_generation_candidate_titles (
    title_id, generation_id
  );

create table public.cloud_source_catalog_title_refresh_actions (
  refresh_run_id uuid not null,
  action_kind text not null,
  job_id uuid not null,
  transition_id uuid not null,
  user_id uuid not null,
  source_id uuid not null,
  generation_id uuid not null,
  baseline_count bigint not null,
  catalog_version bigint,
  category_count bigint,
  observed_count bigint,
  active_row_count bigint,
  pruned_count bigint,
  inventory_complete boolean not null default false,
  prune_complete boolean not null default false,
  prune_safe boolean not null default false,
  state text not null default 'started',
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (refresh_run_id,action_kind),
  unique (job_id,action_kind),
  constraint cloud_source_title_refresh_actions_kind_ck check (
    action_kind in ('live','vod','series')
  ),
  constraint cloud_source_title_refresh_actions_baseline_count_ck check (
    baseline_count >= 0
  ),
  constraint cloud_source_title_refresh_actions_category_count_ck check (
    category_count is null or category_count >= 0
  ),
  constraint cloud_source_title_refresh_actions_observed_count_ck check (
    observed_count is null or observed_count >= 0
  ),
  constraint cloud_source_title_refresh_actions_active_count_ck check (
    active_row_count is null or active_row_count >= 0
  ),
  constraint cloud_source_title_refresh_actions_pruned_count_ck check (
    pruned_count is null or pruned_count >= 0
  ),
  constraint cloud_source_title_refresh_actions_state_ck check (
    state in ('started','complete')
  ),
  constraint cloud_source_title_refresh_actions_complete_ck check (
    (
      state = 'started' and catalog_version is null
      and category_count is null and observed_count is null
      and active_row_count is null and pruned_count is null
      and not inventory_complete and not prune_complete and not prune_safe
      and completed_at is null
    ) or (
      state = 'complete' and catalog_version is not null
      and category_count is not null and observed_count is not null
      and active_row_count is not null and pruned_count = 0
      and inventory_complete and prune_complete and prune_safe
      and completed_at is not null
    )
  ),
  constraint cloud_source_title_refresh_actions_catalog_version_ck check (
    catalog_version is null or catalog_version >= 0
  ),
  constraint cloud_source_title_refresh_actions_job_fk
    foreign key (job_id)
    references public.cloud_source_credential_transition_jobs(id)
    on update cascade on delete restrict,
  constraint cloud_source_title_refresh_actions_generation_fk
    foreign key (source_id,generation_id)
    references public.cloud_source_catalog_generations(source_id,id)
    on update cascade on delete restrict,
  constraint cloud_source_title_refresh_actions_generation_owner_fk
    foreign key (user_id,generation_id)
    references public.cloud_source_catalog_generations(user_id,id)
    on update cascade on delete restrict,
  constraint cloud_source_title_refresh_actions_generation_transition_fk
    foreign key (generation_id,transition_id)
    references public.cloud_source_catalog_generations(id,transition_id)
    on update cascade on delete restrict,
  constraint cloud_source_title_refresh_actions_transition_fk
    foreign key (user_id,transition_id)
    references public.cloud_source_transitions(user_id,id)
    on update cascade on delete restrict
);

alter table public.cloud_source_catalog_title_refresh_actions
  enable row level security;
revoke all on table public.cloud_source_catalog_title_refresh_actions
from public,anon,authenticated,service_role;

create or replace function public.norva_catalog_generation_guard_begin_statement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_nonce uuid := gen_random_uuid();
  v_enabled boolean := false;
  v_contracted boolean := false;
begin
  select coalesce(flag.enabled, false), rollout.contracted_at is not null
  into v_enabled, v_contracted
  from public.cloud_catalog_generation_rollout rollout
  left join public.admin_feature_flags flag
    on flag.key = 'provider_credential_transition_v1_enabled'
  where rollout.singleton;
  perform set_config('norva.catalog_guard_nonce', v_nonce::text, true);
  perform set_config(
    'norva.catalog_guard_transition_enabled', v_enabled::text, true
  );
  perform set_config(
    'norva.catalog_guard_rollout_contracted', v_contracted::text, true
  );
  perform set_config('norva.catalog_guard_validation_count', '0', true);
  perform set_config('norva.catalog_guard_head_lookup_count', '0', true);
  return null;
end
$function$;

create or replace function public.norva_catalog_generation_write_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_nonce uuid;
  v_generation_id uuid;
  v_generation_state text;
  v_generation_config_revision bigint;
  v_head_generation_id uuid;
  v_job_id uuid;
  v_attempt integer;
  v_lease_owner text;
  v_config_revision bigint;
  v_head_revision bigint;
  v_source_visibility_epoch bigint;
  v_user_visibility_epoch bigint;
  v_delete_proof jsonb;
  v_new_row jsonb;
  v_generation_fence_enforced boolean := false;
  v_rollout_contracted boolean := false;
  v_visible boolean := false;
  v_job_valid boolean := false;
  v_manifest_sealing boolean := false;
  v_cache_key text;
  v_cache_name text;
  v_cache jsonb;
  v_head_cache_name text;
  v_head_cache jsonb;
  v_validation_count integer := 0;
  v_head_lookup_count integer := 0;
  v_owner_user_id uuid;
  v_owner_source_id uuid;
  v_online_backfill boolean := false;
  v_active_refresh_context jsonb;
  v_active_refresh_context_text text;
  v_active_prune_context jsonb;
  v_active_prune_context_text text;
  v_old_row jsonb;
begin
  begin
    v_nonce := nullif(current_setting('norva.catalog_guard_nonce', true), '')::uuid;
  exception when others then
    v_nonce := null;
  end;
  if v_nonce is null then
    -- Defensive fallback for restored schemas where a statement trigger was
    -- temporarily absent.  Normal execution always takes the trigger path.
    v_nonce := gen_random_uuid();
    select coalesce(flag.enabled, false), rollout.contracted_at is not null
    into v_generation_fence_enforced, v_rollout_contracted
    from public.cloud_catalog_generation_rollout rollout
    left join public.admin_feature_flags flag
      on flag.key = 'provider_credential_transition_v1_enabled'
    where rollout.singleton;
    perform set_config('norva.catalog_guard_nonce', v_nonce::text, true);
    perform set_config(
      'norva.catalog_guard_transition_enabled',
      v_generation_fence_enforced::text,
      true
    );
    perform set_config(
      'norva.catalog_guard_rollout_contracted',
      v_rollout_contracted::text,
      true
    );
    perform set_config('norva.catalog_guard_validation_count', '0', true);
    perform set_config('norva.catalog_guard_head_lookup_count', '0', true);
  else
    v_generation_fence_enforced := coalesce(nullif(current_setting(
      'norva.catalog_guard_transition_enabled', true
    ), '')::boolean, false);
    v_rollout_contracted := coalesce(nullif(current_setting(
      'norva.catalog_guard_rollout_contracted', true
    ), '')::boolean, false);
  end if;

  if tg_op = 'DELETE' then
    v_old_row := to_jsonb(old);
    v_generation_id := old.generation_id;
    v_job_id := old.ingest_job_id;
    v_attempt := old.ingest_attempt;
    v_lease_owner := old.ingest_lease_owner;
    v_owner_user_id := old.user_id;
    v_owner_source_id := old.source_id;
  else
    v_owner_user_id := new.user_id;
    v_owner_source_id := new.source_id;
    if new.generation_id is null then
      if v_generation_fence_enforced then
        raise exception 'explicit catalog generation is required'
          using errcode = '22004';
      end if;
      v_head_cache_name := 'norva.catalog_guard_head_' || pg_catalog.md5(
        new.user_id::text || ':' || new.source_id::text
      );
      begin
        v_head_cache := nullif(current_setting(v_head_cache_name, true), '')::jsonb;
      exception when others then
        v_head_cache := null;
      end;
      if v_head_cache ->> 'nonce' is not distinct from v_nonce::text then
        new.generation_id := (v_head_cache ->> 'generationId')::uuid;
      else
        new.generation_id := public.norva_ensure_source_catalog_head(
          new.source_id, new.user_id
        );
        perform set_config(
          v_head_cache_name,
          jsonb_build_object(
            'nonce', v_nonce,
            'generationId', new.generation_id
          )::text,
          true
        );
        v_head_lookup_count := coalesce(nullif(current_setting(
          'norva.catalog_guard_head_lookup_count', true
        ), '')::integer, 0) + 1;
        perform set_config(
          'norva.catalog_guard_head_lookup_count',
          v_head_lookup_count::text,
          true
        );
      end if;
    end if;
    v_new_row := to_jsonb(new);
    v_generation_id := new.generation_id;
    v_job_id := new.ingest_job_id;
    v_attempt := new.ingest_attempt;
    v_lease_owner := new.ingest_lease_owner;
  end if;

  if tg_op = 'DELETE' and v_generation_id is null
     and not v_generation_fence_enforced and not v_rollout_contracted then
    return old;
  end if;
  if tg_op = 'UPDATE' and new.generation_id is distinct from old.generation_id
     and not (
       old.generation_id is null
       and not v_generation_fence_enforced
       and not v_rollout_contracted
     ) then
    raise exception 'catalog row generation is immutable' using errcode = '23514';
  end if;

  -- Preserve the pre-contract compatibility path while making cross-generation
  -- links fail closed.  Validated composite FKs become the durable second line
  -- of defence before contract.
  if tg_op <> 'DELETE' and tg_relid = 'public.cloud_title_variants'::regclass
     and nullif(v_new_row->>'media_item_id','') is not null and not exists (
       select 1 from public.cloud_media_items parent
       where parent.id=(v_new_row->>'media_item_id')::uuid
         and parent.source_id=new.source_id
         and (parent.generation_id=new.generation_id
           or (parent.generation_id is null and not v_rollout_contracted
             and not v_generation_fence_enforced))
     ) then
    raise exception 'title variant media item crosses catalog generation'
      using errcode='23514';
  end if;
  if tg_op <> 'DELETE' and tg_relid = 'public.cloud_live_variants'::regclass then
    if nullif(v_new_row->>'logical_channel_id','') is not null and not exists (
      select 1 from public.cloud_live_logical_channels parent
      where parent.id=(v_new_row->>'logical_channel_id')::uuid
        and parent.source_id=new.source_id
        and (parent.generation_id=new.generation_id
          or (parent.generation_id is null and not v_rollout_contracted
            and not v_generation_fence_enforced))
    ) then
      raise exception 'live variant logical channel crosses catalog generation'
        using errcode='23514';
    end if;
    if nullif(v_new_row->>'media_item_id','') is not null and not exists (
      select 1 from public.cloud_media_items parent
      where parent.id=(v_new_row->>'media_item_id')::uuid
        and parent.source_id=new.source_id
        and (parent.generation_id=new.generation_id
          or (parent.generation_id is null and not v_rollout_contracted
            and not v_generation_fence_enforced))
    ) then
      raise exception 'live variant media item crosses catalog generation'
        using errcode='23514';
    end if;
  end if;
  if tg_op <> 'DELETE'
     and tg_relid in ('public.catalog_series_episode_memberships'::regclass,
                      'public.catalog_series_inventory_state'::regclass)
     and not exists (
       select 1 from public.cloud_title_variants parent
       where parent.id=(v_new_row->>'parent_variant_id')::uuid
         and parent.source_id=new.source_id
         and (parent.generation_id=new.generation_id
           or (parent.generation_id is null and not v_rollout_contracted
             and not v_generation_fence_enforced))
     ) then
    raise exception 'series parent variant crosses catalog generation'
      using errcode='23514';
  end if;

  v_cache_key := pg_catalog.md5(
    v_owner_user_id::text || ':' || v_owner_source_id::text || ':'
    || v_generation_id::text || ':' || coalesce(v_job_id::text, '') || ':'
    || coalesce(v_attempt::text, '') || ':' || coalesce(v_lease_owner, '')
  );
  v_cache_name := 'norva.catalog_guard_context_' || v_cache_key;
  begin
    v_cache := nullif(current_setting(v_cache_name, true), '')::jsonb;
  exception when others then
    v_cache := null;
  end;
  if v_cache ->> 'nonce' is distinct from v_nonce::text then
    select jsonb_build_object(
      'nonce', v_nonce,
      'generationId', generation.id,
      'state', generation.state,
      'generationConfigRevision', generation.config_revision,
      'manifestSealing', generation.manifest_sealing,
      'headGenerationId', head.active_generation_id,
      'headRevision', head.head_revision,
      'sourceConfigRevision', lifecycle.config_revision,
      'sourceVisibilityEpoch', lifecycle.visibility_epoch,
      'userVisibilityEpoch', coalesce(epoch.visibility_epoch, 1),
      'visible', public.norva_source_catalog_visible_internal(
        generation.source_id, generation.user_id
      ),
      'jobValid', exists (
        select 1
        from public.cloud_source_credential_transition_jobs job
        join public.cloud_source_transitions transition
          on transition.id = job.transition_id
         and transition.user_id = job.user_id
        where job.id = v_job_id
          and job.catalog_generation_id = generation.id
          and job.job_kind = 'build_candidate_generation'
          and job.state = 'processing'
          and job.lease_until > now()
          and job.lease_sequence = v_attempt
          and job.lease_owner = v_lease_owner
          and transition.state = 'importing'
      )
    ) into v_cache
    from public.cloud_source_catalog_generations generation
    left join public.cloud_source_catalog_heads head
      on head.source_id = generation.source_id
     and head.user_id = generation.user_id
    left join public.cloud_source_lifecycle lifecycle
      on lifecycle.source_id = generation.source_id
     and lifecycle.user_id = generation.user_id
    left join public.cloud_user_catalog_visibility_epochs epoch
      on epoch.user_id = generation.user_id
    where generation.id = v_generation_id
      and generation.source_id = v_owner_source_id
      and generation.user_id = v_owner_user_id;
    if v_cache is null then
      raise exception 'catalog generation not found' using errcode = '23503';
    end if;
    perform set_config(v_cache_name, v_cache::text, true);
    v_validation_count := coalesce(nullif(current_setting(
      'norva.catalog_guard_validation_count', true
    ), '')::integer, 0) + 1;
    perform set_config(
      'norva.catalog_guard_validation_count',
      v_validation_count::text,
      true
    );
  end if;

  v_generation_state := v_cache ->> 'state';
  v_generation_config_revision := (v_cache ->> 'generationConfigRevision')::bigint;
  v_head_generation_id := nullif(v_cache ->> 'headGenerationId', '')::uuid;
  v_head_revision := nullif(v_cache ->> 'headRevision', '')::bigint;
  v_config_revision := nullif(v_cache ->> 'sourceConfigRevision', '')::bigint;
  v_source_visibility_epoch := nullif(
    v_cache ->> 'sourceVisibilityEpoch', ''
  )::bigint;
  v_user_visibility_epoch := nullif(
    v_cache ->> 'userVisibilityEpoch', ''
  )::bigint;
  v_visible := coalesce((v_cache ->> 'visible')::boolean, false);
  v_job_valid := coalesce((v_cache ->> 'jobValid')::boolean, false);
  v_manifest_sealing := coalesce(
    (v_cache ->> 'manifestSealing')::boolean, false
  );
  if v_manifest_sealing then
    raise exception 'catalog generation is sealed for manifest snapshot'
      using errcode = '40001', detail = 'reason=manifest_sealing';
  end if;
  v_online_backfill := tg_op = 'UPDATE'
    and old.generation_id is null
    and current_setting('norva.catalog_online_backfill_generation', true)
      is not distinct from v_generation_id::text
    and not v_generation_fence_enforced
    and not v_rollout_contracted;

  if v_generation_state = 'active' then
    -- Provider inventory is upsert-only until an exact signed-spool checkpoint
    -- has reached the bounded prune RPC.  That RPC supplies an exact current
    -- job/run lease context and may delete only rows whose run marker is stale;
    -- an arbitrary DELETE or a current-run row still fails closed.
    if tg_op = 'DELETE' and exists (
      select 1
      from public.cloud_source_catalog_generations generation
      join public.cloud_source_transitions transition
        on transition.id = generation.transition_id
       and transition.user_id = generation.user_id
      where generation.id = v_generation_id
        and transition.state = 'committing'
    ) then
      v_active_prune_context_text := current_setting(
        'norva.catalog_active_inventory_prune', true
      );
      begin
        v_active_prune_context := nullif(
          v_active_prune_context_text, ''
        )::jsonb;
      exception when others then
        v_active_prune_context := null;
      end;
      if jsonb_typeof(v_active_prune_context) <> 'object'
         or (select count(*) from jsonb_object_keys(
           v_active_prune_context
         )) <> 8
         or not (v_active_prune_context ?& array[
           'transitionId','userId','sourceId','generationId',
           'refreshRunId','jobId','worker','leaseSequence'
         ])
         or v_old_row ->> 'projection_refresh_run_id' is not distinct from
            v_active_prune_context ->> 'refreshRunId'
         or not exists (
           select 1
           from public.cloud_source_catalog_generations generation
           join public.cloud_source_credential_transition_jobs job
             on job.catalog_generation_id = generation.id
            and job.transition_id = generation.transition_id
           join public.cloud_source_transitions transition
             on transition.id = generation.transition_id
            and transition.user_id = generation.user_id
           where generation.id = v_generation_id
             and generation.user_id = v_owner_user_id
             and generation.source_id = v_owner_source_id
             and generation.title_projection_refresh_run_id =
               (v_active_prune_context ->> 'refreshRunId')::uuid
             and transition.id =
               (v_active_prune_context ->> 'transitionId')::uuid
             and transition.state = 'committing'
             and job.id = (v_active_prune_context ->> 'jobId')::uuid
             and job.user_id =
               (v_active_prune_context ->> 'userId')::uuid
             and job.source_id =
               (v_active_prune_context ->> 'sourceId')::uuid
             and job.job_kind = 'post_switch_verify'
             and job.state = 'processing'
             and job.lease_owner = v_active_prune_context ->> 'worker'
             and job.lease_sequence =
               (v_active_prune_context ->> 'leaseSequence')::integer
              and job.lease_until > now()
         ) then
        raise exception 'committing catalog refresh prune is not authorized'
          using errcode = '40001',
            detail = 'reason=credential_job_lease_changed';
      end if;
    end if;
    -- Transition generations use the durable projection as their display
    -- payload.  Serialize variant membership behind the generation fence and
    -- require the active projector to publish/refine that projection first.
    -- Reconciliation holds the same generation row while retiring stale
    -- projections, so an old statement cannot insert an orphan variant after
    -- its projection proof was removed.
    if tg_op <> 'DELETE'
       and tg_relid = 'public.cloud_title_variants'::regclass
       and exists (
         select 1
         from public.cloud_source_catalog_generations generation
         where generation.id = v_generation_id
           and generation.transition_id is not null
       ) then
      perform 1
      from public.cloud_source_catalog_generations generation
      where generation.id = v_generation_id
      for update;
      if not exists (
        select 1
        from public.cloud_source_catalog_generation_candidate_titles projection
        where projection.generation_id = v_generation_id
          and projection.title_id = (v_new_row ->> 'title_id')::uuid
          and projection.source_id = v_owner_source_id
          and projection.user_id = v_owner_user_id
      ) then
        raise exception 'active transition title variant has no projection'
          using errcode = '23503',
          detail = 'reason=active_title_projection_missing';
      end if;
    end if;
    -- While the new head is still compensable, every provider inventory or
    -- materialization write must come from the exact post-switch job lease.
    -- Stamping the durable run marker in the same statement prevents an
    -- expired worker from mutating rows after a reclaimed worker certified
    -- the refresh.  Terminal active generations return to the ordinary active
    -- writer contract.
    if tg_op <> 'DELETE'
       and tg_relid in (
         'public.cloud_media_items'::regclass,
         'public.cloud_title_variants'::regclass,
         'public.cloud_live_logical_channels'::regclass,
         'public.cloud_live_variants'::regclass
       )
       and exists (
         select 1
         from public.cloud_source_catalog_generations generation
         join public.cloud_source_transitions transition
           on transition.id = generation.transition_id
          and transition.user_id = generation.user_id
         where generation.id = v_generation_id
           and transition.state = 'committing'
       ) then
      perform 1
      from public.cloud_source_catalog_generations generation
      where generation.id = v_generation_id
      for update;
      v_active_refresh_context_text := current_setting(
        'norva.catalog_active_variant_refresh', true
      );
      begin
        v_active_refresh_context := nullif(
          v_active_refresh_context_text, ''
        )::jsonb;
      exception when others then
        v_active_refresh_context := null;
      end;
      if jsonb_typeof(v_active_refresh_context) <> 'object'
         or (select count(*) from jsonb_object_keys(
           v_active_refresh_context
         )) <> 8
         or not (v_active_refresh_context ?& array[
           'transitionId','userId','sourceId','generationId',
           'refreshRunId','jobId','worker','leaseSequence'
         ])
         or v_new_row ->> 'projection_refresh_run_id' is distinct from
            v_active_refresh_context ->> 'refreshRunId'
         or not exists (
           select 1
           from public.cloud_source_catalog_generations generation
           join public.cloud_source_credential_transition_jobs job
             on job.catalog_generation_id = generation.id
            and job.transition_id = generation.transition_id
           join public.cloud_source_transitions transition
             on transition.id = generation.transition_id
            and transition.user_id = generation.user_id
           where generation.id = v_generation_id
             and generation.user_id = v_owner_user_id
             and generation.source_id = v_owner_source_id
             and generation.title_projection_refresh_run_id =
               (v_active_refresh_context ->> 'refreshRunId')::uuid
             and transition.id =
               (v_active_refresh_context ->> 'transitionId')::uuid
             and transition.state = 'committing'
             and job.id = (v_active_refresh_context ->> 'jobId')::uuid
             and job.user_id =
               (v_active_refresh_context ->> 'userId')::uuid
             and job.source_id =
               (v_active_refresh_context ->> 'sourceId')::uuid
             and job.job_kind = 'post_switch_verify'
             and job.state = 'processing'
             and job.lease_owner =
               v_active_refresh_context ->> 'worker'
              and job.lease_sequence =
                (v_active_refresh_context ->> 'leaseSequence')::integer
              and job.lease_until > now()
         )
         or not exists (
           select 1
           from public.cloud_source_catalog_title_refresh_actions action
           where action.refresh_run_id =
               (v_active_refresh_context ->> 'refreshRunId')::uuid
             and action.job_id =
               (v_active_refresh_context ->> 'jobId')::uuid
             and action.generation_id = v_generation_id
             and action.action_kind = case
               when tg_relid in (
                 'public.cloud_live_logical_channels'::regclass,
                 'public.cloud_live_variants'::regclass
               ) then 'live'
               when v_new_row ->> 'item_type' = 'movie' then 'vod'
               else v_new_row ->> 'item_type'
             end
             and action.state = 'started'
         ) then
        raise exception 'active transition refresh lease is stale'
          using errcode = '40001',
            detail = 'reason=credential_job_lease_changed';
      end if;
    end if;
    if v_head_generation_id is distinct from v_generation_id then
      raise exception 'active catalog row does not match source head'
        using errcode = '23514';
    end if;
    if (v_generation_fence_enforced
        and v_generation_config_revision is distinct from v_config_revision)
       or (not v_visible and not v_online_backfill) then
      raise exception 'active catalog write snapshot is stale or invisible'
        using errcode = '40001';
    end if;
    if tg_op = 'DELETE' and v_generation_fence_enforced then
      begin
        v_delete_proof := current_setting('norva.catalog_delete_proof', true)::jsonb;
      exception when others then
        v_delete_proof := null;
      end;
      if (v_delete_proof ->> 'headRevision')::bigint is distinct from v_head_revision
         or (v_delete_proof ->> 'configRevision')::bigint is distinct from v_config_revision
         or (v_delete_proof ->> 'sourceVisibilityEpoch')::bigint
              is distinct from v_source_visibility_epoch
         or (v_delete_proof ->> 'userVisibilityEpoch')::bigint
              is distinct from v_user_visibility_epoch then
        raise exception 'active catalog delete proof is stale or missing'
          using errcode = '40001';
      end if;
    elsif tg_op <> 'DELETE' and v_generation_fence_enforced then
      if new.write_head_revision is distinct from v_head_revision
         or new.write_config_revision is distinct from v_config_revision
         or new.write_source_visibility_epoch is distinct from v_source_visibility_epoch
         or new.write_user_visibility_epoch is distinct from v_user_visibility_epoch then
        raise exception 'active catalog write proof is stale or missing'
          using errcode = '40001';
      end if;
      new.write_head_revision := null;
      new.write_config_revision := null;
      new.write_source_visibility_epoch := null;
      new.write_user_visibility_epoch := null;
    elsif tg_op <> 'DELETE' then
      new.write_head_revision := null;
      new.write_config_revision := null;
      new.write_source_visibility_epoch := null;
      new.write_user_visibility_epoch := null;
    end if;
    if tg_op <> 'DELETE' then
      new.ingest_job_id := null;
      new.ingest_attempt := null;
      new.ingest_lease_owner := null;
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op <> 'DELETE' and (
       new.write_head_revision is not null
       or new.write_config_revision is not null
       or new.write_source_visibility_epoch is not null
       or new.write_user_visibility_epoch is not null
     ) then
    raise exception 'candidate generation cannot carry an active write proof'
      using errcode = '23514';
  end if;
  if v_generation_state = 'purging' then
    if tg_op = 'DELETE'
       and current_setting('norva.catalog_purge_generation', true)
         is not distinct from v_generation_id::text then
      return old;
    end if;
    raise exception 'catalog generation is closed for purge'
      using errcode = '42501';
  end if;
  if not v_rollout_contracted or not v_generation_fence_enforced then
    raise exception 'candidate catalog writes require contracted rollout and enabled flag'
      using errcode = '55000';
  end if;
  if v_generation_state <> 'building' or not v_job_valid then
    raise exception 'catalog generation write lease is invalid or closed'
      using errcode = '42501';
  end if;
  if tg_op <> 'DELETE'
     and tg_relid = 'public.cloud_title_variants'::regclass
     and not exists (
       select 1
       from public.cloud_source_catalog_generation_candidate_titles projection
       where projection.generation_id = v_generation_id
         and projection.title_id = (v_new_row ->> 'title_id')::uuid
         and projection.source_id = v_owner_source_id
         and projection.user_id = v_owner_user_id
     ) then
    raise exception 'candidate title variant has no generation title projection'
      using errcode = '23503',
        detail = 'reason=candidate_title_projection_missing';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

create or replace function public.norva_catalog_generation_row_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_generation_id uuid;
begin
  if tg_op = 'DELETE' then
    for v_generation_id in select distinct generation_id from old_rows loop
      update public.cloud_source_catalog_generations generation
      set revision = generation.revision + 1, updated_at = now()
      where generation.id = v_generation_id and generation.state = 'building';
    end loop;
  else
    for v_generation_id in select distinct generation_id from new_rows loop
      update public.cloud_source_catalog_generations generation
      set revision = generation.revision + 1, updated_at = now()
      where generation.id = v_generation_id and generation.state = 'building';
    end loop;
  end if;
  return null;
end
$function$;

-- cloud_catalog_visible_titles is intentionally left as the global logical
-- title rollup.  Its only source-scoped inputs are read from the head-filtered
-- cloud_catalog_visible_title_variants view above, so a BUILDING/READY
-- generation cannot contribute a title, rollup, language, or default variant.

create table public.cloud_source_credential_transition_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  transition_id uuid not null,
  action_kind text not null check (
    action_kind in (
      'manual_decision', 'cancel', 'validation_failed', 'begin_swap',
      'replacement_handoff_consumed'
    )
  ),
  idempotency_key text not null check (
    btrim(idempotency_key) <> '' and length(idempotency_key) <= 200
  ),
  request_fingerprint text not null check (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  result_state text not null check (
    result_state in (
      'validating', 'staging', 'importing', 'ready_to_switch',
      'committing', 'completed', 'failed', 'cancelled'
    )
  ),
  result_revision bigint not null check (result_revision >= 0),
  result_identity_decision text check (
    result_identity_decision is null
    or result_identity_decision in ('same_catalog', 'different_catalog', 'ambiguous')
  ),
  result_payload jsonb not null check (
    jsonb_typeof(result_payload) = 'object'
    and octet_length(result_payload::text) <= 8192
    and not result_payload ?| array[
      'requestFingerprint', 'candidateSecretRef', 'previousSecretRef',
      'candidateConfigCiphertext', 'previousConfigCiphertext'
    ]
  ),
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create or replace function public.norva_credential_secret_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'credential transition secrets cannot be deleted'
      using errcode = '42501';
  end if;

  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = new.transition_id
    and transition.user_id = new.user_id;
  if not found
     or v_transition.transition_kind is distinct from 'credential'
     or v_transition.old_source_id is distinct from new.source_id then
    raise exception 'secret row must belong to its credential transition'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if new.transition_id is distinct from old.transition_id
       or new.user_id is distinct from old.user_id
       or new.source_id is distinct from old.source_id
       or new.created_at is distinct from old.created_at
       or new.retain_until < old.retain_until
       or new.swap_applied_at is distinct from old.swap_applied_at
          and old.swap_applied_at is not null
       or new.candidate_refresh_healthy_at is distinct from old.candidate_refresh_healthy_at
          and old.candidate_refresh_healthy_at is not null
       or new.compensation_started_at is distinct from old.compensation_started_at
          and old.compensation_started_at is not null
       or new.previous_config_restored_at is distinct from old.previous_config_restored_at
          and old.previous_config_restored_at is not null
       or new.rollback_refresh_healthy_at is distinct from old.rollback_refresh_healthy_at
          and old.rollback_refresh_healthy_at is not null then
      raise exception 'credential secret evidence is immutable'
        using errcode = '23514';
    end if;

    if new.candidate_config_ciphertext is distinct from old.candidate_config_ciphertext
       or new.previous_config_ciphertext is distinct from old.previous_config_ciphertext
       or new.candidate_config_hint is distinct from old.candidate_config_hint
       or new.previous_config_hint is distinct from old.previous_config_hint
       or new.cleared_at is distinct from old.cleared_at then
      if current_setting('norva.credential_secret_clear', true) is distinct from 'on'
         or old.cleared_at is not null
         or new.candidate_config_ciphertext is not null
         or new.previous_config_ciphertext is not null
         or new.candidate_config_hint is not null
         or new.previous_config_hint is not null
         or new.cleared_at is null
         or v_transition.state not in ('completed', 'failed', 'cancelled') then
        raise exception 'credential ciphertexts may only be cleared after terminal state'
          using errcode = '42501';
      end if;
    end if;
  end if;

  new.updated_at := now();
  return new;
end
$function$;

create trigger trg_cloud_source_transition_secrets_guard
before insert or update or delete on public.cloud_source_transition_secrets
for each row execute function public.norva_credential_secret_guard();

create or replace function public.norva_credential_job_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'credential transition jobs cannot be deleted'
      using errcode = '42501';
  end if;
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = new.transition_id and transition.user_id = new.user_id;
  if not found
     or (
       v_transition.transition_kind = 'credential'
       and v_transition.old_source_id is distinct from new.source_id
     )
     or (
       v_transition.transition_kind = 'replacement'
       and v_transition.candidate_source_id is distinct from new.source_id
     )
     or v_transition.transition_kind not in ('credential', 'replacement') then
    raise exception 'job must belong to its transition source'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
       or new.user_id is distinct from old.user_id
       or new.transition_id is distinct from old.transition_id
       or new.source_id is distinct from old.source_id
       or (old.catalog_generation_id is not null
         and new.catalog_generation_id is distinct from old.catalog_generation_id)
       or new.expected_source_revision is distinct from old.expected_source_revision
       or (
         new.job_kind is distinct from old.job_kind
         and not (
           old.job_kind = 'post_switch_verify'
           and new.job_kind = 'promote_generation_titles'
           and v_transition.state = 'completed'
           and old.state = 'processing'
           and new.state = 'pending'
         )
       )
       or new.max_attempts is distinct from old.max_attempts
       or new.created_at is distinct from old.created_at then
      raise exception 'credential job identity is immutable' using errcode = '23514';
    end if;
    if old.state in ('completed', 'dead') then
      raise exception 'terminal credential job is immutable' using errcode = '23514';
    end if;
  end if;
  new.updated_at := now();
  return new;
end
$function$;

create trigger trg_cloud_source_credential_jobs_guard
before insert or update or delete on public.cloud_source_credential_transition_jobs
for each row execute function public.norva_credential_job_guard();

create or replace function public.norva_credential_action_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op <> 'INSERT' then
    raise exception 'credential transition actions are append-only'
      using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.cloud_source_transitions transition
    where transition.id = new.transition_id
      and transition.user_id = new.user_id
      and transition.transition_kind = 'credential'
  ) then
    raise exception 'action must belong to its credential transition'
      using errcode = '23514';
  end if;
  return new;
end
$function$;

create trigger trg_cloud_source_credential_actions_guard
before insert or update or delete on public.cloud_source_credential_transition_actions
for each row execute function public.norva_credential_action_guard();

create or replace function public.norva_credential_require_service_role()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(
    nullif(auth.jwt() ->> 'role', ''),
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), 'none'),
    ''
  );
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
end
$function$;

-- Every terminal credential RPC locks the account before transition, source,
-- job or lifecycle rows.  auth.users deletion owns that same row before its
-- cascades, so this one parent fence prevents account->child / child->account
-- cycles without exposing credential material or a caller-forgeable token.
create or replace function public.norva_credential_lock_account(
  p_user_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_user_id is null then
    raise exception 'credential account is required' using errcode = '22004';
  end if;
  perform 1
  from auth.users account
  where account.id = p_user_id
  for key share;
  if not found then
    raise exception 'credential account no longer exists'
      using errcode = '40001';
  end if;
end
$function$;

create or replace function public.norva_credential_require_enabled()
returns void language plpgsql stable security definer set search_path = '' as $function$
begin
  if not coalesce((select flag.enabled from public.admin_feature_flags flag
    where flag.key = 'provider_credential_transition_v1_enabled'), false) then
    raise exception 'provider credential transition feature is disabled'
      using errcode = '55000';
  end if;
end
$function$;

create or replace function public.norva_credential_transition_result(
  p_transition_id uuid,
  p_user_id uuid
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'transitionId', transition.id,
    'sourceId', transition.old_source_id,
    'state', upper(transition.state),
    'identityDecision', case
      when transition.identity_decision is null then null
      else upper(transition.identity_decision)
    end,
    'decisionOrigin', case
      when transition.decision_origin is null then null
      else upper(transition.decision_origin)
    end,
    'revision', transition.revision,
    'expectedSourceRevision', transition.expected_source_revision,
    'readinessCheckId', transition.readiness_check_id,
    'readinessPassedAt', transition.readiness_passed_at,
    'startedAt', transition.started_at,
    'readyAt', transition.ready_at,
    'committingAt', transition.committing_at,
    'completedAt', transition.completed_at,
    'failureCode', transition.failure_code,
    'currentSourceRevision', lifecycle.config_revision
  )
  from public.cloud_source_transitions transition
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id = transition.old_source_id
   and lifecycle.user_id = transition.user_id
  where transition.id = p_transition_id
    and transition.user_id = p_user_id
    and transition.transition_kind = 'credential';
$function$;

create or replace function public.norva_credential_action_result(
  p_action_id uuid
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select action.result_payload || jsonb_build_object('replayed', true)
  from public.cloud_source_credential_transition_actions action
  where action.id = p_action_id;
$function$;

create or replace function public.norva_create_credential_transition(
  p_user_id uuid,
  p_source_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_if_match_revision bigint,
  p_candidate_config_ciphertext text,
  p_candidate_config_hint jsonb,
  p_actor text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_existing public.cloud_source_transitions%rowtype;
  v_source public.cloud_sources%rowtype;
  v_lifecycle public.cloud_source_lifecycle%rowtype;
  v_transition_id uuid := gen_random_uuid();
  v_enabled boolean := false;
begin
  perform public.norva_credential_require_service_role();
  if p_user_id is null or p_source_id is null or p_if_match_revision is null then
    raise exception 'user_id, source_id and If-Match revision are required'
      using errcode = '22004';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
     or length(p_idempotency_key) > 200 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  if p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'request fingerprint must be lowercase SHA-256 hex'
      using errcode = '22023';
  end if;
  if p_candidate_config_ciphertext is null
     or btrim(p_candidate_config_ciphertext) = ''
     or octet_length(p_candidate_config_ciphertext) > 131072 then
    raise exception 'candidate ciphertext is required and bounded'
      using errcode = '22023';
  end if;
  if not public.norva_credential_candidate_hint_safe(p_candidate_config_hint) then
    raise exception 'candidate config hint is invalid or unsafe' using errcode = '22023';
  end if;
  if p_actor is null or btrim(p_actor) = '' or length(p_actor) > 200 then
    raise exception 'bounded actor is required' using errcode = '22023';
  end if;

  select flag.enabled into v_enabled
  from public.admin_feature_flags flag
  where flag.key = 'provider_credential_transition_v1_enabled'
  for share;
  if not found or not coalesce(v_enabled, false) then
    raise exception 'provider credential transition feature is disabled'
      using errcode = '55000';
  end if;

  select transition.* into v_existing
  from public.cloud_source_transitions transition
  where transition.user_id = p_user_id
    and transition.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_existing.transition_kind = 'credential'
       and v_existing.old_source_id = p_source_id
       and v_existing.request_fingerprint = p_request_fingerprint then
      return public.norva_credential_transition_result(v_existing.id, p_user_id);
    end if;
    raise exception 'idempotency key reused with different request'
      using errcode = '22023';
  end if;

  select source.* into v_source
  from public.cloud_sources source
  where source.id = p_source_id and source.user_id = p_user_id
  for update;
  if not found then
    raise exception 'source not found' using errcode = 'P0002';
  end if;
  select lifecycle.* into v_lifecycle
  from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id = p_source_id and lifecycle.user_id = p_user_id
  for update;
  if not found then
    raise exception 'source not found' using errcode = 'P0002';
  end if;
  if v_source.deleted_at is not null or v_source.source_type <> 'xtream'
     or v_lifecycle.lifecycle_state <> 'active'
     then
    raise exception 'source is not active and visible' using errcode = '55000';
  end if;
  if v_source.config_ciphertext is null or btrim(v_source.config_ciphertext) = '' then
    raise exception 'active source has no credential ciphertext' using errcode = '55000';
  end if;
  if v_lifecycle.config_revision <> p_if_match_revision then
    raise exception 'stale source revision' using errcode = '40001';
  end if;

  insert into public.cloud_source_transitions (
    id, user_id, transition_kind, old_source_id, state,
    idempotency_key, request_fingerprint,
    candidate_secret_ref, previous_secret_ref,
    expected_source_revision, created_by
  ) values (
    v_transition_id, p_user_id, 'credential', p_source_id, 'validating',
    p_idempotency_key, p_request_fingerprint,
    'credential-transition:' || v_transition_id::text || ':candidate',
    'credential-transition:' || v_transition_id::text || ':previous',
    p_if_match_revision, p_actor
  );

  insert into public.cloud_source_transition_secrets (
    transition_id, user_id, source_id,
    candidate_config_ciphertext, previous_config_ciphertext,
    candidate_config_hint, previous_config_hint
  ) values (
    v_transition_id, p_user_id, p_source_id,
    p_candidate_config_ciphertext, v_source.config_ciphertext,
    p_candidate_config_hint, coalesce(v_source.config_hint, '{}'::jsonb)
  );

  insert into public.cloud_source_credential_transition_jobs (
    user_id, transition_id, source_id, expected_source_revision, job_kind
  ) values (
    p_user_id, v_transition_id, p_source_id, p_if_match_revision,
    'validate_candidate'
  );

  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, transition_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, p_source_id, v_transition_id,
    'credential_transition_created',
    'credential-transition:' || v_transition_id::text || ':created',
    jsonb_build_object('expectedSourceRevision', p_if_match_revision),
    p_actor
  ) on conflict (user_id, idempotency_key) do nothing;

  return public.norva_credential_transition_result(v_transition_id, p_user_id);
end
$function$;

create or replace function public.norva_fail_credential_transition_validation(
  p_transition_id uuid,
  p_user_id uuid,
  p_expected_transition_revision bigint,
  p_failure_code text,
  p_actor text,
  p_idempotency_key text,
  p_request_fingerprint text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_action public.cloud_source_credential_transition_actions%rowtype;
  v_result jsonb;
begin
  perform public.norva_credential_require_service_role();
  if p_failure_code not in (
       'candidate_auth_rejected', 'candidate_invalid',
       'identity_validation_failed', 'validation_exhausted',
       'catalog_changed_during_staging'
     ) then
    raise exception 'invalid validation failure code' using errcode = '22023';
  end if;
  if p_actor is null or btrim(p_actor) = '' or length(p_actor) > 200
     or p_idempotency_key is null or btrim(p_idempotency_key) = ''
     or length(p_idempotency_key) > 200
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'valid actor, idempotency key and fingerprint are required'
      using errcode = '22023';
  end if;
  perform public.norva_credential_lock_account(p_user_id);
  select action.* into v_action
  from public.cloud_source_credential_transition_actions action
  where action.user_id = p_user_id
    and action.idempotency_key = p_idempotency_key
  for share;
  if found then
    if v_action.transition_id = p_transition_id
       and v_action.action_kind = 'validation_failed'
       and v_action.request_fingerprint = p_request_fingerprint then
      return public.norva_credential_action_result(v_action.id);
    end if;
    raise exception 'action idempotency key reused with different request'
      using errcode = '22023';
  end if;
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id
  for update;
  if not found then raise exception 'credential transition not found' using errcode = 'P0002'; end if;
  if v_transition.state not in ('validating', 'staging', 'importing')
     or v_transition.revision <> p_expected_transition_revision then
    raise exception 'credential validation failure CAS failed' using errcode = '40001';
  end if;
  update public.cloud_source_transitions
  set state = 'failed', failure_code = p_failure_code, approved_by = p_actor
  where id = p_transition_id;
  update public.cloud_source_credential_transition_jobs job
  set state = 'dead', lease_owner = null, lease_until = null,
      completed_at = null, dead_at = now(),
      last_error_code = case when p_failure_code = 'candidate_auth_rejected'
        then 'auth_rejected' else 'invalid_payload' end
  where job.transition_id = p_transition_id and job.user_id = p_user_id
    and job.state in ('pending', 'processing');
  update public.cloud_source_catalog_generations generation
  set state = 'purging', revision = generation.revision + 1, updated_at = now()
  where generation.transition_id = p_transition_id and generation.user_id = p_user_id
    and generation.state in ('building', 'ready');
  insert into public.cloud_source_credential_transition_jobs (
    user_id, transition_id, source_id, catalog_generation_id,
    expected_source_revision, job_kind, max_attempts
  )
  select generation.user_id, p_transition_id, generation.source_id,
         generation.id, v_transition.expected_source_revision,
         'purge_terminal_generation', 25
  from public.cloud_source_catalog_generations generation
  where generation.transition_id = p_transition_id
    and generation.user_id = p_user_id
    and generation.state = 'purging'
  on conflict (transition_id, job_kind)
    where state in ('pending', 'processing') do nothing;
  v_result := public.norva_credential_transition_result(p_transition_id, p_user_id);
  insert into public.cloud_source_credential_transition_actions (
    user_id, transition_id, action_kind, idempotency_key,
    request_fingerprint, result_state, result_revision,
    result_identity_decision, result_payload
  ) values (
    p_user_id, p_transition_id, 'validation_failed', p_idempotency_key,
    p_request_fingerprint, 'failed', (v_result ->> 'revision')::bigint,
    v_transition.identity_decision, v_result
  );
  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, transition_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, v_transition.old_source_id, p_transition_id,
    'credential_validation_failed',
    'credential-transition:' || p_transition_id::text || ':validation-failed',
    jsonb_build_object('failureCode', p_failure_code), p_actor
  ) on conflict (user_id, idempotency_key) do nothing;
  perform set_config('norva.credential_secret_clear', 'on', true);
  update public.cloud_source_transition_secrets secret
  set candidate_config_ciphertext = null,
      previous_config_ciphertext = null,
      candidate_config_hint = null,
      previous_config_hint = null,
      cleared_at = now()
  where secret.transition_id = p_transition_id
    and secret.user_id = p_user_id and secret.cleared_at is null;
  perform set_config('norva.credential_secret_clear', 'off', true);
  return v_result || jsonb_build_object('replayed', false);
end
$function$;

create or replace function public.norva_get_credential_transition(
  p_transition_id uuid,
  p_user_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  perform public.norva_credential_require_service_role();
  v_result := public.norva_credential_transition_result(p_transition_id, p_user_id);
  if v_result is null then
    raise exception 'credential transition not found' using errcode = 'P0002';
  end if;
  return v_result;
end
$function$;

create or replace function public.norva_read_credential_transition_secret(
  p_transition_id uuid,
  p_user_id uuid,
  p_purpose text
) returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_secret text;
begin
  perform public.norva_credential_require_service_role();
  if p_purpose = 'candidate' then
    select secret.candidate_config_ciphertext into v_secret
    from public.cloud_source_transition_secrets secret
    where secret.transition_id = p_transition_id and secret.user_id = p_user_id;
  elsif p_purpose = 'previous' then
    select secret.previous_config_ciphertext into v_secret
    from public.cloud_source_transition_secrets secret
    where secret.transition_id = p_transition_id and secret.user_id = p_user_id;
  else
    raise exception 'invalid credential secret purpose' using errcode = '22023';
  end if;
  if v_secret is null then
    raise exception 'credential transition secret unavailable' using errcode = 'P0002';
  end if;
  return v_secret;
end
$function$;

create or replace function public.norva_mark_credential_candidate_validated(
  p_transition_id uuid,
  p_user_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_transition_revision bigint,
  p_category_count integer
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  if p_category_count is null or p_category_count < 0 or p_category_count > 1000000 then
    raise exception 'candidate category count is invalid' using errcode = '22023';
  end if;
  select transition.* into v_transition from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id for update;
  if not found then raise exception 'credential transition not found' using errcode = 'P0002'; end if;
  select job.* into v_job from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id for update;
  if not found or v_job.job_kind <> 'validate_candidate'
     or v_job.state <> 'processing' or v_job.lease_owner <> p_worker
     or v_job.lease_sequence <> p_expected_lease_sequence
     or v_job.lease_until <= now() or v_transition.state <> 'validating'
     or v_transition.revision <> p_expected_transition_revision then
    raise exception 'candidate validation lease CAS failed' using errcode = '40001';
  end if;
  update public.cloud_source_credential_transition_jobs
  set state = 'completed', lease_owner = null, lease_until = null,
      completed_at = now(), last_error_code = null
  where id = p_job_id;
  update public.cloud_source_transitions set state = 'staging'
  where id = p_transition_id;
  insert into public.cloud_source_credential_transition_jobs (
    user_id, transition_id, source_id, expected_source_revision, job_kind
  ) values (
    p_user_id, p_transition_id, v_transition.old_source_id,
    v_transition.expected_source_revision, 'build_candidate_generation'
  );
  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, transition_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, v_transition.old_source_id, p_transition_id,
    'credential_candidate_validated',
    'credential-transition:' || p_transition_id::text || ':candidate-validated',
    jsonb_build_object('categoryCount', p_category_count), 'service_role'
  ) on conflict (user_id, idempotency_key) do nothing;
  return public.norva_credential_transition_result(p_transition_id, p_user_id);
end
$function$;

create or replace function public.norva_record_credential_identity_assessment(
  p_transition_id uuid,
  p_user_id uuid,
  p_algorithm_version text,
  p_sample_size_old integer,
  p_sample_size_new integer,
  p_overlap_count integer,
  p_similarity_score numeric,
  p_summary jsonb,
  p_automatic_decision text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_decision text := lower(p_automatic_decision);
  v_assessment public.cloud_source_identity_assessments%rowtype;
  v_candidate_evidence jsonb;
  v_previous_evidence jsonb;
  v_candidate_manifest_checksum text;
  v_previous_manifest_checksum text;
  v_previous_manifest_sealing boolean;
  v_content_manifest_match boolean := false;
  v_expected_similarity numeric;
  v_expected_overlap integer;
  v_expected_decision text;
  v_samples_complete boolean;
  v_strong_signals jsonb;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  if p_algorithm_version is distinct from
       'xtream-type-streamid-sha256-bottom256-jaccard-manifest-v2' then
    raise exception 'invalid algorithm version' using errcode = '22023';
  end if;
  if v_decision not in ('same_catalog', 'different_catalog', 'ambiguous') then
    raise exception 'invalid automatic identity decision' using errcode = '22023';
  end if;
  if p_summary is null or jsonb_typeof(p_summary) <> 'object'
     or octet_length(p_summary::text) > 4096
     or exists (
       select 1 from jsonb_object_keys(p_summary) key
       where key not in (
          'sample_complete', 'strong_identity_distinct',
          'canonical_identity_match', 'content_manifest_checksum_match',
          'decision_reason_code'
       )
     )
     or (
       p_summary ? 'decision_reason_code'
       and (p_summary ->> 'decision_reason_code') !~ '^[a-z0-9_]{1,64}$'
     ) then
    raise exception 'assessment summary contains unbounded or identifying fields'
      using errcode = '22023';
  end if;

  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id
  for update;
  if not found then
    raise exception 'credential transition not found' using errcode = 'P0002';
  end if;
  if v_transition.transition_kind <> 'credential'
     or v_transition.state <> 'importing'
     or not exists (
       select 1 from public.cloud_source_catalog_generations generation
       where generation.id = v_transition.candidate_catalog_generation_id
         and generation.transition_id = p_transition_id
         and generation.state = 'ready'
         and generation.gateway_complete_at is not null
     ) then
    raise exception 'sealed candidate generation is required before identity assessment'
      using errcode = '55000';
  end if;

  select generation.identity_evidence, generation.manifest_checksum
  into v_candidate_evidence, v_candidate_manifest_checksum
  from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.candidate_catalog_generation_id;
  select generation.identity_evidence, generation.manifest_checksum,
         generation.manifest_sealing
  into v_previous_evidence, v_previous_manifest_checksum,
       v_previous_manifest_sealing
  from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.previous_catalog_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = v_transition.old_source_id
    and generation.state = 'active'
  for update;
  if not found or not v_previous_manifest_sealing
     or v_previous_manifest_checksum is null
     or not coalesce((v_previous_evidence ->> 'complete')::boolean, false) then
    raise exception 'previous catalog identity evidence is not sealed'
      using errcode = '40001', detail = 'reason=manifest_seal_incomplete';
  end if;
  v_content_manifest_match := v_candidate_manifest_checksum is not null
    and v_candidate_manifest_checksum = v_previous_manifest_checksum
    and v_candidate_evidence ->> 'contentManifestChecksum'
      = v_candidate_manifest_checksum
    and v_previous_evidence ->> 'contentManifestChecksum'
      = v_previous_manifest_checksum;
  v_expected_similarity := case
    when p_sample_size_old + p_sample_size_new - p_overlap_count = 0 then 1
    else p_overlap_count::numeric
      / (p_sample_size_old + p_sample_size_new - p_overlap_count)
  end;
  v_samples_complete := coalesce((v_previous_evidence ->> 'complete')::boolean, false)
    and coalesce((v_candidate_evidence ->> 'complete')::boolean, false);
  v_strong_signals := public.norva_credential_strong_identity_signals(
    p_transition_id, p_user_id
  );
  select count(*) into v_expected_overlap
  from jsonb_array_elements(v_previous_evidence -> 'sample') old_sample
  join jsonb_array_elements(v_candidate_evidence -> 'sample') candidate_sample
    on candidate_sample ->> 'itemType' = old_sample ->> 'itemType'
   and candidate_sample ->> 'externalIdHash'
      = old_sample ->> 'externalIdHash';
  v_expected_decision := case
    when v_samples_complete
      and p_sample_size_old >= 32
      and p_sample_size_new >= 32
      and round(v_expected_similarity, 5) >= 0.5
      and v_content_manifest_match
      and not coalesce((v_strong_signals ->> 'distinct')::boolean, false)
      then 'same_catalog'
    else 'ambiguous'
  end;
  if p_sample_size_old <> (v_previous_evidence ->> 'sampleSize')::integer
     or p_sample_size_new <> (v_candidate_evidence ->> 'sampleSize')::integer
     or p_overlap_count <> v_expected_overlap
     or p_similarity_score is distinct from round(v_expected_similarity, 5)
     or coalesce((p_summary ->> 'sample_complete')::boolean, false)
       is distinct from v_samples_complete
     or coalesce((p_summary ->> 'strong_identity_distinct')::boolean, false)
       is distinct from coalesce((v_strong_signals ->> 'distinct')::boolean, false)
      or coalesce((p_summary ->> 'canonical_identity_match')::boolean, false)
        is distinct from coalesce((v_strong_signals ->> 'match')::boolean, false)
      or coalesce((p_summary ->> 'content_manifest_checksum_match')::boolean, false)
        is distinct from v_content_manifest_match
      or v_decision <> v_expected_decision then
    raise exception 'identity assessment does not match sealed generation evidence'
      using errcode = '22023';
  end if;

  select assessment.* into v_assessment
  from public.cloud_source_identity_assessments assessment
  where assessment.transition_id = p_transition_id
    and assessment.algorithm_version = p_algorithm_version;
  if found then
    if v_assessment.sample_size_old = p_sample_size_old
       and v_assessment.sample_size_new = p_sample_size_new
       and v_assessment.overlap_count = p_overlap_count
       and v_assessment.similarity_score is not distinct from p_similarity_score
       and v_assessment.secondary_signals = p_summary
       and v_assessment.automatic_decision = v_decision then
      update public.cloud_source_catalog_generations generation
      set manifest_sealing = false,
          revision = generation.revision + 1,
          updated_at = clock_timestamp()
      where generation.id = v_transition.previous_catalog_generation_id
        and generation.manifest_sealing;
      return public.norva_credential_transition_result(p_transition_id, p_user_id);
    end if;
    raise exception 'assessment version replayed with different evidence'
      using errcode = '22023';
  end if;

  insert into public.cloud_source_identity_assessments (
    user_id, transition_id, algorithm_version,
    sample_size_old, sample_size_new, overlap_count, similarity_score,
    secondary_signals, automatic_decision,
    final_decision, decision_origin, decided_at
  ) values (
    p_user_id, p_transition_id, p_algorithm_version,
    p_sample_size_old, p_sample_size_new, p_overlap_count, p_similarity_score,
    p_summary, v_decision,
    case when v_decision = 'ambiguous' then null else v_decision end,
    case when v_decision = 'ambiguous' then null else 'automatic' end,
    case when v_decision = 'ambiguous' then null else now() end
  );

  update public.cloud_source_transitions transition
  set identity_decision = v_decision,
      decision_origin = 'automatic',
      validation_summary = jsonb_build_object(
        'algorithmVersion', p_algorithm_version,
        'sampleSizeOld', p_sample_size_old,
        'sampleSizeNew', p_sample_size_new,
        'overlapCount', p_overlap_count,
        'similarityScore', p_similarity_score,
        'automaticDecision', upper(v_decision),
        'decisionReasonCode', p_summary ->> 'decision_reason_code'
      )
  where transition.id = p_transition_id;

  if v_decision = 'different_catalog' then
    update public.cloud_source_transitions transition
    set state = 'cancelled'
    where transition.id = p_transition_id;
  end if;

  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, transition_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, v_transition.old_source_id, p_transition_id,
    'credential_identity_assessed',
    'credential-transition:' || p_transition_id::text || ':assessment:' || p_algorithm_version,
    jsonb_build_object('decision', upper(v_decision)),
    'service_role'
  ) on conflict (user_id, idempotency_key) do nothing;

  update public.cloud_source_catalog_generations generation
  set manifest_sealing = false,
      revision = generation.revision + 1,
      updated_at = clock_timestamp()
  where generation.id = v_transition.previous_catalog_generation_id
    and generation.manifest_sealing;

  return public.norva_credential_transition_result(p_transition_id, p_user_id);
end
$function$;

create or replace function public.norva_decide_ambiguous_credential_transition(
  p_transition_id uuid,
  p_user_id uuid,
  p_decision text,
  p_actor text,
  p_expected_transition_revision bigint,
  p_idempotency_key text,
  p_request_fingerprint text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_assessment public.cloud_source_identity_assessments%rowtype;
  v_decision text := upper(p_decision);
  v_final text;
  v_action public.cloud_source_credential_transition_actions%rowtype;
  v_result jsonb;
begin
  perform public.norva_credential_require_service_role();
  if v_decision not in ('KEEP_AS_SAME_CATALOG', 'REPLACE_WITH_NEW_CATALOG') then
    raise exception 'invalid ambiguous transition decision' using errcode = '22023';
  end if;
  if p_actor is null or btrim(p_actor) = '' or length(p_actor) > 200 then
    raise exception 'bounded manual actor is required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
     or length(p_idempotency_key) > 200
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'valid action idempotency key and fingerprint are required'
      using errcode = '22023';
  end if;
  perform public.norva_credential_lock_account(p_user_id);
  select action.* into v_action
  from public.cloud_source_credential_transition_actions action
  where action.user_id = p_user_id
    and action.idempotency_key = p_idempotency_key
  for share;
  if found then
    if v_action.transition_id = p_transition_id
       and v_action.action_kind = 'manual_decision'
       and v_action.request_fingerprint = p_request_fingerprint then
      return public.norva_credential_action_result(v_action.id);
    end if;
    raise exception 'action idempotency key reused with different request'
      using errcode = '22023';
  end if;
  if v_decision = 'REPLACE_WITH_NEW_CATALOG' and not coalesce((
    select flag.enabled from public.admin_feature_flags flag
    where flag.key = 'provider_replacement_v1_enabled'
  ), false) then
    raise exception 'provider replacement feature is disabled' using errcode = '55000';
  end if;
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id
  for update;
  if not found then
    raise exception 'credential transition not found' using errcode = 'P0002';
  end if;
  if v_transition.state <> 'importing'
     or v_transition.identity_decision <> 'ambiguous'
     or v_transition.revision <> p_expected_transition_revision then
    raise exception 'ambiguous transition decision CAS failed' using errcode = '40001';
  end if;
  select assessment.* into v_assessment
  from public.cloud_source_identity_assessments assessment
  where assessment.transition_id = p_transition_id
    and assessment.automatic_decision = 'ambiguous'
  order by assessment.created_at desc
  limit 1
  for update;
  if not found or v_assessment.final_decision is not null then
    raise exception 'open ambiguous assessment not found' using errcode = '55000';
  end if;

  v_final := case v_decision
    when 'KEEP_AS_SAME_CATALOG' then 'same_catalog'
    else 'different_catalog'
  end;
  update public.cloud_source_identity_assessments assessment
  set final_decision = v_final,
      decision_origin = 'manual',
      decided_at = now(),
      decided_by = p_actor
  where assessment.id = v_assessment.id;
  update public.cloud_source_transitions transition
  set identity_decision = v_final,
      decision_origin = 'manual',
      approved_by = p_actor,
      state = case
        when v_decision = 'REPLACE_WITH_NEW_CATALOG' then 'cancelled'
        else transition.state
      end
  where transition.id = p_transition_id
  returning public.norva_credential_transition_result(transition.id, p_user_id)
  into v_result;


  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, transition_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, v_transition.old_source_id, p_transition_id,
    'credential_ambiguous_decided',
    'credential-transition:' || p_transition_id::text || ':manual-decision',
    jsonb_build_object('decision', v_decision), p_actor
  ) on conflict (user_id, idempotency_key) do nothing;

  insert into public.cloud_source_credential_transition_actions (
    user_id, transition_id, action_kind, idempotency_key,
    request_fingerprint, result_state, result_revision,
    result_identity_decision, result_payload
  )
  select p_user_id, transition.id, 'manual_decision', p_idempotency_key,
         p_request_fingerprint, transition.state, transition.revision,
         transition.identity_decision,
         public.norva_credential_transition_result(transition.id, p_user_id)
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id;

  -- REPLACE_WITH_NEW_CATALOG is an authorization for the replacement workflow
  -- to consume the already encrypted candidate.  Do not force the client to
  -- resend a secret and do not clear it at this decision boundary.
  return v_result || jsonb_build_object('replayed', false);
end
$function$;

create or replace function public.norva_cancel_credential_transition(
  p_transition_id uuid,
  p_user_id uuid,
  p_actor text,
  p_expected_transition_revision bigint,
  p_idempotency_key text,
  p_request_fingerprint text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_action public.cloud_source_credential_transition_actions%rowtype;
  v_result jsonb;
begin
  perform public.norva_credential_require_service_role();
  if p_actor is null or btrim(p_actor) = '' or length(p_actor) > 200
     or p_idempotency_key is null or btrim(p_idempotency_key) = ''
     or length(p_idempotency_key) > 200
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'valid actor, idempotency key and fingerprint are required'
      using errcode = '22023';
  end if;
  perform public.norva_credential_lock_account(p_user_id);
  select action.* into v_action
  from public.cloud_source_credential_transition_actions action
  where action.user_id = p_user_id
    and action.idempotency_key = p_idempotency_key
  for share;
  if found then
    if v_action.transition_id = p_transition_id
       and v_action.action_kind = 'cancel'
       and v_action.request_fingerprint = p_request_fingerprint then
      return public.norva_credential_action_result(v_action.id);
    end if;
    raise exception 'action idempotency key reused with different request'
      using errcode = '22023';
  end if;
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id
  for update;
  if not found then raise exception 'credential transition not found' using errcode = 'P0002'; end if;
  if v_transition.state not in ('validating', 'staging', 'importing', 'ready_to_switch')
     or v_transition.revision <> p_expected_transition_revision then
    raise exception 'credential cancellation CAS failed' using errcode = '40001';
  end if;
  update public.cloud_source_transitions
  set state = 'cancelled', approved_by = p_actor
  where id = p_transition_id;
  update public.cloud_source_credential_transition_jobs job
  set state = 'dead', lease_owner = null, lease_until = null,
      completed_at = null, dead_at = now(),
      last_error_code = 'transition_cancelled'
  where job.transition_id = p_transition_id and job.user_id = p_user_id
    and job.state in ('pending', 'processing');
  update public.cloud_source_catalog_generations generation
  set state = 'purging', revision = generation.revision + 1, updated_at = now()
  where generation.transition_id = p_transition_id and generation.user_id = p_user_id
    and generation.state in ('building', 'ready');
  insert into public.cloud_source_credential_transition_jobs (
    user_id, transition_id, source_id, catalog_generation_id,
    expected_source_revision, job_kind, max_attempts
  )
  select generation.user_id, p_transition_id, generation.source_id,
         generation.id, v_transition.expected_source_revision,
         'purge_terminal_generation', 25
  from public.cloud_source_catalog_generations generation
  where generation.transition_id = p_transition_id
    and generation.user_id = p_user_id
    and generation.state = 'purging'
  on conflict (transition_id, job_kind)
    where state in ('pending', 'processing') do nothing;
  v_result := public.norva_credential_transition_result(p_transition_id, p_user_id);
  insert into public.cloud_source_credential_transition_actions (
    user_id, transition_id, action_kind, idempotency_key,
    request_fingerprint, result_state, result_revision,
    result_identity_decision, result_payload
  ) values (
    p_user_id, p_transition_id, 'cancel', p_idempotency_key,
    p_request_fingerprint, 'cancelled', (v_result ->> 'revision')::bigint,
    v_transition.identity_decision, v_result
  );
  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, transition_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, v_transition.old_source_id, p_transition_id,
    'credential_transition_cancelled',
    'credential-transition:' || p_transition_id::text || ':cancelled',
    '{}'::jsonb, p_actor
  ) on conflict (user_id, idempotency_key) do nothing;
  perform set_config('norva.credential_secret_clear', 'on', true);
  update public.cloud_source_transition_secrets secret
  set candidate_config_ciphertext = null,
      previous_config_ciphertext = null,
      candidate_config_hint = null,
      previous_config_hint = null,
      cleared_at = now()
  where secret.transition_id = p_transition_id
    and secret.user_id = p_user_id and secret.cleared_at is null;
  perform set_config('norva.credential_secret_clear', 'off', true);
  return v_result || jsonb_build_object('replayed', false);
end
$function$;

create or replace function public.norva_allocate_credential_catalog_generation(
  p_transition_id uuid,
  p_user_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_attempt integer,
  p_expected_transition_revision bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_head public.cloud_source_catalog_heads%rowtype;
  v_generation_id uuid := gen_random_uuid();
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id
  for update;
  if not found then raise exception 'credential transition not found' using errcode = 'P0002'; end if;
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id
  for update;
  if not found or v_job.job_kind <> 'build_candidate_generation'
     or v_job.state <> 'processing' or v_job.lease_owner <> p_worker
     or v_job.lease_sequence <> p_expected_attempt or v_job.lease_until <= now() then
    raise exception 'candidate generation job lease CAS failed' using errcode = '40001';
  end if;
  if v_transition.state <> 'staging'
     or v_transition.revision <> p_expected_transition_revision then
    raise exception 'candidate generation allocation CAS failed' using errcode = '40001';
  end if;
  select head.* into v_head from public.cloud_source_catalog_heads head
  where head.source_id = v_transition.old_source_id and head.user_id = p_user_id
  for update;
  if not found then raise exception 'source catalog head is missing' using errcode = '23503'; end if;
  insert into public.cloud_source_catalog_generations (
    id, user_id, source_id, transition_id, config_revision, state
  ) values (
    v_generation_id, p_user_id, v_transition.old_source_id,
    p_transition_id, v_transition.expected_source_revision, 'building'
  );
  insert into public.cloud_source_catalog_generation_episode_copy (
    generation_id, user_id, source_id, previous_generation_id
  ) values (
    v_generation_id, p_user_id, v_transition.old_source_id,
    v_head.active_generation_id
  );
  update public.cloud_source_credential_transition_jobs
  set catalog_generation_id = v_generation_id
  where id = p_job_id;
  update public.cloud_source_transitions
  set state = 'importing',
      candidate_catalog_generation_id = v_generation_id,
      previous_catalog_generation_id = v_head.active_generation_id
  where id = p_transition_id;
  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, transition_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, v_transition.old_source_id, p_transition_id,
    'credential_generation_allocated',
    'credential-transition:' || p_transition_id::text || ':generation-allocated',
    '{}'::jsonb, 'service_role'
  ) on conflict (user_id, idempotency_key) do nothing;
  return jsonb_build_object(
    'transitionId', p_transition_id,
    'generationId', v_generation_id,
    'generationRevision', 0,
    'transitionRevision', v_transition.revision + 1,
    'previousGenerationId', v_head.active_generation_id,
    'headRevision', v_head.head_revision
  );
end
$function$;

create or replace function public.norva_credential_strong_identity_signals(
  p_transition_id uuid,
  p_user_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_source_id uuid;
  v_generation_id uuid;
  v_current_identity uuid;
  v_candidate_identity uuid;
begin
  select transition.old_source_id, transition.candidate_catalog_generation_id
  into v_source_id, v_generation_id
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id;
  select link.identity_id into v_current_identity
  from public.catalog_source_provider_identities link
  join public.provider_identities identity on identity.id = link.identity_id
  where link.source_id = v_source_id and link.user_id = p_user_id
    and identity.status = 'active';
  with candidate_sample as (
    select array_agg(sample.external_id order by sample.external_id) as stream_sample
    from (
      select identity.external_id
      from (
        select distinct item.external_id
        from public.cloud_media_items item
        where item.generation_id = v_generation_id
          and item.item_type in ('movie', 'series')
          and coalesce(item.external_id, '') <> ''
      ) identity
      order by md5(identity.external_id)
      limit 256
    ) sample
  ), scored as (
    select identity.id,
      cardinality(array(
        select value from unnest(identity.stream_sample) value
        intersect select value from unnest(sample.stream_sample) value
      ))::numeric / nullif(cardinality(array(
        select value from unnest(identity.stream_sample) value
        union select value from unnest(sample.stream_sample) value
      )), 0) as score
    from candidate_sample sample
    join public.provider_identities identity
      on identity.status = 'active' and identity.stream_sample && sample.stream_sample
    where cardinality(sample.stream_sample) >= 32
  )
  select scored.id into v_candidate_identity
  from scored where scored.score >= 0.5
  order by scored.score desc, scored.id limit 1;
  return jsonb_build_object(
    'currentKnown', v_current_identity is not null,
    'candidateKnown', v_candidate_identity is not null,
    'match', v_current_identity is not null and v_candidate_identity = v_current_identity,
    'distinct', v_current_identity is not null and v_candidate_identity is not null
      and v_candidate_identity <> v_current_identity
  );
end
$function$;

create or replace function public.norva_get_credential_catalog_generation(
  p_transition_id uuid,
  p_user_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  perform public.norva_credential_require_service_role();
  select jsonb_build_object(
    'transitionId', transition.id,
    'transitionRevision', transition.revision,
    'generationId', generation.id,
    'generationState', upper(generation.state),
    'generationRevision', generation.revision,
    'configRevision', generation.config_revision,
    'manifestCounts', generation.manifest_counts,
    'manifestChecksum', generation.manifest_checksum,
    'identityEvidence', generation.identity_evidence,
    'strongIdentity', public.norva_credential_strong_identity_signals(
      transition.id, transition.user_id
    ),
    'gatewayCompleteAt', generation.gateway_complete_at,
    'headRevision', head.head_revision,
    'isActiveHead', head.active_generation_id = generation.id
  ) into v_result
  from public.cloud_source_transitions transition
  join public.cloud_source_catalog_generations generation
    on generation.id = transition.candidate_catalog_generation_id
   and generation.transition_id = transition.id
  join public.cloud_source_catalog_heads head
    on head.source_id = transition.old_source_id
   and head.user_id = transition.user_id
  where transition.id = p_transition_id and transition.user_id = p_user_id;
  if v_result is null then
    raise exception 'credential catalog generation not found' using errcode = 'P0002';
  end if;
  return v_result;
end
$function$;

create or replace function public.norva_get_source_catalog_head(
  p_user_id uuid,
  p_source_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  perform public.norva_credential_require_service_role();
  select jsonb_build_object(
    'sourceId', head.source_id,
    'activeGenerationId', head.active_generation_id,
    'headRevision', head.head_revision,
    'sourceRevision', lifecycle.config_revision,
    'generationState', upper(generation.state),
    'generationRevision', generation.revision
  ) into v_result
  from public.cloud_source_catalog_heads head
  join public.cloud_source_catalog_generations generation
    on generation.id = head.active_generation_id
   and generation.source_id = head.source_id
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id = head.source_id and lifecycle.user_id = head.user_id
  where head.source_id = p_source_id and head.user_id = p_user_id;
  if v_result is null then raise exception 'source catalog head not found' using errcode = 'P0002'; end if;
  return v_result;
end
$function$;

create or replace function public.norva_get_catalog_write_snapshot(
  p_source_id uuid,
  p_user_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  perform public.norva_credential_require_service_role();
  select jsonb_build_object(
    'generationId', head.active_generation_id,
    'headRevision', head.head_revision,
    'configRevision', lifecycle.config_revision,
    'sourceVisibilityEpoch', lifecycle.visibility_epoch,
    'userVisibilityEpoch', coalesce(epoch.visibility_epoch, 1),
    'isCatalogVisible', public.norva_source_catalog_visible_internal(
      head.source_id, head.user_id
    )
  ) into v_result
  from public.cloud_source_catalog_heads head
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id = head.source_id and lifecycle.user_id = head.user_id
  left join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id = head.user_id
  where head.source_id = p_source_id and head.user_id = p_user_id;
  if v_result is null then raise exception 'source catalog write snapshot not found' using errcode = 'P0002'; end if;
  return v_result;
end
$function$;

-- Physical rollups are generation-aware as well as lifecycle-aware.  A
-- BUILDING candidate variant must not mutate its title row through the legacy
-- rollup trigger: that UPDATE would otherwise re-enter the global mirror.
-- Legacy NULL generations remain readable only during expand; contract proves
-- that none remain before it removes the nullable representation.
create or replace function public.refresh_cloud_title_rollup(target_title_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  best_variant_id uuid;
  best_ttff integer;
  variant_total integer;
begin
  if target_title_id is null then return; end if;

  select variant.id, variant.last_observed_ttff_ms
    into best_variant_id, best_ttff
  from public.cloud_title_variants variant
  left join public.cloud_source_catalog_heads head
    on head.source_id = variant.source_id
   and head.user_id = variant.user_id
  where variant.title_id = target_title_id
    and public.norva_source_catalog_visible(variant.source_id, variant.user_id)
    and (
      variant.generation_id is null
      or head.active_generation_id = variant.generation_id
    )
  order by
    variant.playback_cost_score asc,
    variant.last_observed_ttff_ms asc nulls last,
    variant.created_at desc
  limit 1;

  select count(*)::integer into variant_total
  from public.cloud_title_variants variant
  left join public.cloud_source_catalog_heads head
    on head.source_id = variant.source_id
   and head.user_id = variant.user_id
  where variant.title_id = target_title_id
    and public.norva_source_catalog_visible(variant.source_id, variant.user_id)
    and (
      variant.generation_id is null
      or head.active_generation_id = variant.generation_id
    );

  update public.cloud_titles title
  set default_variant_id = best_variant_id,
      variant_count = coalesce(variant_total, 0),
      last_observed_ttff_ms = best_ttff,
      updated_at = now()
  where title.id = target_title_id
    -- Candidate-only titles start with an empty physical rollup.  Do not issue
    -- even a no-op UPDATE until a variant is active, because statement mirrors
    -- observe UPDATEs, not changed columns.
    and (
      coalesce(variant_total, 0) > 0
      or title.default_variant_id is not null
      or coalesce(title.variant_count, 0) <> 0
      or title.last_observed_ttff_ms is not null
    )
    and (title.default_variant_id, coalesce(title.variant_count, 0),
         title.last_observed_ttff_ms)
        is distinct from
        (best_variant_id, coalesce(variant_total, 0), best_ttff);
end
$function$;
revoke all on function public.refresh_cloud_title_rollup(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.refresh_cloud_title_rollup(uuid)
to service_role;

-- The legacy statement mirror writes a global overlay and self-thins
-- cloud_titles.  The transaction context below is defense-in-depth around the
-- bounded projector, while the intrinsic active-head/terminal-success proof is
-- authoritative for every caller and every rollup-trigger re-entry.
create or replace function public.cloud_titles_mirror_to_catalog()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context_text text := current_setting(
    'norva.catalog_candidate_title_write', true
  );
  v_context jsonb;
begin
  if coalesce(v_context_text, '') <> '' then
    begin
      v_context := v_context_text::jsonb;
    exception when others then
      raise exception 'candidate title mirror context is malformed'
        using errcode = '42501';
    end;
    perform public.norva_credential_require_service_role();
    if v_context ->> 'mode' = 'active_transition_projection' then
      if jsonb_typeof(v_context) <> 'object'
         or (select count(*) from jsonb_object_keys(v_context)) <> 9
         or not (v_context ?& array[
           'mode','userId','sourceId','generationId','headRevision',
           'configRevision','sourceVisibilityEpoch','userVisibilityEpoch',
           'refreshRunId'
         ])
         or not exists (
           select 1
           from public.cloud_source_catalog_generations generation
           join public.cloud_source_transitions transition
             on transition.id = generation.transition_id
            and transition.user_id = generation.user_id
           join public.cloud_source_catalog_heads head
             on head.source_id = generation.source_id
            and head.user_id = generation.user_id
            and head.active_generation_id = generation.id
           join public.cloud_source_lifecycle lifecycle
             on lifecycle.source_id = generation.source_id
            and lifecycle.user_id = generation.user_id
           left join public.cloud_user_catalog_visibility_epochs epoch
             on epoch.user_id = generation.user_id
           where generation.id = (v_context ->> 'generationId')::uuid
             and generation.user_id = (v_context ->> 'userId')::uuid
             and generation.source_id = (v_context ->> 'sourceId')::uuid
             and generation.state = 'active'
             and generation.title_projection_refresh_run_id =
               (v_context ->> 'refreshRunId')::uuid
             and transition.state in ('committing','completed')
             and head.head_revision = (v_context ->> 'headRevision')::bigint
             and lifecycle.config_revision =
               (v_context ->> 'configRevision')::bigint
             and lifecycle.visibility_epoch =
               (v_context ->> 'sourceVisibilityEpoch')::bigint
             and coalesce(epoch.visibility_epoch, 1) =
               (v_context ->> 'userVisibilityEpoch')::bigint
             and public.norva_source_catalog_visible_internal(
               generation.source_id, generation.user_id
             )
         ) then
        raise exception 'active transition title context is not current'
          using errcode = '40001',
            detail = 'reason=catalog_generation_changed';
      end if;
      -- The durable generation projection is the only payload authority.  A
      -- missing cloud_titles row is merely an FK shell and must not mirror or
      -- self-thin while it is being created under this verified context.
      return null;
    end if;
    if jsonb_typeof(v_context) <> 'object'
       or (select count(*) from jsonb_object_keys(v_context)) <> 6
       or not (v_context ?& array[
         'transitionId','userId','generationId','jobId','worker','leaseSequence'
       ])
       or not exists (
         select 1
         from public.cloud_source_credential_transition_jobs job
         join public.cloud_source_transitions transition
           on transition.id = job.transition_id
          and transition.user_id = job.user_id
         join public.cloud_source_catalog_generations generation
           on generation.id = job.catalog_generation_id
          and generation.user_id = job.user_id
          -- Credential candidates are built on A; replacement candidates are
          -- built on hidden B.  The leased job's source is the durable
          -- authority in both cases, whereas old_source_id is only A's
          -- lineage identity.
          and generation.source_id = job.source_id
         where transition.id = (v_context ->> 'transitionId')::uuid
           and transition.user_id = (v_context ->> 'userId')::uuid
           and transition.state = 'importing'
           and generation.id = (v_context ->> 'generationId')::uuid
           and generation.state = 'building'
           and job.id = (v_context ->> 'jobId')::uuid
           and job.job_kind = 'build_candidate_generation'
           and job.state = 'processing'
           and job.lease_owner = v_context ->> 'worker'
           and job.lease_sequence = (v_context ->> 'leaseSequence')::integer
           and job.lease_until > now()
       ) then
      raise exception 'candidate title mirror context is not lease-valid'
        using errcode = '42501';
    end if;
    return null;
  end if;

  insert into public.catalog_titles
    (item_type, provider_tmdb_id, title, original_title, release_year,
     poster_url, backdrop_url, metadata, enriched_at, updated_at)
  select distinct on (item_type, provider_tmdb_id)
    item_type, provider_tmdb_id, title, original_title, release_year,
    poster_url, backdrop_url, metadata, now(), now()
  from changed
  where provider_tmdb_id is not null
    and provider_tmdb_id <> ''
    and provider_tmdb_id !~ '^(tt)?0+$'
    and metadata is not null
    and metadata <> '{}'::jsonb
    and exists (
      select 1
      from public.cloud_title_variants variant
      left join public.cloud_source_catalog_heads head
        on head.source_id = variant.source_id
       and head.user_id = variant.user_id
      left join public.cloud_source_catalog_generations generation
        on generation.id = variant.generation_id
       and generation.source_id = variant.source_id
       and generation.user_id = variant.user_id
      left join public.cloud_source_transitions transition
        on transition.id = generation.transition_id
       and transition.user_id = generation.user_id
      where variant.title_id = changed.id
        and variant.user_id = changed.user_id
        and (
          (
            variant.generation_id is null
            and not exists (
              select 1
              from public.cloud_catalog_generation_rollout rollout
              where rollout.singleton and rollout.phase = 'contracted'
            )
          )
          or (
            head.active_generation_id = variant.generation_id
            and (
              generation.transition_id is null
              or transition.state = 'completed'
            )
          )
        )
    )
  order by item_type, provider_tmdb_id, updated_at desc nulls last
  on conflict (item_type, provider_tmdb_id) do update set
    title          = excluded.title,
    original_title = excluded.original_title,
    release_year   = excluded.release_year,
    poster_url     = excluded.poster_url,
    backdrop_url   = excluded.backdrop_url,
    metadata       = excluded.metadata,
    updated_at     = now();

  -- A normal projector inserts cloud_titles before its active variant.  The
  -- variant rollup then re-enters this statement trigger at depth 2; intrinsic
  -- eligibility above makes that path safe to thin.  The resulting metadata={}
  -- re-entry is depth 3 and is intentionally ignored.
  if pg_trigger_depth() <= 2 then
    update public.cloud_titles title
       set metadata = '{}'::jsonb
      from changed
     where title.id = changed.id
       and title.metadata <> '{}'::jsonb
       and changed.provider_tmdb_id is not null
       and changed.provider_tmdb_id <> ''
       and changed.provider_tmdb_id !~ '^(tt)?0+$'
       and exists (
         select 1
         from public.cloud_title_variants variant
         left join public.cloud_source_catalog_heads head
           on head.source_id = variant.source_id
          and head.user_id = variant.user_id
         left join public.cloud_source_catalog_generations generation
           on generation.id = variant.generation_id
          and generation.source_id = variant.source_id
          and generation.user_id = variant.user_id
         left join public.cloud_source_transitions transition
           on transition.id = generation.transition_id
          and transition.user_id = generation.user_id
         where variant.title_id = changed.id
           and variant.user_id = changed.user_id
           and (
             (
               variant.generation_id is null
               and not exists (
                 select 1
                 from public.cloud_catalog_generation_rollout rollout
                 where rollout.singleton and rollout.phase = 'contracted'
               )
             )
             or (
               head.active_generation_id = variant.generation_id
               and (
                 generation.transition_id is null
                 or transition.state = 'completed'
               )
             )
           )
       )
       and exists (
         select 1 from public.catalog_titles catalog
         where catalog.item_type = changed.item_type
           and catalog.provider_tmdb_id = changed.provider_tmdb_id
           and catalog.metadata is not null
           and catalog.metadata <> '{}'::jsonb
       );
  end if;
  return null;
end
$function$;
revoke all on function public.cloud_titles_mirror_to_catalog()
from public, anon, authenticated, service_role;

create or replace function public.norva_ensure_credential_generation_titles(
  p_transition_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_attempt integer,
  p_titles jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_count integer := 0;
  v_shell_count integer := 0;
  v_expected_count integer := 0;
  v_previous_context text := current_setting(
    'norva.catalog_candidate_title_write', true
  );
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  if p_titles is null or jsonb_typeof(p_titles) <> 'array'
     or jsonb_array_length(p_titles) > 200
     or octet_length(p_titles::text) > 1048576 then
    raise exception 'title batch is invalid or exceeds bounds' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_titles) item(value)
    where jsonb_typeof(item.value) <> 'object'
       or coalesce(item.value ->> 'item_type', '') not in ('movie', 'series')
       or nullif(btrim(item.value ->> 'identity_key'), '') is null
       or coalesce(item.value ->> 'identity_source', '') not in (
         'provider_tmdb', 'provider_imdb', 'normalized'
       )
       or coalesce(item.value ->> 'match_status', 'provider_unverified')
          not in (
            'provider_unverified', 'provider_verified', 'matched',
            'weak', 'unmatched', 'manual'
          )
       or nullif(btrim(item.value ->> 'title'), '') is null
       or (
         item.value ? 'metadata'
         and item.value -> 'metadata' <> 'null'::jsonb
         and jsonb_typeof(item.value -> 'metadata') <> 'object'
       )
  ) then
    raise exception 'candidate title payload contains an invalid row'
      using errcode = '22023';
  end if;
  select job.* into v_job from public.cloud_source_credential_transition_jobs job
  join public.cloud_source_transitions transition
    on transition.id = job.transition_id and transition.user_id = job.user_id
  join public.cloud_source_catalog_generations generation
    on generation.id = job.catalog_generation_id
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id and job.catalog_generation_id = p_generation_id
    and job.job_kind = 'build_candidate_generation'
    and job.state = 'processing' and job.lease_owner = p_worker
    and job.lease_sequence = p_expected_attempt and job.lease_until > now()
    and transition.state = 'importing' and generation.state = 'building'
  for share of job;
  if not found then raise exception 'candidate title batch lease CAS failed' using errcode = '40001'; end if;

  perform set_config(
    'norva.catalog_candidate_title_write',
    jsonb_build_object(
      'transitionId', p_transition_id,
      'userId', p_user_id,
      'generationId', p_generation_id,
      'jobId', p_job_id,
      'worker', p_worker,
      'leaseSequence', p_expected_attempt
    )::text,
    true
  );
  begin
    -- cloud_titles is only a stable FK shell.  The generation projection below
    -- always records the candidate payload, including when the shell already
    -- exists because another source or an abandoned generation created it.
    -- Consequently a later candidate C can never publish stale payload B.
    -- Statement 1 creates only missing shells and records exact ownership via
    -- INSERT RETURNING.  Statement 2 deliberately takes a fresh READ COMMITTED
    -- snapshot: if another writer won the unique-key race while this INSERT
    -- waited, its committed shell is then visible and still gets a projection.
    with input_rows as materialized (
      select distinct on (row.item_type, btrim(row.identity_key))
        row.item_type,
        btrim(row.identity_key) as identity_key,
        row.identity_source,
        row.provider_tmdb_id,
        row.provider_imdb_id,
        coalesce(row.match_status, 'provider_unverified') as match_status,
        btrim(row.title) as title,
        row.original_title,
        row.release_year,
        row.poster_url,
        row.backdrop_url,
        coalesce(row.metadata, '{}'::jsonb) as metadata
      from jsonb_array_elements(p_titles) with ordinality item(value, ordinal)
      cross join lateral jsonb_to_record(item.value) as row(
        item_type text, identity_key text, identity_source text,
        provider_tmdb_id text, provider_imdb_id text, match_status text,
        title text, original_title text, release_year integer,
        poster_url text, backdrop_url text, metadata jsonb
      )
      where row.item_type in ('movie', 'series')
        and nullif(btrim(row.identity_key), '') is not null
        and nullif(btrim(row.title), '') is not null
      order by row.item_type, btrim(row.identity_key), item.ordinal desc
    ), inserted_shells as (
      insert into public.cloud_titles (
        user_id, item_type, identity_key, identity_source,
        provider_tmdb_id, provider_imdb_id, match_status, title,
        original_title, release_year, poster_url, backdrop_url, metadata,
        candidate_shell_token
      )
      select
        p_user_id, input.item_type, input.identity_key,
        input.identity_source, input.provider_tmdb_id,
        input.provider_imdb_id, input.match_status, input.title,
        input.original_title, input.release_year, input.poster_url,
        input.backdrop_url, input.metadata, gen_random_uuid()
      from input_rows input
      on conflict (user_id, item_type, identity_key) do nothing
      returning id
    )
    select
      (select count(*)::integer from input_rows),
      (select count(*)::integer from inserted_shells)
    into v_expected_count, v_shell_count;

    with input_rows as materialized (
      select distinct on (row.item_type, btrim(row.identity_key))
        row.item_type,
        btrim(row.identity_key) as identity_key,
        row.identity_source,
        row.provider_tmdb_id,
        row.provider_imdb_id,
        coalesce(row.match_status, 'provider_unverified') as match_status,
        btrim(row.title) as title,
        row.original_title,
        row.release_year,
        row.poster_url,
        row.backdrop_url,
        coalesce(row.metadata, '{}'::jsonb) as metadata
      from jsonb_array_elements(p_titles) with ordinality item(value, ordinal)
      cross join lateral jsonb_to_record(item.value) as row(
        item_type text, identity_key text, identity_source text,
        provider_tmdb_id text, provider_imdb_id text, match_status text,
        title text, original_title text, release_year integer,
        poster_url text, backdrop_url text, metadata jsonb
      )
      where row.item_type in ('movie', 'series')
        and nullif(btrim(row.identity_key), '') is not null
        and nullif(btrim(row.title), '') is not null
      order by row.item_type, btrim(row.identity_key), item.ordinal desc
    ), resolved as materialized (
      select
        input.*, title.id as title_id,
        title.created_at as catalog_created_at,
        title.candidate_shell_token is not null as shell_created,
        title.candidate_shell_token as shell_token,
        case when input.metadata ? 'categoryName'
          then input.metadata ->> 'categoryName' else null end
          as genre_category,
        case when input.metadata #> '{tmdb,genres}' is not null
          then input.metadata #> '{tmdb,genres}' else null end
          as genre_payload,
        public.safe_numeric(input.metadata #>> '{tmdb,vote_average}')
          as rating_num
      from input_rows input
      join public.cloud_titles title
        on title.user_id = p_user_id
       and title.item_type = input.item_type
       and title.identity_key = input.identity_key
    ), upserted as (
      insert into public.cloud_source_catalog_generation_candidate_titles (
        generation_id, title_id, transition_id, user_id, source_id,
        item_type, identity_key, identity_source, provider_tmdb_id,
        provider_imdb_id, match_status, title, original_title, release_year,
        poster_url, backdrop_url, metadata, catalog_metadata,
        genre_category, genre_payload, genre_buckets, rating_num,
        synced_at, catalog_created_at, shell_created, shell_token
      )
      select
        p_generation_id, resolved.title_id, p_transition_id, p_user_id,
        v_job.source_id, resolved.item_type, resolved.identity_key,
        resolved.identity_source, resolved.provider_tmdb_id,
        resolved.provider_imdb_id, resolved.match_status, resolved.title,
        resolved.original_title, resolved.release_year, resolved.poster_url,
        resolved.backdrop_url,
        case
          -- Match the legacy active projector after its mirror/self-thin step.
          -- A projection is only readable once it owns a visible variant, so
          -- the remaining eligibility proof is exactly the provider id and
          -- non-empty provider payload below.
          when resolved.provider_tmdb_id is not null
            and resolved.provider_tmdb_id <> ''
            and resolved.provider_tmdb_id !~ '^(tt)?0+$'
            and resolved.metadata <> '{}'::jsonb
            then '{}'::jsonb
          else resolved.metadata
        end,
        resolved.metadata,
        resolved.genre_category, resolved.genre_payload,
        public.norva_classify_buckets(
          resolved.genre_category, resolved.genre_payload
        ), resolved.rating_num, clock_timestamp(),
        resolved.catalog_created_at, resolved.shell_created,
        resolved.shell_token
      from resolved
      on conflict (generation_id, item_type, identity_key) do update set
        identity_source = excluded.identity_source,
        provider_tmdb_id = excluded.provider_tmdb_id,
        provider_imdb_id = excluded.provider_imdb_id,
        match_status = excluded.match_status,
        title = excluded.title,
        original_title = excluded.original_title,
        release_year = excluded.release_year,
        poster_url = excluded.poster_url,
        backdrop_url = excluded.backdrop_url,
        metadata = excluded.metadata,
        catalog_metadata = excluded.catalog_metadata,
        genre_category = excluded.genre_category,
        genre_payload = excluded.genre_payload,
        genre_buckets = excluded.genre_buckets,
        rating_num = excluded.rating_num,
        synced_at = excluded.synced_at,
        catalog_created_at = excluded.catalog_created_at,
        shell_created =
          public.cloud_source_catalog_generation_candidate_titles.shell_created
          or excluded.shell_created,
        shell_token = case
          when public.cloud_source_catalog_generation_candidate_titles.shell_created
            then public.cloud_source_catalog_generation_candidate_titles.shell_token
          else excluded.shell_token
        end,
        updated_at = now()
      returning shell_created
    )
    select count(*)::integer into v_count from upserted;
    if v_count <> v_expected_count then
      raise exception 'candidate title shell visibility race; retry transaction'
        using errcode = '40001',
          detail = 'reason=candidate_title_shell_not_visible';
    end if;
  exception when others then
    perform set_config(
      'norva.catalog_candidate_title_write',
      coalesce(v_previous_context, ''), true
    );
    raise;
  end;
  perform set_config(
    'norva.catalog_candidate_title_write',
    coalesce(v_previous_context, ''), true
  );
  -- Existing global title metadata and rollups are intentionally never updated
  -- by a BUILDING generation. Newly inserted shells stay invisible until one
  -- of their generation-scoped variants becomes the active head, while the
  -- projection remains isolated and rollback-safe.
  return jsonb_build_object(
    'projectedTitles', v_count,
    'insertedTitleShells', v_shell_count,
    -- Keep the legacy key during the rolling caller window.
    'insertedTitles', v_shell_count,
    'batchSize', jsonb_array_length(p_titles)
  );
end
$function$;

-- A security-invoker catalogue view cannot read the private generation
-- projection table directly without exposing that table through PostgREST.
-- This narrow SECURITY DEFINER helper returns only a visible active-head title
-- payload and enforces the caller/user boundary itself.
create or replace function public.norva_visible_catalog_title_projection(
  p_title_id uuid,
  p_user_id uuid,
  p_generation_id uuid
) returns table (
  generation_id uuid,
  identity_source text,
  provider_tmdb_id text,
  provider_imdb_id text,
  match_status text,
  title text,
  original_title text,
  release_year integer,
  poster_url text,
  backdrop_url text,
  metadata jsonb,
  projected_at timestamptz
)
language sql
stable
rows 1
security definer
set search_path = ''
as $function$
  select
    projection.generation_id,
    projection.identity_source,
    projection.provider_tmdb_id,
    projection.provider_imdb_id,
    projection.match_status,
    projection.title,
    projection.original_title,
    projection.release_year,
    projection.poster_url,
    projection.backdrop_url,
    projection.metadata,
    projection.updated_at
  from public.cloud_source_catalog_generation_candidate_titles projection
  join public.cloud_source_catalog_heads head
    on head.source_id = projection.source_id
   and head.user_id = projection.user_id
   and head.active_generation_id = projection.generation_id
  where projection.title_id = p_title_id
    and projection.user_id = p_user_id
    and projection.generation_id = p_generation_id
    and public.norva_source_catalog_visible(
      projection.source_id, projection.user_id
    )
    and (
      session_user = 'postgres'
      or current_setting('request.jwt.claim.role', true) = 'service_role'
      or projection.user_id = (select auth.uid())
    )
  limit 1
$function$;
revoke all on function public.norva_visible_catalog_title_projection(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;

create or replace function public.norva_cloud_title_rollup_needs_refresh(
  p_title_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.cloud_titles title
    cross join lateral (
      select count(*)::integer as variant_count
      from public.cloud_title_variants variant
      left join public.cloud_source_catalog_heads head
        on head.source_id = variant.source_id
       and head.user_id = variant.user_id
      where variant.title_id = title.id
        and public.norva_source_catalog_visible(
          variant.source_id, variant.user_id
        )
        and (
          variant.generation_id is null
          or head.active_generation_id = variant.generation_id
        )
    ) expected
    left join lateral (
      select variant.id, variant.last_observed_ttff_ms
      from public.cloud_title_variants variant
      left join public.cloud_source_catalog_heads head
        on head.source_id = variant.source_id
       and head.user_id = variant.user_id
      where variant.title_id = title.id
        and public.norva_source_catalog_visible(
          variant.source_id, variant.user_id
        )
        and (
          variant.generation_id is null
          or head.active_generation_id = variant.generation_id
        )
      order by variant.playback_cost_score,
        variant.last_observed_ttff_ms nulls last,
        variant.created_at desc
      limit 1
    ) best on true
    where title.id = p_title_id
      and (
        title.metadata <> '{}'::jsonb
        or (title.default_variant_id, coalesce(title.variant_count, 0),
            title.last_observed_ttff_ms)
           is distinct from
           (best.id, expected.variant_count, best.last_observed_ttff_ms)
      )
  )
$function$;
revoke all on function public.norva_cloud_title_rollup_needs_refresh(uuid)
from public, anon, authenticated, service_role;

create or replace function public.norva_promote_credential_generation_titles_batch(
  p_generation_id uuid,
  p_user_id uuid,
  p_limit integer default 200
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_state public.cloud_source_catalog_generation_title_promotions%rowtype;
  v_generation_state text;
  v_transition_state text;
  v_is_active_head boolean := false;
  v_is_superseded boolean := false;
  v_processed integer := 0;
  v_complete boolean := false;
  v_title_ids uuid[] := '{}'::uuid[];
  v_new_cursor uuid;
  v_processed_total bigint;
begin
  perform public.norva_credential_require_service_role();
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'title promotion batch limit must be between 1 and 500'
      using errcode = '22023';
  end if;
  perform set_config('lock_timeout', '2s', true);
  if not pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'credential-title-promotion:' || p_generation_id::text, 0
    )
  ) then
    raise exception 'credential title promotion is already running'
      using errcode = '55P03';
  end if;

  select promotion.* into v_state
  from public.cloud_source_catalog_generation_title_promotions promotion
  join public.cloud_source_catalog_generations generation
    on generation.id = promotion.generation_id
   and generation.user_id = promotion.user_id
   and generation.source_id = promotion.source_id
  where promotion.generation_id = p_generation_id
    and promotion.user_id = p_user_id
  for update of promotion, generation;
  if not found then
    raise exception 'credential generation title promotion CAS failed'
      using errcode = '40001';
  end if;

  select generation.state, transition.state,
         exists (
           select 1
           from public.cloud_source_transitions successor
           join public.cloud_source_catalog_heads successor_head
             on successor_head.source_id = successor.old_source_id
            and successor_head.user_id = successor.user_id
           join public.cloud_source_catalog_generations successor_generation
             on successor_generation.id =
                successor_head.active_generation_id
            and successor_generation.source_id = successor.old_source_id
            and successor_generation.user_id = successor.user_id
            and successor_generation.state = 'active'
           where successor.previous_catalog_generation_id = generation.id
             and successor.old_source_id = generation.source_id
             and successor.user_id = generation.user_id
             and successor.state = 'completed'
             and successor_head.active_generation_id <> generation.id
         )
    into v_generation_state, v_transition_state, v_is_superseded
  from public.cloud_source_catalog_generations generation
  join public.cloud_source_transitions transition
    on transition.id = generation.transition_id
   and transition.user_id = generation.user_id
  where generation.id = p_generation_id
    and generation.user_id = p_user_id;
  if not found then
    raise exception 'credential generation title promotion CAS failed'
      using errcode = '40001';
  end if;
  if v_state.phase = 'complete' then
    return jsonb_build_object(
      'generationId', p_generation_id,
      'processedTitles', 0,
      'processedTitlesTotal', v_state.processed_titles,
      'titleCursor', v_state.title_cursor,
      'limit', p_limit,
      'complete', true
    );
  end if;

  select exists (
    select 1
    from public.cloud_source_catalog_heads head
    where head.source_id = v_state.source_id
      and head.user_id = v_state.user_id
      and head.active_generation_id = p_generation_id
  ) into v_is_active_head;

  -- A rapid A -> B -> C rotation may complete while B's durable promotion is
  -- still pending.  Once C is terminal-success and the head is C, publishing B
  -- would be stale work.  Mark that outbox complete without touching titles so
  -- its worker can settle normally while B's independent purge proceeds.
  if v_is_superseded
     and v_generation_state in ('purging', 'purged') then
    update public.cloud_source_catalog_generation_title_promotions promotion
    set phase = 'complete',
        started_at = coalesce(promotion.started_at, clock_timestamp()),
        completed_at = coalesce(promotion.completed_at, clock_timestamp()),
        updated_at = clock_timestamp()
    where promotion.generation_id = p_generation_id
    returning promotion.* into v_state;
    return jsonb_build_object(
      'generationId', p_generation_id,
      'processedTitles', 0,
      'processedTitlesTotal', v_state.processed_titles,
      'titleCursor', v_state.title_cursor,
      'limit', p_limit,
      'complete', true,
      'superseded', true
    );
  end if;

  -- COMMITTING is still compensable.  Publishing its title metadata would
  -- leak candidate B into the global overlay if post-switch verification
  -- restores A, so ordinary promotion is terminal-success and active-head
  -- only.
  if v_generation_state <> 'active'
     or v_transition_state <> 'completed'
     or not v_is_active_head then
    raise exception 'active credential generation title promotion CAS failed'
      using errcode = '40001';
  end if;

  with target_rows as materialized (
    select projection.*
    from public.cloud_source_catalog_generation_candidate_titles projection
    where projection.generation_id = p_generation_id
      and projection.user_id = p_user_id
      and projection.created_at <= v_state.snapshot_at
      and exists (
        select 1
        from public.cloud_title_variants variant
        where variant.generation_id = p_generation_id
          and variant.user_id = p_user_id
          and variant.source_id = v_state.source_id
          and variant.title_id = projection.title_id
      )
      and (
        v_state.title_cursor is null
        or projection.title_id > v_state.title_cursor
    )
    order by projection.title_id
    limit p_limit
    -- Projector/background writers lock the projection before publishing the
    -- corresponding catalog_titles row.  Use the same order so an older
    -- promotion page can never overwrite a concurrently-enriched payload.
    for update of projection
  ), mirrored as (
    insert into public.catalog_titles (
      item_type, provider_tmdb_id, title, original_title, release_year,
      poster_url, backdrop_url, metadata, enriched_at, updated_at
    )
    select distinct on (target.item_type, target.provider_tmdb_id)
      target.item_type,
      target.provider_tmdb_id,
      target.title,
      target.original_title,
      target.release_year,
      target.poster_url,
      target.backdrop_url,
      target.catalog_metadata,
      clock_timestamp(),
      clock_timestamp()
    from target_rows target
    where target.provider_tmdb_id is not null
      and target.provider_tmdb_id <> ''
      and target.provider_tmdb_id !~ '^(tt)?0+$'
      and target.catalog_metadata <> '{}'::jsonb
    order by target.item_type, target.provider_tmdb_id,
      target.updated_at desc, target.title_id
    on conflict (item_type, provider_tmdb_id) do update set
      title = excluded.title,
      original_title = excluded.original_title,
      release_year = excluded.release_year,
      poster_url = excluded.poster_url,
      backdrop_url = excluded.backdrop_url,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
    returning item_type, provider_tmdb_id
  ), mirror_barrier as (
    select count(*) as mirrored_count from mirrored
  )
  select coalesce(array_agg(target.title_id order by target.title_id), '{}'::uuid[])
    into v_title_ids
  from target_rows target
  cross join mirror_barrier;
  v_processed := cardinality(v_title_ids);

  -- PostgreSQL 15 has no max(uuid) aggregate.  The bounded array is already
  -- assembled in title_id order, but spell the cursor derivation explicitly
  -- so the postcondition remains correct if that aggregate changes later.
  select target.id into v_new_cursor
  from unnest(v_title_ids) target(id)
  order by target.id desc
  limit 1;
  v_complete := v_processed < p_limit;
  update public.cloud_source_catalog_generation_title_promotions promotion
  set title_cursor = coalesce(v_new_cursor, promotion.title_cursor),
      phase = case when v_complete then 'complete' else 'pending' end,
      processed_titles = promotion.processed_titles + v_processed,
      started_at = coalesce(promotion.started_at, clock_timestamp()),
      completed_at = case when v_complete then clock_timestamp() else null end,
      updated_at = clock_timestamp()
  where promotion.generation_id = p_generation_id
  returning promotion.processed_titles into v_processed_total;

  -- cloud_titles is a user/identity shell shared by every active source.  It can
  -- never hold B's generation payload without corrupting a simultaneous A-owned
  -- best variant.  The durable projection remains read authority for this
  -- generation even after the bounded global mirror completes.  Therefore this
  -- outbox completion changes no user-visible payload and must not bump the
  -- visibility epoch; head switch/restore already owns that linearization.

  return jsonb_build_object(
    'generationId', p_generation_id,
    'processedTitles', v_processed,
    'processedTitlesTotal', v_processed_total,
    'titleCursor', coalesce(v_new_cursor, v_state.title_cursor),
    'limit', p_limit,
    'complete', v_complete
  );
end
$function$;

create or replace function public.norva_requeue_credential_title_promotion(
  p_job_id uuid,
  p_user_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_retry_after_seconds integer default 1
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job public.cloud_source_credential_transition_jobs%rowtype;
begin
  perform public.norva_credential_require_service_role();
  if p_retry_after_seconds is null
     or p_retry_after_seconds < 0 or p_retry_after_seconds > 60 then
    raise exception 'title promotion retry delay is out of bounds'
      using errcode = '22023';
  end if;
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  join public.cloud_source_transitions transition
    on transition.id = job.transition_id
   and transition.user_id = job.user_id
  join public.cloud_source_catalog_generations generation
    on generation.id = job.catalog_generation_id
   and generation.user_id = job.user_id
   and generation.source_id = job.source_id
  where job.id = p_job_id
    and job.user_id = p_user_id
    and job.job_kind = 'promote_generation_titles'
    and job.state = 'processing'
    and job.lease_owner = p_worker
    and job.lease_sequence = p_expected_lease_sequence
    and job.lease_until > now()
    and transition.state = 'completed'
    and (
      (
        generation.state = 'active'
        and exists (
          select 1
          from public.cloud_source_catalog_heads head
          where head.source_id = job.source_id
            and head.user_id = job.user_id
            and head.active_generation_id = generation.id
        )
      )
      or (
        generation.state in ('purging', 'purged')
        and exists (
          select 1
          from public.cloud_source_transitions successor
          join public.cloud_source_catalog_heads successor_head
            on successor_head.source_id = successor.old_source_id
           and successor_head.user_id = successor.user_id
          join public.cloud_source_catalog_generations successor_generation
            on successor_generation.id =
               successor_head.active_generation_id
           and successor_generation.source_id = successor.old_source_id
           and successor_generation.user_id = successor.user_id
           and successor_generation.state = 'active'
          where successor.previous_catalog_generation_id = generation.id
            and successor.old_source_id = generation.source_id
            and successor.user_id = generation.user_id
            and successor.state = 'completed'
            and successor_head.active_generation_id <> generation.id
        )
      )
    )
  for update of job;
  if not found then
    raise exception 'title promotion requeue lease CAS failed'
      using errcode = '40001';
  end if;
  update public.cloud_source_credential_transition_jobs
  set state = 'pending',
      lease_owner = null,
      lease_until = null,
      checkpoint_revision = checkpoint_revision + 1,
      available_at = now() + make_interval(secs => p_retry_after_seconds)
  where id = p_job_id;
  return jsonb_build_object(
    'jobId', p_job_id,
    'state', 'PENDING',
    'leaseSequence', p_expected_lease_sequence,
    'checkpointRevision', v_job.checkpoint_revision + 1,
    'retryAfterSeconds', p_retry_after_seconds
  );
end
$function$;

create or replace function public.norva_requeue_credential_generation_purge(
  p_job_id uuid,
  p_user_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_retry_after_seconds integer default 1
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job public.cloud_source_credential_transition_jobs%rowtype;
begin
  perform public.norva_credential_require_service_role();
  if p_retry_after_seconds is null
     or p_retry_after_seconds < 0 or p_retry_after_seconds > 60 then
    raise exception 'generation purge retry delay is out of bounds'
      using errcode = '22023';
  end if;
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  join public.cloud_source_transitions transition
    on transition.id = job.transition_id
   and transition.user_id = job.user_id
  join public.cloud_source_catalog_generations generation
    on generation.id = job.catalog_generation_id
   and generation.user_id = job.user_id
   and generation.source_id = job.source_id
  where job.id = p_job_id
    and job.user_id = p_user_id
    and job.job_kind = 'purge_terminal_generation'
    and job.state = 'processing'
    and job.lease_owner = p_worker
    and job.lease_sequence = p_expected_lease_sequence
    and job.lease_until > now()
    and generation.state = 'purging'
    and (
      transition.state = 'failed'
      or (
        transition.state = 'cancelled'
        and exists (
          select 1
          from public.cloud_source_credential_transition_actions action
          where action.transition_id = transition.id
            and action.user_id = transition.user_id
            and action.action_kind = 'cancel'
          )
        )
      or (
        transition.state = 'completed'
        and transition.previous_catalog_generation_id = generation.id
        and exists (
          select 1
          from public.cloud_source_catalog_heads head
          join public.cloud_source_catalog_generations candidate
            on candidate.id = head.active_generation_id
           and candidate.source_id = head.source_id
           and candidate.user_id = head.user_id
           and candidate.state = 'active'
          where head.source_id = generation.source_id
            and head.user_id = generation.user_id
            and head.active_generation_id <> generation.id
        )
      )
    )
  for update of job;
  if not found then
    raise exception 'generation purge requeue lease CAS failed'
      using errcode = '40001';
  end if;
  update public.cloud_source_credential_transition_jobs
  set state = 'pending', lease_owner = null, lease_until = null,
      checkpoint_revision = checkpoint_revision + 1,
      available_at = now() + make_interval(secs => p_retry_after_seconds)
  where id = p_job_id;
  return jsonb_build_object(
    'jobId', p_job_id, 'state', 'PENDING',
    'leaseSequence', p_expected_lease_sequence,
    'checkpointRevision', v_job.checkpoint_revision + 1,
    'retryAfterSeconds', p_retry_after_seconds
  );
end
$function$;

create or replace function public.norva_register_credential_generation_categories(
  p_transition_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_category_kind text,
  p_categories jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_count integer;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  if p_category_kind not in ('live', 'vod', 'series')
     or p_categories is null or jsonb_typeof(p_categories) <> 'array'
     or jsonb_array_length(p_categories) > 500
     or octet_length(p_categories::text) > 524288 then
    raise exception 'category batch is invalid or exceeds bounds' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.cloud_source_credential_transition_jobs job
    join public.cloud_source_transitions transition
      on transition.id = job.transition_id and transition.user_id = job.user_id
    join public.cloud_source_catalog_generations generation
      on generation.id = job.catalog_generation_id
    where job.id = p_job_id and job.transition_id = p_transition_id
      and job.user_id = p_user_id and job.catalog_generation_id = p_generation_id
      and job.job_kind = 'build_candidate_generation'
      and job.state = 'processing' and job.lease_owner = p_worker
      and job.lease_sequence = p_expected_lease_sequence
      and job.lease_until > now() and transition.state = 'importing'
      and generation.state = 'building'
  ) then raise exception 'category registration lease CAS failed' using errcode = '40001'; end if;
  perform 1 from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id for update;
  with input as (
    select distinct on (row.provider_category_id)
      row.provider_category_id, row.category_name
    from jsonb_to_recordset(p_categories) row(
      category_ordinal integer, provider_category_id text, category_name text
    )
    order by row.provider_category_id
  ), numbered as (
    select input.*,
      coalesce((select max(category.category_ordinal) + 1
        from public.cloud_source_catalog_generation_categories category
        where category.generation_id = p_generation_id
          and category.category_kind = p_category_kind), 0)
      + row_number() over (order by input.provider_category_id) - 1 as category_ordinal
    from input
    where not exists (
      select 1 from public.cloud_source_catalog_generation_categories existing
      where existing.generation_id = p_generation_id
        and existing.category_kind = p_category_kind
        and existing.provider_category_id = input.provider_category_id
    )
  )
  insert into public.cloud_source_catalog_generation_categories (
    generation_id, user_id, source_id, category_kind,
    category_ordinal, provider_category_id, category_name
  )
  select p_generation_id, p_user_id, transition.old_source_id,
         p_category_kind, numbered.category_ordinal,
         numbered.provider_category_id, numbered.category_name
  from numbered
  cross join public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id
  on conflict (generation_id, category_kind, provider_category_id)
  do nothing;
  with input as (
    select distinct on (row.provider_category_id)
      row.provider_category_id, row.category_name
    from jsonb_to_recordset(p_categories) row(
      category_ordinal integer, provider_category_id text, category_name text
    ) order by row.provider_category_id
  )
  update public.cloud_source_catalog_generation_categories category
  set category_name = input.category_name, updated_at = now()
  from input
  where category.generation_id = p_generation_id
    and category.category_kind = p_category_kind
    and category.provider_category_id = input.provider_category_id
    and category.category_name is distinct from input.category_name;
  select count(distinct row.provider_category_id) into v_count
  from jsonb_to_recordset(p_categories) row(
    category_ordinal integer, provider_category_id text, category_name text
  );
  update public.cloud_source_catalog_generations
  set revision = revision + 1, updated_at = now()
  where id = p_generation_id and state = 'building';
  return jsonb_build_object(
    'generationId', p_generation_id,
    'categoryKind', upper(p_category_kind),
    'accepted', v_count
  );
end
$function$;

create or replace function public.norva_get_credential_generation_categories(
  p_transition_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_category_kind text,
  p_offset integer default 0,
  p_limit integer default 200
) returns table (
  category_ordinal integer,
  provider_category_id text,
  category_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform public.norva_credential_require_service_role();
  if p_category_kind not in ('live', 'vod', 'series')
     or p_offset < 0 or p_limit < 1 or p_limit > 500 then
    raise exception 'category page bounds are invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.cloud_source_catalog_generations generation
    where generation.id = p_generation_id and generation.transition_id = p_transition_id
      and generation.user_id = p_user_id
  ) then raise exception 'credential catalog generation not found' using errcode = 'P0002'; end if;
  return query
  select category.category_ordinal, category.provider_category_id,
         category.category_name
  from public.cloud_source_catalog_generation_categories category
  where category.generation_id = p_generation_id
    and category.category_kind = p_category_kind
  order by category.category_ordinal
  offset p_offset limit p_limit;
end
$function$;

create or replace function public.norva_mark_credential_category_list_complete(
  p_transition_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_category_kind text,
  p_expected_category_count integer
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actual_count integer;
  v_source_id uuid;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  if p_category_kind not in ('live', 'vod', 'series')
     or p_expected_category_count < 0 or p_expected_category_count > 1000000 then
    raise exception 'category listing proof is invalid' using errcode = '22023';
  end if;
  select transition.old_source_id into v_source_id
  from public.cloud_source_credential_transition_jobs job
  join public.cloud_source_transitions transition
    on transition.id = job.transition_id and transition.user_id = job.user_id
  join public.cloud_source_catalog_generations generation
    on generation.id = job.catalog_generation_id
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id and job.catalog_generation_id = p_generation_id
    and job.job_kind = 'build_candidate_generation'
    and job.state = 'processing' and job.lease_owner = p_worker
    and job.lease_sequence = p_expected_lease_sequence and job.lease_until > now()
    and transition.state = 'importing' and generation.state = 'building';
  if v_source_id is null then raise exception 'category listing lease CAS failed' using errcode = '40001'; end if;
  select count(*) into v_actual_count
  from public.cloud_source_catalog_generation_categories category
  where category.generation_id = p_generation_id
    and category.category_kind = p_category_kind;
  if v_actual_count <> p_expected_category_count then
    raise exception 'category listing count mismatch' using errcode = '22023';
  end if;
  insert into public.cloud_source_catalog_generation_category_lists (
    generation_id, user_id, source_id, category_kind,
    expected_category_count, listing_complete, completed_at
  ) values (
    p_generation_id, p_user_id, v_source_id, p_category_kind,
    p_expected_category_count, true, now()
  ) on conflict (generation_id, category_kind) do update
  set expected_category_count = excluded.expected_category_count,
      listing_complete = true, completed_at = coalesce(
        public.cloud_source_catalog_generation_category_lists.completed_at, now()
      );
  return jsonb_build_object(
    'generationId', p_generation_id,
    'categoryKind', upper(p_category_kind),
    'categoryCount', v_actual_count,
    'complete', true
  );
end
$function$;

create or replace function public.norva_mark_credential_parent_action_complete(
  p_transition_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_category_kind text,
  p_action text,
  p_staged_item_count bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_source_id uuid;
  v_actual_count bigint;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  if p_category_kind not in ('live', 'vod', 'series')
     or p_action <> (case p_category_kind
       when 'live' then 'get_live_streams'
       when 'vod' then 'get_vod_streams'
       else 'get_series' end)
     or p_staged_item_count is null or p_staged_item_count < 0 then
    raise exception 'inventory action proof is invalid' using errcode = '22023';
  end if;
  select generation.source_id into v_source_id
  from public.cloud_source_credential_transition_jobs job
  join public.cloud_source_transitions transition
    on transition.id = job.transition_id and transition.user_id = job.user_id
  join public.cloud_source_catalog_generations generation
    on generation.id = job.catalog_generation_id
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id and job.catalog_generation_id = p_generation_id
    and job.job_kind = 'build_candidate_generation'
    and job.state = 'processing' and job.lease_owner = p_worker
    and job.lease_sequence = p_expected_lease_sequence and job.lease_until > now()
    and transition.state = 'importing' and generation.state = 'building';
  if v_source_id is null then
    raise exception 'inventory action lease CAS failed' using errcode = '40001';
  end if;
  select count(*) into v_actual_count
  from public.cloud_media_items item
  where item.generation_id = p_generation_id
    and item.item_type = case p_category_kind when 'vod' then 'movie' else p_category_kind end;
  if v_actual_count <> p_staged_item_count then
    raise exception 'inventory action count mismatch' using errcode = '22023';
  end if;
  insert into public.cloud_source_catalog_generation_inventory_actions (
    generation_id, user_id, source_id, action_kind,
    staged_item_count, action_complete, completed_at
  ) values (
    p_generation_id, p_user_id, v_source_id, p_category_kind,
    p_staged_item_count, true, now()
  ) on conflict (generation_id, action_kind) do update
  set staged_item_count = excluded.staged_item_count,
      action_complete = true,
      completed_at = coalesce(
        public.cloud_source_catalog_generation_inventory_actions.completed_at, now()
      );
  return jsonb_build_object(
    'generationId', p_generation_id,
    'categoryKind', upper(p_category_kind),
    'action', p_action,
    'stagedItemCount', v_actual_count,
    'complete', true
  );
end
$function$;

create or replace function public.norva_mark_credential_category_slice_complete(
  p_transition_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_category_kind text,
  p_category_ordinal integer,
  p_staged_item_count integer
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  if p_category_kind not in ('live', 'vod', 'series')
     or p_category_ordinal < 0 or p_staged_item_count < 0 then
    raise exception 'category slice proof is invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.cloud_source_credential_transition_jobs job
    join public.cloud_source_transitions transition
      on transition.id = job.transition_id and transition.user_id = job.user_id
    join public.cloud_source_catalog_generations generation
      on generation.id = job.catalog_generation_id
    where job.id = p_job_id and job.transition_id = p_transition_id
      and job.user_id = p_user_id and job.catalog_generation_id = p_generation_id
      and job.job_kind = 'build_candidate_generation'
      and job.state = 'processing' and job.lease_owner = p_worker
      and job.lease_sequence = p_expected_lease_sequence and job.lease_until > now()
      and transition.state = 'importing' and generation.state = 'building'
  ) then raise exception 'category slice lease CAS failed' using errcode = '40001'; end if;
  update public.cloud_source_catalog_generation_categories category
  set streams_complete = true,
      staged_item_count = p_staged_item_count,
      completed_at = now(), updated_at = now()
  where category.generation_id = p_generation_id
    and category.category_kind = p_category_kind
    and category.category_ordinal = p_category_ordinal;
  if not found then raise exception 'registered category not found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'generationId', p_generation_id,
    'categoryKind', upper(p_category_kind),
    'categoryOrdinal', p_category_ordinal,
    'stagedItemCount', p_staged_item_count,
    'complete', true
  );
end
$function$;

create or replace function public.norva_copy_credential_generation_episode_state(
  p_transition_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_copy_revision bigint,
  p_limit integer default 200
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_copy public.cloud_source_catalog_generation_episode_copy%rowtype;
  v_members_processed integer := 0;
  v_members_inserted integer := 0;
  v_inventory_processed integer := 0;
  v_inventory_inserted integer := 0;
  v_candidate_variant public.cloud_title_variants%rowtype;
  v_membership public.catalog_series_episode_memberships%rowtype;
  v_inventory public.catalog_series_inventory_state%rowtype;
  v_members_done boolean;
  v_inventory_done boolean;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  if p_limit < 1 or p_limit > 500 then
    raise exception 'episode-state copy batch limit invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.cloud_source_credential_transition_jobs job
    join public.cloud_source_transitions transition
      on transition.id = job.transition_id and transition.user_id = job.user_id
    join public.cloud_source_catalog_generations generation
      on generation.id = job.catalog_generation_id
    where job.id = p_job_id and job.transition_id = p_transition_id
      and job.user_id = p_user_id and job.catalog_generation_id = p_generation_id
      and job.job_kind = 'build_candidate_generation'
      and job.state = 'processing' and job.lease_owner = p_worker
      and job.lease_sequence = p_expected_lease_sequence and job.lease_until > now()
      and transition.state = 'importing' and generation.state = 'building'
  ) then raise exception 'episode-state copy lease CAS failed' using errcode = '40001'; end if;
  select copy.* into v_copy
  from public.cloud_source_catalog_generation_episode_copy copy
  where copy.generation_id = p_generation_id for update;
  if not found or v_copy.state <> 'pending'
     or v_copy.revision <> p_expected_copy_revision then
    raise exception 'episode-state copy revision CAS failed' using errcode = '40001';
  end if;

  for v_membership in
    select membership.*
    from public.catalog_series_episode_memberships membership
    where membership.generation_id = v_copy.previous_generation_id
      and (membership.parent_series_id, membership.episode_id) > (
        coalesce(v_copy.membership_parent_cursor, ''),
        coalesce(v_copy.membership_episode_cursor, '')
      )
    order by membership.parent_series_id, membership.episode_id
    limit p_limit
  loop
    v_members_processed := v_members_processed + 1;
    v_copy.membership_parent_cursor := v_membership.parent_series_id;
    v_copy.membership_episode_cursor := v_membership.episode_id;
    select variant.* into v_candidate_variant
    from public.cloud_title_variants variant
    where variant.source_id = v_copy.source_id
      and variant.generation_id = p_generation_id
      and variant.item_type = 'series'
      and variant.external_id = v_membership.parent_series_id;
    if found then
      insert into public.catalog_series_episode_memberships (
        user_id, source_id, generation_id, provider_identity_id,
        parent_title_id, parent_variant_id, parent_item_type,
        parent_series_id, episode_id, container_extension,
        season_number, episode_number, payload_fingerprint,
        series_info_observed_at, created_at, updated_at,
        ingest_job_id, ingest_attempt, ingest_lease_owner
      ) values (
        p_user_id, v_copy.source_id, p_generation_id,
        v_membership.provider_identity_id, v_candidate_variant.title_id,
        v_candidate_variant.id, 'series', v_membership.parent_series_id,
        v_membership.episode_id, v_membership.container_extension,
        v_membership.season_number, v_membership.episode_number,
        v_membership.payload_fingerprint,
        v_membership.series_info_observed_at,
        v_membership.created_at, now(), p_job_id,
        p_expected_lease_sequence, p_worker
      ) on conflict do nothing;
      if found then v_members_inserted := v_members_inserted + 1; end if;
    end if;
  end loop;

  for v_inventory in
    select inventory.*
    from public.catalog_series_inventory_state inventory
    where inventory.generation_id = v_copy.previous_generation_id
      and inventory.parent_series_id > coalesce(v_copy.inventory_parent_cursor, '')
    order by inventory.parent_series_id
    limit p_limit
  loop
    v_inventory_processed := v_inventory_processed + 1;
    v_copy.inventory_parent_cursor := v_inventory.parent_series_id;
    select variant.* into v_candidate_variant
    from public.cloud_title_variants variant
    where variant.source_id = v_copy.source_id
      and variant.generation_id = p_generation_id
      and variant.item_type = 'series'
      and variant.external_id = v_inventory.parent_series_id;
    if found then
      insert into public.catalog_series_inventory_state (
        user_id, source_id, generation_id, provider_identity_id,
        parent_title_id, parent_variant_id, parent_item_type,
        parent_series_id, consecutive_failures, episode_count,
        last_attempted_at, last_succeeded_at, last_failed_at,
        next_retry_at, last_details, created_at, updated_at,
        ingest_job_id, ingest_attempt, ingest_lease_owner
      ) values (
        p_user_id, v_copy.source_id, p_generation_id,
        v_inventory.provider_identity_id, v_candidate_variant.title_id,
        v_candidate_variant.id, 'series', v_inventory.parent_series_id,
        v_inventory.consecutive_failures, v_inventory.episode_count,
        v_inventory.last_attempted_at, v_inventory.last_succeeded_at,
        v_inventory.last_failed_at, v_inventory.next_retry_at,
        v_inventory.last_details, v_inventory.created_at, now(),
        p_job_id, p_expected_lease_sequence, p_worker
      ) on conflict do nothing;
      if found then v_inventory_inserted := v_inventory_inserted + 1; end if;
    end if;
  end loop;

  v_members_done := not exists (
    select 1 from public.catalog_series_episode_memberships membership
    where membership.generation_id = v_copy.previous_generation_id
      and (membership.parent_series_id, membership.episode_id) > (
        coalesce(v_copy.membership_parent_cursor, ''),
        coalesce(v_copy.membership_episode_cursor, '')
      )
  );
  v_inventory_done := not exists (
    select 1 from public.catalog_series_inventory_state inventory
    where inventory.generation_id = v_copy.previous_generation_id
      and inventory.parent_series_id > coalesce(v_copy.inventory_parent_cursor, '')
  );
  update public.cloud_source_catalog_generation_episode_copy copy
  set membership_parent_cursor = v_copy.membership_parent_cursor,
      membership_episode_cursor = v_copy.membership_episode_cursor,
      inventory_parent_cursor = v_copy.inventory_parent_cursor,
      memberships_copied = copy.memberships_copied + v_members_inserted,
      inventory_rows_copied = copy.inventory_rows_copied + v_inventory_inserted,
      memberships_skipped = copy.memberships_skipped
        + (v_members_processed - v_members_inserted),
      inventory_rows_skipped = copy.inventory_rows_skipped
        + (v_inventory_processed - v_inventory_inserted),
      state = case when v_members_done and v_inventory_done then 'complete' else 'pending' end,
      completed_at = case when v_members_done and v_inventory_done then now() else null end,
      revision = copy.revision + 1, updated_at = now()
  where copy.generation_id = p_generation_id;
  return jsonb_build_object(
    'generationId', p_generation_id,
    'copyRevision', p_expected_copy_revision + 1,
    'membershipsProcessed', v_members_processed,
    'inventoryRowsProcessed', v_inventory_processed,
    'complete', v_members_done and v_inventory_done
  );
end
$function$;

create or replace function public.norva_compute_catalog_generation_manifest(
  p_generation_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_counts jsonb;
  v_checksum text;
  v_media_count bigint;
  v_variant_count bigint;
  v_channel_count bigint;
  v_live_variant_count bigint;
  v_membership_count bigint;
  v_inventory_count bigint;
  v_identity_evidence jsonb;
  v_identity_complete boolean;
  v_source_id uuid;
  v_user_id uuid;
begin
  select case
    when generation.transition_id is not null
      then generation.gateway_complete_at is not null
    else source.sync_status = 'ready' and source.last_synced_at is not null
  end, generation.source_id, generation.user_id
  into v_identity_complete, v_source_id, v_user_id
  from public.cloud_source_catalog_generations generation
  join public.cloud_sources source
    on source.id = generation.source_id and source.user_id = generation.user_id
  where generation.id = p_generation_id;
  if v_source_id is null then
    raise exception 'catalog generation not found' using errcode = 'P0002';
  end if;
  select count(*)
  into v_media_count
  from public.cloud_media_items item
  where item.source_id = v_source_id
    and item.user_id = v_user_id
    and item.generation_id = p_generation_id;
  select count(*) into v_variant_count from public.cloud_title_variants
  where source_id = v_source_id and user_id = v_user_id
    and generation_id = p_generation_id;
  select count(*) into v_channel_count from public.cloud_live_logical_channels
  where source_id = v_source_id and user_id = v_user_id
    and generation_id = p_generation_id;
  select count(*) into v_live_variant_count from public.cloud_live_variants
  where source_id = v_source_id and user_id = v_user_id
    and generation_id = p_generation_id;
  select count(*) into v_membership_count from public.catalog_series_episode_memberships
  where source_id = v_source_id and user_id = v_user_id
    and generation_id = p_generation_id;
  select count(*) into v_inventory_count from public.catalog_series_inventory_state
  where source_id = v_source_id and user_id = v_user_id
    and generation_id = p_generation_id;
  v_counts := jsonb_build_object(
    'mediaItems', v_media_count,
    'titleVariants', v_variant_count,
    'liveChannels', v_channel_count,
    'liveVariants', v_live_variant_count,
    'episodeMemberships', v_membership_count,
    'seriesInventory', v_inventory_count
  );
  -- Collision-resistant semantic manifest. Each logical row is SHA-256, then
  -- four independent signed 64-bit lanes are aggregated with both SUM and XOR
  -- plus an exact count before an outer SHA-256. This is constant-memory,
  -- order-independent and avoids both an unbounded sort/string_agg and the old
  -- single 64-bit commutative checksum. Operational UUIDs, local observations,
  -- timestamps, staged/enrichment metadata, playback hints, local health and
  -- presentation caches are deliberately excluded so two rebuilds of the same
  -- provider catalogue can compare equal. Stable provider-semantic coordinates
  -- are included in a deterministic table/key order.
  -- Readiness counts stay complete, but identity is rooted only in the raw
  -- provider inventory. Title/live materialisations, episode caches and their
  -- counts are parser/probe/version dependent and must not turn equivalent A/B
  -- inventories into a false AMBIGUOUS result.
  with row_hashes as materialized (
    select extensions.digest(jsonb_build_array(
      'media', item.item_type, item.external_id, item.parent_external_id,
      item.title
    )::text, 'sha256') as row_hash
    from public.cloud_media_items item
    where item.source_id = v_source_id
      and item.user_id = v_user_id
      and item.generation_id = p_generation_id
  ), lanes as (
    select
      ('x' || substr(encode(row_hash, 'hex'), 1, 16))::bit(64)::bigint as l0,
      ('x' || substr(encode(row_hash, 'hex'), 17, 16))::bit(64)::bigint as l1,
      ('x' || substr(encode(row_hash, 'hex'), 33, 16))::bit(64)::bigint as l2,
      ('x' || substr(encode(row_hash, 'hex'), 49, 16))::bit(64)::bigint as l3
    from row_hashes
  ), stats as (
    select count(*)::bigint as n,
      coalesce(sum(l0::numeric), 0)::text as s0,
      coalesce(bit_xor(l0), 0)::text as x0,
      coalesce(sum(l1::numeric), 0)::text as s1,
      coalesce(bit_xor(l1), 0)::text as x1,
      coalesce(sum(l2::numeric), 0)::text as s2,
      coalesce(bit_xor(l2), 0)::text as x2,
      coalesce(sum(l3::numeric), 0)::text as s3,
      coalesce(bit_xor(l3), 0)::text as x3
    from lanes
  )
  select encode(extensions.digest(jsonb_build_array(
    'norva-catalog-content-manifest-v2', stats.n,
    stats.s0, stats.x0, stats.s1, stats.x1,
    stats.s2, stats.x2, stats.s3, stats.x3
  )::text, 'sha256'), 'hex')
  into v_checksum
  from stats;
  select jsonb_build_object(
    'complete', coalesce(v_identity_complete, false),
    'sampleSize', count(*),
    'sample', coalesce(jsonb_agg(jsonb_build_object(
      'itemType', sample.item_type,
      'externalIdHash', sample.external_id_hash
    ) order by sample.order_hash, sample.item_type, sample.external_id_hash), '[]'::jsonb)
  ) into v_identity_evidence
  from (
    select identity.item_type,
           md5(identity.item_type || ':' || identity.external_id) as order_hash,
           encode(extensions.digest(
             identity.item_type || ':' || identity.external_id, 'sha256'
           ), 'hex') as external_id_hash
    from (
      select distinct item.item_type, item.external_id
      from public.cloud_media_items item
      where item.source_id = v_source_id
        and item.user_id = v_user_id
        and item.generation_id = p_generation_id
        and item.item_type in ('movie', 'series')
    ) identity
    order by
      md5(identity.item_type || ':' || identity.external_id),
      identity.item_type, identity.external_id
    limit 256
  ) sample;
  v_identity_evidence := v_identity_evidence || jsonb_build_object(
    'movieCount', (
      select count(*) from public.cloud_media_items
      where source_id = v_source_id and user_id = v_user_id
        and generation_id = p_generation_id and item_type = 'movie'
    ),
    'seriesCount', (
      select count(*) from public.cloud_media_items
      where source_id = v_source_id and user_id = v_user_id
        and generation_id = p_generation_id and item_type = 'series'
    ),
    'contentManifestChecksum', v_checksum
  );
  return jsonb_build_object(
    'counts', v_counts,
    'checksum', v_checksum,
    'identityEvidence', v_identity_evidence
  );
end
$function$;

create or replace function public.norva_get_active_catalog_identity_evidence(
  p_user_id uuid,
  p_source_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_generation_id uuid;
  v_manifest jsonb;
begin
  perform public.norva_credential_require_service_role();
  select head.active_generation_id into v_generation_id
  from public.cloud_source_catalog_heads head
  where head.source_id = p_source_id and head.user_id = p_user_id;
  if v_generation_id is null then
    raise exception 'active catalog generation not found' using errcode = 'P0002';
  end if;
  v_manifest := public.norva_compute_catalog_generation_manifest(v_generation_id);
  return jsonb_build_object(
    'sourceId', p_source_id,
    'generationId', v_generation_id,
    'identityEvidence', v_manifest -> 'identityEvidence'
  );
end
$function$;

create or replace function public.norva_preview_credential_catalog_manifest(
  p_transition_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_attempt integer
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_manifest jsonb;
begin
  perform public.norva_credential_require_service_role();
  if not exists (
    select 1
    from public.cloud_source_credential_transition_jobs job
    join public.cloud_source_transitions transition
      on transition.id = job.transition_id and transition.user_id = job.user_id
    join public.cloud_source_catalog_generations generation
      on generation.id = job.catalog_generation_id
    where job.id = p_job_id and job.transition_id = p_transition_id
      and job.user_id = p_user_id and job.catalog_generation_id = p_generation_id
      and job.job_kind = 'build_candidate_generation'
      and job.state = 'processing' and job.lease_owner = p_worker
      and job.lease_sequence = p_expected_attempt and job.lease_until > now()
      and transition.state = 'importing' and generation.state = 'building'
  ) then raise exception 'candidate manifest lease CAS failed' using errcode = '40001'; end if;
  v_manifest := public.norva_compute_catalog_generation_manifest(p_generation_id);
  return v_manifest || jsonb_build_object(
    'transitionId', p_transition_id,
    'generationId', p_generation_id,
    'generationRevision', (
      select revision from public.cloud_source_catalog_generations where id = p_generation_id
    )
  );
end
$function$;

create or replace function public.norva_seal_credential_catalog_generation(
  p_transition_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_attempt integer,
  p_expected_transition_revision bigint,
  p_expected_generation_revision bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_manifest jsonb;
  v_counts jsonb;
  v_checksum text;
  v_media_count bigint;
  v_variant_count bigint;
  v_channel_count bigint;
  v_live_variant_count bigint;
  v_membership_count bigint;
  v_inventory_count bigint;
  v_signature text;
begin
  perform public.norva_credential_require_service_role();
  select transition.* into v_transition from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id for update;
  select generation.* into v_generation from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id and generation.transition_id = p_transition_id
    and generation.user_id = p_user_id for update;
  if not found or v_transition.state <> 'importing'
     or v_transition.revision <> p_expected_transition_revision
     or v_generation.state <> 'building'
     or v_generation.revision <> p_expected_generation_revision then
    raise exception 'candidate generation seal CAS failed' using errcode = '40001';
  end if;
  if v_transition.transition_kind = 'credential' then
    perform public.norva_credential_require_enabled();
  elsif v_transition.transition_kind = 'replacement' then
    perform public.norva_replacement_require_enabled();
  else
    raise exception 'candidate generation has an unsupported transition kind'
      using errcode = '23514';
  end if;
  select job.* into v_job from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id and job.catalog_generation_id = p_generation_id
  for update;
  if not found or v_job.job_kind <> 'build_candidate_generation'
     or v_job.state <> 'processing' or v_job.lease_owner <> p_worker
     or v_job.lease_sequence <> p_expected_attempt or v_job.lease_until <= now() then
    raise exception 'candidate generation seal lease CAS failed' using errcode = '40001';
  end if;
  if coalesce(v_job.progress ->> 'action','') <> 'complete'
     or coalesce((v_job.progress ->> 'categoriesDone')::boolean, false) is not true
     or (
       select count(*)
       from public.cloud_source_catalog_generation_category_lists list
       where list.generation_id = p_generation_id and list.listing_complete
     ) <> 3
     or (
       select count(*)
       from public.cloud_source_catalog_generation_inventory_actions action
       where action.generation_id = p_generation_id and action.action_complete
     ) <> 3
     or exists (
       select 1
       from public.cloud_source_catalog_generation_inventory_actions action
       where action.generation_id = p_generation_id
         and action.staged_item_count <> (
           select count(*)
           from public.cloud_media_items item
           where item.generation_id = p_generation_id
             and item.item_type = case action.action_kind
               when 'vod' then 'movie' else action.action_kind end
         )
     )
     or not exists (
       select 1
       from public.cloud_source_catalog_generation_episode_copy copy
       where copy.generation_id = p_generation_id and copy.state = 'complete'
     ) then
    raise exception 'candidate generation completeness ledger is incomplete'
      using errcode = '55000';
  end if;
  v_manifest := public.norva_compute_catalog_generation_manifest(p_generation_id);
  v_manifest := jsonb_set(v_manifest, '{identityEvidence,complete}', 'true'::jsonb);
  v_counts := v_manifest -> 'counts';
  v_checksum := v_manifest ->> 'checksum';
  update public.cloud_source_catalog_generations
  set state = 'ready', manifest_counts = v_counts,
      manifest_checksum = v_checksum,
      identity_evidence = v_manifest -> 'identityEvidence',
      gateway_complete_at = now(),
      ready_at = now(), revision = revision + 1, updated_at = now()
  where id = p_generation_id;
  update public.cloud_source_credential_transition_jobs
  set state = 'pending', lease_owner = null, lease_until = null,
      available_at = now(), completed_at = null, last_error_code = null
  where id = p_job_id;
  return jsonb_build_object(
    'transitionId', p_transition_id,
    'generationId', p_generation_id,
    'generationState', 'READY',
    'generationRevision', p_expected_generation_revision + 1,
    'manifestCounts', v_counts,
    'manifestChecksum', v_checksum
  );
end
$function$;

create or replace function public.norva_mark_credential_transition_ready(
  p_transition_id uuid,
  p_user_id uuid,
  p_readiness_check_id uuid,
  p_expected_transition_revision bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  if p_readiness_check_id is null then
    raise exception 'readiness proof is required' using errcode = '22004';
  end if;
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id
  for update;
  if not found then raise exception 'credential transition not found' using errcode = 'P0002'; end if;
  if v_transition.state <> 'importing'
     or v_transition.identity_decision <> 'same_catalog'
     or v_transition.revision <> p_expected_transition_revision then
    raise exception 'credential readiness CAS failed or identity is not SAME_CATALOG'
      using errcode = '40001';
  end if;
  if not exists (
    select 1 from public.cloud_source_identity_assessments assessment
    where assessment.transition_id = p_transition_id
      and assessment.user_id = p_user_id
      and assessment.final_decision = 'same_catalog'
      and assessment.decided_at is not null
  ) then
    raise exception 'final SAME_CATALOG assessment is required' using errcode = '55000';
  end if;
  select generation.* into v_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.candidate_catalog_generation_id
    and generation.transition_id = p_transition_id
    and generation.user_id = p_user_id;
  if not found or v_generation.state <> 'ready'
     or v_generation.gateway_complete_at is null
     or v_generation.manifest_checksum is null then
    raise exception 'complete sealed candidate generation is required'
      using errcode = '55000';
  end if;
  update public.cloud_source_transitions
  set state = 'ready_to_switch',
      readiness_check_id = p_readiness_check_id,
      readiness_passed_at = now()
  where id = p_transition_id;

  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, transition_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, v_transition.old_source_id, p_transition_id,
    'credential_transition_ready',
    'credential-transition:' || p_transition_id::text || ':ready',
    '{}'::jsonb, 'service_role'
  ) on conflict (user_id, idempotency_key) do nothing;
  return public.norva_credential_transition_result(p_transition_id, p_user_id);
end
$function$;

create or replace function public.norva_begin_credential_swap(
  p_transition_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_expected_generation_revision bigint,
  p_expected_transition_revision bigint,
  p_expected_source_revision bigint,
  p_expected_head_revision bigint,
  p_idempotency_key text,
  p_request_fingerprint text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_lifecycle public.cloud_source_lifecycle%rowtype;
  v_secret public.cloud_source_transition_secrets%rowtype;
  v_head public.cloud_source_catalog_heads%rowtype;
  v_candidate_generation public.cloud_source_catalog_generations%rowtype;
  v_previous_generation public.cloud_source_catalog_generations%rowtype;
  v_action public.cloud_source_credential_transition_actions%rowtype;
  v_result jsonb;
  v_visibility_epoch bigint;
  v_active_refresh_ready boolean := false;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
     or length(p_idempotency_key) > 200
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'valid action idempotency key and fingerprint are required'
      using errcode = '22023';
  end if;
  perform public.norva_credential_lock_account(p_user_id);
  select action.* into v_action
  from public.cloud_source_credential_transition_actions action
  where action.user_id = p_user_id
    and action.idempotency_key = p_idempotency_key
  for share;
  if found then
    if v_action.transition_id = p_transition_id
       and v_action.action_kind = 'begin_swap'
       and v_action.request_fingerprint = p_request_fingerprint then
      return public.norva_credential_action_result(v_action.id);
    end if;
    raise exception 'action idempotency key reused with different request'
      using errcode = '22023';
  end if;
  -- A flag can remain ON after the v3 worker has rolled back or stopped
  -- heartbeating.  Fence every new cutover at the operational capability,
  -- while still allowing a previously committed idempotent action to replay.
  if pg_catalog.to_regprocedure(
       'public.norva_active_catalog_refresh_contract_ready()'
     ) is not null then
    execute 'select public.norva_active_catalog_refresh_contract_ready()'
    into v_active_refresh_ready;
  end if;
  if not coalesce(v_active_refresh_ready,false) then
    raise exception 'active catalog refresh worker v3 is not ready'
      using errcode = '55000',
        detail = 'reason=active_catalog_refresh_worker_v3_not_ready';
  end if;
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id
  for update;
  if not found then raise exception 'credential transition not found' using errcode = 'P0002'; end if;

  perform 1 from public.cloud_sources source
  where source.id = v_transition.old_source_id and source.user_id = p_user_id
  for update;
  select lifecycle.* into v_lifecycle
  from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id = v_transition.old_source_id and lifecycle.user_id = p_user_id
  for update;
  select secret.* into v_secret
  from public.cloud_source_transition_secrets secret
  where secret.transition_id = p_transition_id and secret.user_id = p_user_id
  for update;
  select head.* into v_head from public.cloud_source_catalog_heads head
  where head.source_id = v_transition.old_source_id and head.user_id = p_user_id
  for update;
  select generation.* into v_candidate_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id and generation.transition_id = p_transition_id
    and generation.user_id = p_user_id for update;
  select generation.* into v_previous_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.previous_catalog_generation_id
    and generation.source_id = v_transition.old_source_id for update;

  if v_transition.state <> 'ready_to_switch'
     or v_transition.identity_decision <> 'same_catalog'
     or v_transition.revision <> p_expected_transition_revision
     or v_transition.expected_source_revision <> p_expected_source_revision
     or v_lifecycle.config_revision <> p_expected_source_revision
     or v_secret.cleared_at is not null
     or v_transition.candidate_catalog_generation_id <> p_generation_id
     or v_candidate_generation.state <> 'ready'
     or v_candidate_generation.revision <> p_expected_generation_revision
     or v_candidate_generation.gateway_complete_at is null
     or v_head.head_revision <> p_expected_head_revision
     or v_head.active_generation_id <> v_transition.previous_catalog_generation_id
     or v_previous_generation.state <> 'active' then
    raise exception 'credential swap CAS failed' using errcode = '40001';
  end if;

  update public.cloud_source_transitions
  set state = 'committing'
  where id = p_transition_id;
  update public.cloud_sources source
  set config_ciphertext = v_secret.candidate_config_ciphertext,
      config_hint = v_secret.candidate_config_hint,
      updated_at = now()
  where source.id = v_transition.old_source_id and source.user_id = p_user_id;
  update public.cloud_source_catalog_generations
  set state = 'retained', retained_at = now(), updated_at = now()
  where id = v_previous_generation.id;
  update public.cloud_source_catalog_generations
  set state = 'active', activated_at = now(),
      config_revision = p_expected_source_revision + 1,
      revision = revision + 1, updated_at = now()
  where id = p_generation_id;
  update public.cloud_source_catalog_heads
  set active_generation_id = p_generation_id,
      head_revision = head_revision + 1, updated_at = now()
  where source_id = v_transition.old_source_id and user_id = p_user_id;
  v_visibility_epoch := public.norva_bump_user_catalog_visibility_epoch(p_user_id);
  update public.cloud_source_lifecycle
  set visibility_epoch = v_visibility_epoch, updated_at = now()
  where source_id = v_transition.old_source_id and user_id = p_user_id;
  delete from public.cloud_catalog_facet_summary where user_id = p_user_id;
  update public.cloud_source_transition_secrets secret
  set swap_applied_at = now()
  where secret.transition_id = p_transition_id;
  insert into public.cloud_source_credential_transition_jobs (
    user_id, transition_id, source_id, catalog_generation_id,
    expected_source_revision, job_kind
  ) values (
    p_user_id, p_transition_id, v_transition.old_source_id,
    p_generation_id, p_expected_source_revision + 1, 'post_switch_verify'
  ) on conflict (transition_id, job_kind)
    where state in ('pending', 'processing') do nothing;
  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, transition_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, v_transition.old_source_id, p_transition_id,
    'credential_swap_started',
    'credential-transition:' || p_transition_id::text || ':swap-started',
    jsonb_build_object(
      'sourceRevision', p_expected_source_revision + 1,
      'headRevision', p_expected_head_revision + 1,
      'visibilityEpoch', v_visibility_epoch
    ),
    'service_role'
  ) on conflict (user_id, idempotency_key) do nothing;
  v_result := public.norva_credential_transition_result(p_transition_id, p_user_id);
  insert into public.cloud_source_credential_transition_actions (
    user_id, transition_id, action_kind, idempotency_key,
    request_fingerprint, result_state, result_revision,
    result_identity_decision, result_payload
  ) values (
    p_user_id, p_transition_id, 'begin_swap', p_idempotency_key,
    p_request_fingerprint, 'committing', (v_result ->> 'revision')::bigint,
    'same_catalog', v_result
  );
  return v_result || jsonb_build_object('replayed', false);
end
$function$;

create or replace function public.norva_complete_credential_transition(
  p_transition_id uuid,
  p_user_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_transition_revision bigint,
  p_expected_head_revision bigint,
  p_refresh_proof_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_secret public.cloud_source_transition_secrets%rowtype;
  v_lifecycle public.cloud_source_lifecycle%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_head public.cloud_source_catalog_heads%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_previous_generation public.cloud_source_catalog_generations%rowtype;
  v_config text;
begin
  perform public.norva_credential_require_service_role();
  if p_refresh_proof_id is null then raise exception 'refresh proof is required' using errcode = '22004'; end if;
  perform public.norva_credential_lock_account(p_user_id);
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id
  for update;
  if not found then raise exception 'credential transition not found' using errcode = 'P0002'; end if;
  select secret.* into v_secret from public.cloud_source_transition_secrets secret
  where secret.transition_id = p_transition_id and secret.user_id = p_user_id for update;
  select source.config_ciphertext into v_config from public.cloud_sources source
  where source.id = v_transition.old_source_id and source.user_id = p_user_id for update;
  select lifecycle.* into v_lifecycle from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id = v_transition.old_source_id and lifecycle.user_id = p_user_id for update;
  select job.* into v_job from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id for update;
  select head.* into v_head from public.cloud_source_catalog_heads head
  where head.source_id = v_transition.old_source_id and head.user_id = p_user_id for update;
  select generation.* into v_generation from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.candidate_catalog_generation_id for update;
  if v_transition.state <> 'committing'
     or v_transition.revision <> p_expected_transition_revision
     or v_secret.swap_applied_at is null
     or v_secret.compensation_started_at is not null
     or v_config is distinct from v_secret.candidate_config_ciphertext
     or v_lifecycle.config_revision <> v_transition.expected_source_revision + 1
     or v_job.job_kind <> 'post_switch_verify'
     or v_job.catalog_generation_id <> v_generation.id
     or v_job.state <> 'processing' or v_job.lease_owner <> p_worker
     or v_job.lease_sequence <> p_expected_lease_sequence
     or v_job.lease_until <= now()
     or v_head.head_revision <> p_expected_head_revision
     or v_head.active_generation_id <> v_generation.id
     or v_generation.state <> 'active'
     or v_generation.gateway_complete_at is null
     or v_generation.title_projection_refresh_run_id is null
     or p_refresh_proof_id is distinct from
        v_generation.title_projection_refresh_run_id
     or v_generation.title_projection_inventory_completed_at is null
     or v_generation.title_projection_refreshed_at is null
     or v_generation.title_projection_refreshed_at < v_secret.swap_applied_at
     or not public.norva_active_catalog_refresh_proof_is_current(
       v_transition.old_source_id,p_user_id,v_generation.id,
       v_generation.title_projection_refresh_run_id,p_job_id
     )
     or exists (
       select 1
       from public.cloud_source_catalog_generation_candidate_titles projection
       where projection.generation_id = v_generation.id
         and not projection.post_switch_refreshed
         and exists (
           select 1
           from public.cloud_title_variants variant
           where variant.generation_id = v_generation.id
             and variant.user_id = p_user_id
             and variant.source_id = v_transition.old_source_id
             and variant.title_id = projection.title_id
         )
       limit 1
     ) then
    raise exception 'healthy candidate completion CAS failed' using errcode = '40001';
  end if;
  update public.cloud_source_transition_secrets
  set candidate_refresh_proof_id = p_refresh_proof_id,
      candidate_refresh_healthy_at = now()
  where transition_id = p_transition_id;
  update public.cloud_source_transitions set state = 'completed'
  where id = p_transition_id
  returning * into v_transition;
  insert into public.cloud_source_catalog_generation_title_promotions (
    generation_id, user_id, source_id, snapshot_at
  ) values (
    v_generation.id, p_user_id, v_transition.old_source_id,
    v_transition.completed_at
  );
  -- The first healthy refresh is the retention boundary from the rollout
  -- contract.  Clear both A/B ciphertexts and sanitized hints in the same
  -- terminal transaction; title promotion never needs credential material.
  perform set_config('norva.credential_secret_clear', 'on', true);
  update public.cloud_source_transition_secrets secret
  set candidate_config_ciphertext = null,
      previous_config_ciphertext = null,
      candidate_config_hint = null,
      previous_config_hint = null,
      cleared_at = coalesce(secret.cleared_at, now())
  where secret.transition_id = p_transition_id
    and secret.user_id = p_user_id;
  perform set_config('norva.credential_secret_clear', 'off', true);
  -- Terminal completion atomically turns the verified job into a durable,
  -- independently retryable title-promotion outbox.  The user request never
  -- loops over the catalogue and a worker can process bounded 1..500 batches.
  update public.cloud_source_credential_transition_jobs
  set job_kind = 'promote_generation_titles',
      state = 'pending',
      lease_owner = null,
      lease_until = null,
      attempt_count = 0,
      checkpoint_revision = checkpoint_revision + 1,
      available_at = now(),
      completed_at = null,
      dead_at = null,
      last_error_code = null
  where id = p_job_id;
  -- Once B has a healthy terminal refresh, A is no longer compensable because
  -- its ciphertext was cleared above.  Retaining its complete physical
  -- catalogue would accumulate one full hidden generation per rotation, so a
  -- second v2-only outbox purges it independently in bounded batches.
  update public.cloud_source_catalog_generations generation
  set state = 'purging', revision = generation.revision + 1,
      updated_at = now()
  where generation.id = v_transition.previous_catalog_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = v_transition.old_source_id
    and generation.state = 'retained'
  returning generation.* into v_previous_generation;
  if not found then
    raise exception 'previous catalog generation retention CAS failed'
      using errcode = '40001';
  end if;
  insert into public.cloud_source_credential_transition_jobs (
    user_id, transition_id, source_id, catalog_generation_id,
    expected_source_revision, job_kind, max_attempts
  ) values (
    p_user_id, p_transition_id, v_transition.old_source_id,
    v_previous_generation.id, v_transition.expected_source_revision,
    'purge_terminal_generation', 25
  );
  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, transition_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, v_transition.old_source_id, p_transition_id,
    'credential_transition_completed',
    'credential-transition:' || p_transition_id::text || ':completed',
    '{}'::jsonb, 'service_role'
  ) on conflict (user_id, idempotency_key) do nothing;
  return public.norva_credential_transition_result(p_transition_id, p_user_id);
end
$function$;

create or replace function public.norva_restore_previous_credential_config(
  p_transition_id uuid,
  p_user_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_transition_revision bigint,
  p_expected_source_revision bigint,
  p_expected_head_revision bigint,
  p_reason_code text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_secret public.cloud_source_transition_secrets%rowtype;
  v_lifecycle public.cloud_source_lifecycle%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_head public.cloud_source_catalog_heads%rowtype;
  v_candidate_generation public.cloud_source_catalog_generations%rowtype;
  v_previous_generation public.cloud_source_catalog_generations%rowtype;
  v_visibility_epoch bigint;
  v_config text;
begin
  perform public.norva_credential_require_service_role();
  if p_reason_code not in (
    'candidate_refresh_failed', 'candidate_auth_rejected',
    'candidate_catalog_unhealthy', 'operator_requested'
  ) then raise exception 'invalid compensation reason' using errcode = '22023'; end if;
  perform public.norva_credential_lock_account(p_user_id);
  select transition.* into v_transition from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id for update;
  if not found then raise exception 'credential transition not found' using errcode = 'P0002'; end if;
  select secret.* into v_secret from public.cloud_source_transition_secrets secret
  where secret.transition_id = p_transition_id and secret.user_id = p_user_id for update;
  select source.config_ciphertext into v_config from public.cloud_sources source
  where source.id = v_transition.old_source_id and source.user_id = p_user_id for update;
  select lifecycle.* into v_lifecycle from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id = v_transition.old_source_id and lifecycle.user_id = p_user_id for update;
  select job.* into v_job from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id for update;
  select head.* into v_head from public.cloud_source_catalog_heads head
  where head.source_id = v_transition.old_source_id and head.user_id = p_user_id for update;
  select generation.* into v_candidate_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.candidate_catalog_generation_id for update;
  select generation.* into v_previous_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.previous_catalog_generation_id for update;
  if v_transition.state <> 'committing'
     or v_transition.revision <> p_expected_transition_revision
     or v_lifecycle.config_revision <> p_expected_source_revision
     or p_expected_source_revision <> v_transition.expected_source_revision + 1
     or v_config is distinct from v_secret.candidate_config_ciphertext
     or v_secret.compensation_started_at is not null
     or v_job.job_kind <> 'post_switch_verify'
     or v_job.state <> 'processing' or v_job.lease_owner <> p_worker
     or v_job.lease_sequence <> p_expected_lease_sequence
     or v_job.lease_until <= now()
     or v_head.head_revision <> p_expected_head_revision
     or v_head.active_generation_id <> v_candidate_generation.id
     or v_candidate_generation.state <> 'active'
     or v_previous_generation.state <> 'retained' then
    raise exception 'credential compensation CAS failed' using errcode = '40001';
  end if;
  update public.cloud_sources source
  set config_ciphertext = v_secret.previous_config_ciphertext,
      config_hint = v_secret.previous_config_hint,
      updated_at = now()
  where source.id = v_transition.old_source_id and source.user_id = p_user_id;
  update public.cloud_source_catalog_generations
  set state = 'retained', retained_at = coalesce(retained_at, now()),
      updated_at = now()
  where id = v_candidate_generation.id;
  update public.cloud_source_catalog_generations
  set state = 'active', activated_at = now(), retained_at = null,
      config_revision = v_transition.expected_source_revision + 2,
      revision = revision + 1, updated_at = now()
  where id = v_previous_generation.id;
  update public.cloud_source_catalog_heads
  set active_generation_id = v_previous_generation.id,
      head_revision = head_revision + 1, updated_at = now()
  where source_id = v_transition.old_source_id and user_id = p_user_id;
  v_visibility_epoch := public.norva_bump_user_catalog_visibility_epoch(p_user_id);
  update public.cloud_source_lifecycle
  set visibility_epoch = v_visibility_epoch, updated_at = now()
  where source_id = v_transition.old_source_id and user_id = p_user_id;
  delete from public.cloud_catalog_facet_summary where user_id = p_user_id;
  update public.cloud_source_transition_secrets
  set compensation_started_at = now(),
      compensation_reason_code = p_reason_code,
      previous_config_restored_at = now()
  where transition_id = p_transition_id;
  update public.cloud_source_credential_transition_jobs
  set state = 'dead', lease_owner = null, lease_until = null,
      dead_at = now(), last_error_code = 'catalog_unhealthy'
  where id = p_job_id;
  insert into public.cloud_source_credential_transition_jobs (
    user_id, transition_id, source_id, catalog_generation_id,
    expected_source_revision, job_kind
  ) values (
    p_user_id, p_transition_id, v_transition.old_source_id,
    v_previous_generation.id,
    v_transition.expected_source_revision + 2, 'rollback_refresh'
  ) on conflict (transition_id, job_kind)
    where state in ('pending', 'processing') do nothing;
  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, transition_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, v_transition.old_source_id, p_transition_id,
    'credential_compensation_started',
    'credential-transition:' || p_transition_id::text || ':compensation-started',
    jsonb_build_object('reasonCode', p_reason_code), 'service_role'
  ) on conflict (user_id, idempotency_key) do nothing;
  return public.norva_credential_transition_result(p_transition_id, p_user_id);
end
$function$;

create or replace function public.norva_finish_credential_compensation(
  p_transition_id uuid,
  p_user_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_transition_revision bigint,
  p_expected_head_revision bigint,
  p_refresh_proof_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_secret public.cloud_source_transition_secrets%rowtype;
  v_lifecycle public.cloud_source_lifecycle%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_head public.cloud_source_catalog_heads%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_candidate_generation public.cloud_source_catalog_generations%rowtype;
  v_config text;
begin
  perform public.norva_credential_require_service_role();
  if p_refresh_proof_id is null then raise exception 'rollback refresh proof is required' using errcode = '22004'; end if;
  perform public.norva_credential_lock_account(p_user_id);
  select transition.* into v_transition from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id for update;
  if not found then raise exception 'credential transition not found' using errcode = 'P0002'; end if;
  select secret.* into v_secret from public.cloud_source_transition_secrets secret
  where secret.transition_id = p_transition_id and secret.user_id = p_user_id for update;
  select source.config_ciphertext into v_config from public.cloud_sources source
  where source.id = v_transition.old_source_id and source.user_id = p_user_id for update;
  select lifecycle.* into v_lifecycle from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id = v_transition.old_source_id and lifecycle.user_id = p_user_id for update;
  select job.* into v_job from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id for update;
  select head.* into v_head from public.cloud_source_catalog_heads head
  where head.source_id = v_transition.old_source_id and head.user_id = p_user_id for update;
  select generation.* into v_generation from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.previous_catalog_generation_id for update;
  select generation.* into v_candidate_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.candidate_catalog_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = v_transition.old_source_id
  for update;
  if v_transition.state <> 'committing'
     or v_transition.revision <> p_expected_transition_revision
     or v_secret.previous_config_restored_at is null
     or v_config is distinct from v_secret.previous_config_ciphertext
     or v_lifecycle.config_revision <> v_transition.expected_source_revision + 2
     or v_job.job_kind <> 'rollback_refresh'
     or v_job.catalog_generation_id <> v_generation.id
     or v_job.state <> 'processing' or v_job.lease_owner <> p_worker
     or v_job.lease_sequence <> p_expected_lease_sequence
     or v_job.lease_until <= now()
     or v_head.head_revision <> p_expected_head_revision
     or v_head.active_generation_id <> v_generation.id
     or v_generation.state <> 'active'
     or v_candidate_generation.state <> 'retained' then
    raise exception 'rollback refresh proof CAS failed' using errcode = '40001';
  end if;
  update public.cloud_source_transition_secrets
  set rollback_refresh_proof_id = p_refresh_proof_id,
      rollback_refresh_healthy_at = now()
  where transition_id = p_transition_id;
  update public.cloud_source_transitions
  set state = 'failed', failure_code = v_secret.compensation_reason_code
  where id = p_transition_id;
  -- B is no longer head and the first healthy rollback proved A.  A durable
  -- generation projection would otherwise retain B forever after every
  -- compensation.  Complete the immutable rollback-proof job and enqueue a
  -- distinct bounded purge outbox atomically; repurposing the leased job would
  -- violate its identity fence (generation, revision and kind).
  update public.cloud_source_catalog_generations generation
  set state = 'purging', revision = generation.revision + 1,
      updated_at = now()
  where generation.id = v_candidate_generation.id
    and generation.state = 'retained';
  if not found then
    raise exception 'compensated candidate purge CAS failed'
      using errcode = '40001';
  end if;
  update public.cloud_source_credential_transition_jobs
  set state = 'completed', completed_at = now(),
      lease_owner = null, lease_until = null
  where id = p_job_id
    and state = 'processing'
    and lease_owner = p_worker
    and lease_sequence = p_expected_lease_sequence;
  if not found then
    raise exception 'rollback proof job completion CAS failed'
      using errcode = '40001';
  end if;
  insert into public.cloud_source_credential_transition_jobs (
    user_id, transition_id, source_id, catalog_generation_id,
    expected_source_revision, job_kind, max_attempts
  ) values (
    p_user_id, p_transition_id, v_transition.old_source_id,
    v_candidate_generation.id, v_transition.expected_source_revision + 1,
    'purge_terminal_generation', 25
  );
  perform set_config('norva.credential_secret_clear', 'on', true);
  update public.cloud_source_transition_secrets secret
  set candidate_config_ciphertext = null,
      previous_config_ciphertext = null,
      candidate_config_hint = null,
      previous_config_hint = null,
      cleared_at = coalesce(secret.cleared_at, now())
  where secret.transition_id = p_transition_id
    and secret.user_id = p_user_id;
  perform set_config('norva.credential_secret_clear', 'off', true);
  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, transition_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, v_transition.old_source_id, p_transition_id,
    'credential_compensation_completed',
    'credential-transition:' || p_transition_id::text || ':compensation-completed',
    '{}'::jsonb, 'service_role'
  ) on conflict (user_id, idempotency_key) do nothing;
  return public.norva_credential_transition_result(p_transition_id, p_user_id);
end
$function$;

create or replace function public.norva_set_catalog_delete_proof(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform public.norva_credential_require_service_role();
  if not exists (
    select 1
    from public.cloud_source_catalog_heads head
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.source_id = head.source_id and lifecycle.user_id = head.user_id
    left join public.cloud_user_catalog_visibility_epochs epoch
      on epoch.user_id = head.user_id
    where head.source_id = p_source_id and head.user_id = p_user_id
      and head.active_generation_id = p_generation_id
      and head.head_revision = p_head_revision
      and lifecycle.config_revision = p_config_revision
      and lifecycle.visibility_epoch = p_source_visibility_epoch
      and coalesce(epoch.visibility_epoch, 1) = p_user_visibility_epoch
      and public.norva_source_catalog_visible_internal(p_source_id, p_user_id)
  ) then raise exception 'catalog delete proof CAS failed' using errcode = '40001'; end if;
  perform set_config('norva.catalog_delete_proof', jsonb_build_object(
    'headRevision', p_head_revision,
    'configRevision', p_config_revision,
    'sourceVisibilityEpoch', p_source_visibility_epoch,
    'userVisibilityEpoch', p_user_visibility_epoch
  )::text, true);
end
$function$;

create or replace function public.norva_delete_catalog_generation_items_batch(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_limit integer
) returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_deleted integer;
begin
  perform public.norva_set_catalog_delete_proof(
    p_source_id, p_user_id, p_generation_id, p_head_revision,
    p_config_revision, p_source_visibility_epoch, p_user_visibility_epoch
  );
  if p_limit < 1 or p_limit > 5000 then raise exception 'delete batch limit invalid' using errcode = '22023'; end if;
  with doomed as (
    select item.id from public.cloud_media_items item
    where item.source_id = p_source_id and item.user_id = p_user_id
      and item.generation_id = p_generation_id
    order by item.id limit p_limit for update skip locked
  )
  delete from public.cloud_media_items item using doomed
  where item.id = doomed.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;

create or replace function public.norva_prune_stale_catalog_generation_items(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_catalog_version bigint,
  p_limit integer
) returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_deleted integer;
begin
  perform public.norva_set_catalog_delete_proof(
    p_source_id, p_user_id, p_generation_id, p_head_revision,
    p_config_revision, p_source_visibility_epoch, p_user_visibility_epoch
  );
  if p_limit < 1 or p_limit > 5000 then raise exception 'prune batch limit invalid' using errcode = '22023'; end if;
  with doomed as (
    select item.id from public.cloud_media_items item
    where item.source_id = p_source_id and item.user_id = p_user_id
      and item.generation_id = p_generation_id
      and item.catalog_version is distinct from p_catalog_version
    order by item.id limit p_limit for update skip locked
  )
  delete from public.cloud_media_items item using doomed
  where item.id = doomed.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;

create or replace function public.norva_clear_catalog_generation_live_materialization(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_variants integer; v_channels integer;
begin
  perform public.norva_set_catalog_delete_proof(
    p_source_id, p_user_id, p_generation_id, p_head_revision,
    p_config_revision, p_source_visibility_epoch, p_user_visibility_epoch
  );
  delete from public.cloud_live_variants
  where source_id = p_source_id and user_id = p_user_id
    and generation_id = p_generation_id;
  get diagnostics v_variants = row_count;
  delete from public.cloud_live_logical_channels
  where source_id = p_source_id and user_id = p_user_id
    and generation_id = p_generation_id;
  get diagnostics v_channels = row_count;
  return jsonb_build_object('deletedVariants', v_variants, 'deletedChannels', v_channels);
end
$function$;

create or replace function public.norva_clear_terminal_credential_secrets(
  p_transition_id uuid,
  p_user_id uuid,
  p_expected_transition_revision bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
begin
  perform public.norva_credential_require_service_role();
  select transition.* into v_transition from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id for update;
  if not found then raise exception 'credential transition not found' using errcode = 'P0002'; end if;
  if v_transition.state not in ('completed', 'failed', 'cancelled')
     or v_transition.revision <> p_expected_transition_revision
     or (
       v_transition.state = 'cancelled'
       and not exists (
         select 1
         from public.cloud_source_credential_transition_actions action
         where action.transition_id = v_transition.id
           and action.user_id = v_transition.user_id
           and action.action_kind in (
             'cancel', 'replacement_handoff_consumed'
           )
       )
     ) then
    raise exception 'terminal secret clearance CAS failed' using errcode = '40001';
  end if;
  perform set_config('norva.credential_secret_clear', 'on', true);
  update public.cloud_source_transition_secrets secret
  set candidate_config_ciphertext = null,
      previous_config_ciphertext = null,
      candidate_config_hint = null,
      previous_config_hint = null,
      cleared_at = coalesce(secret.cleared_at, now())
  where secret.transition_id = p_transition_id and secret.user_id = p_user_id
    and secret.cleared_at is null;
  perform set_config('norva.credential_secret_clear', 'off', true);
  return jsonb_build_object(
    'transitionId', p_transition_id,
    'state', upper(v_transition.state),
    'secretsCleared', true
  );
end
$function$;

create or replace function public.norva_purge_cancelled_credential_generation_batch(
  p_generation_id uuid,
  p_user_id uuid,
  p_limit integer default 200
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_remaining bigint;
  v_deleted bigint := 0;
  v_count bigint;
  v_budget integer;
  v_has_remaining boolean;
  v_generation_state text;
  v_purge_mode text;
  v_projection public.cloud_source_catalog_generation_candidate_titles%rowtype;
  v_title public.cloud_titles%rowtype;
  v_can_delete_shell boolean;
  v_deleted_title_shells bigint := 0;
begin
  perform public.norva_credential_require_service_role();
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'purge batch limit is invalid' using errcode = '22023';
  end if;
  if not public.norva_title_gc_indexes_ready() then
    raise exception 'candidate title GC indexes are incomplete or drifted'
      using errcode = '55000',
        detail = 'reason=title_gc_index_drift';
  end if;
  perform set_config('lock_timeout', '2s', true);
  select generation.state, 'abandoned'
  into v_generation_state, v_purge_mode
  from public.cloud_source_catalog_generations generation
  join public.cloud_source_transitions transition
    on transition.id = generation.transition_id
   and transition.user_id = generation.user_id
  where generation.id = p_generation_id and generation.user_id = p_user_id
    and generation.state in ('purging', 'failed')
    and (
      transition.state = 'failed'
      or (
        transition.state = 'cancelled'
        and exists (
          select 1
          from public.cloud_source_credential_transition_actions action
          where action.transition_id = transition.id
            and action.user_id = transition.user_id
            and action.action_kind = 'cancel'
        )
      )
    )
  for update of generation;
  if not found then
    select generation.state, 'superseded'
    into v_generation_state, v_purge_mode
    from public.cloud_source_catalog_generations generation
    join public.cloud_source_transitions transition
      on transition.previous_catalog_generation_id = generation.id
     and transition.user_id = generation.user_id
     and transition.old_source_id = generation.source_id
     and transition.state = 'completed'
    join public.cloud_source_catalog_heads head
      on head.source_id = generation.source_id
     and head.user_id = generation.user_id
    join public.cloud_source_catalog_generations candidate
      on candidate.id = head.active_generation_id
     and candidate.source_id = generation.source_id
     and candidate.user_id = generation.user_id
     and candidate.state = 'active'
    where generation.id = p_generation_id
      and generation.user_id = p_user_id
      and generation.state in ('purging', 'purged')
      and head.active_generation_id <> generation.id
    for update of generation;
  end if;
  if not found then
    raise exception 'terminal generation purge CAS failed' using errcode = '40001';
  end if;

  -- The final purge transaction may commit before the worker settles its job.
  -- A reclaimed job must observe the already-failed, already-empty generation
  -- as a successful idempotent replay rather than dead-letter forever.
  if (v_purge_mode = 'abandoned' and v_generation_state = 'failed')
     or (v_purge_mode = 'superseded' and v_generation_state = 'purged') then
    select exists (
      select 1 from public.catalog_series_episode_memberships
        where generation_id = p_generation_id
      union all select 1 from public.catalog_series_inventory_state
        where generation_id = p_generation_id
      union all select 1 from public.cloud_live_variants
        where generation_id = p_generation_id
      union all select 1 from public.cloud_live_logical_channels
        where generation_id = p_generation_id
      union all select 1 from public.cloud_title_variants
        where generation_id = p_generation_id
      union all select 1 from public.cloud_media_items
        where generation_id = p_generation_id
      union all select 1 from public.cloud_source_catalog_generation_categories
        where generation_id = p_generation_id
      union all select 1
        from public.cloud_source_catalog_generation_candidate_titles
        where generation_id = p_generation_id
      union all select 1
        from public.cloud_source_catalog_generation_category_lists
        where generation_id = p_generation_id
      union all select 1
        from public.cloud_source_catalog_generation_inventory_actions
        where generation_id = p_generation_id
      union all select 1
        from public.cloud_source_catalog_generation_episode_copy
        where generation_id = p_generation_id
      limit 1
    ) into v_has_remaining;
    if v_has_remaining then
      raise exception 'terminal generation still owns purgeable rows'
        using errcode = '55000';
    end if;
    return jsonb_build_object(
      'generationId', p_generation_id,
      'deletedRows', 0,
      'deletedTitleShells', 0,
      'remainingRows', 0,
      'complete', true,
      'purgeMode', v_purge_mode,
      'replayed', true
    );
  end if;

  perform set_config('norva.catalog_purge_generation', p_generation_id::text, true);
  v_budget := p_limit;
  if v_budget > 0 then
    delete from public.catalog_series_episode_memberships row
    where row.ctid in (
      select candidate.ctid
      from public.catalog_series_episode_memberships candidate
      where candidate.generation_id = p_generation_id
      limit v_budget
    );
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
  end if;
  if v_budget > 0 then
    delete from public.catalog_series_inventory_state row
    where row.ctid in (
      select candidate.ctid
      from public.catalog_series_inventory_state candidate
      where candidate.generation_id = p_generation_id
      limit v_budget
    );
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
  end if;
  if v_budget > 0 then
    delete from public.cloud_live_variants row
    where row.ctid in (
      select candidate.ctid from public.cloud_live_variants candidate
      where candidate.generation_id = p_generation_id limit v_budget
    );
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
  end if;
  if v_budget > 0 then
    delete from public.cloud_live_logical_channels row
    where row.ctid in (
      select candidate.ctid from public.cloud_live_logical_channels candidate
      where candidate.generation_id = p_generation_id limit v_budget
    );
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
  end if;
  if v_budget > 0 then
    delete from public.cloud_title_variants row
    where row.ctid in (
      select candidate.ctid from public.cloud_title_variants candidate
      where candidate.generation_id = p_generation_id limit v_budget
    );
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
  end if;
  if v_budget > 0 then
    delete from public.cloud_media_items row
    where row.ctid in (
      select candidate.ctid from public.cloud_media_items candidate
      where candidate.generation_id = p_generation_id limit v_budget
    );
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
  end if;
  -- Category discovery can legitimately contain up to one million rows.  It
  -- consumes the same global budget instead of being deleted wholesale in the
  -- terminal batch.
  if v_budget > 0 then
    delete from public.cloud_source_catalog_generation_categories row
    where row.ctid in (
      select candidate.ctid
      from public.cloud_source_catalog_generation_categories candidate
      where candidate.generation_id = p_generation_id
      order by candidate.category_kind, candidate.category_ordinal
      limit v_budget
      for update skip locked
    );
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
  end if;

  -- Consume candidate payload/ownership rows in a bounded loop.  A shell is
  -- deleted only when this exact generation created it, it is byte-identical
  -- to the recorded payload, no newer writer touched it, no other generation
  -- projects it, and none of the six business children references it.
  if v_budget > 0 then
    for v_projection in
      select projection.*
      from public.cloud_source_catalog_generation_candidate_titles projection
      where projection.generation_id = p_generation_id
      order by projection.title_id
      limit v_budget
      for update of projection skip locked
    loop
      v_can_delete_shell := false;
      if v_projection.shell_created then
        select title.* into v_title
        from public.cloud_titles title
        where title.id = v_projection.title_id
          and title.user_id = v_projection.user_id
        for update of title skip locked;
        if not found then
          -- A concurrent owner holds the shell.  Keep provenance for retry and
          -- never advance cleanup past it blindly.
          continue;
        end if;
        v_can_delete_shell :=
          v_title.candidate_shell_token = v_projection.shell_token
          and v_title.identity_source is not distinct from v_projection.identity_source
          and v_title.provider_tmdb_id is not distinct from v_projection.provider_tmdb_id
          and v_title.provider_imdb_id is not distinct from v_projection.provider_imdb_id
          and v_title.match_status is not distinct from v_projection.match_status
          and v_title.title is not distinct from v_projection.title
          and v_title.original_title is not distinct from v_projection.original_title
          and v_title.release_year is not distinct from v_projection.release_year
          and v_title.poster_url is not distinct from v_projection.poster_url
          and v_title.backdrop_url is not distinct from v_projection.backdrop_url
          and v_title.metadata is not distinct from v_projection.metadata
          and not exists (
            select 1
            from public.cloud_source_catalog_generation_candidate_titles other
            where other.title_id = v_projection.title_id
              and other.generation_id <> p_generation_id
          )
          and not exists (
            select 1 from public.cloud_title_variants child
            where child.title_id = v_projection.title_id
          )
          and not exists (
            select 1 from public.cloud_title_file_language_observations child
            where child.title_id = v_projection.title_id
              and child.user_id = v_projection.user_id
          )
          and not exists (
            select 1 from public.catalog_series_episode_memberships child
            where child.parent_title_id = v_projection.title_id
          )
          and not exists (
            select 1 from public.catalog_series_inventory_state child
            where child.parent_title_id = v_projection.title_id
          )
          and not exists (
            select 1 from public.cloud_title_rating_operations child
            where child.title_id = v_projection.title_id
              and child.user_id = v_projection.user_id
          )
          and not exists (
            select 1 from public.cloud_title_ratings child
            where child.title_id = v_projection.title_id
              and child.user_id = v_projection.user_id
          );
      end if;

      if v_can_delete_shell then
        delete from public.cloud_titles title
        where title.id = v_projection.title_id
          and title.user_id = v_projection.user_id;
        get diagnostics v_count = row_count;
        v_deleted_title_shells := v_deleted_title_shells + v_count;
      else
        delete from public.cloud_source_catalog_generation_candidate_titles projection
        where projection.generation_id = p_generation_id
          and projection.title_id = v_projection.title_id;
      end if;
      v_deleted := v_deleted + 1;
      v_budget := v_budget - 1;
      exit when v_budget = 0;
    end loop;
  end if;

  select exists (
    select 1 from public.catalog_series_episode_memberships
      where generation_id = p_generation_id
    union all
    select 1 from public.catalog_series_inventory_state
      where generation_id = p_generation_id
    union all
    select 1 from public.cloud_live_variants
      where generation_id = p_generation_id
    union all
    select 1 from public.cloud_live_logical_channels
      where generation_id = p_generation_id
    union all
    select 1 from public.cloud_title_variants
      where generation_id = p_generation_id
    union all
    select 1 from public.cloud_media_items
      where generation_id = p_generation_id
    union all
    select 1 from public.cloud_source_catalog_generation_categories
      where generation_id = p_generation_id
    union all
    select 1 from public.cloud_source_catalog_generation_candidate_titles
      where generation_id = p_generation_id
    limit 1
  ) into v_has_remaining;
  v_remaining := case when v_has_remaining then 1 else 0 end;
  if not v_has_remaining then
    delete from public.cloud_source_catalog_generation_category_lists where generation_id = p_generation_id;
    delete from public.cloud_source_catalog_generation_inventory_actions where generation_id = p_generation_id;
    delete from public.cloud_source_catalog_generation_episode_copy where generation_id = p_generation_id;
    update public.cloud_source_catalog_generations
    set state = case
          when v_purge_mode = 'superseded' then 'purged'
          else 'failed'
        end,
        revision = revision + 1, updated_at = now()
    where id = p_generation_id;
  end if;
  -- Candidate projection deletion is manifest-observed too.  Keep the exact
  -- transaction-local purge proof until every generation-owned cleanup step
  -- has finished; an exception rolls the local setting back with the statement.
  perform set_config('norva.catalog_purge_generation', '', true);
  return jsonb_build_object(
    'generationId', p_generation_id,
    'deletedRows', v_deleted,
    'deletedTitleShells', v_deleted_title_shells,
    'remainingRows', v_remaining,
    'complete', v_remaining = 0,
    'purgeMode', v_purge_mode,
    'replayed', false
  );
end
$function$;

create or replace function public.norva_claim_credential_transition_jobs(
  p_worker text,
  p_limit integer,
  p_lease_seconds integer,
  p_worker_protocol text
) returns table (
  job_id uuid,
  user_id uuid,
  transition_id uuid,
  source_id uuid,
  catalog_generation_id uuid,
  job_kind text,
  lease_sequence integer,
  failure_attempt_count integer,
  checkpoint_revision bigint,
  progress jsonb,
  expected_source_revision bigint,
  transition_revision bigint,
  lease_until timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform public.norva_credential_require_service_role();
  if p_worker is null or btrim(p_worker) = '' or length(p_worker) > 160 then
    raise exception 'bounded worker id is required' using errcode = '22023';
  end if;
  if p_worker_protocol is not null
     and p_worker_protocol not in (
       'credential-transition-worker-v2-title-cleanup',
       'credential-transition-worker-v3-active-catalog-refresh'
     ) then
    raise exception 'unsupported credential worker protocol'
      using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50
     or p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 900 then
    raise exception 'job claim bounds are invalid' using errcode = '22023';
  end if;

  update public.cloud_source_credential_transition_jobs job
  set state = 'dead',
      lease_owner = null,
      lease_until = null,
      last_error_code = 'lease_expired',
      dead_at = now()
  where job.state = 'processing'
    and job.lease_until <= now()
    and job.attempt_count >= job.max_attempts;

  return query
  with candidates as (
    select job.id
    from public.cloud_source_credential_transition_jobs job
    where ((
      job.state = 'pending' and job.available_at <= now()
    ) or (
      job.state = 'processing'
      and job.lease_until <= now()
      and job.attempt_count < job.max_attempts
    ))
    and (
      job.job_kind = 'rollback_refresh'
      or (
        job.job_kind = 'post_switch_verify'
        and p_worker_protocol =
          'credential-transition-worker-v3-active-catalog-refresh'
      )
      or (
        job.job_kind in (
          'promote_generation_titles', 'purge_terminal_generation'
        )
        and p_worker_protocol in (
          'credential-transition-worker-v2-title-cleanup',
          'credential-transition-worker-v3-active-catalog-refresh'
        )
      )
      or (
        job.job_kind in ('validate_candidate', 'build_candidate_generation')
        and exists (
        select 1 from public.admin_feature_flags flag
        where flag.key = 'provider_credential_transition_v1_enabled' and flag.enabled
        )
      )
    )
    order by job.available_at, job.created_at, job.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.cloud_source_credential_transition_jobs job
    set state = 'processing',
        attempt_count = job.attempt_count + case when job.state = 'processing' then 1 else 0 end,
        lease_sequence = job.lease_sequence + 1,
        lease_owner = p_worker,
        lease_until = now() + make_interval(secs => p_lease_seconds),
        last_error_code = case
          when job.state = 'processing' then 'lease_expired'
          else job.last_error_code
        end
    from candidates
    where job.id = candidates.id
    returning job.*
  )
  select claimed.id, claimed.user_id, claimed.transition_id,
         claimed.source_id, claimed.catalog_generation_id, claimed.job_kind,
         claimed.lease_sequence, claimed.attempt_count,
         claimed.checkpoint_revision, claimed.progress,
         claimed.expected_source_revision, transition.revision,
         claimed.lease_until
  from claimed
  join public.cloud_source_transitions transition
    on transition.id = claimed.transition_id
   and transition.user_id = claimed.user_id;
end
$function$;

-- Rolling compatibility: pre-v2 workers keep their three-argument call and
-- can never claim a job kind they do not understand.  V2 callers may drain
-- title cleanup but cannot claim the new active-refresh workflow; only V3 can
-- claim post_switch_verify after this DB migration is installed.
create or replace function public.norva_claim_credential_transition_jobs(
  p_worker text,
  p_limit integer default 10,
  p_lease_seconds integer default 60
) returns table (
  job_id uuid,
  user_id uuid,
  transition_id uuid,
  source_id uuid,
  catalog_generation_id uuid,
  job_kind text,
  lease_sequence integer,
  failure_attempt_count integer,
  checkpoint_revision bigint,
  progress jsonb,
  expected_source_revision bigint,
  transition_revision bigint,
  lease_until timestamptz
)
language sql
volatile
security definer
set search_path = ''
as $function$
  select *
  from public.norva_claim_credential_transition_jobs(
    p_worker, p_limit, p_lease_seconds, null::text
  )
$function$;

create or replace function public.norva_checkpoint_credential_generation_job(
  p_job_id uuid,
  p_user_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_checkpoint_revision bigint,
  p_progress jsonb,
  p_retry_after_seconds integer default 0
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job public.cloud_source_credential_transition_jobs%rowtype;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  if not public.norva_credential_job_progress_safe(p_progress) then
    raise exception 'invalid bounded generation progress' using errcode = '22023';
  end if;
  if p_retry_after_seconds is null or p_retry_after_seconds < 0
     or p_retry_after_seconds > 60 then
    raise exception 'generation checkpoint retry delay is invalid' using errcode = '22023';
  end if;
  select job.* into v_job from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.user_id = p_user_id for update;
  if not found or v_job.job_kind <> 'build_candidate_generation'
     or v_job.state <> 'processing' or v_job.lease_owner <> p_worker
     or v_job.lease_sequence <> p_expected_lease_sequence
     or v_job.checkpoint_revision <> p_expected_checkpoint_revision
     or v_job.lease_until <= now() then
    raise exception 'generation checkpoint lease CAS failed' using errcode = '40001';
  end if;
  update public.cloud_source_credential_transition_jobs
  set state = 'pending', lease_owner = null, lease_until = null,
      available_at = now() + make_interval(secs => p_retry_after_seconds), progress = p_progress,
      checkpoint_revision = checkpoint_revision + 1
  where id = p_job_id;
  return jsonb_build_object(
    'jobId', p_job_id,
    'state', 'PENDING',
    'checkpointRevision', p_expected_checkpoint_revision + 1,
    'progress', p_progress,
    'retryAfterSeconds', p_retry_after_seconds,
    'failureAttemptCount', v_job.attempt_count
  );
end
$function$;

create or replace function public.norva_reset_credential_catalog_generation(
  p_transition_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence integer
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job public.cloud_source_credential_transition_jobs%rowtype;
begin
  perform public.norva_credential_require_service_role();
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  join public.cloud_source_transitions transition
    on transition.id = job.transition_id and transition.user_id = job.user_id
  join public.cloud_source_catalog_generations generation
    on generation.id = job.catalog_generation_id
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id and job.catalog_generation_id = p_generation_id
    and job.job_kind = 'build_candidate_generation'
    and job.state = 'processing' and job.lease_owner = p_worker
    and job.lease_sequence = p_expected_lease_sequence
    and job.lease_until > now() and transition.state = 'importing'
    and generation.state = 'building'
  for update of job;
  if not found then raise exception 'generation reset lease CAS failed' using errcode = '40001'; end if;

  update public.cloud_live_variants set
    ingest_job_id = p_job_id, ingest_attempt = p_expected_lease_sequence,
    ingest_lease_owner = p_worker where generation_id = p_generation_id;
  delete from public.cloud_live_variants where generation_id = p_generation_id;
  update public.catalog_series_episode_memberships set
    ingest_job_id = p_job_id, ingest_attempt = p_expected_lease_sequence,
    ingest_lease_owner = p_worker where generation_id = p_generation_id;
  delete from public.catalog_series_episode_memberships where generation_id = p_generation_id;
  update public.catalog_series_inventory_state set
    ingest_job_id = p_job_id, ingest_attempt = p_expected_lease_sequence,
    ingest_lease_owner = p_worker where generation_id = p_generation_id;
  delete from public.catalog_series_inventory_state where generation_id = p_generation_id;
  update public.cloud_title_variants set
    ingest_job_id = p_job_id, ingest_attempt = p_expected_lease_sequence,
    ingest_lease_owner = p_worker where generation_id = p_generation_id;
  delete from public.cloud_title_variants where generation_id = p_generation_id;
  update public.cloud_live_logical_channels set
    ingest_job_id = p_job_id, ingest_attempt = p_expected_lease_sequence,
    ingest_lease_owner = p_worker where generation_id = p_generation_id;
  delete from public.cloud_live_logical_channels where generation_id = p_generation_id;
  update public.cloud_media_items set
    ingest_job_id = p_job_id, ingest_attempt = p_expected_lease_sequence,
    ingest_lease_owner = p_worker where generation_id = p_generation_id;
  delete from public.cloud_media_items where generation_id = p_generation_id;
  update public.cloud_source_credential_transition_jobs
  set progress = '{"action":"live_categories","version":1,"typeIndex":0,"categoryOrdinal":0,"itemOffset":0,"categoryPageCursor":"","categoriesDone":false,"itemCursor":"","processedCategories":0,"processedItems":0}'::jsonb,
      checkpoint_revision = checkpoint_revision + 1
  where id = p_job_id;
  return jsonb_build_object(
    'transitionId', p_transition_id,
    'generationId', p_generation_id,
    'reset', true,
    'checkpointRevision', v_job.checkpoint_revision + 1
  );
end
$function$;

create or replace function public.norva_settle_credential_transition_job(
  p_job_id uuid,
  p_worker text,
  p_expected_attempt integer,
  p_outcome text,
  p_error_code text default null,
  p_retry_after_seconds integer default 60
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_outcome text := lower(p_outcome);
  v_state text;
begin
  perform public.norva_credential_require_service_role();
  if v_outcome not in ('completed', 'retry', 'dead') then
    raise exception 'invalid job outcome' using errcode = '22023';
  end if;
  if p_error_code is not null and p_error_code not in (
    'network_timeout', 'provider_unavailable', 'auth_rejected',
    'rate_limited', 'invalid_payload', 'catalog_unhealthy',
    'internal_error', 'lease_expired'
  ) then raise exception 'invalid job error code' using errcode = '22023'; end if;
  if v_outcome in ('retry', 'dead') and p_error_code is null then
    raise exception 'failed job outcome requires an error code' using errcode = '22023';
  end if;
  if p_retry_after_seconds < 1 or p_retry_after_seconds > 86400 then
    raise exception 'retry delay is out of bounds' using errcode = '22023';
  end if;
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id
  for update;
  if not found
     or v_job.state <> 'processing'
     or v_job.lease_owner is distinct from p_worker
     or v_job.lease_sequence <> p_expected_attempt
     or v_job.lease_until <= now() then
    raise exception 'credential job lease CAS failed' using errcode = '40001';
  end if;

  v_state := case
    when v_outcome = 'completed' then 'completed'
    when v_outcome = 'dead' or v_job.attempt_count + 1 >= v_job.max_attempts then 'dead'
    else 'pending'
  end;
  update public.cloud_source_credential_transition_jobs job
  set state = v_state,
      lease_owner = null,
      lease_until = null,
      attempt_count = case
        when v_outcome in ('retry', 'dead') then job.attempt_count + 1
        else job.attempt_count
      end,
      available_at = case
        when v_state = 'pending' then now() + make_interval(secs => p_retry_after_seconds)
        else job.available_at
      end,
      last_error_code = case when v_state = 'completed' then null else p_error_code end,
      completed_at = case when v_state = 'completed' then now() else null end,
      dead_at = case when v_state = 'dead' then now() else null end
  where job.id = p_job_id;
  return jsonb_build_object(
    'jobId', p_job_id,
    'state', upper(v_state),
    'failureAttemptCount', case
      when v_outcome in ('retry', 'dead') then v_job.attempt_count + 1
      else v_job.attempt_count
    end,
    'leaseSequence', v_job.lease_sequence
  );
end
$function$;

alter table public.cloud_source_transition_secrets enable row level security;
alter table public.cloud_source_credential_transition_jobs enable row level security;
alter table public.cloud_source_credential_transition_actions enable row level security;
alter table public.cloud_source_catalog_generations enable row level security;
alter table public.cloud_source_catalog_heads enable row level security;
alter table public.cloud_source_catalog_generation_categories enable row level security;
alter table public.cloud_source_catalog_generation_category_lists enable row level security;
alter table public.cloud_source_catalog_generation_inventory_actions enable row level security;
alter table public.cloud_source_catalog_generation_episode_copy enable row level security;
alter table public.cloud_source_catalog_generation_title_promotions enable row level security;
alter table public.cloud_source_catalog_generation_candidate_titles enable row level security;
alter table public.cloud_catalog_generation_rollout enable row level security;

revoke all on table
  public.cloud_source_transition_secrets,
  public.cloud_source_credential_transition_jobs,
  public.cloud_source_credential_transition_actions,
  public.cloud_source_catalog_generations,
  public.cloud_source_catalog_heads,
  public.cloud_source_catalog_generation_categories,
  public.cloud_source_catalog_generation_category_lists,
  public.cloud_source_catalog_generation_inventory_actions,
  public.cloud_source_catalog_generation_episode_copy,
  public.cloud_source_catalog_generation_title_promotions,
  public.cloud_source_catalog_generation_candidate_titles,
  public.cloud_catalog_generation_rollout
from public, anon, authenticated, service_role;

do $assert_private_title_control_tables$
begin
  if exists (
    select 1
    from pg_class class
    join pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relname in (
        'cloud_source_catalog_generation_title_promotions',
        'cloud_source_catalog_generation_candidate_titles'
      )
      and (
        not class.relrowsecurity
        or has_table_privilege('public', class.oid, 'SELECT,INSERT,UPDATE,DELETE')
        or has_table_privilege('anon', class.oid, 'SELECT,INSERT,UPDATE,DELETE')
        or has_table_privilege(
          'authenticated', class.oid, 'SELECT,INSERT,UPDATE,DELETE'
        )
        or has_table_privilege(
          'service_role', class.oid, 'SELECT,INSERT,UPDATE,DELETE'
        )
      )
  ) then
    raise exception 'private title rollout table RLS/ACL drift'
      using errcode = '55000';
  end if;
end
$assert_private_title_control_tables$;

-- security_invoker visible views need this non-secret pointer metadata.  Keep
-- DML behind guarded RPCs/triggers and keep secrets/jobs/actions non-readable.
grant select on table
  public.cloud_source_catalog_generations,
  public.cloud_source_catalog_heads,
  public.cloud_catalog_generation_rollout
to service_role;

revoke all on function
  public.norva_credential_transition_fingerprint_guard(),
  public.norva_credential_candidate_hint_safe(jsonb),
  public.norva_credential_job_progress_safe(jsonb),
  public.norva_catalog_generation_guard_begin_statement(),
  public.norva_catalog_generation_write_guard(),
  public.norva_catalog_generation_row_changed(),
  public.norva_bootstrap_source_catalog_generation(),
  public.norva_ensure_source_catalog_head(uuid,uuid),
  public.norva_credential_secret_guard(),
  public.norva_credential_job_guard(),
  public.norva_credential_action_guard(),
  public.norva_credential_require_service_role(),
  public.norva_credential_lock_account(uuid),
  public.norva_credential_require_enabled(),
  public.norva_credential_transition_result(uuid, uuid),
  public.norva_credential_action_result(uuid),
  public.norva_credential_strong_identity_signals(uuid, uuid),
  public.norva_compute_catalog_generation_manifest(uuid),
  public.norva_set_catalog_delete_proof(uuid,uuid,uuid,bigint,bigint,bigint,bigint)
from public, anon, authenticated, service_role;

revoke all on function public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_get_credential_transition(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_read_credential_transition_secret(uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_record_credential_identity_assessment(uuid,uuid,text,integer,integer,integer,numeric,jsonb,text)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_decide_ambiguous_credential_transition(uuid,uuid,text,text,bigint,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_cancel_credential_transition(uuid,uuid,text,bigint,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_fail_credential_transition_validation(uuid,uuid,bigint,text,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_mark_credential_candidate_validated(uuid,uuid,uuid,text,integer,bigint,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_allocate_credential_catalog_generation(uuid,uuid,uuid,text,integer,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_get_credential_catalog_generation(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_get_source_catalog_head(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_get_catalog_write_snapshot(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_ensure_credential_generation_titles(uuid,uuid,uuid,uuid,text,integer,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_promote_credential_generation_titles_batch(uuid,uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_requeue_credential_title_promotion(uuid,uuid,text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_requeue_credential_generation_purge(uuid,uuid,text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_register_credential_generation_categories(uuid,uuid,uuid,uuid,text,integer,text,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_get_credential_generation_categories(uuid,uuid,uuid,text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_mark_credential_category_list_complete(uuid,uuid,uuid,uuid,text,integer,text,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_mark_credential_parent_action_complete(uuid,uuid,uuid,uuid,text,integer,text,text,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_mark_credential_category_slice_complete(uuid,uuid,uuid,uuid,text,integer,text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_copy_credential_generation_episode_state(uuid,uuid,uuid,uuid,text,integer,bigint,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_get_active_catalog_identity_evidence(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_preview_credential_catalog_manifest(uuid,uuid,uuid,uuid,text,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_mark_credential_transition_ready(uuid,uuid,uuid,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_begin_credential_swap(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_complete_credential_transition(uuid,uuid,uuid,text,integer,bigint,bigint,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_restore_previous_credential_config(uuid,uuid,uuid,text,integer,bigint,bigint,bigint,text)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_finish_credential_compensation(uuid,uuid,uuid,text,integer,bigint,bigint,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_clear_terminal_credential_secrets(uuid,uuid,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_delete_catalog_generation_items_batch(uuid,uuid,uuid,bigint,bigint,bigint,bigint,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_prune_stale_catalog_generation_items(uuid,uuid,uuid,bigint,bigint,bigint,bigint,bigint,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_clear_catalog_generation_live_materialization(uuid,uuid,uuid,bigint,bigint,bigint,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_purge_cancelled_credential_generation_batch(uuid,uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_claim_credential_transition_jobs(text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_claim_credential_transition_jobs(text,integer,integer,text)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_checkpoint_credential_generation_job(uuid,uuid,text,integer,bigint,jsonb,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_reset_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.norva_settle_credential_transition_job(uuid,text,integer,text,text,integer)
  from public, anon, authenticated, service_role;

grant execute on function public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text)
  to service_role;
grant execute on function public.norva_get_credential_transition(uuid,uuid)
  to service_role;
grant execute on function public.norva_read_credential_transition_secret(uuid,uuid,text)
  to service_role;
grant execute on function public.norva_record_credential_identity_assessment(uuid,uuid,text,integer,integer,integer,numeric,jsonb,text)
  to service_role;
grant execute on function public.norva_decide_ambiguous_credential_transition(uuid,uuid,text,text,bigint,text,text)
  to service_role;
grant execute on function public.norva_cancel_credential_transition(uuid,uuid,text,bigint,text,text)
  to service_role;
grant execute on function public.norva_fail_credential_transition_validation(uuid,uuid,bigint,text,text,text,text)
  to service_role;
grant execute on function public.norva_mark_credential_candidate_validated(uuid,uuid,uuid,text,integer,bigint,integer)
  to service_role;
grant execute on function public.norva_allocate_credential_catalog_generation(uuid,uuid,uuid,text,integer,bigint)
  to service_role;
grant execute on function public.norva_get_credential_catalog_generation(uuid,uuid) to service_role;
grant execute on function public.norva_get_source_catalog_head(uuid,uuid) to service_role;
grant execute on function public.norva_get_catalog_write_snapshot(uuid,uuid) to service_role;
grant execute on function public.norva_ensure_credential_generation_titles(uuid,uuid,uuid,uuid,text,integer,jsonb) to service_role;
grant execute on function public.norva_promote_credential_generation_titles_batch(uuid,uuid,integer) to service_role;
grant execute on function public.norva_requeue_credential_title_promotion(uuid,uuid,text,integer,integer) to service_role;
grant execute on function public.norva_requeue_credential_generation_purge(uuid,uuid,text,integer,integer) to service_role;
grant execute on function public.norva_register_credential_generation_categories(uuid,uuid,uuid,uuid,text,integer,text,jsonb) to service_role;
grant execute on function public.norva_get_credential_generation_categories(uuid,uuid,uuid,text,integer,integer) to service_role;
grant execute on function public.norva_mark_credential_category_list_complete(uuid,uuid,uuid,uuid,text,integer,text,integer) to service_role;
grant execute on function public.norva_mark_credential_parent_action_complete(uuid,uuid,uuid,uuid,text,integer,text,text,bigint) to service_role;
grant execute on function public.norva_mark_credential_category_slice_complete(uuid,uuid,uuid,uuid,text,integer,text,integer,integer) to service_role;
grant execute on function public.norva_copy_credential_generation_episode_state(uuid,uuid,uuid,uuid,text,integer,bigint,integer) to service_role;
grant execute on function public.norva_get_active_catalog_identity_evidence(uuid,uuid) to service_role;
grant execute on function public.norva_preview_credential_catalog_manifest(uuid,uuid,uuid,uuid,text,integer) to service_role;
grant execute on function public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint) to service_role;
grant execute on function public.norva_mark_credential_transition_ready(uuid,uuid,uuid,bigint)
  to service_role;
grant execute on function public.norva_begin_credential_swap(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text)
  to service_role;
grant execute on function public.norva_complete_credential_transition(uuid,uuid,uuid,text,integer,bigint,bigint,uuid)
  to service_role;
grant execute on function public.norva_restore_previous_credential_config(uuid,uuid,uuid,text,integer,bigint,bigint,bigint,text)
  to service_role;
grant execute on function public.norva_finish_credential_compensation(uuid,uuid,uuid,text,integer,bigint,bigint,uuid)
  to service_role;
grant execute on function public.norva_clear_terminal_credential_secrets(uuid,uuid,bigint)
  to service_role;
grant execute on function public.norva_delete_catalog_generation_items_batch(uuid,uuid,uuid,bigint,bigint,bigint,bigint,integer)
  to service_role;
grant execute on function public.norva_prune_stale_catalog_generation_items(uuid,uuid,uuid,bigint,bigint,bigint,bigint,bigint,integer)
  to service_role;
grant execute on function public.norva_clear_catalog_generation_live_materialization(uuid,uuid,uuid,bigint,bigint,bigint,bigint)
  to service_role;
grant execute on function public.norva_purge_cancelled_credential_generation_batch(uuid,uuid,integer)
  to service_role;
grant execute on function public.norva_claim_credential_transition_jobs(text,integer,integer)
  to service_role;
grant execute on function public.norva_claim_credential_transition_jobs(text,integer,integer,text)
  to service_role;
grant execute on function public.norva_checkpoint_credential_generation_job(uuid,uuid,text,integer,bigint,jsonb,integer)
  to service_role;
grant execute on function public.norva_reset_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer)
  to service_role;
grant execute on function public.norva_settle_credential_transition_job(uuid,text,integer,text,text,integer)
  to service_role;

-- Migrations must never silently activate the rollout gate.
update public.admin_feature_flags
set enabled = false,
    updated_at = now(),
    updated_by = 'migration:provider_credential_transition_v1'
where key = 'provider_credential_transition_v1_enabled';

notify pgrst, 'reload schema';

commit;
