'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const edge = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
  const a = edge.indexOf(start), b = edge.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return edge.slice(a, b);
}
const user = '10000000-0000-4000-8000-000000000001';
const source = '10000000-0000-4000-8000-000000000002';
const jobId = '10000000-0000-4000-8000-000000000003';
const variant = '10000000-0000-4000-8000-000000000004';
const code = [
  section('async function requireLanguageValidationEntitlement(', '\nasync function loadOwnedMovieLanguageCertificate('),
  section('async function requirePlaybackEntitlement(', '\nasync function requirePlaybackCapacity('),
  section('async function revalidateLanguageValidationClaim(', '\nfunction gatewayProviderDrainAttested('),
  section('async function getPlaybackLanguageValidation(', '\nfunction requireLanguageValidationWaitUntil('),
  section('async function startPlaybackLanguageValidation(', '\nfunction exactLanguageValidationIndices('),
].map(text => stripTypeScriptTypes(text)).join('\n');
class HttpError extends Error {
  constructor(status, message, details) {
    super(message); this.status = status;
    // Normalize the VM realm's diagnostic record, not the production result.
    this.details = details ? { ...details } : details;
  }
}
function fixture(options = {}) {
  const events = [];
  const state = {
    account: { id: user }, projection: null, origin: 'automatic', sourceVisible: true,
    playbackAllowed: false, ...options,
  };
  const exactProfile = {
    variantId: variant, audioTracks: [{ index: 1 }], fileSizeBytes: 12345,
    profileProbedAt: '2026-09-11T14:00:00Z', profile: {},
  };
  const job = { id: jobId, requested_by: user, source_id: source, external_id: 'file-1',
    state: 'queued', expected_audio_indices: [1] };
  const db = {
    auth: { admin: { async getUserById(id) {
      events.push('auth-read'); assert.equal(id, user);
      if (state.authThrows) throw Error('private upstream response');
      return { data: { user: state.account }, error: state.authError || null };
    } } },
    from(table) {
      const where = {};
      const q = { select(fields) { events.push({ table, fields }); return q; },
        eq(key, value) { where[key] = value; return q; },
        async maybeSingle() {
          if (table === 'cloud_entitlement_projection') {
            assert.deepEqual(where, { user_id: user });
            if (state.dbThrows) throw Error('private database response');
            return { data: state.projection, error: state.projectionError || null };
          }
          assert.equal(table, 'catalog_file_audio_validation_jobs');
          assert.equal(where.id, jobId); assert.equal(where.requested_by, user);
          if (where.source_id) assert.equal(where.source_id, source);
          return { data: state.jobMissing ? null : { ...job, request_origin: state.origin }, error: state.jobError || null };
        } };
      return q;
    },
    rpc() { throw Error('unexpected database mutation'); },
  };
  const visible = async (s, u) => {
    events.push('source-check'); assert.equal(s, source); assert.equal(u, user);
    if (!state.sourceVisible) throw new HttpError(403, 'Source unavailable');
  };
  const context = vm.createContext({
    HttpError, Date, Set, PLAYBACK_SESSION_UUID_PATTERN: /^[0-9a-f-]{36}$/i,
    recordOrEmpty: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    stringOr: (v, fallback) => typeof v === 'string' ? v : fallback,
    stringOrNull: v => v ?? null,
    throwDb: () => { throw new HttpError(503, 'Database unavailable'); },
    getEntitlementDecision: async () => { events.push('playback-entitlement'); return { allowed: true, limits: { concurrent_streams: state.playbackAllowed ? 1 : 0 } }; },
    limitNumber: (limits, key, fallback) => limits[key] ?? fallback,
    throwEntitlementRequired: () => { throw new HttpError(402, 'Playback subscription required'); },
    assertSourceCatalogVisible: visible, assertOwnedSource: visible,
    languageValidationAccessWasRevoked: e => [401, 402, 403, 404].includes(e.status),
    exactLanguageValidationIndices: value => [...value],
    exactPositiveSafeInteger: value => Number.isSafeInteger(value) && value > 0 ? value : null,
    loadExactLanguageValidationProfile: async () => { events.push('profile-read'); return exactProfile; },
    loadExactEpisodeLanguageValidationProfile: async () => { events.push('episode-profile-read'); return exactProfile; },
    languageValidationProfileFingerprint: async () => 'fingerprint',
    sameIntegerSet: (a, b) => a.length === b.length && a.every(v => b.includes(v)),
    loadLanguageValidationIdentity: async () => state.identity || 'provider-1',
    loadLanguageValidationCache: async () => ({ audio_tracks: [{ index: 1 }] }),
    cacheMatchesObservedFileProfile: () => true, exactCachedAudioTracks: v => v,
    cancelLanguageValidationJob: async () => { events.push('cancel'); },
    languageValidationJobScheduleDue: () => true,
    requireLanguageValidationWaitUntil: () => {},
    scheduleLanguageValidationJob: () => { events.push('schedule'); },
    languageValidationPendingResponse: v => v, boundedNullableInt: v => v ?? null,
    readJson: async req => req,
  });
  vm.runInContext(code, context);
  const claim = { jobId, requestedBy: user, sourceId: source, itemId: 'file-1',
    itemType: 'movie', variantId: variant, identityKey: 'provider-1', expectedAudioIndices: [1],
    fileSizeBytes: 12345, profileProbedAt: exactProfile.profileProbedAt, profileFingerprint: 'fingerprint',
    requestOrigin: 'automatic' }; // Deliberately untrusted hint: the DB row must win.
  return { state, events, context, db, claim,
    access: () => context.requireAutomaticLanguageEnrichmentAccess(user, db),
    revalidate: () => context.revalidateLanguageValidationClaim(db, claim),
    poll: () => context.getPlaybackLanguageValidation(jobId, user, db),
  };
}

for (const status of [null, 'trialing', 'active', 'grace', 'past_due', 'cancelled_at_period_end', 'expired', 'unknown']) {
  test(`automatic maintenance permits ${status ?? 'no subscription'} without granting playback`, async () => {
    const h = fixture({ projection: status ? { status } : null });
    await h.access();
    assert.ok(!h.events.includes('playback-entitlement'));
    assert.deepEqual(h.events.filter(v => v.table).map(v => [v.table, v.fields]), [['cloud_entitlement_projection', 'status']]);
    await assert.rejects(h.context.requirePlaybackEntitlement(user, h.db), { status: 402 });
    await assert.rejects(h.context.requireLanguageValidationEntitlement(user, h.db), { status: 402 });
  });
}
for (const status of ['revoked', 'refunded', 'fraud']) {
  test(`${status} remains authoritative even with admin or spoofed metadata`, async () => {
    const h = fixture({ projection: { status }, account: { id: user, app_metadata: { role: 'admin' }, user_metadata: { enrichment: true } } });
    await assert.rejects(h.access(), { status: 403, details: { code: 'LANGUAGE_ENRICHMENT_ACCESS_REVOKED' } });
  });
}
for (const [name, account] of [
  ['missing', null], ['wrong owner', { id: source }], ['deleted', { id: user, deleted_at: '2026-09-01' }],
  ['banned', { id: user, banned_until: '2999-01-01T00:00:00Z' }], ['malformed ban', { id: user, banned_until: 'invalid' }],
]) test(`${name} account cannot enrich`, async () => {
  const h = fixture({ account }); await assert.rejects(h.access(), { status: 403 });
  assert.ok(!h.events.some(v => v.table));
});
test('an elapsed ban is not treated as a current ban', async () => {
  await fixture({ account: { id: user, banned_until: '2000-01-01T00:00:00Z' } }).access();
});
for (const options of [
  { authError: { status: 503 } }, { authThrows: true }, { projectionError: { message: 'private SQL' } },
  { dbThrows: true }, { projection: undefined }, { projection: {} }, { projection: { status: 'future_unrecognized_status' } },
]) test(`uncertain auth/projection read fails closed and retryable ${JSON.stringify(options)}`, async () => {
  const h = fixture(options);
  await assert.rejects(h.access(), e => {
    assert.equal(e.status, 503); assert.equal(e.details.code, 'LANGUAGE_ENRICHMENT_ACCESS_RETRY');
    assert.doesNotMatch(e.message, /private/); return true;
  });
});
test('Auth user_not_found is a denial, not an outage', async () => {
  await assert.rejects(fixture({ authError: { code: 'user_not_found', status: 404 } }).access(), { status: 403 });
});

test('the actual worker revalidation permits a free owner, and rechecks later revocation', async () => {
  const h = fixture();
  assert.equal((await h.revalidate()).identityKey, 'provider-1');
  assert.ok(!h.events.includes('playback-entitlement'));
  h.state.projection = { status: 'revoked' };
  await assert.rejects(h.revalidate(), { status: 409, details: { code: 'LANGUAGE_VALIDATION_ACCESS_REVOKED' } });
  assert.equal(h.events.filter(v => v === 'profile-read').length, 1);
  assert.equal(h.events.filter(v => v === 'auth-read').length, 2);
});
test('automatic episodes use the same authorization with their separate exact profile proof', async () => {
  const h = fixture(); h.claim.itemType = 'episode'; await h.revalidate();
  assert.ok(h.events.includes('episode-profile-read')); assert.ok(!h.events.includes('profile-read'));
});
for (const origin of ['manual', 'legacy', undefined, 'unrecognized']) {
  test(`a spoofed automatic claim never relaxes a stored ${origin ?? 'absent'} origin`, async () => {
    const h = fixture({ origin });
    await assert.rejects(h.revalidate(), { details: { code: 'LANGUAGE_VALIDATION_ACCESS_REVOKED' } });
    assert.ok(h.events.includes('playback-entitlement')); assert.ok(!h.events.includes('auth-read'));
    assert.ok(!h.events.includes('profile-read'));
  });
}
test('paid manual jobs retain their existing path', async () => {
  const h = fixture({ origin: 'manual', playbackAllowed: true }); await h.revalidate();
  assert.ok(h.events.includes('playback-entitlement')); assert.ok(!h.events.includes('auth-read'));
});
test('unknown origin/owner rows and hidden sources fail closed before profile/network work', async () => {
  for (const options of [{ jobMissing: true }, { jobError: {} }, { sourceVisible: false }]) {
    const h = fixture(options); await assert.rejects(h.revalidate());
    assert.ok(!h.events.includes('profile-read')); assert.ok(!h.events.includes('auth-read'));
  }
});
test('provider identity drift remains a terminal mismatch', async () => {
  const h = fixture({ identity: 'other-provider' });
  await assert.rejects(h.revalidate(), { details: { code: 'LANGUAGE_VALIDATION_IDENTITY_CHANGED' } });
});
test('a free caller cannot poll/schedule or cancel its automatic background job', async () => {
  const h = fixture(); await assert.rejects(h.poll(), { status: 402 });
  assert.ok(!h.events.includes('cancel')); assert.ok(!h.events.includes('schedule'));
});
test('polling a truly revoked automatic job still cancels it', async () => {
  const h = fixture({ projection: { status: 'fraud' } });
  await assert.rejects(h.poll(), { status: 403 }); assert.ok(h.events.includes('cancel'));
  assert.ok(!h.events.includes('schedule'));
});
test('polling a manual job without rights retains cancellation', async () => {
  const h = fixture({ origin: 'manual' }); await assert.rejects(h.poll(), { status: 402 });
  assert.ok(h.events.includes('cancel'));
});
test('paid callers can still poll/schedule their automatic jobs', async () => {
  const h = fixture({ playbackAllowed: true }); assert.equal((await h.poll()).status, 202);
  assert.ok(h.events.includes('schedule')); assert.ok(!h.events.includes('cancel'));
});
test('manual POST rejects origin injection and still requires a subscription', async () => {
  const h = fixture(), body = { sourceId: source, itemType: 'movie', itemId: 'file-1', expectedAudioIndices: [1] };
  for (const field of ['requestOrigin', 'request_origin', 'automaticUnknowns']) {
    await assert.rejects(h.context.startPlaybackLanguageValidation({ ...body, [field]: 'automatic' }, user, h.db), { status: 400 });
  }
  await assert.rejects(h.context.startPlaybackLanguageValidation(body, user, h.db), { status: 402 });
  assert.ok(!h.events.includes('profile-read')); assert.ok(!h.events.includes('schedule'));
});
test('worker revalidates after provider leases and before final publication', () => {
  const worker = section('async function processOneLanguageValidationTrack(', '\nasync function finalizeLanguageValidationTrackWindows(');
  assert.ok(worker.indexOf('await revalidateLanguageValidationClaim(db, claim)') < worker.indexOf('await resolvePlaybackTarget('));
  assert.match(worker, /providerLeaseClaimed = true;[\s\S]*await assertProviderCircuitClosed[\s\S]*await assertLanguageValidationIdle[\s\S]*await revalidateLanguageValidationClaim\(db, claim\)/);
  assert.match(worker, /await revalidateLanguageValidationClaim\(db, claim\);[\s\S]*await finalizeLanguageValidationTrackWindows/);
  const finalize = section('async function finalizeLanguageValidationTrackWindows(', '\nasync function finalizeLanguageValidationJob(');
  assert.match(finalize, /await revalidateLanguageValidationClaim\(db, claim\);\s*await finalizeLanguageValidationJob/);
});
test('new permission performs only narrow server reads; no billing or metadata overrides', () => {
  const access = section('async function requireAutomaticLanguageEnrichmentAccess(', '\nasync function requireLanguageValidationJobAccess(');
  assert.doesNotMatch(access, /getEntitlementDecision|\.rpc\(|\.insert\(|\.update\(|\.upsert\(|user_metadata|app_metadata/);
  assert.match(edge, /languageEnrichmentAccessProtocol: 1/);
});

for (const condition of ['browse-only', 'banned', 'auth-unavailable']) {
  test(`Supabase client wire contract: ${condition}, GET only and no real network`, async () => {
    const { createClient } = require('@supabase/supabase-js');
    const requests = [];
    const db = createClient('https://enrichment-fixture.invalid', 'service-fixture', {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: async (input, init = {}) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        assert.equal(url.origin, 'https://enrichment-fixture.invalid');
        assert.equal(init.method ?? 'GET', 'GET');
        requests.push(url.pathname);
        let body;
        if (url.pathname === `/auth/v1/admin/users/${user}`) {
          if (condition === 'auth-unavailable') return new Response(JSON.stringify({ msg: 'unavailable' }), { status: 503 });
          body = { id: user, ...(condition === 'banned' ? { banned_until: '2999-01-01T00:00:00Z' } : {}) };
        } else {
          assert.equal(url.pathname, '/rest/v1/cloud_entitlement_projection');
          assert.equal(url.searchParams.get('user_id'), `eq.${user}`);
          assert.equal(url.searchParams.get('select'), 'status');
          body = [];
        }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      } },
    });
    const h = fixture();
    const access = h.context.requireAutomaticLanguageEnrichmentAccess(user, db);
    if (condition === 'browse-only') {
      await access; assert.equal(requests.length, 2);
    } else {
      await assert.rejects(access, { status: condition === 'banned' ? 403 : 503 });
      assert.ok(requests.every(v => v.startsWith('/auth/v1/')));
    }
    assert.ok(!h.events.includes('playback-entitlement'));
  });
}
