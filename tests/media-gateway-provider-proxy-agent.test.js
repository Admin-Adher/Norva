'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const {
  createProviderProxyAgent,
  socks5ProxyDescriptor,
} = require('../services/media-gateway/src/providerProxyAgent.js');

function encodedSocksUrl({ host = '127.0.0.1', port, username, password }) {
  return `socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

function authenticatedSocks5Server(expectedCredentials) {
  const observed = [];
  const server = net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    let phase = 'greeting';
    let upstream = null;

    const fail = () => client.destroy(new Error('Invalid local SOCKS5 test exchange'));
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (phase === 'greeting') {
          if (buffer.length < 2) return;
          const length = 2 + buffer[1];
          if (buffer.length < length) return;
          if (buffer[0] !== 0x05 || !buffer.subarray(2, length).includes(0x02)) return fail();
          buffer = buffer.subarray(length);
          phase = 'auth';
          client.write(Buffer.from([0x05, 0x02]));
          continue;
        }

        if (phase === 'auth') {
          if (buffer.length < 2) return;
          const authVersion = buffer[0];
          const usernameLength = buffer[1];
          if (buffer.length < 2 + usernameLength + 1) return;
          const passwordLengthOffset = 2 + usernameLength;
          const passwordLength = buffer[passwordLengthOffset];
          const length = passwordLengthOffset + 1 + passwordLength;
          if (buffer.length < length) return;
          const username = buffer.subarray(2, passwordLengthOffset).toString('utf8');
          const password = buffer.subarray(passwordLengthOffset + 1, length).toString('utf8');
          observed.push({ username, password });
          buffer = buffer.subarray(length);
          if (authVersion === 0x01 && username === expectedCredentials.username
              && password === expectedCredentials.password) {
            phase = 'connect';
            client.write(Buffer.from([0x01, 0x00]));
            continue;
          }
          client.end(Buffer.from([0x01, 0x01]));
          return;
        }

        if (phase === 'connect') {
          if (buffer.length < 4 || buffer[0] !== 0x05 || buffer[1] !== 0x01) return;
          const addressType = buffer[3];
          let address;
          let addressEnd;
          if (addressType === 0x01) {
            if (buffer.length < 10) return;
            address = Array.from(buffer.subarray(4, 8)).join('.');
            addressEnd = 8;
          } else if (addressType === 0x03) {
            if (buffer.length < 5 + buffer[4] + 2) return;
            addressEnd = 5 + buffer[4];
            address = buffer.subarray(5, addressEnd).toString('utf8');
          } else {
            return fail();
          }
          if (buffer.length < addressEnd + 2) return;
          const port = buffer.readUInt16BE(addressEnd);
          const pending = buffer.subarray(addressEnd + 2);
          buffer = Buffer.alloc(0);
          phase = 'tunnel-pending';
          client.pause();
          upstream = net.createConnection({ host: address, port });
          upstream.once('error', (error) => client.destroy(error));
          upstream.once('connect', () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            client.removeListener('data', onData);
            if (pending.length) upstream.write(pending);
            client.pipe(upstream);
            upstream.pipe(client);
            client.resume();
            phase = 'tunnel';
          });
          return;
        }
        return;
      }
    };

    client.on('data', onData);
    client.once('close', () => upstream?.destroy());
  });
  return { server, observed };
}

test('SOCKS5 credentials are decoded exactly once and removed from the transport URL', () => {
  const credentials = {
    username: 'user+name@example',
    password: 'p@ss#%:+/word',
  };
  const descriptor = socks5ProxyDescriptor(encodedSocksUrl({
    port: 1080,
    ...credentials,
  }));

  assert.equal(descriptor.proxyUrl, 'socks5://127.0.0.1:1080');
  assert.equal(descriptor.username, credentials.username);
  assert.equal(descriptor.password, credentials.password);
  assert.equal(descriptor.proxyUrl.includes('user'), false);
  assert.equal(descriptor.proxyUrl.includes('p%40ss'), false);
});

test('SOCKS5 agent construction supplies decoded credentials as explicit private options', () => {
  class FakeSocks5ProxyAgent {
    constructor(proxyUrl, options) {
      this.proxyUrl = proxyUrl;
      this.options = options;
    }
  }
  class FakeProxyAgent {}
  const credentials = { username: 'u+ser', password: 'p@ss#%:+' };
  const agent = createProviderProxyAgent(
    encodedSocksUrl({ port: 1080, ...credentials }),
    { requestTls: { servername: 'provider.example' } },
    { ProxyAgent: FakeProxyAgent, Socks5ProxyAgent: FakeSocks5ProxyAgent },
  );

  assert.equal(agent.proxyUrl, 'socks5://127.0.0.1:1080');
  assert.equal(agent.options.username, credentials.username);
  assert.equal(agent.options.password, credentials.password);
  assert.deepEqual(agent.options.requestTls, { servername: 'provider.example' });
});

test('SOCKS5 credentials fail closed when malformed, incomplete, or too large', () => {
  assert.throws(
    () => socks5ProxyDescriptor('socks5://user:bad%@127.0.0.1:1080'),
    (error) => error.code === 'PROXY_CREDENTIALS_INVALID'
      && !String(error.message).includes('bad%'),
  );
  assert.throws(
    () => socks5ProxyDescriptor('socks5://user@127.0.0.1:1080'),
    (error) => error.code === 'PROXY_CREDENTIALS_INVALID',
  );
  assert.throws(
    () => socks5ProxyDescriptor(encodedSocksUrl({
      port: 1080,
      username: 'user',
      password: 'x'.repeat(256),
    })),
    (error) => error.code === 'PROXY_CREDENTIALS_INVALID',
  );
});

let undici = null;
try {
  undici = require(path.join(
    __dirname,
    '../services/media-gateway/node_modules/undici',
  ));
} catch (_) {
  // The root test suite does not install service dependencies in every CI lane.
}

test('real Undici SOCKS5 exchange authenticates special-character credentials', {
  skip: !undici && 'media-gateway dependencies are not installed',
}, async (t) => {
  const credentials = {
    username: 'user+name@example',
    password: 'p@ss#%:+/word',
  };
  const origin = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('SOCKS5_OK');
  });
  const socks = authenticatedSocks5Server(credentials);
  const originAddress = await listen(origin);
  const socksAddress = await listen(socks.server);
  let agent = null;

  t.after(async () => {
    await agent?.close();
    await closeServer(socks.server);
    await closeServer(origin);
  });

  agent = createProviderProxyAgent(
    encodedSocksUrl({ port: socksAddress.port, ...credentials }),
    {},
    undici,
  );
  const response = await undici.request(
    `http://127.0.0.1:${originAddress.port}/probe`,
    { dispatcher: agent, headersTimeout: 2_000, bodyTimeout: 2_000 },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(await response.body.text(), 'SOCKS5_OK');
  assert.deepEqual(socks.observed, [credentials]);
});
