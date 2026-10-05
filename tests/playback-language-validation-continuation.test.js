'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const edge = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8').replace(/\r\n?/g, '\n');
function section(start, end) {
  const from = edge.indexOf(start); const to = edge.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return edge.slice(from, to);
}

function fixture(options = {}) {
  let now = 1_000_000; let active = 0; let maxActive = 0;
  const calls = []; const logs = []; const order = []; const registered = [];
  const context = vm.createContext({
    Date: { now: () => now }, Promise,
    LANGUAGE_VALIDATION_TASK_BUDGET_MS: 270000,
    LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS: 240000,
    LANGUAGE_VALIDATION_POST_FETCH_RESERVE_MS: 30000,
    languageValidationTasks: new Map(),
    recordOrEmpty: value => value && typeof value === 'object' ? value : {},
    stringOr: (value, fallback) => typeof value === 'string' ? value : fallback,
    console: { info: (label, value) => logs.push({ label, ...value }), warn: () => order.push('caught-error') },
    HttpError: class extends Error {},
    processOneLanguageValidationTrack: async (_db, jobId, deadline) => {
      active++; maxActive = Math.max(maxActive, active);
      const index = calls.length; calls.push({ jobId, deadline, start: now });
      order.push('work-' + index);
      try {
        if (index === 0 && options.cleanupGate) await options.cleanupGate;
        now += (options.durations || [15000, 15000])[index] || 0;
        if (index === 0 && options.throwFirst) throw new Error('private-details-not-to-log');
        return (options.results || ['window-incomplete', 'window-incomplete'])[index];
      } finally { active--; order.push('cleanup-' + index); }
    },
  });
  const db = { rpc: async (name, args) => {
    assert.equal(name, 'list_due_catalog_file_audio_validation_jobs');
    assert.equal(args.p_limit, 1);
    assert.equal(active, 0, 'selection follows completion of prior cleanup');
    order.push('selection'); now += options.selectionMs || 0;
    if (options.selectionThrows) throw Error('private-db-detail');
    return options.selection || { data: [{ job_id: 'job-a' }] };
  } };
  vm.runInContext(stripTypeScriptTypes(section('function scheduleLanguageValidationJob(', 'function languageValidationJobScheduleDue('), { mode: 'transform' }), context);
  vm.runInContext(stripTypeScriptTypes(section('function languageValidationFetchBudgetMs(', 'type StrictLidWindowState'), { mode: 'transform' }), context);
  return {
    calls, logs, order, registered, context,
    schedule: () => context.scheduleLanguageValidationJob(task => registered.push(task), db, 'job-a'),
    finish: async () => { await registered[0]; assert.equal(context.languageValidationTasks.size, 0); },
    maxActive: () => maxActive,
  };
}

test('two successful checkpoints share one deadline and execute sequentially, never a third window', async () => {
  const f = fixture(); assert.equal(f.schedule(), true); await f.finish();
  assert.equal(f.calls.length, 2); assert.equal(f.registered.length, 1); assert.equal(f.maxActive(), 1);
  assert.equal(f.calls[0].deadline, 1_270_000); assert.equal(f.calls[1].deadline, f.calls[0].deadline);
  assert.deepEqual(f.order, ['work-0', 'cleanup-0', 'selection', 'work-1', 'cleanup-1']);
  assert.deepEqual(f.logs.map(x => x.event), ['eligible', 'started', 'completed']);
  assert.equal(f.logs.at(-1).elapsedMs, 15000, 'duration is measured within this continuation, independent of other isolates');
  assert.equal(f.context.languageValidationFetchBudgetMs(f.calls[1].deadline, f.calls[1].start), 225000);
  assert.equal(JSON.stringify(f.logs).includes('job-a'), false, 'diagnostics expose no job or provider identity');
});

test('exact 30 s first step retains 210 s fetch plus 30 s cleanup; one millisecond more stops', async () => {
  const boundary = fixture({ durations: [30000, 1000] }); boundary.schedule(); await boundary.finish();
  assert.equal(boundary.calls.length, 2);
  const second = boundary.calls[1];
  assert.equal(boundary.context.languageValidationFetchBudgetMs(second.deadline, second.start), 210000);
  const slow = fixture({ durations: [30001] }); slow.schedule(); await slow.finish();
  assert.equal(slow.calls.length, 1); assert.equal(slow.order.includes('selection'), false);
  assert.deepEqual(slow.logs.map(x => x.reason), ['budget']);
});

test('time spent selecting a due job is included in the continuation budget', async () => {
  const f = fixture({ durations: [15000], selectionMs: 15001 }); f.schedule(); await f.finish();
  assert.equal(f.calls.length, 1); assert.equal(f.logs.at(-1).reason, 'budget');
});

for (const result of [undefined, null, false, true, 'queued', 'window-complete', 'failed', 'retry_wait']) {
  test(`result ${String(result)} does not start another window`, async () => {
    const f = fixture({ results: [result] }); f.schedule(); await f.finish();
    assert.equal(f.calls.length, 1); assert.equal(f.order.includes('selection'), false);
  });
}

for (const selection of [{ data: [{ job_id: 'higher-priority-job' }] }, { data: [] }, { data: null }, { data: [{ job_id: 'job-a' }], error: true }]) {
  test(`ordinary ordering or failed selection stops continuation: ${JSON.stringify(selection)}`, async () => {
    const f = fixture({ selection }); f.schedule(); await f.finish();
    assert.equal(f.calls.length, 1); assert.equal(f.logs.at(-1).reason, 'selection');
  });
}

test('cleanup completion precedes fairness checks and concurrent polls remain coalesced', async () => {
  let release; const cleanupGate = new Promise(resolve => { release = resolve; });
  const f = fixture({ cleanupGate }); f.schedule();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.schedule(), false); assert.equal(f.order.includes('selection'), false);
  release(); await f.finish();
  assert.equal(f.calls.length, 2); assert.equal(f.registered.length, 1);
});

test('worker or selection exception stops without leaking private error details', async () => {
  for (const option of ['throwFirst', 'selectionThrows']) {
    const f = fixture({ [option]: true }); f.schedule(); await f.finish();
    assert.equal(f.calls.length, 1); assert.equal(f.order.at(-1), 'caught-error');
    assert.equal(JSON.stringify(f.logs).includes('private'), false);
  }
});

test('a second attempt stopped by its ordinary guards ends the invocation', async () => {
  const f = fixture({ results: ['window-incomplete', undefined] }); f.schedule(); await f.finish();
  assert.equal(f.calls.length, 2); assert.equal(f.logs.at(-1).event, 'deferred');
  assert.equal(f.logs.at(-1).reason, 'worker-stopped');
  assert.equal(f.logs.at(-1).elapsedMs, 15000);
});
