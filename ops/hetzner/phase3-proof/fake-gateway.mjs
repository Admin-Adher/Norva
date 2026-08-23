import { createServer } from 'node:http';

const token = process.env.FAKE_GATEWAY_TOKEN;
if (!token) throw new Error('FAKE_GATEWAY_TOKEN is required');

createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/sessions/stop-provider-affinities') {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      const hashes = parsed?.affinityHashes;
      if (!Array.isArray(hashes) || hashes.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
        response.writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'opaque SHA-256 affinity hashes are required' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ protocol: 1, providerDrained: true, acceptedHashes: hashes.length }));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid JSON' }));
    }
  });
}).listen(8080, '0.0.0.0');
