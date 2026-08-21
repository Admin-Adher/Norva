'use strict';

// Equivalence vectors. Every pair here is one subject wearing two spellings, and
// a canonicaliser that files them apart would make the engine quietly worse at
// its job without failing a single other test.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { importTypescriptModule } = require('./helpers/import-typescript-module');

const modulePath = path.join(
  __dirname,
  '..',
  'supabase/functions/_shared/risk-subject-canonical.ts',
);
const loading = importTypescriptModule(modulePath);

test('the same IPv6 host is one subject however it is written', async () => {
  const { canonicalizeRiskSubject } = await loading;
  const expected = canonicalizeRiskSubject('ip', '2001:db8::1');
  assert.ok(expected);
  for (const spelling of [
    '2001:0db8:0000:0000:0000:0000:0000:0001',
    '2001:DB8::1',
    '2001:db8:0:0:0:0:0:1',
    '  2001:db8::1  ',
    // A zone index names a local interface, not a different peer.
    '2001:db8::1%eth0',
  ]) {
    assert.equal(canonicalizeRiskSubject('ip', spelling), expected, spelling);
  }
});

test('an IPv4-mapped address collapses onto its hextet spelling', async () => {
  const { canonicalizeRiskSubject } = await loading;
  assert.equal(
    canonicalizeRiskSubject('ip', '::ffff:1.2.3.4'),
    canonicalizeRiskSubject('ip', '::ffff:102:304'),
  );
});

test('IPv4 and IPv4-mapped IPv6 stay separate subjects', async () => {
  const { canonicalizeRiskSubject } = await loading;
  // They are the same host, but they arrive through different stacks and
  // conflating them would let one hide behind the other's counter.
  assert.notEqual(
    canonicalizeRiskSubject('ip', '1.2.3.4'),
    canonicalizeRiskSubject('ip', '::ffff:1.2.3.4'),
  );
});

test('a /24 is masked on the bytes, not by cutting the text', async () => {
  const { canonicalizeRiskSubject } = await loading;
  const subnet = canonicalizeRiskSubject('ip_subnet_24', '88.163.67.137');
  assert.equal(canonicalizeRiskSubject('ip_subnet_24', '88.163.67.1'), subnet);
  // 67.137 and 67.13 share a /24; naive string trimming at the last dot would
  // tell them apart.
  assert.equal(canonicalizeRiskSubject('ip_subnet_24', '88.163.67.13'), subnet);
  assert.notEqual(canonicalizeRiskSubject('ip_subnet_24', '88.163.68.137'), subnet);
  assert.equal(canonicalizeRiskSubject('ip_subnet_24', '2001:db8::1'), null,
    'a /24 is meaningless for IPv6');
});

test('a /64 keeps neighbours apart and one LAN together', async () => {
  const { canonicalizeRiskSubject } = await loading;
  const lan = canonicalizeRiskSubject('ip_subnet_64', '2001:db8:1:2:3:4:5:6');
  assert.equal(canonicalizeRiskSubject('ip_subnet_64', '2001:db8:1:2::ffff'), lan);
  assert.equal(canonicalizeRiskSubject('ip_subnet_64', '2001:0db8:0001:0002::1'), lan);
  // The neighbouring /64 is a different subscriber and must not share a counter.
  assert.notEqual(canonicalizeRiskSubject('ip_subnet_64', '2001:db8:1:3::1'), lan);
  assert.equal(canonicalizeRiskSubject('ip_subnet_64', '88.163.67.137'), null);
});

test('an ASN is a number however it is spelled', async () => {
  const { canonicalizeRiskSubject } = await loading;
  const expected = canonicalizeRiskSubject('asn', '64500');
  for (const spelling of ['AS64500', 'as64500', ' As64500 ']) {
    assert.equal(canonicalizeRiskSubject('asn', spelling), expected, spelling);
  }
  assert.equal(canonicalizeRiskSubject('asn', 'AS64500x'), null);
  assert.equal(canonicalizeRiskSubject('asn', '4294967296'), null, 'beyond 32 bits');
});

test('malformed addresses are refused rather than counted as a shared subject', async () => {
  const { canonicalizeRiskSubject } = await loading;
  for (const bad of [
    '',
    '   ',
    'not-an-ip',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    // Leading zeros are read as octal by some resolvers and decimal by others,
    // so the value has no single meaning worth counting.
    '010.1.1.1',
    '2001:db8::1::2',
    '2001:db8:1:2:3:4:5:6:7',
    'gggg::1',
  ]) {
    assert.equal(canonicalizeRiskSubject('ip', bad), null, JSON.stringify(bad));
  }
});

test('an email is lowercased but its local part is left alone', async () => {
  const { canonicalizeRiskSubject } = await loading;
  const canonical = canonicalizeRiskSubject('email', 'User@Example.COM');
  assert.equal(canonicalizeRiskSubject('email', '  user@example.com '), canonical);
  // Gmail dot and plus folding is a provider-specific policy decision and is
  // deliberately not taken here: merging counters that a provider does not merge
  // would punish people who legitimately own both addresses.
  assert.notEqual(canonicalizeRiskSubject('email', 'u.ser@example.com'), canonical);
  assert.equal(canonicalizeRiskSubject('email', 'nope'), null);
  assert.equal(canonicalizeRiskSubject('email', '@example.com'), null);
});

test('dimensions cannot collide with one another', async () => {
  const { canonicalizeRiskSubject } = await loading;
  const values = new Set([
    canonicalizeRiskSubject('ip', '1.2.3.0'),
    canonicalizeRiskSubject('ip_subnet_24', '1.2.3.0'),
    canonicalizeRiskSubject('device', '1.2.3.0'),
    canonicalizeRiskSubject('user_agent', '1.2.3.0'),
  ]);
  // A family prefix keeps a /24 from ever sharing an identifier with the exact
  // address that sits at the bottom of it.
  assert.equal(values.size, 4);
});

test('a user agent survives reformatting by a proxy', async () => {
  const { canonicalizeRiskSubject } = await loading;
  assert.equal(
    canonicalizeRiskSubject('user_agent', 'Mozilla/5.0  (Linux)   Chrome/1'),
    canonicalizeRiskSubject('user_agent', 'Mozilla/5.0 (Linux) Chrome/1'),
  );
});
