import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractProviderAccessState,
  PROVIDER_ACCESS_DETECTION_VERSION,
} from '../supabase/functions/_shared/provider-access-state.mjs';

const NOW = '2026-08-24T12:00:00.000Z';
const epoch = (iso) => String(Math.floor(new Date(`${iso}T12:00:00.000Z`).getTime() / 1000));
const detect = (userInfo) => extractProviderAccessState({ user_info: userInfo }, { now: NOW });

test('active Xtream account with a future expiry is active and can prove restoration', () => {
  const result = detect({ auth: 1, status: 'Active', exp_date: epoch('2026-10-01'), is_trial: '0', active_cons: '1', max_connections: '2' });
  assert.equal(result.detectionVersion, PROVIDER_ACCESS_DETECTION_VERSION);
  assert.equal(result.status, 'active');
  assert.equal(result.expiresOn, '2026-10-01');
  assert.equal(result.restorationConfirmed, true);
  assert.equal(result.hideEligible, false);
  assert.deepEqual(result.contradictions, []);
});

test('active account inside the seven-day boundary is expiring', () => {
  const result = detect({ auth: true, status: 'Active', exp_date: epoch('2026-08-31') });
  assert.equal(result.status, 'expiring');
  assert.equal(result.reasonCode, 'PROVIDER_EXPIRY_APPROACHING');
});

test('confirmed expired account is the only date-expiry path eligible to hide', () => {
  const result = detect({ auth: 0, status: 'Expired', exp_date: epoch('2026-08-23') });
  assert.equal(result.status, 'expired_confirmed');
  assert.equal(result.hideEligible, true);
  assert.equal(result.restorationConfirmed, false);
});

test('disabled account without an expiry is confirmed unavailable', () => {
  const result = detect({ auth: 0, status: 'Disabled', exp_date: '0' });
  assert.equal(result.status, 'access_unavailable_confirmed');
  assert.equal(result.hideEligible, true);
  assert.equal(result.expiresOn, null);
});

test('manual-looking past date without provider status stays expected and visible', () => {
  const result = detect({ exp_date: epoch('2026-08-23') });
  assert.equal(result.status, 'expected_expired');
  assert.equal(result.hideEligible, false);
});

for (const expDate of ['', 0, '0', null, undefined]) {
  test(`empty/unlimited expiry ${String(expDate)} never manufactures expiration`, () => {
    const result = detect({ auth: 1, status: 'Active', exp_date: expDate });
    assert.equal(result.status, 'active');
    assert.equal(result.expiresOn, null);
    assert.equal(result.hideEligible, false);
  });
}

test('Active plus a past date is contradictory and cannot hide', () => {
  const result = detect({ auth: 1, status: 'Active', exp_date: epoch('2026-08-23') });
  assert.equal(result.status, 'check_failed_temporary');
  assert.equal(result.hideEligible, false);
  assert.ok(result.contradictions.includes('ACTIVE_WITH_PAST_EXPIRY'));
});

test('Expired plus a future date is contradictory and cannot hide', () => {
  const result = detect({ auth: 0, status: 'Expired', exp_date: epoch('2026-09-30') });
  assert.equal(result.status, 'check_failed_temporary');
  assert.equal(result.hideEligible, false);
  assert.ok(result.contradictions.includes('UNAVAILABLE_WITH_FUTURE_EXPIRY'));
});

for (const invalid of ['not-a-timestamp', '-1', '999999999999', '1.5']) {
  test(`invalid expiry ${invalid} is a temporary check failure`, () => {
    const result = detect({ auth: 1, status: 'Active', exp_date: invalid });
    assert.equal(result.status, 'check_failed_temporary');
    assert.equal(result.hideEligible, false);
    assert.ok(result.contradictions.includes('INVALID_EXPIRY'));
  });
}

test('connection counters are retained as bounded signals', () => {
  const result = detect({ auth: 1, status: 'Active', active_cons: '2', max_connections: '3' });
  assert.equal(result.activeConnections, 2);
  assert.equal(result.maxConnections, 3);
  assert.equal(result.status, 'active');
});

test('active connections above the maximum are inconsistent and cannot hide', () => {
  const result = detect({ auth: 1, status: 'Active', active_cons: '4', max_connections: '3' });
  assert.equal(result.status, 'check_failed_temporary');
  assert.equal(result.hideEligible, false);
  assert.ok(result.contradictions.includes('ACTIVE_CONNECTIONS_EXCEED_MAXIMUM'));
});

test('invalid counters are an inconsistency instead of an implicit zero', () => {
  const result = detect({ auth: 1, status: 'Active', active_cons: '-1', max_connections: 'many' });
  assert.equal(result.status, 'check_failed_temporary');
  assert.ok(result.contradictions.includes('INVALID_ACTIVE_CONNECTIONS'));
  assert.ok(result.contradictions.includes('INVALID_MAX_CONNECTIONS'));
});

test('auth/status contradictions fail visible', () => {
  const authenticatedExpired = detect({ auth: 1, status: 'Expired', exp_date: epoch('2026-08-23') });
  const unauthenticatedActive = detect({ auth: 0, status: 'Active', exp_date: epoch('2026-09-30') });
  assert.equal(authenticatedExpired.status, 'check_failed_temporary');
  assert.equal(unauthenticatedActive.status, 'check_failed_temporary');
  assert.equal(authenticatedExpired.hideEligible, false);
  assert.equal(unauthenticatedActive.hideEligible, false);
});

test('input is not mutated and output is frozen', () => {
  const input = { user_info: { auth: 1, status: 'Active', exp_date: '0' } };
  const before = JSON.stringify(input);
  const result = extractProviderAccessState(input, { now: NOW });
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.isFrozen(result), true);
});

test('warning boundary is configurable but bounded', () => {
  const result = extractProviderAccessState({ user_info: { auth: 1, status: 'Active', exp_date: epoch('2026-09-03') } }, { now: NOW, warningDays: 10 });
  assert.equal(result.status, 'expiring');
  assert.throws(() => extractProviderAccessState({}, { now: NOW, warningDays: 91 }), /warningDays/);
  assert.throws(() => extractProviderAccessState({}, { now: 'invalid' }), /valid date/);
});
