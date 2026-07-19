const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

test('cross-device progress is ordered atomically by capture time', () => {
    const migration = read('supabase/migrations/20260719150000_watch_history_causal_upsert.sql');
    const edge = read('supabase/functions/norva-cloud/index.ts');

    assert.ok(migration.includes('on conflict (profile_id, source_id, item_type, item_id)'));
    assert.ok(migration.includes('excluded.watched_at >= cloud_watch_history.watched_at'));
    assert.ok(migration.includes('source_id is not distinct from p_source_id'),
        'a rejected stale write must return the authoritative row even for orphaned sources');
    assert.ok(migration.includes('data = cloud_watch_history.data || excluded.data'),
        'accepted delta heartbeats must preserve rich history metadata');
    assert.ok(migration.includes('when p_completed is not null then p_completed'));
    assert.ok(migration.includes('when excluded.progress_seconds >= 60 then false'));
    assert.ok(edge.includes('db.rpc("upsert_cloud_watch_history_causal"'));
    assert.ok(edge.includes('data: recordOrEmpty(body.data)'));
    assert.ok(!edge.includes('existingQuery'),
        'pre-conflict scalar/JSON snapshots must not overwrite fresher concurrent data');
    assert.ok(!edge.includes('body.force !== true'),
        'an older delayed exit packet must not bypass causal ordering');
    assert.ok(edge.includes('Math.min(incomingWatchedAtMs, receivedAtMs)'),
        'future-skewed device clocks must not freeze resume progress');
});

test('the web player timestamps every progress capture, including exit saves', () => {
    const watch = read('public/js/pages/WatchPage.js');
    const start = watch.indexOf('async saveProgress(options = {})');
    const body = watch.slice(start);
    assert.ok(body.includes('watchedAt: new Date().toISOString()'));
    assert.ok(body.includes("window.API.request('POST', '/history', payload)"));

    const castStart = watch.indexOf('async saveCastProgress()');
    const castBody = watch.slice(castStart, watch.indexOf('\n    }', castStart));
    assert.ok(castBody.includes('const watchedAt = new Date().toISOString()'));
    assert.ok(castBody.includes('progress, duration, watchedAt, data'),
        'Cast progress must preserve receiver capture time across delayed writes');
});

test('gateway measured seek offsets survive the playback edge response', () => {
    const edge = read('supabase/functions/norva-playback/index.ts');
    for (const field of [
        'requestedSeekOffset',
        'actualStartOffset',
        'localSeekTarget',
        'sourceTimestamps',
    ]) {
        assert.ok(edge.includes(`${field}: gateway.${field}`),
            `${field} must be exposed to the web player`);
        assert.ok(edge.includes(`gatewayBody.${field}`),
            `${field} must be read from the media gateway response`);
    }
});

test('targeted resume reads bypass the per-tab history cache', () => {
    const cloud = read('public/js/cloudApi.js');
    const start = cloud.indexOf('getItem: (params = {}) =>');
    const body = cloud.slice(start, cloud.indexOf('\n            save:', start));
    assert.ok(body.includes("request('GET', `/history${query(params)}`)"));
    assert.ok(!body.includes('cachedGet('),
        'another device cannot invalidate a process-local targeted-history cache');

    const deviceStart = cloud.indexOf('getItem: (params = {}) =>', start + body.length);
    const deviceBody = cloud.slice(deviceStart, cloud.indexOf('\n                save:', deviceStart));
    assert.ok(deviceBody.includes('`/device/history${query(params)}`'));
    assert.ok(!deviceBody.includes('cachedGet('),
        'a paired TV must see a phone/web save immediately too');
});

test('targeted resume never borrows a provider-local item id from another source', () => {
    const edge = read('supabase/functions/norva-cloud/index.ts');
    const start = edge.indexOf('async function getHistoryItem(');
    const body = edge.slice(start, edge.indexOf('\nasync function listHistory(', start));
    assert.ok(body.includes('fallback = fallback.is("source_id", null)'),
        'source renewal may only inherit explicitly orphaned legacy history');
    assert.ok(!body.includes('base().order("updated_at"'),
        'an exact-source lookup must not fall back to another provider');
});
