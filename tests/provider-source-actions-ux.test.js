const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
const sourceManagerSource = fs.readFileSync(
  path.join(root, 'public/js/components/SourceManager.js'),
  'utf8',
);
const appHtml = fs.readFileSync(path.join(root, 'public/app.html'), 'utf8');

function appHarness({ cloud = true, sources = [] } = {}) {
  const calls = { getAll: 0, sync: [], health: 0, whatsNew: 0 };
  const api = {
    isCloudMode: () => cloud,
    sources: {
      async getAll() {
        calls.getAll += 1;
        return sources;
      },
      async sync(id) {
        calls.sync.push(id);
      },
    },
  };
  const window = { API: api };
  window.window = window;
  const context = {
    window,
    API: api,
    document: { addEventListener() {} },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.runInNewContext(`${appSource}\nwindow.__TestApp = App;`, context, {
    filename: 'public/js/app.js',
  });
  const app = Object.create(window.__TestApp.prototype);
  app.player = { settings: { autoRefreshEnabled: true, autoRefreshIntervalHours: 24 } };
  app.refreshSourceHealth = () => { calls.health += 1; };
  app.surfaceWhatsNew = async () => { calls.whatsNew += 1; };
  return { app, calls };
}

function sourceManagerHarness({
  enabled = true,
  confirm = true,
  instantTimers = false,
  loadError = null,
  statuses = [{ source_id: 'source-1', status: 'ready' }],
  testResult = null,
} = {}) {
  const calls = {
    cacheClear: [],
    confirm: [],
    delete: [],
    getStatus: 0,
    hardSync: [],
    load: 0,
    notify: 0,
    release: 0,
    sync: [],
    test: [],
    toast: [],
    toggle: [],
  };
  const sourceName = { textContent: 'NINJA' };
  const checkButton = { disabled: false, textContent: 'Check service' };
  const syncButton = { disabled: false, querySelector() { return null; } };
  const hardSyncButton = { disabled: false, querySelector() { return null; } };
  const sourceItem = {
    classList: { contains: (name) => name === 'disabled' && !enabled },
    querySelector(selector) {
      if (selector === '.source-name') return sourceName;
      if (selector === '[data-action="refresh"]') return syncButton;
      if (selector === '[data-action="hard-refresh"]') return hardSyncButton;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-action="refresh"], [data-action="hard-refresh"]') {
        return [syncButton, hardSyncButton];
      }
      return [];
    },
  };
  const document = {
    querySelector(selector) {
      if (selector === '.source-item[data-id="source-1"]') return sourceItem;
      if (selector === '.source-item[data-id="source-1"] [data-action="test"]') return checkButton;
      return null;
    },
    dispatchEvent() {},
  };
  const api = {
    isCloudMode: () => true,
    proxy: { cache: { async clear(id) { calls.cacheClear.push(id); } } },
    sources: {
      async delete(id) { calls.delete.push(id); },
      async getStatus() {
        calls.getStatus += 1;
        return statuses;
      },
      async hardSync(id) {
        calls.hardSync.push(id);
        return { accepted: true };
      },
      async sync(id) {
        calls.sync.push(id);
        return { accepted: true };
      },
      async test(id) {
        calls.test.push(id);
        return testResult || { success: true };
      },
      async toggle(id) { calls.toggle.push(id); },
    },
  };
  const modal = {
    async confirm(message, options) {
      calls.confirm.push({ message, options });
      return confirm;
    },
    toast(message, tone) { calls.toast.push({ message, tone }); },
  };
  const window = { API: api, NorvaModal: modal };
  window.window = window;
  const context = {
    window,
    document,
    API: api,
    NorvaModal: modal,
    Icons: { live: '', guide: '', series: '' },
    CustomEvent: class CustomEvent {},
    console,
    URL,
    setTimeout: instantTimers ? ((callback) => { callback(); return 0; }) : setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.runInNewContext(sourceManagerSource, context, {
    filename: 'public/js/components/SourceManager.js',
  });
  const manager = Object.create(window.SourceManager.prototype);
  manager.releasePlaybackForSourceChange = async () => { calls.release += 1; };
  manager.showWarningModal = async () => confirm;
  manager.loadSources = async () => {
    calls.load += 1;
    if (loadError) throw loadError;
  };
  manager.notifySourceHealthChanged = () => { calls.notify += 1; };
  return { manager, calls, checkButton, hardSyncButton, syncButton };
}

test('cloud app launch leaves refresh ownership to the durable fair scheduler', async () => {
  const { app, calls } = appHarness({
    cloud: true,
    sources: [{ id: 'ninja', type: 'xtream', sync_status: 'error' }],
  });

  await app.maybeAutoRefreshSources();

  assert.equal(calls.getAll, 0);
  assert.deepEqual(calls.sync, []);
  assert.equal(calls.health, 1);
  assert.equal(calls.whatsNew, 1);
});

test('cloud Settings does not expose a browser-only refresh control as server authority', () => {
  assert.match(
    appHtml,
    /class="setting-item needs-local-server">[\s\S]*?id="setting-auto-refresh"/,
  );
  assert.match(
    appHtml,
    /class="setting-item needs-local-server" id="auto-refresh-interval-row"/,
  );
});

test('local app launch retains one-device stale-provider refresh behavior', async () => {
  const { app, calls } = appHarness({
    cloud: false,
    sources: [
      { id: 'stale', type: 'xtream', sync_status: 'ready', last_synced_at: null },
      { id: 'running', type: 'm3u', sync_status: 'syncing', last_synced_at: null },
    ],
  });

  await app.maybeAutoRefreshSources();

  assert.equal(calls.getAll, 1);
  assert.deepEqual(calls.sync, ['stale']);
  assert.equal(calls.health, 1);
  assert.equal(calls.whatsNew, 1);
});

test('cloud rebuild copy preserves the current catalog and describes the real operation', () => {
  const { manager } = sourceManagerHarness();
  const copy = manager.rebuildConfirmationCopy();

  assert.equal(copy.title, 'Rebuild catalog?');
  assert.match(copy.message, /current catalog stays available/i);
  assert.match(copy.details, /clears only saved sync progress/i);
  assert.doesNotMatch(`${copy.message} ${copy.details}`, /delete the current|removed locally/i);
});

test('cloud rebuild labels never claim that local catalog data will be cleared', () => {
  assert.doesNotMatch(sourceManagerSource, /Hard Refresh: clear local data and sync/);
  assert.match(sourceManagerSource, /Rescan and update the complete provider catalog/);
});

test('Sync now claims the ordinary sync path once and completes from durable status', async () => {
  const { manager, calls, hardSyncButton, syncButton } = sourceManagerHarness({
    instantTimers: true,
  });

  await manager.refreshSource('source-1', 'xtream');

  assert.deepEqual(calls.sync, ['source-1']);
  assert.deepEqual(calls.hardSync, []);
  assert.equal(calls.getStatus, 1);
  assert.deepEqual(calls.cacheClear, ['source-1']);
  assert.equal(syncButton.disabled, false);
  assert.equal(hardSyncButton.disabled, false);
  assert.deepEqual(calls.toast.at(-1), {
    message: 'Xtream data synced & refreshed!',
    tone: 'success',
  });
});

test('Rebuild catalog cancels without mutation and otherwise uses only hard-sync', async () => {
  const cancelled = sourceManagerHarness({ confirm: false, instantTimers: true });
  await cancelled.manager.refreshSource('source-1', 'xtream', { hard: true });
  assert.deepEqual(cancelled.calls.sync, []);
  assert.deepEqual(cancelled.calls.hardSync, []);
  assert.equal(cancelled.calls.getStatus, 0);

  const accepted = sourceManagerHarness({ confirm: true, instantTimers: true });
  await accepted.manager.refreshSource('source-1', 'xtream', { hard: true });
  assert.deepEqual(accepted.calls.sync, []);
  assert.deepEqual(accepted.calls.hardSync, ['source-1']);
  assert.equal(accepted.calls.getStatus, 1);
  assert.deepEqual(accepted.calls.toast.at(-1), {
    message: 'Xtream data hard refreshed!',
    tone: 'success',
  });
});

test('Sync now turns a durable rejected-login status into Repair login guidance', async () => {
  const { manager, calls } = sourceManagerHarness({
    instantTimers: true,
    statuses: [{
      source_id: 'source-1',
      status: 'error',
      error: 'The TV service rejected the saved credentials.',
      error_code: 'PROVIDER_CREDENTIALS_REJECTED',
    }],
  });

  await manager.refreshSource('source-1', 'xtream');

  assert.deepEqual(calls.sync, ['source-1']);
  assert.deepEqual(calls.cacheClear, []);
  assert.match(calls.toast.at(-1).message, /Open Repair login/);
  assert.equal(calls.toast.at(-1).tone, 'error');
});

test('sync errors turn terminal provider states into actionable guidance', () => {
  const { manager } = sourceManagerHarness();

  assert.match(
    manager.sourceSyncErrorMessage({ error_code: 'PROVIDER_CREDENTIALS_REJECTED' }),
    /Open Repair login/,
  );
  assert.match(
    manager.sourceSyncErrorMessage({ error_code: 'PROVIDER_ENDPOINT_NOT_FOUND' }),
    /address or account endpoint/i,
  );
  assert.match(
    manager.sourceSyncErrorMessage({ error_code: 'PROVIDER_ACCESS_EXPIRED' }),
    /Review the access dates/,
  );
  assert.match(
    manager.sourceSyncErrorMessage({ error_code: 'PROVIDER_BUSY' }),
    /busy/,
  );
});

test('cloud status polling preserves the sanitized provider error code', () => {
  assert.match(
    apiSource,
    /error_code:\s*source\.sync_error_code\s*\|\|\s*source\.syncErrorCode\s*\|\|\s*null/,
  );
});

test('Check service exposes a busy state, restores the control and shows the provider verdict', async () => {
  const { manager, calls, checkButton } = sourceManagerHarness({
    testResult: { success: false, status: 401 },
  });
  let disabledDuringRequest = false;
  manager.sourceConnectionTestMessage = windowValue => {
    disabledDuringRequest = checkButton.disabled && checkButton.textContent === 'Checking…';
    return windowValue.status === 401 ? 'The provider refused the saved username or password.' : 'Unexpected';
  };

  await manager.testSource('source-1');

  assert.equal(disabledDuringRequest, true);
  assert.equal(checkButton.disabled, false);
  assert.equal(checkButton.textContent, 'Check service');
  assert.deepEqual(calls.test, ['source-1']);
  assert.deepEqual(calls.toast, [{
    message: 'The provider refused the saved username or password.',
    tone: 'error',
  }]);
});

test('Disable service cancels without mutation and confirms before hiding the catalog', async () => {
  const cancelled = sourceManagerHarness({ enabled: true, confirm: false });
  await cancelled.manager.toggleSource('source-1');
  assert.equal(cancelled.calls.confirm.length, 1);
  assert.match(cancelled.calls.confirm[0].message, /catalog will be hidden without being deleted/i);
  assert.deepEqual(cancelled.calls.toggle, []);
  assert.equal(cancelled.calls.release, 0);

  const accepted = sourceManagerHarness({ enabled: true, confirm: true });
  await accepted.manager.toggleSource('source-1');
  assert.deepEqual(accepted.calls.toggle, ['source-1']);
  assert.equal(accepted.calls.release, 1);
  assert.deepEqual(accepted.calls.toast.at(-1), {
    message: 'Service disabled. Its catalog is still saved.',
    tone: 'success',
  });
});

test('Enable service is direct, reversible and acknowledged', async () => {
  const { manager, calls } = sourceManagerHarness({ enabled: false });

  await manager.toggleSource('source-1');

  assert.equal(calls.confirm.length, 0);
  assert.deepEqual(calls.toggle, ['source-1']);
  assert.deepEqual(calls.toast.at(-1), { message: 'Service enabled.', tone: 'success' });
});

test('a committed service toggle never becomes a false failure when only card refresh fails', async () => {
  const { manager, calls } = sourceManagerHarness({
    enabled: true,
    confirm: true,
    loadError: new Error('view refresh interrupted'),
  });

  await manager.toggleSource('source-1');

  assert.deepEqual(calls.toggle, ['source-1']);
  assert.equal(calls.load, 1);
  assert.equal(calls.notify, 1);
  assert.deepEqual(calls.toast, [{
    message: 'Service disabled. Its catalog is still saved.',
    tone: 'success',
  }]);
});

test('Remove stays confirmed, releases playback, removes last and shows a receipt', async () => {
  const { manager, calls } = sourceManagerHarness({ confirm: true });

  await manager.deleteSource('source-1');

  assert.equal(calls.confirm.length, 1);
  assert.equal(calls.release, 1);
  assert.deepEqual(calls.delete, ['source-1']);
  assert.equal(calls.load, 1);
  assert.equal(calls.notify, 1);
  assert.deepEqual(calls.toast.at(-1), {
    message: 'Source removed from Norva.',
    tone: 'success',
  });
});

test('a committed removal never asks the user to repeat delete when only view refresh fails', async () => {
  const { manager, calls } = sourceManagerHarness({
    confirm: true,
    loadError: new Error('view refresh interrupted'),
  });

  await manager.deleteSource('source-1');

  assert.deepEqual(calls.delete, ['source-1']);
  assert.equal(calls.load, 1);
  assert.equal(calls.notify, 1);
  assert.deepEqual(calls.toast, [{
    message: 'Source removed from Norva.',
    tone: 'success',
  }]);
});

test('404 sync errors are sanitized as a provider endpoint action state', async () => {
  const moduleUrl = pathToFileURL(
    path.join(root, 'supabase/functions/_shared/source-public-view.mjs'),
  ).href;
  const { publicSourceSyncError } = await import(moduleUrl);

  assert.deepEqual(publicSourceSyncError('[404] Provider endpoint missing'), {
    code: 'PROVIDER_ENDPOINT_NOT_FOUND',
    message: 'The TV service address or account endpoint is no longer available.',
  });
});
