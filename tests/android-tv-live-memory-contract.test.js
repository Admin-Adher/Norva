'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function bracedBlock(source, open, label) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  assert.fail(`unterminated JavaScript block: ${label}`);
}

function callableSource(source, start, label) {
  const openParen = source.indexOf('(', start);
  assert.ok(openParen >= 0, `missing parameter list: ${label}`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let closeParen = -1;

  for (let index = openParen; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        closeParen = index;
        break;
      }
    }
  }

  assert.ok(closeParen >= 0, `unterminated parameter list: ${label}`);
  const bodyOpen = source.indexOf('{', closeParen + 1);
  assert.ok(bodyOpen >= 0, `missing function body: ${label}`);
  return source.slice(start, bodyOpen) + bracedBlock(source, bodyOpen, label);
}

function classMethod(source, name) {
  const pattern = new RegExp(`^\\s*(?:async\\s+)?${name}\\s*\\(`, 'm');
  const match = pattern.exec(source);
  assert.ok(match, `missing class method: ${name}`);
  const start = match.index + match[0].search(/\S/);
  return callableSource(source, start, name);
}

function functionDeclaration(source, name) {
  const signature = `async function ${name}(`;
  const plainSignature = `function ${name}(`;
  const start = source.indexOf(signature) >= 0
    ? source.indexOf(signature)
    : source.indexOf(plainSignature);
  assert.ok(start >= 0, `missing function declaration: ${name}`);
  return callableSource(source, start, name);
}

function sliceBetween(source, startToken, endToken, label) {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `missing source slice: ${label}`);
  return source.slice(start, end);
}

function evaluateClassMethod(source, name, thisArg = {}) {
  const method = classMethod(source, name);
  const context = {};
  vm.runInNewContext(`this.method = ({ ${method} }).${name};`, context);
  return context.method.call(thisArg);
}

const home = read('public/js/pages/HomePage.js');
const channelList = read('public/js/components/ChannelList.js');
const livePage = read('public/js/pages/LivePage.js');
const api = read('public/js/api.js');

test('Home favorite channels never bootstrap or hydrate the Live catalogue', () => {
  const renderFavorites = classMethod(home, 'renderFavoriteChannels');

  assert.doesNotMatch(renderFavorites, /\.loadSources\s*\(/);
  assert.doesNotMatch(renderFavorites, /\.loadChannels\s*\(/);
  assert.doesNotMatch(renderFavorites, /\.loadAllChannels\s*\(/);
  assert.doesNotMatch(renderFavorites, /hydrateRemainingLivePages\s*\(/);
  assert.match(renderFavorites, /item_name|itemName/);
  assert.match(renderFavorites, /item_meta|itemMeta/);
});

test('Android TV Live requests lightweight logical channels without variants', () => {
  for (const methodName of [
    'loadFirstLivePage',
    'hydrateRemainingLivePages',
    'loadRemoteSearchResults',
    'consumePendingChannelSelection'
  ]) {
    const method = classMethod(channelList, methodName);
    assert.match(
      method,
      /liveStreams\([\s\S]*?includeVariants:\s*false/,
      `${methodName} must explicitly opt out of logical variants`
    );
  }

  const liveStreamsAdapter = sliceBetween(
    api,
    'liveStreams: (sourceId',
    'vodCategories:',
    'API liveStreams adapter'
  );
  assert.match(liveStreamsAdapter, /options\.includeVariants/);
  assert.match(liveStreamsAdapter, /includeVariants/);

  const liveRoute = sliceBetween(
    api,
    "if (action === 'live_streams'",
    "if (action === 'series_info')",
    'cloud live_streams route'
  );
  assert.match(liveRoute, /query\.get\(['"]includeVariants['"]\)/);

  const logicalChannels = functionDeclaration(api, 'listLiveLogicalChannels');
  assert.match(logicalChannels, /includeVariants/);
  assert.match(logicalChannels, /getLiveLogicalCatalog\([\s\S]*includeVariants/);
});

test('Android TV background hydration has a resident cap and is cancelled on Live exit', () => {
  const pageSize = evaluateClassMethod(channelList, 'livePageSize', {
    _isTvMode: () => true
  });
  const residentCap = evaluateClassMethod(channelList, 'liveResidentCap', {
    _isTvMode: () => true
  });

  assert.equal(Number.isInteger(pageSize), true);
  assert.equal(Number.isInteger(residentCap), true);
  assert.ok(pageSize > 0 && pageSize <= 1000, `unexpected TV page size: ${pageSize}`);
  assert.ok(
    residentCap >= pageSize && residentCap <= 10000,
    `unexpected TV resident cap: ${residentCap}`
  );

  const hydrate = classMethod(channelList, 'hydrateRemainingLivePages');
  assert.match(hydrate, /this\.livePageSize\(\)/);
  assert.match(hydrate, /this\.liveResidentCap\(\)/);
  assert.doesNotMatch(hydrate, /\b80000\b/);
  assert.match(hydrate, /liveHydrationRunId/);

  const pause = classMethod(channelList, 'pauseLiveHydration');
  assert.match(pause, /liveHydrationRunId\s*(?:\+\+|\+=\s*1)/);

  const hide = classMethod(livePage, 'hide');
  assert.match(hide, /channelList\.pauseLiveHydration\(\)/);
});

test('Home favorite selection and Live search resolve a bounded target without full preload', () => {
  const playChannel = classMethod(home, 'playChannel');
  assert.doesNotMatch(playChannel, /\.loadSources\s*\(|\.loadChannels\s*\(/);
  assert.match(playChannel, /queueChannelSelection\s*\(/);
  assert.ok(
    playChannel.indexOf('queueChannelSelection') < playChannel.indexOf("navigateTo('live')"),
    'favorite selection must be queued before navigating to Live'
  );

  const consume = classMethod(channelList, 'consumePendingChannelSelection');
  assert.doesNotMatch(consume, /\.loadSources\s*\(|\.loadChannels\s*\(|hydrateRemainingLivePages\s*\(/);
  assert.match(consume, /liveStreams\(/);
  assert.match(consume, /\bq\s*:/);
  const targetLimit = consume.match(/\blimit\s*:\s*(\d+)/);
  assert.ok(targetLimit, 'targeted favorite lookup must declare a finite limit');
  assert.ok(Number(targetLimit[1]) > 0 && Number(targetLimit[1]) <= 100);
  assert.match(consume, /includeVariants:\s*false/);

  const remoteSearch = classMethod(channelList, 'loadRemoteSearchResults');
  assert.match(remoteSearch, /liveStreams\(/);
  assert.match(remoteSearch, /\bq\s*:\s*term/);
  const searchLimit = remoteSearch.match(/\blimit\s*:\s*(\d+)/);
  assert.ok(searchLimit, 'remote search must declare a finite limit');
  assert.ok(Number(searchLimit[1]) > 0 && Number(searchLimit[1]) <= 100);

  const show = classMethod(livePage, 'show');
  assert.match(show, /channelList\.consumePendingChannelSelection\(\)/);
});
