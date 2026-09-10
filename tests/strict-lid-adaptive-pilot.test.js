const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync('ops/hetzner/scripts/check-strict-lid-adaptive-evidence-batch-20260910.py', 'utf8').replace(/\r\n/g, '\n');
const section = (name, next) => source.split(`def ${name}(`)[1].split(`def ${next}(`)[0];

test('adaptive pilot is capped at three new files and one per canonical provider', () => {
    assert.match(source, /^MAX_SAMPLES = 3$/m);
    assert.match(source, /PARTITION BY identity_key ORDER BY/);
    assert.match(source, /FROM ranked WHERE preference=1[\s\S]*LIMIT 3/);
    assert.match(source, /len\(\{row\['identity_key'\] for row in rows\}\) != len\(rows\)/);
    assert.match(source, /AND NOT EXISTS\(SELECT 1 FROM public\.catalog_file_audio_validation_jobs j\s+WHERE j\.identity_key=i\.identity_id::text AND j\.item_type='movie' AND j\.external_id=v\.external_id\)/);
    assert.doesNotMatch(source, /UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE\s+|prepare-replacement|retest-after-fix/);
});

test('eligibility is exact, internal, fresh and unverified, never a provider fetch', () => {
    const eligible = section('eligible_cte', 'read_query');
    for (const fragment of [
        'public.admin_internal_accounts', 'account.deleted_at IS NULL', 'account.banned_until',
        's.enabled AND s.deleted_at IS NULL', "s.sync_status='ready'",
        'h.active_generation_id=v.generation_id', 'i.source_id=v.source_id AND i.user_id=v.user_id',
        'c.audio_lang_verified_at IS NULL', 'catalog_audio_track_indexes(c.audio_tracks)=public.vod_language_profile_audio_indices(v.codec_profile)',
        "profile->>'probeSource' IN ('gatewayinband','gatewayprobe')", "profile->'metadataComplete'='true'::jsonb",
        "now()-interval '48 hours'", "jsonb_array_length(profile->'audioTracks')=1", "'und')='und'",
    ]) assert.ok(eligible.includes(fragment), fragment);
    assert.match(source, /PGOPTIONS=-c default_transaction_read_only=on/);
    assert.match(source, /BEGIN READ ONLY; SET LOCAL statement_timeout='20s'/);
    assert.equal((source.match(/urllib\.request\.urlopen\(/g) || []).length, 1);
    assert.match(source, /env\.get\('PORT', '8080'\) \+ '\/health'/);
});

test('prepare and each explicit start require the reviewed release and verified speech sampler', () => {
    assert.match(source, /^EXPECTED_GATEWAY_VERSION = 167$/m);
    assert.match(source, /hashlib\.sha256\(live\.replace\(b'\\r\\n', b'\\n'\)\)\.hexdigest\(\) != expected_hash/);
    for (const field of ['runtimeVerified', 'speechSamplerRuntimeVerified']) {
        assert.ok(source.includes(`engine.get('${field}') is not True`));
    }
    assert.match(source, /engine\.get\('strictLidSpeechSelectionProtocol'\) != 1/);
    assert.match(section('prepare', 'start'), /^expected_hash\):\n    require_release\(expected_hash\)/);
    assert.match(section('start', 'status'), /^sample, expected_hash\):\n    require_release\(expected_hash\)/);
    assert.match(source, /plan\['expectedIndexSha256'\] != expected_hash/);
    assert.equal((source.match(/add_argument\('--expected-index-sha256', required=True\)/g) || []).length, 2);
});

test('the normal RPC is fenced and the private journal prevents uncertain automatic retries', () => {
    const start = section('start', 'status');
    assert.match(start, /row\.get\('startRequestedAt'\) or row\.get\('job'\)/);
    assert.ok(start.indexOf("catalog-file-audio-validation-user:") < start.indexOf("catalog-file-audio-validation:'"));
    assert.match(start, /eligible_cte\(predicate\)/);
    assert.match(start, /profile=%s::jsonb AND audio_tracks=%s::jsonb/);
    assert.match(start, /SET LOCAL ROLE service_role; SELECT public\.start_automatic_catalog_file_audio_validation_job\(/);
    assert.match(start, /literal\(json\.dumps\(row\['audio_tracks'\]\)\)\+'::jsonb', 'false'/);
    assert.ok(start.indexOf("row['startRequestedAt'] = utc_now()") < start.indexOf('result = json.loads(sql('));
    assert.match(start, /'automaticRetry': False/);
    assert.match(source, /fcntl\.flock\(handle, fcntl\.LOCK_EX\)/);
    assert.match(source, /os\.fsync\(handle\.fileno\(\)\)/);
    assert.match(source, /os\.umask\(0o077\)/);
    assert.match(source, /PLAN_PATH\.open\('x', encoding='utf8'\)/);
    assert.match(source, /strict-lid-adaptive-evidence-20260910/);
    assert.match(source, /PLAN_PATH = ROOT \/ 'pilot\.private\.json'/);
});

test('status and stdout expose only closed diagnostics, never private source coordinates', () => {
    const status = section('status', 'main');
    assert.match(status, /value = read_query\(/);
    assert.doesNotMatch(status, /readonly=False|\bsave\(\)/);
    for (const field of ['state', 'errorCode', 'retryAt', 'updatedAt', 'attempts', 'noProgress', 'window', 'windows', 'tracksDone', 'verified', 'quarantined', 'cacheVerified']) {
        assert.ok(status.includes(`'${field}'`), field);
    }
    assert.match(status, /WHEN j\.error_code ~ '\^\[A-Z0-9_\]\{1,80\}\$' THEN j\.error_code ELSE 'OTHER' END/);
    assert.match(status, /'databaseChanged': False/);
    assert.equal((source.match(/\bprint\(/g) || []).length, 2);
    assert.match(source, /print\(json\.dumps\(result\)\)/);
    assert.match(source, /print\(json\.dumps\(\{'ok': False, 'error': 'adaptive_pilot_operation_failed'\}\)\)/);
    assert.doesNotMatch(source, /\bprint\([^\n]*(?:profile|row|stderr|stdout|env|exception)/i);
});
