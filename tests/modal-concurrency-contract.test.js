'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const profilesSource = read('public/js/profiles.js');
const sourceManagerSource = read('public/js/components/SourceManager.js');
const appHtml = read('public/app.html');

test('all profile entry points join one flight and preserve the forced picker resolver', async () => {
  let listCalls = 0;
  let releaseList;
  const listResponse = new Promise((resolve) => { releaseList = resolve; });
  const profileApi = {
    list() {
      listCalls += 1;
      return listResponse;
    },
    setActiveId() {},
    getActiveId() { return ''; },
    avatarUrl() { return '/avatar.svg'; }
  };
  const sessionValues = new Map();
  const context = {
    console,
    navigator: { userAgent: '' },
    sessionStorage: {
      getItem(key) { return sessionValues.get(key) || null; },
      setItem(key, value) { sessionValues.set(key, String(value)); }
    },
    window: {
      API: { isCloudMode: () => true },
      NorvaCloud: { profiles: profileApi }
    }
  };
  vm.runInNewContext(profilesSource, context);

  const first = context.window.NorvaProfiles.ensureSelected();
  const second = context.window.NorvaProfiles.openSwitcher();
  const third = context.window.NorvaProfiles.openManage();
  assert.strictEqual(second, first);
  assert.strictEqual(third, first);

  await Promise.resolve();
  assert.equal(listCalls, 1);
  releaseList({ profiles: [{ id: 'profile-1', setup_completed: true }], limit: 1, canCreate: false });
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
});

test('profile retry dialogs are single-flight and settle through one owned callback', () => {
  assert.match(profilesSource, /if \(loadFailureFlight\) return loadFailureFlight/);
  assert.match(profilesSource, /loadFailureFlight = flight/);
  assert.match(profilesSource, /settleLoadFailure = finish/);
  assert.match(profilesSource, /if \(settleLoadFailure !== finish\) return/);
  assert.match(profilesSource, /settleLoadFailure\?\.\(null\)/);
  assert.doesNotMatch(profilesSource, /resolveLoadFailure/);
  assert.match(profilesSource, /return runProfileEntry\(\(\) => ensureSelected\(options\)\)/);
  assert.match(profilesSource, /ensureSelected: ensureSelectedEntry/);
  assert.match(profilesSource, /return runProfileEntry\(openSwitcherFlow\)/);
  assert.match(profilesSource, /return runProfileEntry\(openManageFlow\)/);
  assert.match(profilesSource, /if \(resolveSelect\) return; \/\/ forced "Who's watching\?"/);
});

test('source warning confirmation is single-flight and every caller settles', async () => {
  const cancelButton = { onclick: null, focus() {} };
  const proceedButton = { onclick: null, focus() {} };
  const closeButton = { onclick: null };
  const modal = {
    active: false,
    classList: {
      add() { modal.active = true; },
      remove() { modal.active = false; }
    },
    querySelector(selector) {
      return selector === '.modal-close' ? closeButton : null;
    }
  };
  const title = { textContent: '' };
  const body = { innerHTML: '' };
  const footer = { innerHTML: '' };
  const elements = {
    modal,
    'modal-title': title,
    'modal-body': body,
    'modal-footer': footer,
    'warning-cancel': cancelButton,
    'warning-proceed': proceedButton
  };
  const context = {
    console,
    document: { getElementById: (id) => elements[id] || null },
    window: {}
  };
  vm.runInNewContext(sourceManagerSource, context);
  const manager = Object.create(context.window.SourceManager.prototype);

  const first = manager.showWarningModal({ title: 'First', message: 'Keep this confirmation' });
  const second = manager.showWarningModal({ title: 'Second', message: 'Must not replace the first' });
  assert.strictEqual(second, first);
  assert.equal(title.textContent, 'First');
  assert.equal(modal.active, true);

  proceedButton.onclick();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(modal.active, false);

  const third = manager.showWarningModal({ title: 'Third', message: 'A later dialog may open' });
  assert.notStrictEqual(third, first);
  cancelButton.onclick();
  assert.equal(await third, false);
});

test('modal concurrency fixes are cache-busted in the app shell', () => {
  assert.match(appHtml, /SourceManager\.js\?v=9aa468a08c/);
  assert.match(appHtml, /profiles\.js\?v=13/);
});
