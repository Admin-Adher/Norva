const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
const app = read('public/js/app.js');
const method = app.slice(app.indexOf('    async refreshLifecycleTimezoneContext() {'), app.indexOf('    async registerPushToken() {'));

function runtime() {
  const calls = [];
  const state = { timezone: 'Asia/Calcutta', now: 10000000, throws: false, result: { ok: true } };
  const sandbox = {
    window: { NorvaCloud: { lifecycleEvents: { recordContext: async zone => {
      calls.push(zone);
      if (state.deferred) return state.deferred;
      return state.result;
    } } } },
    Intl: { DateTimeFormat: () => { if (state.throws) throw Error('unavailable'); return { resolvedOptions: () => ({ timeZone: state.timezone }) }; } },
    Date: { now: () => state.now },
  };
  const instance = vm.runInNewContext(`new (class { ${method} })()`, sandbox);
  instance.currentUser = { id: 'internal-test-one' };
  return { instance, state, calls };
}

test('observed timezone is reported without an FCM token or analytics permission', async () => {
  const r = runtime();
  await r.instance.refreshLifecycleTimezoneContext();
  assert.deepEqual(r.calls, ['Asia/Calcutta']);
  await r.instance.refreshLifecycleTimezoneContext();
  assert.equal(r.calls.length, 1);
  r.state.now += 3600001;
  await r.instance.refreshLifecycleTimezoneContext();
  assert.equal(r.calls.length, 2);
});

test('timezone and account changes report immediately; explicit UTC is valid', async () => {
  const r = runtime();
  await r.instance.refreshLifecycleTimezoneContext();
  r.state.timezone = 'Asia/Dhaka';
  await r.instance.refreshLifecycleTimezoneContext();
  r.instance.currentUser = { id: 'internal-test-two' };
  await r.instance.refreshLifecycleTimezoneContext();
  r.state.timezone = 'UTC';
  await r.instance.refreshLifecycleTimezoneContext();
  assert.deepEqual(r.calls, ['Asia/Calcutta', 'Asia/Dhaka', 'Asia/Dhaka', 'UTC']);
});

test('missing timezone, unauthenticated sessions and paired screens never invent UTC', async () => {
  const r = runtime();
  for (const zone of ['', null, undefined, 'x'.repeat(65)]) {
    r.state.timezone = zone;
    await r.instance.refreshLifecycleTimezoneContext();
  }
  r.state.throws = true;
  await r.instance.refreshLifecycleTimezoneContext();
  r.state.throws = false;
  r.state.timezone = 'Europe/Paris';
  r.instance.currentUser = null;
  await r.instance.refreshLifecycleTimezoneContext();
  r.instance.currentUser = { id: 'paired', device: true };
  await r.instance.refreshLifecycleTimezoneContext();
  assert.equal(r.calls.length, 0);
});

test('failed observation can retry; simultaneous reports are coalesced', async () => {
  const r = runtime();
  r.state.result = null;
  await r.instance.refreshLifecycleTimezoneContext();
  r.state.result = { ok: true };
  let release;
  r.state.deferred = new Promise(resolve => { release = resolve; });
  const pending = r.instance.refreshLifecycleTimezoneContext();
  await r.instance.refreshLifecycleTimezoneContext();
  assert.equal(r.calls.length, 2);
  release({ ok: true });
  await pending;
  await r.instance.refreshLifecycleTimezoneContext();
  assert.equal(r.calls.length, 2);
});

test('observations bind only to authenticated identity and no layer defaults timezone to UTC', () => {
  const api = read('public/js/cloudApi.js');
  const cloud = read('supabase/functions/norva-cloud/index.ts');
  const sql = read('supabase/migrations/20260905160000_lifecycle_timezone_provenance.sql');
  assert.match(app, /void this\.refreshLifecycleTimezoneContext\(\)/);
  assert.match(app, /visibilitychange.*this\._lifecycleTimezoneListener/);
  assert.doesNotMatch(app, /let timezone = 'UTC'|timeZone \|\| 'UTC'/);
  assert.match(api, /timezone: details\.timezone \|\| null/);
  assert.match(app, /timezoneObserved: Boolean\(timezone\)/);
  assert.match(api, /timezoneObserved: details\.timezoneObserved === true/);
  assert.match(cloud, /const timezone = body\.timezoneObserved === true \? stringOr\(body\.timezone, ""\)\.slice\(0, 64\) : ""/);
  assert.match(cloud, /p_user_id: user\.id, p_timezone: body\.timezone/);
  assert.match(cloud, /Object\.keys\(body\)\.some\(\(key\) => key !== "timezone"\)/);
  assert.match(sql, /revoke all on function public\.norva_record_lifecycle_timezone\(uuid,text\) from public,anon,authenticated/);
});
