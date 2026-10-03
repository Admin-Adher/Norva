const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const mod = () => import('../supabase/functions/_shared/provider-epg.mjs');
const windowOptions = { windowStartMs: Date.parse('2026-10-03T06:00:00Z'), windowEndMs: Date.parse('2026-10-03T16:00:00Z'), maxProgrammes: 100 };
const xml = `<?xml version="1.0"?><tv><channel id="unknown.fr"><display-name>FR - TF 1 UHD</display-name></channel>
<channel id="unknown.fr"><display-name>FR - TF1 HD</display-name><display-name>TF1</display-name></channel>
<programme start="20261003095000 +0200" stop="20261003114500 +0200" channel="unknown.fr"><title><![CDATA[Télé & matin]]></title><desc>Actualités &#x1f4fa;</desc></programme>
<programme start="20261003095000 +0200" stop="20261003114500 +0200" channel="unknown.fr"><title>Télé &amp; matin</title></programme>
<programme start="20261003114500 +0200" stop="20261003130000 +0200" channel="unknown.fr"><title>Le journal</title></programme>
<programme start="20261001120000 +0200" stop="20261001130000 +0200" channel="unknown.fr"><title>Old</title></programme></tv>`;

test('unknown XMLTV provider retains all channel aliases, deduplicates broadcasts and respects timezone/window', async () => {
  const { parseProviderXmltv } = await mod();
  const guide = parseProviderXmltv(xml, windowOptions);
  assert.deepEqual(guide.channels[0].aliases, ['FR - TF 1 UHD', 'FR - TF1 HD', 'TF1']);
  assert.equal(guide.programmes.length, 2);
  assert.equal(guide.programmes[0].title, 'Télé & matin');
  assert.equal(guide.programmes[0].description, 'Actualités 📺');
  assert.equal(guide.programmes[0].start, '2026-10-03T07:50:00.000Z');
  assert.equal(guide.truncated, false);
});

test('stream boundaries including split UTF-8, closing tags and attributes do not alter results', async () => {
  const { fetchProviderXmltv, parseProviderXmltv } = await mod();
  const expected = parseProviderXmltv(xml, windowOptions), bytes = new TextEncoder().encode(xml);
  for (const size of [1, 17, 113]) {
    const result = await fetchProviderXmltv('https://unknown.example/guide.xml', { ...windowOptions, fetch: async () => new Response(new ReadableStream({
      start(controller) { for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size)); controller.close(); }
    })) });
    assert.deepEqual(result.value, expected);
  }
});

test('declared XMLTV gzip file is decoded under the same programme and decompressed byte limits', async () => {
  const { fetchProviderXmltv, parseProviderXmltv } = await mod();
  const bytes = require('node:zlib').gzipSync(xml);
  const result = await fetchProviderXmltv('https://new.example/guide.xml.gz', { ...windowOptions, fetch: async () => new Response(bytes) });
  assert.deepEqual(result.value, parseProviderXmltv(xml, windowOptions));
});

test('invalid/truncated XML, excessive bytes and oversized elements are terminal and cancel the response', async () => {
  const { fetchProviderXmltv, parseProviderXmltv, XMLTV_MAX_BYTES } = await mod();
  assert.throws(() => parseProviderXmltv('<html>error</html>', windowOptions));
  assert.throws(() => parseProviderXmltv(xml.slice(0, -5), windowOptions));
  assert.throws(() => parseProviderXmltv('<tv><programme>' + 'x'.repeat(1024 * 1024 + 1), windowOptions));
  let cancelled = false;
  await assert.rejects(fetchProviderXmltv('https://unknown.example/guide.xml', { ...windowOptions, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(XMLTV_MAX_BYTES + 1) } }) }), e => e.kind === 'too_large');
  // A response rejected before acquiring its reader must still be released.
  assert.equal(cancelled, true);
});

test('programme cap is explicit and repeated channel definitions cannot exhaust it', async () => {
  const { parseProviderXmltv } = await mod();
  const guide = parseProviderXmltv(xml, { ...windowOptions, maxProgrammes: 1 });
  assert.equal(guide.programmes.length, 1); assert.equal(guide.truncated, true);
});

test('targeted guide keeps only requested channel IDs or declared aliases, not the worldwide schedule', async () => {
  const { parseProviderXmltv } = await mod();
  assert.equal(parseProviderXmltv(xml, { ...windowOptions, channelIds: [], channelNames: ['TF1'] }).programmes.length, 2);
  assert.equal(parseProviderXmltv(xml, { ...windowOptions, channelIds: ['unknown.fr'], channelNames: [] }).channels.length, 1);
  assert.equal(parseProviderXmltv(xml, { ...windowOptions, channelIds: [], channelNames: ['TF1 Series Films'] }).programmes.length, 0);
});

test('M3U only discovers an explicit HTTP XMLTV declaration, including relative URLs', async () => {
  const { declaredM3uEpgUrl } = await mod();
  for (const key of ['x-tvg-url', 'url-tvg', 'tvg-url'])
    assert.equal(declaredM3uEpgUrl(`#EXTM3U ${key}="../guide.xml"\n#EXTINF`, 'https://new.example/lists/account.m3u'), 'https://new.example/guide.xml');
  assert.equal(declaredM3uEpgUrl('#EXTM3U\n#EXTINF', 'https://new.example/list.m3u'), '');
  assert.equal(declaredM3uEpgUrl('#EXTM3U x-tvg-url="file:///secret"', 'https://new.example/list.m3u'), '');
  assert.equal(declaredM3uEpgUrl('#EXTM3U x-tvg-url="http://127.0.0.1/admin"', 'https://new.example/list.m3u'), '');
});

test('a public guide redirect cannot make Norva fetch a private endpoint', async () => {
  const { fetchProviderXmltv } = await mod(); let requests = 0;
  await assert.rejects(fetchProviderXmltv('https://new.example/guide.xml', { ...windowOptions, fetch: async () => {
    requests++; return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/credentials' } });
  } }), e => e.kind === 'invalid_epg_url');
  assert.equal(requests, 1);
});

function guideClass(API) {
  const context = vm.createContext({ window: {}, API, console, Map, Set, Date });
  vm.runInContext(fs.readFileSync('public/js/components/EpgGuide.js', 'utf8'), context);
  return Object.create(context.window.EpgGuide.prototype);
}

test('same channel name and ID on two providers never mixes broadcasts; ambiguous aliases remain unmatched', async () => {
  const guide = guideClass({});
  guide._mergeSourceGuides(new Map(['a', 'b'].map(id => [id, { source: { type: 'xtream' }, data: {
    channels: [{ id: 'same.fr', name: 'FR - TF 1 UHD', aliases: ['FR - TF1 HD'] }, { id: 'other.fr', name: 'Other', aliases: ['Ambiguous'] }, { id: 'third.fr', name: 'Third', aliases: ['Ambiguous'] }],
    programmes: [{ channelId: 'same.fr', title: id, start: '2026-10-03T07:50:00Z', stop: '2026-10-03T09:45:00Z' }]
  } }])));
  for (const id of ['a', 'b']) {
    const channel = guide.getEpgChannel('', 'TF1', id);
    assert.equal(guide.getChannelProgrammes(channel.id)[0].title, id);
  }
  assert.equal(guide.getEpgChannel('same.fr', 'TF1', 'unrelated'), null);
  assert.equal(guide.getEpgChannel('', 'TF1'), null);
  assert.equal(guide.getEpgChannel('', 'Ambiguous', 'a'), null);
});

test('fast provider becomes visible while a slow provider is still pending; failed refresh retains previous guide', async () => {
  let release, fail = false;
  const data = { channels: [{ id: 'c', name: 'Channel' }], programmes: [] };
  const guide = guideClass({ sources: { getAll: async () => ['fast', 'slow'].map(id => ({ id, type: 'xtream', enabled: true })) },
    proxy: { epg: { get: async id => { if (fail) throw new Error('offline'); return id === 'fast' ? data : new Promise(resolve => { release = resolve; }); } } }, favorites: { getAll: async () => [] } });
  const pending = guide.fetchEpgData();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(guide.getEpgChannel('c', '', 'fast')?.name, 'Channel');
  assert.equal(guide.getEpgChannel('c', '', 'slow'), null);
  release(data); await pending;
  fail = true; await guide.fetchEpgData();
  assert.equal(guide.getEpgChannel('c', '', 'slow')?.name, 'Channel');
});

test('channel navigation cannot start a duplicate provider guide while its initial guide is pending', async () => {
  let release, calls = 0;
  const guide = guideClass({ sources: { getAll: async () => [{ id: 'new', type: 'xtream', enabled: true }] },
    proxy: { epg: { get: async () => { calls++; return new Promise(resolve => { release = resolve; }); } } },
    favorites: { getAll: async () => [] } });
  const pending = guide.fetchEpgData();
  await new Promise(resolve => setImmediate(resolve));
  guide.ensureChannels([{ sourceId: 'new', name: 'TF1' }]);
  assert.equal(calls, 1);
  release({ channels: [], programmes: [] });
  await pending;
  assert.equal(guide._epgPendingSources.size, 0);
});
