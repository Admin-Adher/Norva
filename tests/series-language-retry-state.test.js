const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260724162341_episode_probe_retry_and_inventory_backoff.sql',
  ),
  'utf8',
);

const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notStrictEqual(from, -1, `missing start anchor: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notStrictEqual(to, -1, `missing end anchor: ${end}`);
  return source.slice(from, to);
};

test('retry migration is atomic and keeps both state tables service-only', () => {
  assert.match(migration, /\nbegin;\s*\n/);
  assert.match(migration, /commit;\s*$/);

  for (const table of [
    'catalog_episode_probe_state',
    'catalog_provider_inventory_backoff',
  ]) {
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security`),
    );
    assert.match(
      migration,
      new RegExp(
        `revoke all on table public\\.${table}[\\s\\S]*?` +
          `from public, anon, authenticated`,
      ),
    );
    assert.match(
      migration,
      new RegExp(
        `grant select, insert, update, delete[\\s\\S]*?` +
          `on table public\\.${table} to service_role`,
      ),
    );
  }
});

test('episode retry key is exact and a successful probe deletes its state', () => {
  const table = between(
    migration,
    'create table if not exists public.catalog_episode_probe_state (',
    '\ncreate index if not exists catalog_episode_probe_state_variant_due_idx',
  );
  const outcome = between(
    migration,
    'create or replace function public.record_catalog_episode_probe_outcome(',
    '\ncreate or replace function public.catalog_provider_inventory_backoff_state(',
  );

  assert.ok(table.includes(
    'primary key (provider_identity_id, variant_id, episode_id)',
  ));
  assert.ok(table.includes(
    'references public.provider_identities(id) on delete cascade',
  ));
  assert.ok(table.includes(
    'references public.cloud_title_variants(id) on delete cascade',
  ));
  assert.ok(table.includes('next_retry_at timestamptz not null'));
  assert.ok(table.includes('attempts integer not null default 0'));

  assert.ok(outcome.includes('catalog_series_episode_memberships membership'));
  assert.ok(outcome.includes('membership.parent_variant_id = p_variant'));
  assert.ok(outcome.includes(
    'identity.identity_id = membership.provider_identity_id',
  ));
  assert.ok(outcome.includes(
    'conflicting.parent_series_id is distinct from membership.parent_series_id',
  ));
  assert.match(
    outcome,
    /if p_success then[\s\S]*delete from public\.catalog_episode_probe_state retry/,
  );
  assert.match(
    outcome,
    /on conflict \(provider_identity_id, variant_id, episode_id\) do update/,
  );
});

test('persisted provider failure metadata is bounded and contains no free-form payload', () => {
  const episodeTable = between(
    migration,
    'create table if not exists public.catalog_episode_probe_state (',
    '\ncreate index if not exists catalog_episode_probe_state_variant_due_idx',
  );
  const providerTable = between(
    migration,
    'create table if not exists public.catalog_provider_inventory_backoff (',
    '\ncreate index if not exists catalog_provider_inventory_backoff_due_idx',
  );
  const sanitizer = between(
    migration,
    'create or replace function public.catalog_sanitize_provider_failure_code(',
    '\ncreate or replace function public.catalog_sanitize_probe_transport(',
  );

  assert.match(
    providerTable,
    /source_id uuid primary key\s+references public\.cloud_sources\(id\) on delete cascade/,
  );
  assert.match(providerTable, /provider_identity_id uuid not null/);
  for (const table of [episodeTable, providerTable]) {
    assert.ok(table.includes(
      'last_status is null or last_status between 100 and 599',
    ));
    assert.match(table, /last_code ~ '\^\[a-z\]\[a-z0-9_\]\{0,63\}\$'/);
    assert.doesNotMatch(table, /\b(details|payload|body|url|host|credential)\b/i);
  }
  assert.ok(sanitizer.includes("when 'account_busy' then 'account_busy'"));
  assert.ok(sanitizer.includes(
    "when 'background_busy' then 'background_busy'",
  ));
  assert.match(sanitizer, /else null/);
  assert.doesNotMatch(
    migration,
    /p_details|last_details|response_body|provider_url|server_url/i,
  );
});

test('failure classes have distinct viewer, gateway, auth, rate and transient delays', () => {
  const classifier = between(
    migration,
    'create or replace function public.catalog_provider_failure_class(',
    '\ncreate or replace function public.catalog_provider_retry_interval(',
  );
  const retry = between(
    migration,
    'create or replace function public.catalog_provider_retry_interval(',
    '\ncreate table if not exists public.catalog_episode_probe_state (',
  );

  assert.ok(classifier.includes("then 'viewer_priority'"));
  assert.ok(classifier.includes("then 'background_busy'"));
  assert.ok(classifier.includes("then 'authentication'"));
  assert.ok(classifier.includes("then 'forbidden'"));
  assert.ok(classifier.includes("then 'rate_limited'"));
  assert.ok(classifier.includes("then 'transient'"));

  assert.ok(retry.includes(
    "when 'viewer_priority' then interval '1 minute'",
  ));
  assert.ok(retry.includes(
    "when 'background_busy' then interval '2 minutes'",
  ));
  assert.ok(retry.includes(
    "when 'authentication' then interval '24 hours'",
  ));
  assert.ok(retry.includes(
    "when 'forbidden' then interval '24 hours'",
  ));
  assert.match(retry, /when 'rate_limited' then make_interval\(/);
  assert.match(retry, /when 'transient' then make_interval\(/);
});

test('episode candidates preserve fair ordering and exclude future retry rows', () => {
  const candidates = between(
    migration,
    'create or replace function public.catalog_episode_probe_candidates(',
    '\n-- Preserve the exact backlog-priority contract',
  );

  assert.ok(candidates.includes(
    'left join public.catalog_episode_probe_state retry',
  ));
  assert.ok(candidates.includes(
    'retry.provider_identity_id = membership.provider_identity_id',
  ));
  assert.ok(candidates.includes(
    'retry.variant_id = membership.parent_variant_id',
  ));
  assert.match(
    candidates,
    /retry\.provider_identity_id is null\s*or retry\.next_retry_at <= now\(\)/,
  );
  assert.ok(candidates.includes('bool_or(cache.audio_probed_at is not null)'));
  assert.ok(candidates.includes('row_number() over ('));
  assert.match(
    candidates,
    /when not due\.parent_has_probe and due\.parent_due_rank = 1 then 0/,
  );
  assert.ok(candidates.includes(
    'limit greatest(1, least(100, coalesce(p_limit, 4)))',
  ));
});

test('series inventory candidates respect source-account backoff without cross-user blocking', () => {
  const candidates = between(
    migration,
    'create or replace function public.catalog_series_inventory_candidates(',
    '\nrevoke all on function public.catalog_sanitize_provider_failure_code',
  );

  assert.ok(candidates.includes(
    'left join public.catalog_provider_inventory_backoff provider_backoff',
  ));
  assert.ok(candidates.includes(
    'provider_backoff.source_id = source.id',
  ));
  assert.ok(candidates.includes(
    'provider_backoff.provider_identity_id = identity.identity_id',
  ));
  assert.match(
    candidates,
    /provider_backoff\.provider_identity_id is null\s*or provider_backoff\.next_retry_at <= now\(\)/,
  );
  assert.ok(candidates.includes(
    'inventory.next_retry_at nulls first',
  ));
  assert.ok(candidates.includes(
    "legacy_parent.item_type = 'series'",
  ));

  const outcome = between(
    migration,
    'create or replace function public.record_catalog_provider_inventory_outcome(',
    '\n-- Preserve the exact return contract',
  );
  assert.match(outcome, /'catalog-provider-inventory-backoff:' \|\| p_source::text/);
  assert.match(outcome, /insert into public\.catalog_provider_inventory_backoff as backoff \(\s*source_id,/);
  assert.match(outcome, /on conflict \(source_id\) do update set/);
  assert.match(outcome, /where backoff\.source_id = p_source/);
});

test('all retry and backoff RPCs are service-role-only', () => {
  for (const name of [
    'catalog_episode_probe_retry_state',
    'record_catalog_episode_probe_outcome',
    'catalog_provider_inventory_backoff_state',
    'record_catalog_provider_inventory_outcome',
    'catalog_episode_probe_candidates',
    'catalog_series_inventory_candidates',
  ]) {
    assert.match(
      migration,
      new RegExp(
        `revoke all on function public\\.${name}\\([\\s\\S]*?` +
          `from public, anon, authenticated`,
      ),
    );
    assert.match(
      migration,
      new RegExp(
        `grant execute on function public\\.${name}\\([\\s\\S]*?` +
          `to service_role`,
      ),
    );
  }
});
