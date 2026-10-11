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
    for (const route of [['history'], ['content-events'], ['sources'], ['favorites'], ['device', 'history'], ['device', 'content-events'], ['device', 'sources'], ['device', 'favorites']]) {
      if (reports('GET', ...route)) lastSeen = now;
    }
    if (now % 300 === 0) {
      for (const method of ['GET', 'POST']) {
        if (reports(method, 'sources', 'source', 'epg')) lastSeen = now;
        if (reports(method, 'device', 'sources', 'source', 'epg')) lastSeen = now;
      }
    }
    assert.equal(now - lastSeen < 300, now < 300);
  }
  assert.equal(lastSeen, 0);
});

test('first load, catalogue interaction and mutations retain first-play protection', () => {
  for (const route of [
    ['GET', 'boot'], ['GET', 'media-items'], ['GET', 'sources', 'detail'],
    ['GET', 'profile'], ['GET', 'device', 'sources', 'detail'], ['GET', 'device', 'me'],
    ['POST', 'sources'], ['PATCH', 'sources', 'detail'], ['DELETE', 'sources', 'detail'],
    ['POST', 'history'], ['DELETE', 'history', 'item'],
    ['POST', 'content-events', 'seen'], ['POST', 'device', 'history'],
    ['DELETE', 'device', 'history', 'item'], ['POST', 'device', 'content-events', 'seen'],
    ['POST', 'favorites'], ['DELETE', 'favorites', 'item'], ['POST', 'device', 'favorites'],
    ['POST', 'sources', 'source', 'test'], ['POST', 'sources', 'source', 'sync'],
    ['GET', 'sources', 'source', 'series-info'], ['GET', 'sources', 'source', 'short-epg'],
  ]) assert.equal(reports(...route), true, JSON.stringify(route));
});

test('only recognized passive routes are excluded, unknown actions fail closed', () => {
  assert.equal(reports('POST', 'device', 'heartbeat'), false);
  for (const route of [
    ['GET', 'history', 'unknown'], ['GET', 'history', undefined, 'unknown'],
    ['GET', 'device', 'history', 'unknown'], ['GET', 'device', 'heartbeat'],
    ['POST', 'device', 'heartbeat', 'unknown'], ['GET', 'unknown'],
    ['POST', 'sources', undefined, 'epg'], ['POST', 'device', 'sources', undefined, 'epg'],
    ['POST', 'sources', 'source', 'epg', 'unknown'], ['DELETE', 'sources', 'source', 'epg'],
  ]) assert.equal(reports(...route), true, JSON.stringify(route));
});

test('authenticated user and device dispatch both apply the same presence policy', () => {
  assert.match(source, /if \(requestReportsViewerPresence\(req\.method, scope, id, action, segments\[3\]\)\) touchUserPresence\(db, user\.id\)/);
  assert.match(source, /if \(requestReportsViewerPresence\(req\.method, scope, id, action, segments\[3\]\)\) touchUserPresence\(db, device\.user_id\)/);
});
