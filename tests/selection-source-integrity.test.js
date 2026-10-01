const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const modulePromise = import('../supabase/functions/_shared/selection-source-integrity.mjs');
const discovery = import('../supabase/functions/_shared/discovery-catalog.mjs');
const userId = '12345678-1234-4234-8234-123456789012';
const now = Date.parse('2026-10-01T12:00:00Z');
const target = 'https://example.invalid/owned-file.mp4';
const digest = createHash('sha256').update(target).digest('hex');
const externalId = 'norva-selection:movie:' + 'a'.repeat(64);
const job = () => ({ external_id:externalId, url_sha256:digest, state:'failed',
  error_code:'SELECTION_AUDIO_SOURCE_TRUNCATED', completed_at:'2026-10-01T11:00:00Z' });
async function row(extra = {}) {
  return { user_id:userId, source_id:await (await discovery).discoverySourceId(userId),
    item_type:'movie', external_id:externalId, playback_hint:{ targetUrl:target }, ...extra };
}
function database(data) {
  const calls = [];
  return { calls, from(table) {
    assert.equal(table,'catalog_selection_audio_jobs');
    const query = { select(fields) { assert.equal(fields,'external_id,url_sha256,state,error_code,completed_at'); return query; },
      in(field,ids) { assert.equal(field,'external_id'); assert.ok(ids.length <= 50); calls.push(ids); return query; },
      eq() { return query; }, then(resolve) { return Promise.resolve({ data, error:null }).then(resolve); } };
    return query;
  } };
}
test('only a current owned exact-file defect becomes a bounded advisory', async () => {
  const { attachSelectionSourceIntegrity } = await modulePromise;
  const variants = [await row(), await row({ playback_hint:{ targetUrl:target+'?replacement=1' } }),
    await row({ user_id:'another-owner' }), await row({ source_id:'another-source' }),
    await row({ item_type:'series' })];
  variants.forEach(v => { v.__source_integrity = { status:'untrusted' }; });
  const db = database([job()]);
  assert.equal(await attachSelectionSourceIntegrity({ db,userId,variants,now }),1);
  assert.deepEqual(variants[0].__source_integrity,{ status:'incomplete',checkedAt:job().completed_at.replace('Z','.000Z') });
  for (const v of variants.slice(1)) assert.equal(v.__source_integrity,undefined);
  assert.equal(db.calls.length,1);
  assert.doesNotMatch(JSON.stringify(variants[0].__source_integrity),/https|sha|job|error/);
});
test('generic, stale, future, replaced, recovered and unfinished diagnoses do not warn', async () => {
  const { attachSelectionSourceIntegrity } = await modulePromise;
  for (const change of [{ error_code:'SELECTION_AUDIO_GATEWAY_REJECTED' },{ state:'retry_wait' },{ state:'completed' },
    { completed_at:'2026-09-29T11:00:00Z' },{ completed_at:'2026-10-02T11:00:00Z' },
    { completed_at:null },{ url_sha256:'b'.repeat(64) }]) {
    const variants = [await row()];
    assert.equal(await attachSelectionSourceIntegrity({ db:database([{ ...job(),...change }]),userId,variants,now }),0);
    assert.equal(variants[0].__source_integrity,undefined);
  }
});
test('unowned lists never query the shared job store', async () => {
  const { attachSelectionSourceIntegrity } = await modulePromise;
  const db = database([job()]);
  assert.equal(await attachSelectionSourceIntegrity({ db,userId,variants:[await row({ user_id:'other' })],now }),0);
  assert.equal(db.calls.length,0);
});

test('public advisory excludes internal evidence and native/web detail changes clear it', async () => {
  const { sanitizeCatalogVariant } = await import('../supabase/functions/_shared/catalog-public-view.mjs');
  const variant = sanitizeCatalogVariant({ source_integrity:{ status:'incomplete',checkedAt:'2026-10-01T11:00:00Z',
    url:target, jobId:'private', error:'private', profile:{ secret:true } } });
  assert.deepEqual(variant.source_integrity,{ status:'incomplete',checkedAt:'2026-10-01T11:00:00.000Z' });
  assert.doesNotMatch(JSON.stringify(variant),/private|secret|https/);
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
  const hidden = new Set(['hidden']);
  const warning = { textContent:'', classList:{ toggle(name,hide) { hide ? hidden.add(name) : hidden.delete(name); } } };
  const context = vm.createContext({ window:{}, Date:class extends Date { static now() { return now; } },
    document:{ getElementById(id) { assert.equal(id,'movie-detail-integrity'); return warning; } },
    NorvaI18n:{ t() { return 'Cette version a été détectée comme incomplète.'; } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/js/pages/MoviesPage.js'),'utf8'),context);
  const render = context.window.MoviesPage.prototype.updateSourceIntegrityWarning;
  render.call({},variant);
  assert.equal(hidden.has('hidden'),false);
  assert.match(warning.textContent,/incomplète/);
  // A healthy selected version must not inherit the representative's warning.
  render.call({},{});
  assert.equal(hidden.has('hidden'),true); assert.equal(warning.textContent,'');
  for (const checkedAt of ['2026-09-29T11:00:00Z','2026-10-02T11:00:00Z','invalid']) {
    render.call({},{ source_integrity:{ status:'incomplete',checkedAt } });
    assert.equal(hidden.has('hidden'),true); assert.equal(warning.textContent,'');
  }
});
