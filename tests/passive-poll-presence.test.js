'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-cloud/index.ts'), 'utf8');
const start = source.indexOf('function requestReportsViewerPresence(');
const end = source.indexOf('function touchUserPresence(', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
const reports = (...args) => context.requestReportsViewerPresence(...args);

test('periodic history and inbox reads cannot perpetually extend idle account exclusion', () => {
  let lastSeen = 0;
  assert.equal(reports('GET', 'boot'), true);
  for (let now = 30; now <= 600; now += 30) {
    for (const route of [['history'], ['content-events'], ['device', 'history'], ['device', 'content-events']]) {
      if (reports('GET', ...route)) lastSeen = now;
    }
    assert.equal(now - lastSeen < 300, now < 300);
  }
  assert.equal(lastSeen, 0);
});

test('first load, catalogue interaction and mutations retain first-play protection', () => {
  for (const route of [
    ['GET', 'boot'], ['GET', 'media-items'], ['GET', 'sources'],
    ['GET', 'profile'], ['GET', 'device', 'sources'], ['GET', 'device', 'me'],
    ['POST', 'history'], ['DELETE', 'history', 'item'],
    ['POST', 'content-events', 'seen'], ['POST', 'device', 'history'],
    ['DELETE', 'device', 'history', 'item'], ['POST', 'device', 'content-events', 'seen'],
  ]) assert.equal(reports(...route), true, JSON.stringify(route));
});

test('only recognized passive routes are excluded, unknown actions fail closed', () => {
  assert.equal(reports('POST', 'device', 'heartbeat'), false);
  for (const route of [
    ['GET', 'history', 'unknown'], ['GET', 'history', undefined, 'unknown'],
    ['GET', 'device', 'history', 'unknown'], ['GET', 'device', 'heartbeat'],
    ['POST', 'device', 'heartbeat', 'unknown'], ['GET', 'unknown'],
  ]) assert.equal(reports(...route), true, JSON.stringify(route));
});

test('authenticated user and device dispatch both apply the same presence policy', () => {
  assert.match(source, /if \(requestReportsViewerPresence\(req\.method, scope, id, action\)\) touchUserPresence\(db, user\.id\)/);
  assert.match(source, /if \(requestReportsViewerPresence\(req\.method, scope, id, action\)\) touchUserPresence\(db, device\.user_id\)/);
});
