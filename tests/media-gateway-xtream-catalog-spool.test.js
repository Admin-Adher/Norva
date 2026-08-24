const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GATEWAY_PATH = path.join(ROOT, 'services', 'media-gateway', 'src', 'index.js');
const SOURCE = fs.readFileSync(GATEWAY_PATH, 'utf8').replace(/\r\n?/g, '\n');

function extractFunction(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  const asyncStart = SOURCE.indexOf(`async function ${name}(`);
  const candidates = [start, asyncStart].filter((value) => value >= 0);
  const offset = candidates.length ? Math.min(...candidates) : -1;
  assert.notEqual(offset, -1, `missing ${name}`);
  const openParen = SOURCE.indexOf('(', offset);
  let parenDepth = 0;
  let signatureQuote = null;
  let signatureEscaped = false;
  let closeParen = -1;
  for (let index = openParen; index < SOURCE.length; index += 1) {
    const char = SOURCE[index];
    if (signatureQuote) {
      if (signatureEscaped) signatureEscaped = false;
      else if (char === '\\') signatureEscaped = true;
      else if (char === signatureQuote) signatureQuote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') signatureQuote = char;
    else if (char === '(') parenDepth += 1;
    else if (char === ')' && --parenDepth === 0) {
      closeParen = index;
      break;
    }
  }
  const brace = SOURCE.indexOf('{', closeParen);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = brace; index < SOURCE.length; index += 1) {
    const char = SOURCE[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(offset, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function spoolHarness(overrides = {}) {
  const names = [
    'catalogSpoolError',
    'xtreamCatalogPagePath',
    'xtreamCatalogPageEncryptionKey',
    'xtreamCatalogPageAad',
    'encryptXtreamCatalogPage',
    'decryptXtreamCatalogPage',
    'spoolTopLevelJsonObjectArray',
  ];
  const source = `(() => {
    const GATEWAY_TOKEN = secret;
    const XTREAM_CATALOG_PAGE_MAX_BYTES = limits.pageBytes;
    const XTREAM_CATALOG_ITEM_MAX_BYTES = limits.itemBytes;
    const XTREAM_CATALOG_SPOOL_MAX_BYTES = limits.spoolBytes;
    const XTREAM_CATALOG_SPOOL_MAX_ITEMS = limits.spoolItems;
    ${names.map(extractFunction).join('\n')}
    return { spoolTopLevelJsonObjectArray, decryptXtreamCatalogPage };
  })()`;
  return vm.runInNewContext(source, {
    Buffer,
    crypto,
    TextDecoder,
    fsp,
    path,
    secret: 'catalog-page-encryption-test-secret',
    limits: {
      pageBytes: overrides.pageBytes || 32 * 1024,
      itemBytes: overrides.itemBytes || 8 * 1024,
      spoolBytes: overrides.spoolBytes || 16 * 1024 * 1024,
      spoolItems: overrides.spoolItems || 100_000,
    },
    isWithin(parent, child) {
      const relative = path.relative(path.resolve(parent), path.resolve(child));
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    },
  });
}

function cursorHarness(secret = 'gateway-secret-for-tests') {
  const names = [
    'timingSafeEqual',
    'signXtreamCatalogCursor',
    'verifyXtreamCatalogCursor',
  ];
  return vm.runInNewContext(`(() => {
    const GATEWAY_TOKEN = secret;
    ${names.map(extractFunction).join('\n')}
    return { signXtreamCatalogCursor, verifyXtreamCatalogCursor };
  })()`, { Buffer, crypto, Date, secret });
}

async function *chunked(text, width, counter) {
  const bytes = Buffer.from(text, 'utf8');
  for (let offset = 0; offset < bytes.length; offset += width) {
    counter.chunks += 1;
    counter.bytes += Math.min(width, bytes.length - offset);
    yield bytes.subarray(offset, offset + width);
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForGateway(baseUrl, token) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/debug/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status < 500) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('media gateway did not start');
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function postPage(baseUrl, token, body) {
  return fetch(`${baseUrl}/xtream/metadata-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

test('gateway exposes an authenticated bounded catalogue page route with no direct array fallback', () => {
  assert.match(SOURCE, /app\.post\('\/xtream\/metadata-page', requireGatewayAuth/);
  assert.match(SOURCE, /XTREAM_CATALOG_PAGE_ACTIONS = new Set\(\[/);
  for (const action of [
    'get_live_categories', 'get_vod_categories', 'get_series_categories',
    'get_live_streams', 'get_vod_streams', 'get_series',
  ]) assert.match(SOURCE, new RegExp(`['"]${action}['"]`));
  assert.match(SOURCE, /fetchProviderArrayToXtreamCatalogSpool/);
  assert.match(SOURCE, /status === 202 \|\| err\.retryAfterSeconds/);
  assert.match(SOURCE, /setHeader\('Retry-After'/);
  assert.match(SOURCE, /void createXtreamCatalogSpool/);
  assert.match(SOURCE, /createCipheriv\('aes-256-gcm'/);
  assert.match(SOURCE, /xtream-catalog-manifest-v2/);
  assert.match(SOURCE, /contentDigest/);
  assert.match(SOURCE, /catalog_cursor_stale/);
  assert.match(SOURCE, /undiciRequest\(target\.pinnedUrl/);
  assert.match(SOURCE, /maxRedirections: 0/);
  assert.match(SOURCE, /host: target\.authority/);
  const accountMetadataRoute = SOURCE.slice(
    SOURCE.indexOf("app.post('/xtream/metadata'"),
    SOURCE.indexOf("app.get('/raw/:token'"),
  );
  assert.match(accountMetadataRoute, /const accountValidation = String\(req\.body\?\.action \|\| ''\) === 'account_info'/);
  assert.match(accountMetadataRoute, /details: accountValidation \? undefined/);
  assert.match(accountMetadataRoute, /maxResponseBytes: isAccountInfo \? XTREAM_ACCOUNT_INFO_MAX_BYTES/);
  assert.doesNotMatch(extractFunction('fetchProviderJson'), /error\.details = payload/);
  assert.doesNotMatch(
    SOURCE.slice(SOURCE.indexOf("app.post('/xtream/metadata-page'"), SOURCE.indexOf("app.post('/xtream/metadata'")),
    /fetchProviderJson\(/,
  );
});

test('Xtream egress rejects local, metadata, RFC1918, and DNS-private targets before a pinned request', async () => {
  const names = [
    'normalizeXtreamEgressHostname', 'ipv4Octets', 'ipv6Words',
    'isPublicXtreamEgressAddress', 'resolveXtreamEgressTarget',
  ];
  const lookups = new Map([
    ['private-dns.test', [{ address: '10.20.30.40', family: 4 }]],
    ['mixed-dns.test', [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.20', family: 4 }]],
    ['public-dns.test', [{ address: '93.184.216.34', family: 4 }]],
  ]);
  const resolveXtreamEgressTarget = vm.runInNewContext(`(() => {
    ${names.map(extractFunction).join('\n')}
    return resolveXtreamEgressTarget;
  })()`, {
    URL,
    String,
    Number,
    Array,
    Set,
    net,
    XTREAM_PRIVATE_EGRESS_ALLOWLIST: new Set(),
    dns: { promises: { lookup: async (hostname) => lookups.get(hostname) || [] } },
    backgroundProbeError(status, code, message) {
      const error = new Error(message); error.status = status; error.code = code; return error;
    },
  });
  for (const endpoint of [
    'http://127.0.0.1', 'http://[::1]', 'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1', 'http://172.16.0.1', 'http://192.168.1.1',
    'http://private-dns.test', 'http://mixed-dns.test',
  ]) {
    await assert.rejects(
      resolveXtreamEgressTarget(endpoint),
      (error) => error.code === 'invalid_egress_target' && error.status === 400,
      endpoint,
    );
  }
  const publicTarget = await resolveXtreamEgressTarget('https://public-dns.test/panel');
  assert.equal(publicTarget.pinnedUrl, 'https://93.184.216.34/panel');
  assert.equal(publicTarget.authority, 'public-dns.test');
});

test('pinned direct and proxy requests never follow a public-to-private redirect', async () => {
  const source = extractFunction('openXtreamProviderResponse');
  async function exercise(proxyUrls) {
    const requests = [];
    const dispatchers = [];
    class FakeDispatcher {
      constructor(options) { this.options = options; this.closed = false; dispatchers.push(this); }
      async close() { this.closed = true; }
    }
    const openXtreamProviderResponse = vm.runInNewContext(`(${source})`, {
      Agent: FakeDispatcher,
      ProxyAgent: FakeDispatcher,
      providerProxyUrls: proxyUrls,
      poolIndexForKey: () => 0,
      proxyKeyFromUrl: () => 'account-key',
      resolveXtreamEgressTarget: async () => ({
        pinnedUrl: 'https://93.184.216.34/player_api.php',
        hostname: 'public-panel.test',
        authority: 'public-panel.test',
        protocol: 'https:',
      }),
      undiciRequest: async (url, options) => {
        requests.push({ url, options });
        return {
          statusCode: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
          body: { text: async () => '' },
        };
      },
    });
    const response = await openXtreamProviderResponse('https://public-panel.test/player_api.php', {
      headers: { Accept: 'application/json' },
    });
    assert.equal(response.status, 302);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://93.184.216.34/player_api.php');
    assert.equal(requests[0].options.maxRedirections, 0);
    assert.equal(requests[0].options.headers.host, 'public-panel.test');
    await response.close();
    assert.equal(dispatchers[0].closed, true);
    return dispatchers[0].options;
  }
  const direct = await exercise([]);
  assert.equal(direct.connect.servername, 'public-panel.test');
  const proxied = await exercise(['http://proxy.operator.test:8080']);
  assert.equal(proxied.uri, 'http://proxy.operator.test:8080');
  assert.equal(proxied.requestTls.servername, 'public-panel.test');
});

test('spool TTL exceeds worst-case one-minute worker throughput with an expiry margin', () => {
  const maxItems = 1_000_000;
  const itemsPerPage = 250;
  const pagesPerClaim = 8;
  const claimIntervalMs = 60_000;
  const worstActionMs = Math.ceil(maxItems / (itemsPerPage * pagesPerClaim)) * claimIntervalMs;
  const minimumTtlMs = 12 * 60 * 60 * 1000;
  assert.equal(worstActionMs, 30_000_000); // 500 claims, approximately 8h20m.
  assert.ok(minimumTtlMs / worstActionMs > 1.4);
  assert.match(SOURCE, /16 \* 60 \* 60 \* 1000,[\s\S]*12 \* 60 \* 60 \* 1000,[\s\S]*24 \* 60 \* 60 \* 1000/);
});

test('runtime route polls asynchronously, resumes without refetch, and safely rebuilds a corrupt spool', async (t) => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-gateway-route-spool-'));
  const output = path.join(temp, 'output');
  const spool = path.join(temp, 'spool');
  const gatewayToken = 'gateway-runtime-token-123456789';
  const privateUser = 'provider-user-runtime-secret';
  const privatePass = 'provider-pass-runtime-secret';
  const privateToken = 'direct-source-token-runtime-987654321';
  const rows = Array.from({ length: 7 }, (_, index) => ({
    stream_id: String(index + 1),
    name: `Runtime ${index}`,
    direct_source: index === 3
      ? `http://${privateUser}:${privatePass}@provider.invalid/movie/${privateToken}`
      : '',
  }));
  let providerRows = rows;
  let providerRequests = 0;
  const providerRequestsByUser = new Map();
  const provider = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const providerUser = url.searchParams.get('username') || '';
    if (url.pathname === '/player_api.php' && !url.searchParams.has('action')
        && providerUser === 'provider-auth-error-user-secret') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `raw provider fragment ${privateUser} ${privatePass} ${privateToken}`,
        account_id: 'raw-account-id-secret',
      }));
      return;
    }
    if (url.pathname === '/player_api.php' && !url.searchParams.has('action')
        && providerUser === 'provider-oversized-account-secret') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(`{"user_info":{"auth":1},"private":"${privateToken}","padding":"`);
      for (let index = 0; index < 40; index += 1) res.write('x'.repeat(8192));
      res.end('"}');
      return;
    }
    if (url.pathname !== '/player_api.php' || url.searchParams.get('action') !== 'get_vod_streams') {
      res.writeHead(404).end();
      return;
    }
    providerRequests += 1;
    providerRequestsByUser.set(providerUser, (providerRequestsByUser.get(providerUser) || 0) + 1);
    if (providerUser === 'provider-5xx-user-secret') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"error":"upstream unavailable"}');
      return;
    }
    if (providerUser === 'provider-invalid-json-user-secret') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[{"stream_id":"1"},] trailing');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const providerPayload = JSON.stringify(providerRows);
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= providerPayload.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(providerPayload.slice(offset, offset + 31));
      offset += 31;
    }, 2);
  });
  const providerPort = await listen(provider);
  t.after(() => new Promise((resolve) => provider.close(resolve)));

  const gatewayPort = await freePort();
  let logs = '';
  const child = spawn(process.execPath, [GATEWAY_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      GATEWAY_TOKEN: gatewayToken,
      OUTPUT_DIR: output,
      XTREAM_CATALOG_SPOOL_DIR: spool,
      XTREAM_CATALOG_BUILD_TIMEOUT_MS: '60000',
      XTREAM_CATALOG_SPOOL_TTL_MS: '600000',
      XTREAM_PRIVATE_EGRESS_ALLOWLIST: '127.0.0.1',
      PROVIDER_PROXY_URL: '',
      PROVIDER_PROXY_URLS: '',
      NORVA_EDGE_CALLBACK_BASE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString('utf8'); });
  t.after(() => stopChild(child));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  await waitForGateway(baseUrl, gatewayToken);

  const accountFailureResponse = await fetch(`${baseUrl}/xtream/metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayToken}` },
    body: JSON.stringify({
      serverUrl: `http://127.0.0.1:${providerPort}`,
      username: 'provider-auth-error-user-secret',
      password: 'provider-auth-error-pass-secret',
      action: 'account_info',
    }),
  });
  assert.equal(accountFailureResponse.status, 401);
  const accountFailureText = await accountFailureResponse.text();
  assert.match(accountFailureText, /PROVIDER_REQUEST_FAILED/);
  for (const fragment of [privateUser, privatePass, privateToken, 'raw-account-id-secret', 'raw provider fragment']) {
    assert.equal(accountFailureText.includes(fragment), false, `account validation leaked ${fragment}`);
  }

  const oversizedAccountResponse = await fetch(`${baseUrl}/xtream/metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayToken}` },
    body: JSON.stringify({
      serverUrl: `http://127.0.0.1:${providerPort}`,
      username: 'provider-oversized-account-secret',
      password: 'provider-oversized-account-pass-secret',
      action: 'account_info',
    }),
  });
  assert.equal(oversizedAccountResponse.status, 502);
  const oversizedAccountText = await oversizedAccountResponse.text();
  assert.match(oversizedAccountText, /PROVIDER_RESPONSE_TOO_LARGE/);
  assert.equal(oversizedAccountText.includes(privateToken), false);

  const body = {
    serverUrl: `http://127.0.0.1:${providerPort}`,
    username: privateUser,
    password: privatePass,
    action: 'get_vod_streams',
    params: {},
    maxItems: 2,
    spoolKey: 'runtimeSpoolKey_1234567890',
  };
  let response = await postPage(baseUrl, gatewayToken, body);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('retry-after'), '2');
  let pending = await response.json();
  assert.equal(pending.code, 'catalog_spool_building');
  assert.ok(typeof pending.cursor === 'string' && pending.cursor.length <= 512);

  let firstPage;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    response = await postPage(baseUrl, gatewayToken, { ...body, cursor: pending.cursor });
    const payload = await response.json();
    if (response.status === 200) {
      firstPage = payload;
      break;
    }
    assert.equal(response.status, 202);
    pending = payload;
  }
  assert.ok(firstPage, 'spool never became readable');
  assert.equal(providerRequests, 1);
  const restored = [...firstPage.items];
  let cursor = firstPage.nextCursor;
  while (cursor) {
    response = await postPage(baseUrl, gatewayToken, { ...body, cursor });
    assert.equal(response.status, 200);
    const page = await response.json();
    restored.push(...page.items);
    cursor = page.nextCursor;
  }
  assert.deepEqual(restored, rows);

  response = await postPage(baseUrl, gatewayToken, body);
  assert.equal(response.status, 200);
  assert.equal(providerRequests, 1, 'completed deterministic spool was fetched twice');
  const replay = await response.json();
  assert.deepEqual(replay.items, firstPage.items);

  response = await postPage(baseUrl, gatewayToken, {
    ...body,
    password: `${privatePass}-changed`,
    cursor: firstPage.nextCursor,
  });
  assert.equal(response.status, 400, 'cursor must be bound to credentials and action');
  assert.equal(providerRequests, 1);

  const spoolEntries = await fsp.readdir(spool, { withFileTypes: true });
  const finalEntry = spoolEntries.find((entry) => entry.isDirectory() && /^[a-f0-9]{48}$/.test(entry.name));
  assert.ok(finalEntry);
  const finalDir = path.join(spool, finalEntry.name);
  const manifestPath = path.join(finalDir, 'manifest.json');
  const manifest = await fsp.readFile(manifestPath);
  const diskFiles = [manifest];
  for (const name of await fsp.readdir(finalDir)) {
    if (name.endsWith('.bin')) diskFiles.push(await fsp.readFile(path.join(finalDir, name)));
  }
  const diskText = Buffer.concat(diskFiles).toString('latin1');
  for (const secret of [body.serverUrl, privateUser, privatePass, privateToken]) {
    assert.equal(diskText.includes(secret), false, `spool leaked ${secret}`);
    assert.equal(logs.includes(secret), false, `logs leaked ${secret}`);
  }

  await fsp.writeFile(manifestPath, '{"corrupt":true}', 'utf8');
  response = await postPage(baseUrl, gatewayToken, body);
  assert.equal(response.status, 202);
  pending = await response.json();
  let rebuilt = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    response = await postPage(baseUrl, gatewayToken, { ...body, cursor: pending.cursor });
    if (response.status === 200) {
      rebuilt = true;
      break;
    }
    assert.equal(response.status, 202);
  }
  assert.equal(rebuilt, true, 'corrupt final directory caused an infinite 202 loop');
  assert.equal(providerRequests, 2);

  const rebuiltEntries = await fsp.readdir(finalDir);
  const firstEncryptedPage = rebuiltEntries.find((name) => name.endsWith('.bin'));
  assert.ok(firstEncryptedPage);
  await fsp.writeFile(path.join(finalDir, firstEncryptedPage), Buffer.from('tampered-page'));
  response = await postPage(baseUrl, gatewayToken, body);
  assert.equal(response.status, 202, 'tampered AEAD page must trigger a safe rebuild');
  pending = await response.json();
  rebuilt = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    response = await postPage(baseUrl, gatewayToken, { ...body, cursor: pending.cursor });
    if (response.status === 200) {
      rebuilt = true;
      break;
    }
    assert.equal(response.status, 202);
  }
  assert.equal(rebuilt, true, 'tampered page remained permanently poisoned');
  assert.equal(providerRequests, 3);

  // An old durable page cursor may resume after reconstruction only when the
  // exact provider response digest is unchanged. Physical build identity and
  // expiry may rotate, but the already-consumed prefix remains byte-identical.
  response = await postPage(baseUrl, gatewayToken, body);
  assert.equal(response.status, 200);
  const sameContentPrefix = await response.json();
  const sameContentRequest = {
    ...body,
    cursor: sameContentPrefix.nextCursor,
    spoolToken: sameContentPrefix.spoolToken,
  };
  await fsp.writeFile(path.join(finalDir, 'page-00000001.bin'), Buffer.from('tampered-same-content'));
  response = await postPage(baseUrl, gatewayToken, sameContentRequest);
  assert.equal(response.status, 202);
  let exactResume = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    response = await postPage(baseUrl, gatewayToken, sameContentRequest);
    const payload = await response.json();
    if (response.status === 200) {
      exactResume = payload;
      break;
    }
    assert.equal(response.status, 202);
  }
  assert.deepEqual(exactResume?.items, rows.slice(2, 4));
  assert.equal(providerRequests, 4);

  // Simulate the durable Edge job having already committed page zero. If page
  // one is corrupt and the provider changes during reconstruction, that old
  // cursor must never continue into the new spool and mix two inventories.
  response = await postPage(baseUrl, gatewayToken, body);
  assert.equal(response.status, 200);
  const prefixPage = await response.json();
  assert.ok(prefixPage.nextCursor && prefixPage.spoolToken);
  await fsp.writeFile(path.join(finalDir, 'page-00000001.bin'), Buffer.from('tampered-page-two'));
  providerRows = rows.map((row, index) => index < 2 ? row : ({ ...row, name: `Changed ${index}` }));
  const staleRequest = {
    ...body,
    cursor: prefixPage.nextCursor,
    spoolToken: prefixPage.spoolToken,
  };
  response = await postPage(baseUrl, gatewayToken, staleRequest);
  assert.equal(response.status, 202);
  let staleFailure = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    response = await postPage(baseUrl, gatewayToken, staleRequest);
    const payload = await response.json();
    assert.notEqual(response.status, 200, 'old cursor resumed into changed rebuilt content');
    if (response.status === 409) {
      staleFailure = payload;
      break;
    }
    assert.equal(response.status, 202);
  }
  assert.equal(staleFailure?.code, 'catalog_cursor_stale');
  assert.equal(providerRequests, 5);

  for (const [username, spoolKey] of [
    ['provider-5xx-user-secret', 'runtimeFailureSpoolKey_12345'],
    ['provider-invalid-json-user-secret', 'runtimeInvalidSpoolKey_12345'],
  ]) {
    const failingBody = { ...body, username, spoolKey };
    response = await postPage(baseUrl, gatewayToken, failingBody);
    assert.equal(response.status, 202);
    pending = await response.json();
    let terminalFailure;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      response = await postPage(baseUrl, gatewayToken, { ...failingBody, cursor: pending.cursor });
      const payload = await response.json();
      if (response.status === 503) {
        terminalFailure = payload;
        break;
      }
      assert.equal(response.status, 202);
    }
    assert.equal(terminalFailure?.code, 'catalog_spool_build_failed');
    const countAfterFailure = providerRequestsByUser.get(username);
    response = await postPage(baseUrl, gatewayToken, { ...failingBody, cursor: pending.cursor });
    assert.equal(response.status, 503, 'persisted failure must stop infinite 202 polling');
    assert.equal(providerRequestsByUser.get(username), countAfterFailure, 'failure poll refetched upstream');
    assert.equal(logs.includes(username), false, 'failure logs leaked provider username');
  }
});

test('large fragmented provider arrays are streamed once into bounded exact pages', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-catalog-spool-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const rows = Array.from({ length: 12_345 }, (_, index) => ({
    stream_id: String(index + 1),
    name: `Title ${index} \\"quoted\\"`,
    nested: { category_id: String(index % 37), flags: [true, false, index] },
    direct_source: index === 17
      ? 'https://secret-user:secret-pass@provider.example/movie/private-token-1234567890'
      : '',
  }));
  const payload = JSON.stringify(rows);
  const counter = { chunks: 0, bytes: 0 };
  const harness = spoolHarness({ pageBytes: 24 * 1024, itemBytes: 4 * 1024 });
  const encryptionContext = {
    spoolId: 'a'.repeat(48), binding: 'b'.repeat(64), buildId: 'c'.repeat(32),
  };
  const result = await harness.spoolTopLevelJsonObjectArray(
    chunked(payload, 97, counter),
    directory,
    113,
    encryptionContext,
  );

  assert.equal(result.itemCount, rows.length);
  assert.match(result.contentDigest, /^[a-f0-9]{64}$/);
  assert.ok(result.pageCount > 100);
  assert.equal(counter.bytes, Buffer.byteLength(payload));
  const restored = [];
  for (let page = 0; page < result.pageCount; page += 1) {
    const file = path.join(directory, `page-${String(page).padStart(8, '0')}.bin`);
    const stat = await fsp.stat(file);
    assert.ok(stat.size <= 24 * 1024 + 64, `page ${page} exceeded byte bound`);
    const encrypted = await fsp.readFile(file);
    const diskText = encrypted.toString('latin1');
    assert.doesNotMatch(diskText, /secret-user|secret-pass|private-token-1234567890|provider\.example/);
    const plaintext = harness.decryptXtreamCatalogPage(encrypted, {
      ...encryptionContext,
      pageIndex: page,
    });
    const items = JSON.parse(Buffer.from(plaintext).toString('utf8'));
    assert.ok(items.length <= 113, `page ${page} exceeded item bound`);
    restored.push(...items);
  }
  assert.deepEqual(restored, rows);
});

test('spooling fails closed instead of truncating oversized provider catalogues', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-catalog-spool-cap-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const harness = spoolHarness({ spoolBytes: 1024, spoolItems: 3, pageBytes: 2048, itemBytes: 1024 });
  await assert.rejects(
    harness.spoolTopLevelJsonObjectArray(
      chunked(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]), 11, { chunks: 0, bytes: 0 }),
      directory,
      2,
      { spoolId: 'c'.repeat(48), binding: 'd'.repeat(64), buildId: 'e'.repeat(32) },
    ),
    (error) => error && error.code === 'catalog_too_many_items',
  );
  await assert.rejects(
    harness.spoolTopLevelJsonObjectArray(
      chunked(JSON.stringify([{ id: 1, value: 'x'.repeat(2000) }]), 67, { chunks: 0, bytes: 0 }),
      directory,
      2,
      { spoolId: 'c'.repeat(48), binding: 'd'.repeat(64), buildId: 'e'.repeat(32) },
    ),
    (error) => error && ['catalog_too_large', 'catalog_item_too_large'].includes(error.code),
  );
});

test('invalid, trailing, scalar, and incomplete JSON never produces a sealed page set', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-catalog-invalid-json-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const harness = spoolHarness();
  const invalidPayloads = [
    '{"id":1}',
    '[{"id":1}] trailing',
    '[{"id":1}',
    '[1]',
    '[{"id":1},]',
  ];
  for (let index = 0; index < invalidPayloads.length; index += 1) {
    const directory = path.join(root, String(index));
    await fsp.mkdir(directory);
    await assert.rejects(
      harness.spoolTopLevelJsonObjectArray(
        chunked(invalidPayloads[index], 3, { chunks: 0, bytes: 0 }),
        directory,
        10,
        { spoolId: 'e'.repeat(48), binding: 'f'.repeat(64), buildId: 'a'.repeat(32) },
      ),
      (error) => error && error.code === 'invalid_payload',
    );
  }
});

test('viewer playback preempts catalogue construction before any upstream fetch', async () => {
  const source = extractFunction('fetchProviderArrayToXtreamCatalogSpool');
  let fetchCalls = 0;
  const fetchProviderArrayToXtreamCatalogSpool = vm.runInNewContext(`(${source})`, {
    AbortController,
    String,
    accountExtractions: new Map(),
    backgroundProbeError(status, code, message) {
      const error = new Error(message);
      error.status = status;
      error.code = code;
      return error;
    },
    viewerPlaybackActiveLocally: () => true,
    fetch: async () => { fetchCalls += 1; },
    setTimeout,
    clearTimeout,
  });
  await assert.rejects(
    fetchProviderArrayToXtreamCatalogSpool({
      url: 'https://provider.invalid/player_api.php',
      userAgent: 'test',
      backgroundAccountKey: 'account-key',
      spoolDir: '/unused',
      maxItems: 2,
      spoolId: 'a'.repeat(48),
      binding: 'b'.repeat(64),
    }),
    (error) => error && error.code === 'account_busy' && error.status === 409,
  );
  assert.equal(fetchCalls, 0);
});

test('opaque cursor is HMAC authenticated, expiring, and contains no credentials', () => {
  const harness = cursorHarness();
  const claims = {
    spoolId: 'a'.repeat(48),
    pageIndex: 7,
    expiresAt: Date.now() + 60_000,
    binding: 'b'.repeat(64),
    buildId: 'c'.repeat(32),
    contentDigest: 'd'.repeat(64),
  };
  const token = harness.signXtreamCatalogCursor(claims);
  assert.ok(token.length <= 512);
  assert.doesNotMatch(token, /provider-user|provider-password|https?:/i);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.verifyXtreamCatalogCursor(token))), {
    spoolId: claims.spoolId,
    pageIndex: 7,
    expiresAt: Math.floor(claims.expiresAt / 1000) * 1000,
    binding: claims.binding,
    buildId: claims.buildId,
    contentDigest: claims.contentDigest,
  });
  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(harness.verifyXtreamCatalogCursor(tampered), null);
  const expired = harness.signXtreamCatalogCursor({ ...claims, expiresAt: Date.now() - 1000 });
  assert.equal(harness.verifyXtreamCatalogCursor(expired), null);
});

test('spool identity is deterministic but keyed and binds credentials/action/category', () => {
  const names = ['xtreamCatalogRequestBinding', 'xtreamCatalogSpoolId'];
  const harness = vm.runInNewContext(`(() => {
    const GATEWAY_TOKEN = secret;
    ${names.map(extractFunction).join('\n')}
    return { xtreamCatalogRequestBinding, xtreamCatalogSpoolId };
  })()`, { crypto, URL, secret: 'spool-hmac-secret' });
  const base = {
    serverUrl: 'https://provider.example/base', username: 'secret-user', password: 'secret-pass',
    action: 'get_vod_streams', categoryId: '42', maxItems: 250, spoolKey: 'A'.repeat(32),
  };
  const binding = harness.xtreamCatalogRequestBinding(base);
  const id = harness.xtreamCatalogSpoolId(binding, base.spoolKey);
  assert.match(binding, /^[a-f0-9]{64}$/);
  assert.match(id, /^[a-f0-9]{48}$/);
  assert.equal(harness.xtreamCatalogSpoolId(binding, base.spoolKey), id);
  assert.notEqual(harness.xtreamCatalogRequestBinding({ ...base, categoryId: '43' }), binding);
  assert.notEqual(harness.xtreamCatalogRequestBinding({ ...base, password: 'changed' }), binding);
  assert.doesNotMatch(`${binding}${id}`, /secret-user|secret-pass|provider\.example/);
});
