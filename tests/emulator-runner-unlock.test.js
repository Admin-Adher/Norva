'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { replaceUnlock, patchRunner } = require('../scripts/qa/patch-emulator-runner-unlock.cjs');

test('unlock replacement preserves surrounding boot and animation operations', () => {
  const original = 'await waitForDevice(port, timeout);\nawait adb(port, `shell input keyevent 82`);\nawait disableAnimations();';
  const patched = replaceUnlock(original);
  assert.equal(patched.slice(patched.indexOf('\n') + 1),
    'await waitForDevice(port, timeout);\nawait adb(port, `shell wm dismiss-keyguard`);\nawait disableAnimations();');
  assert.match(patched, /^\/\/ Modified by Norva CI/);
});

test('absent or duplicated upstream unlock commands fail instead of broad replacement', () => {
  assert.throws(() => replaceUnlock('await dismissSomethingElse();'), /exactly one/);
  assert.throws(() => replaceUnlock('shell input keyevent 82\nshell input keyevent 82'), /exactly one/);
});

test('an unreviewed action fails before modifying source or its retained licence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-emulator-action-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    const source = path.join(root, 'src/emulator-manager.ts');
    fs.writeFileSync(source, 'shell input keyevent 82');
    fs.writeFileSync(path.join(root, 'LICENSE'), 'upstream licence retained');
    assert.throws(() => patchRunner(root), /Unreviewed emulator runner file/);
    assert.equal(fs.readFileSync(source, 'utf8'), 'shell input keyevent 82');
    assert.equal(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), 'upstream licence retained');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
