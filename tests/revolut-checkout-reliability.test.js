const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('checkout schema provides single-flight leases and one current intent per user', () => {
  const sql = read('supabase/migrations/20260721110000_revolut_checkout_reliability.sql');
  assert.match(sql, /cloud_revolut_checkout_intents/);
  assert.match(sql, /claim_revolut_checkout_intent/);
  assert.match(sql, /uq_revolut_checkout_intents_current_user/);
  assert.match(sql, /lease_expires_at/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /finalized_at/);
  assert.match(sql, /cycle_key/);
  assert.match(sql, /v_recovery boolean/);
  assert.match(sql, /then 'recover'/);
  assert.match(sql, /in \(\s*'PENDING', 'PROCESSING', 'AUTHORISED', 'COMPLETED'\s*\)/);
  assert.match(sql, /finalize_revolut_checkout_order/);
  assert.match(sql, /if v_order\.finalized_at is not null then return 'already_finalized'/);
  assert.match(sql, /set status = 'finalized', lease_token = null, lease_expires_at = null/);
  assert.doesNotMatch(sql, /set finalized_at\s*=\s*coalesce[\s\S]{0,300}state\s+in/i);
});

test('checkout API reuses orders, recovers ambiguous creates, and confirms only current intent', () => {
  const source = read('supabase/functions/norva-revolut/index.ts');
  assert.match(source, /claim_revolut_checkout_intent/);
  assert.match(source, /findOrderByExtRef/);
  assert.match(source, /merchant_order_ext_ref: merchantExtRef/);
  assert.match(source, /action === "reuse"/);
  assert.match(source, /intent\.action === "recover"[\s\S]*findOrderByExtRef\(expectedOrder\)/);
  assert.match(source, /metadata:[\s\S]*intent_key: intentKey[\s\S]*intent_generation/);
  assert.match(source, /cloud_revolut_checkout_intents[\s\S]*\.eq\("status", "ready"\)/);
  assert.doesNotMatch(source, /\.order\("created_at"[^\n]+\.limit\(1\).*maybeSingle\(\)/);
});

test('recovery accepts only the exact external reference and immutable owner metadata', () => {
  const source = read('supabase/functions/norva-revolut/index.ts');
  const match = source.match(/function checkoutOrderMatches\([^)]*\): boolean \{([\s\S]*?)\n\}/);
  assert.ok(match, 'checkoutOrderMatches must remain extractable');
  const body = match[1].replace(/\s+as JsonRecord/g, '');
  const matches = new Function('order', 'expected', body);
  const expected = {
    extRef: 'checkout-abc', userId: 'user-a', intentKey: 'intent-a',
    kind: 'trial_setup', plan: 'plus', period: 'monthly', amountCents: 899,
  };
  const valid = {
    merchant_order_ext_ref: 'checkout-abc',
    metadata: { user_id: 'user-a', intent_key: 'intent-a', kind: 'trial_setup', plan: 'plus', period: 'monthly', amount_cents: 899 },
  };
  assert.equal(matches(valid, expected), true);
  assert.equal(matches({ ...valid, merchant_order_ext_ref: 'checkout-other' }, expected), false);
  assert.equal(matches({ ...valid, metadata: { ...valid.metadata, user_id: 'user-b' } }, expected), false);
  const finder = source.slice(source.indexOf('async function findOrderByExtRef'), source.indexOf('// The widget token'));
  assert.match(finder, /list\.find\(\(o\) => String\(o\.merchant_order_ext_ref/);
  assert.doesNotMatch(finder, /list\[0\]/);
});

test('checkout and confirm reject cross-rail mutations and schedule plan changes', () => {
  const source = read('supabase/functions/norva-revolut/index.ts');
  assert.match(source, /\.select\("status,provider,/);
  assert.match(source, /billing_rail_mismatch/);
  assert.match(source, /pending_plan = plan/);
  assert.match(source, /pending_effective_at = planEffectiveAt/);
  assert.match(source, /curStatus === "trialing"[\s\S]*cur\?\.trial_ends_at \?\? cur\?\.current_period_end/);
  assert.match(source, /foreignRailBlocked = Boolean\(cur && curProvider && curProvider !== "revolut" && !curTerminal\)/);
  assert.match(source, /status: "plan_change_scheduled"/);
  assert.match(source, /finalize_revolut_checkout_order/);
  const scheduled = source.slice(source.indexOf('if (kind === "plan_change")'), source.indexOf('// ── /profile'));
  assert.doesNotMatch(scheduled, /patch\.plan_code\s*=/);
});

test('webhook retries provider read failures and marks events only after mandatory writes', () => {
  const source = read('supabase/functions/norva-revolut-webhook/index.ts');
  const fetchOrder = source.slice(source.indexOf('async function fetchOrder'), source.indexOf('async function cancelValidationHold'));
  assert.match(fetchOrder, /throw new Error\(`provider order unavailable:/);
  assert.doesNotMatch(fetchOrder, /return \{\}/);
  assert.match(source, /remoteCheckoutSuccess = \["AUTHORISED", "COMPLETED"\]\.includes\(remoteState\)/);
  assert.match(source, /checkout order metadata does not match immutable journal/);
  assert.match(source, /journal\?\.finalized_at[\s\S]*duplicate_finalization/);
  assert.match(source, /journal\?\.expired_at \|\| journal\?\.superseded_at/);
  assert.match(source, /checkoutSuccess \|\| checkoutKind \? null : projectionPatch/);
  const finalMarker = source.lastIndexOf('await recordProcessedEvent');
  const journalFinalization = source.indexOf('order finalization journal failed');
  const planCommit = source.indexOf('effectiveAt = await commitOrderPlan');
  assert.ok(finalMarker > journalFinalization && finalMarker > planCommit);
  assert.match(source, /if \(error\) throw new Error\(`pending plan commit failed:/);
});

test('web checkout never displays success after all confirm attempts fail', () => {
  const html = read('public/checkout-revolut.html');
  const failedGuard = html.indexOf('if (!done)');
  const successView = html.indexOf("document.getElementById('checkout-view').style.display = 'none'");
  assert.ok(failedGuard > 0 && successView > failedGuard);
  assert.match(html, /sessionStorage\.setItem\('norva-revolut-current-order'/);
  assert.match(html, /already_authorized/);
});

test('hosted checkout restores server kind, uses truthful profile copy, and never reports a purchase before capture', () => {
  const html = read('public/checkout-revolut.html');
  assert.match(html, /plan_change_scheduled/);
  assert.match(html, /applyKindCopy\(r\.kind\)/);
  assert.match(html, /Up to 2 profiles/);
  assert.match(html, /Up to 5 profiles/);
  assert.doesNotMatch(html, /simultaneous streams/i);
  assert.doesNotMatch(html, /NorvaMarketing\.track\('purchase'/);
  assert.match(html, /Your current plan stays unchanged until renewal/);
});

test('browser confirmation cannot apply an expired or superseded checkout', () => {
  const source = read('supabase/functions/norva-revolut/index.ts');
  const confirm = source.slice(source.indexOf('type CheckoutJournal'), source.indexOf('// ── /profile'));
  assert.match(confirm, /finalized_at,expired_at,superseded_at/);
  assert.match(confirm, /if \(journal\.expired_at \|\| journal\.superseded_at\)/);
  assert.ok(confirm.indexOf('if (journal.expired_at || journal.superseded_at)') < confirm.indexOf('const fetched = await revolut'));
});
