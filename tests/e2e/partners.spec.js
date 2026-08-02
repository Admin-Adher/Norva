'use strict';

const path = require('node:path');
const { test, expect } = require('@playwright/test');

const root = path.join(__dirname, '..', '..');
const partnersPageScript = path.join(root, 'public', 'js', 'pages', 'PartnersPage.js');
const qrcodeScript = path.join(root, 'public', 'js', 'vendor', 'qrcode.js');
const mainStyles = path.join(root, 'public', 'css', 'main.css');

async function mountPartners(page, initialState) {
  await page.setContent(`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
      </head>
      <body>
        <button id="nav-account" type="button">Account</button>
        <div id="settings-partners-row" hidden aria-hidden="true"></div>
        <div id="account-sheet"><button data-act="partners" hidden aria-hidden="true">Partners</button></div>
        <div id="page-partners" class="page active"></div>
      </body>
    </html>`);
  await page.addStyleTag({ path: mainStyles });
  await page.addScriptTag({ path: qrcodeScript });
  await page.addScriptTag({ path: partnersPageScript });

  await page.evaluate(async (state) => {
    const shareUrl = `https://norva.tv/r/${'A'.repeat(32)}`;
    window.__partnerState = state;
    window.__partnerCalls = {
      bootstrap: [],
      apply: [],
      acceptTerms: [],
      startKyc: [],
      dashboard: [],
      payoutProfile: [],
      rotateLink: [],
      accessRequest: [],
      share: [],
      navigation: [],
    };

    const accountFor = (current) => {
      if (['discovery', 'early-access', 'early-requested', 'early-declined']
        .includes(current)) {
        return {
          exists: false,
          status: null,
          account_type: null,
          verification_status: null,
          contract_status: null,
          link_status: null,
        };
      }
      if (current === 'pending') {
        return {
          exists: true,
          status: 'pending_verification',
          account_type: 'individual',
          verification_status: 'pending',
          contract_status: 'accepted',
          link_status: 'none',
        };
      }
      if (current === 'applied') {
        return {
          exists: true,
          status: 'pending_verification',
          account_type: 'individual',
          verification_status: 'not_started',
          contract_status: 'not_accepted',
          link_status: 'none',
        };
      }
      if (current === 'kyc-ready') {
        return {
          exists: true,
          status: 'pending_verification',
          account_type: 'individual',
          verification_status: 'not_started',
          contract_status: 'accepted',
          link_status: 'none',
        };
      }
      return {
        exists: true,
        status: 'active',
        account_type: 'individual',
        verification_status: 'verified',
        contract_status: 'accepted',
        link_status: 'active',
      };
    };

    const bootstrapEnvelope = () => {
      const current = window.__partnerState;
      const earlyAccess = ['early-access', 'early-requested', 'early-declined']
        .includes(current);
      return {
        version: '2026-07-29',
        correlationId: `e2e-bootstrap-${current}`,
        data: {
          schema_version: 1,
          flags: {
            partners_enabled: !earlyAccess,
            partners_invite_only: false,
            partners_shadow_mode: true,
            partners_payouts_live: false,
            partners_tv_relay_enabled: false,
          },
          visibility: {
            visible: !earlyAccess,
            reason: earlyAccess
              ? 'disabled'
              : (current === 'discovery' ? 'available' : 'existing_account'),
          },
          eligibility: earlyAccess
            ? { eligible: false, reason: 'disabled' }
            : { eligible: true, reason: 'eligible' },
          program: earlyAccess ? null : {
            version_key: 'p0-2026-07',
            commission_rate_bps: 2000,
            attribution_window_days: 30,
            maturation_days: 45,
            payout_thresholds: { USD: 1000, EUR: 1000 },
            effective_from: '2026-07-29T00:00:00Z',
            effective_until: null,
          },
          policy: earlyAccess ? null : {
            country_code: 'FR',
            subdivision_code: 'FR-IDF',
            individual_available: true,
            minimum_age: 18,
            capacity_required: true,
            kyc_level: 'identity_age_country_capacity',
            payout_currencies: ['EUR'],
            terms_version: 'partners-fr-v1',
            disclosure_version: 'partners-fr-v1',
          },
          allowlist: { required: earlyAccess, included: !earlyAccess },
          account: accountFor(current),
        },
      };
    };

    const dashboardEnvelope = (status = 'all') => ({
      version: '2026-07-29',
      correlationId: `e2e-dashboard-${status}`,
      data: {
        schema_version: 1,
        account: {
          exists: true,
          status: 'active',
          verification_status: 'verified',
          contract_status: 'accepted',
          link_status: 'active',
          country_code: 'FR',
          subdivision_code: 'FR-IDF',
          created_at: '2026-07-29T10:00:00Z',
          updated_at: '2026-07-29T11:00:00Z',
        },
        link: {
          status: 'active',
          share_url: shareUrl,
          created_at: '2026-07-29T11:00:00Z',
        },
        reporting: {
          available: false,
          reason: 'no_financial_activity',
          currency: null,
          clicks: 0,
          referrals: 0,
          pending_minor: null,
          available_minor: null,
          paid_minor: null,
        },
        history: {
          status,
          items: status === 'all'
            ? [
              {
                type: 'application_submitted',
                occurred_at: '2026-07-29T10:00:00Z',
              },
              {
                type: 'account_activated',
                occurred_at: '2026-07-29T11:00:00Z',
              },
            ]
            : [],
          next_cursor: null,
        },
      },
    });

    window.NorvaCloud = {
      token: 'partners-e2e-user-token',
      partners: {
        async bootstrap(input = {}) {
          window.__partnerCalls.bootstrap.push({
            countryCode: input.countryCode || null,
            subdivisionCode: input.subdivisionCode || null,
          });
          return bootstrapEnvelope();
        },
        accessRequest: {
          async get() {
            const status = window.__partnerState === 'early-requested'
              ? 'requested'
              : (window.__partnerState === 'early-declined' ? 'declined' : null);
            return {
              version: '2026-07-29',
              correlationId: 'e2e-access-request-get',
              data: {
                schema_version: 1,
                program_preview: {
                  commission_rate_bps: 2000,
                  attribution_window_days: 30,
                  maturation_days: 45,
                  payout_thresholds: { USD: 1000 },
                },
                request: status ? {
                  exists: true,
                  status,
                  country_code: 'FR',
                  subdivision_code: 'FR-IDF',
                  requested_at: '2026-08-01T10:00:00Z',
                  reviewed_at: status === 'declined' ? '2026-08-02T10:00:00Z' : null,
                } : {
                  exists: false,
                  status: null,
                  country_code: null,
                  subdivision_code: null,
                  requested_at: null,
                  reviewed_at: null,
                },
              },
            };
          },
          async request(input) {
            window.__partnerCalls.accessRequest.push({ ...input });
            window.__partnerState = 'early-requested';
            return {
              version: '2026-07-29',
              correlationId: 'e2e-access-request-post',
              data: {
                schema_version: 1,
                action: 'access_requested',
                replayed: false,
                program_preview: {
                  commission_rate_bps: 2000,
                  attribution_window_days: 30,
                  maturation_days: 45,
                  payout_thresholds: { USD: 1000 },
                },
                request: {
                  exists: true,
                  status: 'requested',
                  country_code: input.countryCode,
                  subdivision_code: input.subdivisionCode || null,
                  requested_at: '2026-08-02T10:00:00Z',
                  reviewed_at: null,
                },
                next_action: 'await_review',
              },
            };
          },
        },
        async apply(input) {
          window.__partnerCalls.apply.push({ ...input });
          window.__partnerState = 'applied';
          return {
            version: '2026-07-29',
            correlationId: 'e2e-application',
            data: {
              schema_version: 1,
              action: 'application_submitted',
              replayed: false,
              account: accountFor('applied'),
              next_action: 'start_verification',
            },
          };
        },
        async acceptTerms(input) {
          window.__partnerCalls.acceptTerms.push({ ...input });
          window.__partnerState = 'kyc-ready';
          return {
            version: '2026-07-29',
            correlationId: 'e2e-terms',
            data: {
              schema_version: 1,
              action: 'terms_accepted',
              replayed: false,
              account: accountFor('kyc-ready'),
              next_action: 'start_verification',
            },
          };
        },
        async startKyc(input) {
          window.__partnerCalls.startKyc.push({ ...input });
          window.__partnerState = 'pending';
          return {
            version: '2026-07-29',
            correlationId: 'e2e-kyc-session',
            data: {
              schema_version: 1,
              action: 'kyc_session_created',
              replayed: false,
              verification: {
                provider: 'didit',
                status: 'pending',
                url: 'https://verify.didit.me/session/opaque-result',
                expires_at: null,
              },
            },
          };
        },
        async dashboard(input = {}) {
          window.__partnerCalls.dashboard.push({
            limit: input.limit,
            status: input.status,
            cursor: input.cursor || null,
          });
          return dashboardEnvelope(input.status || 'all');
        },
        async payoutProfile(input = {}) {
          window.__partnerCalls.payoutProfile.push({ hasSignal: Boolean(input.signal) });
          return {
            version: '2026-07-29',
            correlationId: 'e2e-payout-profile',
            data: {
              schema_version: 1,
              account: { id: `prt_${'a'.repeat(24)}`, status: 'active' },
              fiscal: { status: 'verified', country_code: 'FR' },
              profile: {
                provider: 'revolut',
                display_masked: 'Revolut ·•• 8421',
                currency: 'USD',
                status: 'active',
              },
              profiles: [{
                provider: 'revolut',
                display_masked: 'Revolut ·•• 8421',
                currency: 'USD',
                status: 'active',
              }],
              readiness: { ready: false, payouts_live: false, reason: 'payouts_not_live' },
            },
          };
        },
        async rotateLink(input) {
          window.__partnerCalls.rotateLink.push({ ...input });
          return {
            version: '2026-07-29',
            correlationId: 'e2e-link-rotation',
            data: {
              schema_version: 1,
              action: 'link_rotated',
              replayed: false,
              account: accountFor('active'),
              next_action: 'share_link',
              link: {
                status: 'active',
                share_url: shareUrl,
                rotated_at: '2026-07-29T12:00:00Z',
              },
            },
          };
        },
      },
    };

    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (payload) => {
        window.__partnerCalls.share.push({ ...payload });
      },
    });

    const app = {
      currentUser: { cloud: true, device: false },
      navigateTo(route, replace) {
        window.__partnerCalls.navigation.push({ route, replace: Boolean(replace) });
      },
    };
    window.__partnersPage = new window.PartnersPage(app);
    await window.__partnersPage.show();
  }, initialState);
}

test('every signed-in Cloud user can discover Partners and request reviewed early access', async ({
  page,
}) => {
  await mountPartners(page, 'early-access');

  await expect(page.locator('#settings-partners-row')).not.toHaveAttribute('hidden', '');
  await expect(page.locator('#account-sheet [data-act="partners"]')).not.toHaveAttribute('hidden', '');
  await expect(page.getByRole('heading', {
    name: 'Earn 20% on eligible referrals.',
  })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Join the supervised intake' })).toBeVisible();
  await expect(page.locator('[data-partners-join], [data-partners-start-kyc], [data-partners-share], [data-partners-payout-button]'))
    .toHaveCount(0);

  await page.locator('[data-partners-country-open]').click();
  await page.locator('[data-partners-country-manual-open]').click();
  await page.locator('[data-partners-country-manual-input]').fill('FR');
  await page.locator('[data-partners-access-submit]').click();

  await expect(page.getByRole('heading', { name: 'Request sent successfully' })).toBeVisible();
  await expect(page.getByText('Awaiting review')).toBeVisible();
  await expect(page.locator('[data-partners-access-request-form]')).toHaveCount(0);
  await expect(page.locator('[data-partners-join], [data-partners-start-kyc], [data-partners-share], [data-partners-payout-button]'))
    .toHaveCount(0);
  const calls = await page.evaluate(() => window.__partnerCalls.accessRequest);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ countryCode: 'FR' });
  expect(calls[0].idempotencyKey).toMatch(/^norva\.access-request\./);
});

test('a declined early-access request is terminal and offers support without resubmission', async ({
  page,
}) => {
  await mountPartners(page, 'early-declined');

  await expect(page.getByRole('heading', {
    name: 'This early-access request was not approved',
  })).toBeVisible();
  await expect(page.locator('[data-partners-access-request-form]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Contact support' }))
    .toHaveAttribute('href', '/support.html?returnTo=%2Fapp%23partners');
  await expect(page.locator('[data-partners-join], [data-partners-start-kyc], [data-partners-share], [data-partners-payout-button]'))
    .toHaveCount(0);
});

test('individual application stays gated and reaches the explicit hosted-KYC step', async ({
  page,
}) => {
  await mountPartners(page, 'discovery');

  await expect(page.getByRole('heading', {
    name: /Earn 20% while they stay subscribed/i,
  })).toBeVisible();
  await expect(page.getByRole('heading', {
    name: 'Payout thresholds before you accept',
  })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="partners-payout-thresholds-discovery"]'))
    .toContainText('USD reference');
  await expect(page.locator('dl[aria-label="Exact settlement payout thresholds for your policy"]'))
    .toContainText('EUR settlement');
  await expect(page.locator('dl[aria-label="Exact settlement payout thresholds for your policy"]'))
    .not.toContainText('USD settlement');
  expect(await page.locator('section[aria-labelledby="partners-payout-thresholds-discovery"]')
    .evaluate((element) => Boolean(
      element.compareDocumentPosition(
        document.querySelector('[data-partners-join-form]')
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ))).toBe(true);

  const join = page.locator('[data-partners-join]');
  await expect(join).toBeDisabled();
  await page.locator('[data-partners-individual-confirm]').check();
  await expect(join).toBeDisabled();
  await page.locator('[data-partners-terms-confirm]').check();
  await expect(join).toBeEnabled();

  if ((await page.viewportSize()).width <= 480) {
    expect(await join.evaluate((element) => element.getBoundingClientRect().height))
      .toBeGreaterThanOrEqual(44);
  }

  await join.click();
  await expect(page.getByRole('heading', {
    name: /Verify your identity to activate your partner link/i,
  })).toBeVisible();
  await expect(page.locator('[data-partners-start-kyc]')).toBeDisabled();
  await expect(page.locator('[data-partners-action-status]')).not.toContainText(
    /provider|token|uuid|sql/i,
  );

  const calls = await page.evaluate(() => window.__partnerCalls);
  expect(calls.apply).toHaveLength(1);
  expect(calls.apply[0]).toMatchObject({
    accountType: 'individual',
    countryCode: 'FR',
    subdivisionCode: 'FR-IDF',
  });
  expect(calls.apply[0].idempotencyKey).toMatch(/^norva\.application\./);
  expect(calls.acceptTerms).toHaveLength(1);
  expect(calls.acceptTerms[0]).toMatchObject({
    termsVersion: 'partners-fr-v1',
    disclosureVersion: 'partners-fr-v1',
  });
  expect(JSON.stringify(calls)).not.toMatch(/userId|user_id|verification_reference/i);
});

test('Didit hand-off requires fresh identity and capacity confirmations', async ({ page }) => {
  const startKycCalls = [];
  await page.exposeFunction('__captureStartKycCall', (input) => {
    startKycCalls.push(input);
  });
  await page.route('https://verify.didit.me/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Didit hosted verification</title><h1>Secure identity verification</h1>',
    });
  });
  await mountPartners(page, 'kyc-ready');
  await page.evaluate(() => {
    const startKyc = window.NorvaCloud.partners.startKyc;
    window.NorvaCloud.partners.startKyc = async (input) => {
      await window.__captureStartKycCall(input);
      return startKyc(input);
    };
  });

  const start = page.locator('[data-partners-start-kyc]');
  await expect(start).toBeDisabled();
  await page.locator('[data-partners-kyc-consent]').check();
  await expect(start).toBeDisabled();
  await page.locator('[data-partners-capacity-confirm]').check();
  await expect(start).toBeEnabled();

  await Promise.all([
    page.waitForURL('https://verify.didit.me/session/opaque-result'),
    start.click(),
  ]);
  await expect(page.getByRole('heading', { name: 'Secure identity verification' }))
    .toBeVisible();

  // The hosted hand-off replaces the Norva document, so capture the RPC input
  // through a Playwright binding that survives the cross-origin navigation.
  expect(startKycCalls).toHaveLength(1);
  expect(startKycCalls[0]).toMatchObject({
    language: 'en',
    consentVersion: 'partners-fr-v1',
    capacityConfirmed: true,
  });
  expect(startKycCalls[0].idempotencyKey).toMatch(/^norva\.kyc-session\./);
  expect(JSON.stringify(startKycCalls[0])).not.toMatch(/document|selfie|userId|user_id/i);
});

test('a partial application failure reloads authoritative state without posting the application twice', async ({
  page,
}) => {
  await mountPartners(page, 'discovery');
  await page.evaluate(() => {
    window.NorvaCloud.partners.acceptTerms = async (input) => {
      window.__partnerCalls.acceptTerms.push({ ...input });
      const error = new Error('private provider detail');
      error.code = 'provider_temporarily_unavailable';
      throw error;
    };
  });

  await page.locator('[data-partners-individual-confirm]').check();
  await page.locator('[data-partners-terms-confirm]').check();
  await page.locator('[data-partners-join]').click();

  await expect(page.getByRole('heading', {
    name: /Review the current programme terms to continue/i,
  })).toBeVisible();
  await expect(page.locator('[data-partners-action-status]')).toContainText(
    'identity provider is temporarily unavailable',
  );
  await expect(page.locator('[data-partners-action-status]')).not.toContainText(
    'private provider detail',
  );
  expect(await page.evaluate(() => window.__partnerCalls.apply.length)).toBe(1);
  expect(await page.evaluate(
    () => window.__partnersPage._actionKeys.has('application'),
  )).toBe(true);
});

test('active dashboard exposes the real link, disclosure, filters and accessible QR', async ({
  page,
}) => {
  await mountPartners(page, 'active');

  await expect(page.getByRole('heading', { name: 'Your partner dashboard' }))
    .toBeVisible();
  await expect(page.locator('[data-partners-link]')).toHaveValue(
    `https://norva.tv/r/${'A'.repeat(32)}`,
  );
  await expect(page.locator('.partners-dashboard-grid aside > .partners-program-facts')).toContainText(
    'Not live',
  );
  await expect(page.getByText('Application submitted')).toBeVisible();
  await expect(page.getByText('Partner account activated')).toBeVisible();

  const share = page.locator('[data-partners-share]');
  await share.click();
  await expect(page.locator('[data-partners-action-status]')).toContainText(
    'required disclosure',
  );
  const sharedPayload = await page.evaluate(() => window.__partnerCalls.share.at(-1));
  expect(sharedPayload.url).toBe(`https://norva.tv/r/${'A'.repeat(32)}`);
  expect(sharedPayload.text).toContain('I may receive 20%');
  expect(sharedPayload.text).toContain('Earnings are not guaranteed');

  const qr = page.locator('[data-partners-qr]');
  await qr.focus();
  await qr.click();
  const dialog = page.getByRole('dialog', { name: 'Scan to open Norva' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('.partners-shell')).toHaveAttribute('inert', '');
  await expect(page.locator('[data-partners-qr-code] svg')).toBeVisible();
  await expect(page.locator('[data-partners-qr-close]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(qr).toBeFocused();
  await expect(page.locator('.partners-shell')).not.toHaveAttribute('inert', '');

  await page.locator('[data-partners-history-filter="pending"]').click();
  await expect(page.getByText('No events in this view')).toBeVisible();
  await expect(page.locator('[data-partners-history-filter="pending"]'))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-partners-history-filter="pending"]')).toBeFocused();
  const lastDashboardCall = await page.evaluate(
    () => window.__partnerCalls.dashboard.at(-1),
  );
  expect(lastDashboardCall).toEqual({
    limit: 25,
    status: 'pending',
    cursor: null,
  });

  if ((await page.viewportSize()).width <= 480) {
    const actionHeights = await page.locator(
      '[data-partners-share], [data-partners-qr], [data-partners-rotate]',
    ).evaluateAll((elements) => elements.map(
      (element) => element.getBoundingClientRect().height,
    ));
    expect(actionHeights.every((height) => height >= 44)).toBe(true);
    const horizontalOverflow = await page.locator('#page-partners').evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(2);
  }
});

test('an active account can recover a missing or revoked referral link', async ({ page }) => {
  await mountPartners(page, 'active');
  await page.evaluate(async () => {
    const originalDashboard = window.NorvaCloud.partners.dashboard;
    window.NorvaCloud.partners.dashboard = async (input) => {
      const envelope = await originalDashboard(input);
      envelope.data.account.link_status = 'revoked';
      envelope.data.link = null;
      return envelope;
    };
    await window.__partnersPage.loadDashboard(
      window.__partnersPage.bootstrapEnvelope.envelope.data,
      { reset: true },
    );
  });

  const create = page.locator('[data-partners-create-link]');
  await expect(create).toBeVisible();
  await create.click();
  await expect(page.locator('[data-partners-action-status]')).toContainText(
    'Referral link created',
  );
  const calls = await page.evaluate(() => window.__partnerCalls.rotateLink);
  expect(calls).toHaveLength(1);
  expect(calls[0].idempotencyKey).toMatch(/^norva\.link-rotation\./);
});

test('cancelling the platform share sheet is reported without implying success', async ({ page }) => {
  await mountPartners(page, 'active');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async () => {
        const error = new Error('user cancelled');
        error.name = 'AbortError';
        throw error;
      },
    });
  });

  await page.locator('[data-partners-share]').click();
  await expect(page.locator('[data-partners-action-status]')).toContainText(
    'Sharing cancelled',
  );
  await expect(page.locator('[data-partners-action-status]')).not.toContainText(
    'Share sheet opened',
  );
});

test('masked manual payout status is independently retryable in an accessible mobile-safe sheet', async ({
  page,
}) => {
  await mountPartners(page, 'active');

  const payout = page.locator('[data-partners-payout-button]');
  await expect(payout).toBeEnabled();
  await expect(payout).toContainText('Revolut');
  await payout.focus();
  await payout.click();

  const dialog = page.getByRole('dialog', { name: 'Payout readiness' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Revolut ·•• 8421');
  await expect(dialog).toContainText('Manual Revolut destinations are provisioned by Norva Finance');
  await expect(dialog).not.toContainText(/IBAN\s+[A-Z0-9]|beneficiaryTokenRef|ben_tok_/i);
  await expect(dialog.locator('input, select, textarea')).toHaveCount(0);
  await expect(page.locator('.partners-shell')).toHaveAttribute('inert', '');
  await expect(page.locator('[data-partners-payout-close]').first()).toBeFocused();

  await page.evaluate(() => {
    window.__partnersPage._payoutTimeoutMs = 20;
    window.NorvaCloud.partners.payoutProfile = ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('provider timeout detail');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  });
  await dialog.locator('[data-partners-payout-refresh]').click();
  await expect(dialog.locator('[data-partners-payout-dialog-status]')).toContainText(
    'still unavailable',
  );
  await expect(dialog).not.toContainText('provider timeout detail');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(payout).toBeFocused();
  await expect(page.locator('.partners-shell')).not.toHaveAttribute('inert', '');
});

test('dashboard timeout fails closed and exposes a local retry without blocking payout status', async ({
  page,
}) => {
  await mountPartners(page, 'active');
  await page.evaluate(() => {
    window.__partnersPage._dashboardTimeoutMs = 20;
    window.NorvaCloud.partners.dashboard = ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('raw dashboard timeout');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  });

  await page.locator('[data-partners-dashboard-retry]').click();
  await expect(page.getByText('Dashboard temporarily unavailable')).toBeVisible();
  await expect(page.getByText(/secure request took too long/i)).toBeVisible();
  await expect(page.locator('[data-partners-dashboard-metrics]')).toContainText(
    'Unavailable',
  );
  await expect(page.locator('[data-partners-dashboard-metrics]')).not.toContainText(
    'Loading',
  );
  await expect(page.locator('[data-partners-dashboard-inline-retry]')).toBeVisible();
  await expect(page.locator('[data-partners-payout-button]')).toBeEnabled();
  await expect(page.locator('[data-partners-action-status]')).not.toContainText(
    'raw dashboard timeout',
  );
});
