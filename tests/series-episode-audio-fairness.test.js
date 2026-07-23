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
    '20260723100000_fair_series_episode_audio_candidates.sql',
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

const probe = between(
  migration,
  'create or replace function public.catalog_episode_probe_candidates(',
  '\nrevoke all on function public.catalog_episode_probe_candidates(',
);
const lid = between(
  migration,
  'create or replace function public.catalog_episode_lid_candidates(',
  '\nrevoke all on function public.catalog_episode_lid_candidates(',
);

test('fairness migration is atomic and leaves both queues service-role-only', () => {
  assert.match(migration, /\nbegin;\s*\n/);
  assert.match(migration, /commit;\s*$/);
  for (const name of [
    'catalog_episode_probe_candidates',
    'catalog_episode_lid_candidates',
  ]) {
    assert.match(
      migration,
      new RegExp(
        `revoke all on function public\\.${name}\\([\\s\\S]*?` +
          `grant execute on function public\\.${name}\\([\\s\\S]*?to service_role;`,
      ),
    );
  }
});

test('episode probe queue covers untouched parents before deepening a series', () => {
  assert.ok(probe.includes('with owned_memberships as ('));
  assert.match(
    probe,
    /bool_or\(cache\.audio_probed_at is not null\) over \(\s*partition by\s*membership\.user_id,\s*membership\.source_id,\s*membership\.parent_series_id\s*\) as parent_has_probe/,
  );
  assert.match(
    probe,
    /row_number\(\) over \(\s*partition by\s*owned\.user_id,\s*owned\.source_id,\s*owned\.parent_series_id/,
  );
  assert.match(
    probe,
    /order by\s*case\s*when not due\.parent_has_probe and due\.parent_due_rank = 1 then 0\s*else 1\s*end,\s*due\.parent_due_rank,\s*due\.parent_has_probe asc,/,
  );
  assert.match(
    probe,
    /owned\.audio_probed_at is null\s*or owned\.audio_probed_at < now\(\) - interval '180 days'/,
  );
});

test('episode LID queue treats prior cascade and Whisper work as parent coverage', () => {
  assert.ok(lid.includes('from public.catalog_audio_lid_attempts attempt'));
  assert.ok(lid.includes("attempt.item_type = 'episode'"));
  assert.ok(lid.includes('cache.audio_lang_verified_at is not null'));
  assert.ok(lid.includes('cache.audio_whisper_attempted_at is not null'));
  assert.ok(lid.includes('cache.audio_whisper_retry_at is not null'));
  assert.match(
    lid,
    /bool_or\(owned\.file_has_lid_history\) over \(\s*partition by\s*owned\.user_id,\s*owned\.source_id,\s*owned\.parent_series_id/,
  );
  assert.match(
    lid,
    /row_number\(\) over \(\s*partition by\s*scored\.user_id,\s*scored\.source_id,\s*scored\.parent_series_id/,
  );
  assert.match(
    lid,
    /order by\s*case\s*when not due\.parent_has_lid_history and due\.parent_due_rank = 1 then 0\s*else 1\s*end,\s*due\.parent_due_rank,\s*due\.parent_has_lid_history asc,/,
  );
});

test('fair ordering preserves ownership, provider, ambiguity and retry guards', () => {
  for (const body of [probe, lid]) {
    assert.ok(body.includes('membership.user_id = p_user'));
    assert.ok(body.includes('(p_source is null or membership.source_id = p_source)'));
    assert.ok(body.includes('source.user_id = membership.user_id'));
    assert.ok(body.includes('source.deleted_at is null'));
    assert.ok(body.includes('source.enabled = true'));
    assert.ok(body.includes("source.sync_status = 'ready'"));
    assert.ok(body.includes('catalog_source_provider_identities identity'));
    assert.ok(body.includes('identity.identity_id = membership.provider_identity_id'));
    assert.ok(body.includes("cache.item_type = 'episode'"));
    assert.ok(body.includes('cache.external_id = membership.episode_id'));
    assert.ok(body.includes(
      'conflicting.parent_series_id is distinct from membership.parent_series_id',
    ));
    assert.ok(body.includes(
      'limit greatest(1, least(100, coalesce(p_limit, 4)))',
    ));
  }

  assert.ok(lid.includes('scored.audio_lang_verified_at is null'));
  assert.match(
    lid,
    /coalesce\(\s*scored\.audio_whisper_retry_at,\s*scored\.audio_whisper_attempted_at \+ interval '30 days',\s*'-infinity'::timestamptz\s*\) <= now\(\)/,
  );
  assert.match(
    lid,
    /in \('und', 'un', 'mis', 'mul', 'zxx', 'nar', 'unknown'\)/,
  );
});
