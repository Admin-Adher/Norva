'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { parseHttpForwardAccounts, useProviderHttpForward } = require('../services/media-gateway/src/provider-http-forward-policy');
const KEY = 'provider.example/exact-account';
const HASH = crypto.createHash('sha256').update(KEY).digest('hex');
const enabled = parseHttpForwardAccounts(HASH);
const url = (ext) => `http://provider.example/movie/exact-account/private/1.${ext}`;

test('forward HTTP is disabled by default and rejects malformed service configuration', () => {
  assert.equal(parseHttpForwardAccounts().size, 0);
  for (const bad of ['*', KEY, HASH + ',bad', 'A'.repeat(64), Array(65).fill(HASH).join(',')]) {
    assert.throws(() => parseHttpForwardAccounts(bad), /is invalid/);
  }
  assert.equal(useProviderHttpForward(KEY, url('mp4'), new Set()), false);
});

test('only the exact configured account and HTTP MP4/TS qualify', () => {
  for (const ext of ['mp4', 'ts', 'MP4']) assert.equal(useProviderHttpForward(KEY, url(ext), enabled), true);
  for (const ext of ['mkv', 'm3u8', 'avi', 'mp4.exe']) assert.equal(useProviderHttpForward(KEY, url(ext), enabled), false);
  assert.equal(useProviderHttpForward(KEY + '2', url('mp4'), enabled), false);
  assert.equal(useProviderHttpForward(KEY, url('mp4').replace('http:', 'https:'), enabled), false);
  assert.equal(useProviderHttpForward(KEY, 'not a URL', enabled), false);
  assert.equal(useProviderHttpForward(KEY, 'http://provider.example/player_api.php?x=1.mp4', enabled), false);
});

test('raw and TS use forward HTTP on the same slot, preserve MKV, and pin renewals', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
  const extract = (start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));
  const context = {
    providerProxyAgents: [{}, {}], providerHttpProxyAgents: ['http1', 'http2'],
    providerSocksProxyAgents: ['socks1', 'socks2'], providerHttpForwardAgents: ['forward1', 'forward2'],
    providerHttpForwardAccounts: enabled, useProviderHttpForward,
    providerHttpProxyUrls: ['http://proxy1', 'http://proxy2'], providerSocksProxyUrls: ['socks5://proxy1', 'socks5://proxy2'],
    providerRouteForKey: () => ({ slot: 2, ffmpegSlot: 2, nodeTransport: 'socks5' }),
    proxyKeyFromUrl: () => KEY, asRecord: (x) => x || {},
    createProviderProxyAgent: (proxy, options) => ({ proxy, options }),
  };
  vm.createContext(context);
  vm.runInContext(extract('function pickProxyAgent(', 'function pinnedProxyAgentFactory(')
    + extract('function providerNodeRouteIsAvailable(', 'function waitForVodInputRetry('), context);
  assert.equal(context.pickProxyAgent(KEY, url('mp4')), 'forward2');
  assert.equal(context.pickProxyAgent(KEY, url('mkv')), 'socks2');
  assert.equal(context.pickProxyAgent(KEY + 'other', url('mp4')), 'socks2');
  const session = { sourceUrl: url('ts') };
  const route = context.providerNodeRouteForSession(session);
  assert.equal(route.slot, 2);
  assert.equal(route.ffmpegSlot, 2);
  assert.equal(route.nodeTransport, 'http');
  assert.equal(context.providerProxyAgentForRoute(route), 'forward2');
  context.pinProviderNodeRouteForSession(session, route);
  assert.equal(context.providerNodeRouteForSession(session).httpProxyMode, 'forward');
  const renewed = context.pinnedProxyAgentFactoryForRoute(session.providerNodeRoute)();
  assert.equal(renewed.proxy, 'http://proxy2');
  assert.equal(renewed.options.proxyTunnel, false);
  const alternate = context.alternateProviderNodeTransportRoute(route);
  assert.equal(alternate.slot, 2);
  assert.equal(context.providerProxyAgentForRoute(alternate), 'socks2');
  assert.equal(context.providerNodeRouteForSession({ sourceUrl: url('mkv') }).nodeTransport, 'socks5');
});

test('native MP4 Gateway policy is exact-source, server-owned, off by default', async () => {
  const { useNativeMp4Gateway } = await import(pathToFileURL(path.join(__dirname, '../supabase/functions/_shared/native-mp4-gateway-policy.mjs')));
  const sourceId = '11111111-2222-3333-4444-555555555555';
  const base = { sourceId, itemType: 'movie', container: 'mp4', allowlist: sourceId };
  assert.equal(useNativeMp4Gateway(base), true);
  for (const override of [{ allowlist: '' }, { allowlist: '*' }, { allowlist: sourceId + ',bad' },
    { sourceId: '21111111-2222-3333-4444-555555555555' }, { itemType: 'series' }, { container: 'mkv' }, { container: 'ts' }]) {
    assert.equal(useNativeMp4Gateway({ ...base, ...override }), false);
  }
});

test('native byte-pipe returns after the normal coordinator and before track probes', () => {
  const src = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
  const start = src.indexOf('const nativeMp4Gateway = useNativeMp4Gateway(');
  const block = src.slice(start, src.indexOf('// Name the audio AND subtitle tracks', start));
  assert.match(block, /container: authoritativeVodContainer/);
  assert.match(block, /Deno.env.get\("NORVA_NATIVE_MP4_GATEWAY_SOURCE_IDS"\)/);
  assert.ok(block.indexOf('createBytePipeAccess(') < block.indexOf('commitEdgeSessionCoordinator('));
  assert.ok(block.indexOf('commitEdgeSessionCoordinator(') < block.indexOf('if (nativeMp4Gateway &&'));
  assert.match(block, /mode: "relay", transport: "gateway-raw"/);
  assert.doesNotMatch(block, /probeCodec|probe-audio|mode: "transcode"|mode: "engine"/);
});
