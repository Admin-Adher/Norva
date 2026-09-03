'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

async function streamModule() {
  return import('../supabase/functions/_shared/m3u-playlist-stream.mjs');
}

async function boundedModule() {
  return import('../supabase/functions/_shared/bounded-provider-response.mjs');
}

function chunkedStream(value, chunkSize = 1024) {
  const bytes = new TextEncoder().encode(value);
  let offset = 0;
  return {
    bytes,
    stream: new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const next = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
        offset += next.byteLength;
        controller.enqueue(next);
      },
    }),
  };
}

test('M3U validation reads a prefix even when Content-Length exceeds the old 1 MiB limit', async () => {
  const { fetchBoundedProviderTextPrefix } = await boundedModule();
  const originalFetch = global.fetch;
  let cancelled = false;
  const body = new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,News\nhttps://stream.example/live/1\n'.padEnd(4096, 'x'));
  global.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(body);
    },
    cancel() { cancelled = true; },
  }), { status: 200, headers: { 'content-length': String(8 * 1024 * 1024) } });

  try {
    const result = await fetchBoundedProviderTextPrefix('https://provider.invalid/playlist', {
      timeoutMs: 1_000,
      maxBytes: 1024,
    });
    assert.equal(result.response.ok, true);
    assert.equal(result.truncated, true);
    assert.match(result.value, /^#EXTM3U/);
    assert.equal(cancelled, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('streaming M3U parser accepts a synthetic catalogue above 25,000 entries', async () => {
  const { readM3uPlaylistStream } = await streamModule();
  const lines = ['\uFEFF#EXTM3U'];
  for (let index = 0; index < 25_001; index += 1) {
    lines.push(`#EXTINF:-1 tvg-id="channel-${index}" group-title="India",Channel ${index}`);
    lines.push(`https://stream.example/live/${index}`);
  }
  const fixture = chunkedStream(`${lines.join('\n')}\n`, 777);
  const result = await readM3uPlaylistStream(fixture.stream, {
    maxBytes: fixture.bytes.byteLength + 1,
    maxItems: 30_000,
  });

  assert.equal(result.headerDetected, true);
  assert.equal(result.items.length, 25_001);
  assert.equal(result.items.at(-1).title, 'Channel 25000');
  assert.equal(result.items.at(-1).group, 'India');
  assert.equal(result.truncated, false);
});

test('streaming M3U parser stops at its item budget without rejecting the valid playlist', async () => {
  const { readM3uPlaylistStream } = await streamModule();
  const lines = ['#EXTM3U'];
  for (let index = 0; index < 12; index += 1) {
    lines.push(`#EXTINF:-1,Channel ${index}`, `https://stream.example/live/${index}`);
  }
  const fixture = chunkedStream(`${lines.join('\n')}\n`, 31);
  const result = await readM3uPlaylistStream(fixture.stream, { maxBytes: 1_000_000, maxItems: 5 });

  assert.equal(result.headerDetected, true);
  assert.equal(result.items.length, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.truncationReason, 'item_limit');
});

test('streaming M3U parser cancels the provider body when one line is unsafe', async () => {
  const { readM3uPlaylistStream } = await streamModule();
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`#EXTM3U\n${'x'.repeat(2048)}`));
    },
    cancel() { cancelled = true; },
  });

  await assert.rejects(
    readM3uPlaylistStream(stream, { maxBytes: 4096, maxItems: 10, maxLineChars: 512 }),
    (error) => error?.kind === 'too_large',
  );
  assert.equal(cancelled, true);
});

test('both M3U sync engines use the shared streaming importer and no 20,000-item slice', () => {
  for (const relativePath of [
    'supabase/functions/norva-cloud/index.ts',
    'supabase/functions/norva-source-sync/index.ts',
  ]) {
    const source = read(relativePath);
    assert.match(source, /fetchM3uPlaylistStream/);
    assert.match(source, /maxItems:\s*100_000/);
    assert.match(source, /maxBytes:\s*128 \* 1024 \* 1024/);
    assert.doesNotMatch(source, /parseM3u\(playlist\)\.slice\(0,\s*20000\)/);
    assert.doesNotMatch(source, /fetchText\(playlistUrl,\s*30000,\s*20_000_000\)/);
  }

  const cloud = read('supabase/functions/norva-cloud/index.ts');
  assert.match(cloud, /fetchTextPrefix\(playlistUrl, 12000, 64 \* 1024\)/);
  assert.match(cloud, /maxItems:\s*10_001/);
  assert.match(cloud, /countIsLowerBound:\s*result\.truncated/);
  assert.match(cloud, /waitUntil\(syncCloudSource\(data\.id, userId, db\)\)/);
  assert.doesNotMatch(cloud, /fetchText\(playlistUrl, 12000, 1_000_000\)/);
  assert.doesNotMatch(cloud, /fetchText\(url, 15000, 20_000_000\)/);
  const sourceManager = read('public/js/components/SourceManager.js');
  assert.match(sourceManager, /estimate\.countIsLowerBound \? `at least \$\{count\}` : count/);
});

test('production health gates identify the streaming import release', () => {
  const cloudSource = read('supabase/functions/norva-cloud/index.ts');
  const workerSource = read('supabase/functions/norva-source-sync/index.ts');
  const deployScript = read('ops/hetzner/scripts/04-deploy-edge-functions.sh');

  assert.match(cloudSource, /version:\s*28/);
  assert.match(workerSource, /version:\s*19/);
  assert.match(cloudSource, /m3uStreamingImportProtocol:\s*1/);
  assert.match(workerSource, /m3uStreamingImportProtocol:\s*1/);
  assert.match(deployScript, /EXPECTED_M3U_STREAMING_IMPORT_PROTOCOL=1/);
});
