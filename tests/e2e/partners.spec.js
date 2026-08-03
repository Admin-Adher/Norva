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
      activationReconcile: [],
      apply: [],
      acceptTerms: [],
      startKyc: [],
      dashboard: [],
      payoutProfile: [],
      fiscalProfile: [],
      submitFiscalProfile: [],
      payoutOnboarding: [],
      requestPayoutOnboarding: [],
      rotateLink: [],
      accessRequest: [],
      share: [],
      navigation: [],
    };
    window.__fiscalState = 'missing';
    window.__fiscalLegacyUnattested = false;
    window.__payoutOnboardingState = 'not_started';
    window.__payoutOnboardingReconfigurationRequired = false;
    window.__payoutOnboardingReasonCode = null;

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
        activation: {
          async reconcile(input = {}) {
            const current = window.__partnerState;
            window.__partnerCalls.activationReconcile.push({
              hasSignal: Boolean(input.signal),
              state: current,
            });
            const account = accountFor(current);
            const nextAction = current === 'applied'
              ? 'accept_terms'
              : (current === 'pending' ? 'await_verification' : 'start_verification');
            return {
              version: '2026-07-29',
              correlationId: `e2e-activation-reconcile-${current}`,
              data: {
                schema_version: 1,
                action: 'activation_reconciled',
                changed: false,
                account: {
                  exists: true,
                  status: account.status,
                  verification_status: account.verification_status,
                  contract_status: account.contract_status,
                  link_status: account.link_status,
                },
                next_action: nextAction,
              },
            };
          },
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
        async fiscalProfile(input = {}) {
          window.__partnerCalls.fiscalProfile.push({ hasSignal: Boolean(input.signal) });
          const exists = window.__fiscalState !== 'missing';
          return {
            version: '2026-07-29',
            correlationId: 'e2e-fiscal-profile',
            data: {
              schema_version: 1,
              action: 'fiscal_profile_loaded',
              fiscal_profile: {
                exists,
                status: window.__fiscalState,
                country_code: exists ? 'FR' : null,
                declaration_version: exists && !window.__fiscalLegacyUnattested
                  ? 'partners-tax-self-certification-v1' : null,
                submitted_at: exists && !window.__fiscalLegacyUnattested
                  ? '2026-08-02T12:00:00Z' : null,
                reviewed_at: window.__fiscalState === 'verified'
                  || window.__fiscalLegacyUnattested
                  ? '2026-08-02T12:30:00Z' : null,
              },
            },
          };
        },
        async submitFiscalProfile(input) {
          window.__partnerCalls.submitFiscalProfile.push({ ...input });
          window.__fiscalState = 'pending';
          window.__fiscalLegacyUnattested = false;
          return {
            version: '2026-07-29',
            correlationId: 'e2e-fiscal-profile-submit',
            data: {
              schema_version: 1,
              action: 'fiscal_profile_submitted',
              replayed: false,
              fiscal_profile: {
                exists: true,
                status: 'pending',
                country_code: 'FR',
                declaration_version: 'partners-tax-self-certification-v1',
                submitted_at: '2026-08-02T12:00:00Z',
                reviewed_at: null,
              },
            },
          };
        },
        async payoutOnboarding(input = {}) {
          window.__partnerCalls.payoutOnboarding.push({ hasSignal: Boolean(input.signal) });
          const exists = window.__payoutOnboardingState !== 'not_started';
          return {
            version: '2026-07-29',
            correlationId: 'e2e-payout-onboarding',
            data: {
              schema_version: 1,
              action: 'payout_onboarding_loaded',
              payout_onboarding: {
                exists,
                status: window.__payoutOnboardingState,
                currency: exists ? 'USD' : null,
                execution_adapter: 'revolut_manual',
                reconfiguration_required: window.__payoutOnboardingReconfigurationRequired,
                requested_at: exists ? '2026-08-02T12:35:00Z' : null,
                updated_at: exists ? '2026-08-02T12:35:00Z' : null,
                reason_code: window.__payoutOnboardingReasonCode,
              },
              allowed_currencies: ['EUR', 'USD'],
            },
          };
        },
        async requestPayoutOnboarding(input) {
          window.__partnerCalls.requestPayoutOnboarding.push({ ...input });
          window.__payoutOnboardingState = 'pending';
          window.__payoutOnboardingReconfigurationRequired = false;
          window.__payoutOnboardingReasonCode = null;
          return {
            version: '2026-07-29',
            correlationId: 'e2e-payout-onboarding-request',
            data: {
              schema_version: 1,
              action: 'payout_onboarding_requested',
              replayed: false,
              payout_onboarding: {
                exists: true,
                status: 'pending',
                currency: input.currency,
                execution_adapter: 'revolut_manual',
                reconfiguration_required: false,
                requested_at: '2026-08-02T12:35:00Z',
                updated_at: '2026-08-02T12:35:00Z',
                reason_code: null,
              },
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

test('share fallback copies the complete disclosure through the browser selection path', async ({
  page,
}) => {
  await mountPartners(page, 'active');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    window.__partnerFallbackCopy = null;
    document.addEventListener('copy', () => {
      const source = document.activeElement;
      window.__partnerFallbackCopy = {
        text: source instanceof HTMLTextAreaElement
          ? source.value.slice(source.selectionStart, source.selectionEnd)
          : null,
        ariaHidden: source?.getAttribute?.('aria-hidden') || null,
        readOnly: source instanceof HTMLTextAreaElement ? source.readOnly : false,
        tabIndex: source?.tabIndex ?? null,
      };
    }, { capture: true, once: true });
  });

  const share = page.locator('[data-partners-share]');
  await share.focus();
  await share.click();

  const url = `https://norva.tv/r/${'A'.repeat(32)}`;
  const expected = [
    'Discover Norva — one media ecosystem across Web, Android and TV.',
    '',
    'Partner link · I may receive 20% of eligible Norva payments excluding tax. Earnings are not guaranteed. Norva is a media player; no content or TV subscription is included.',
    url,
  ].join('\n');
  await expect(page.locator('[data-partners-action-status]')).toContainText(
    'link and required disclosure were copied',
  );
  expect(await page.evaluate(() => window.__partnerFallbackCopy)).toEqual({
    text: expected,
    ariaHidden: 'true',
    readOnly: true,
    tabIndex: -1,
  });
  await expect(page.locator('textarea[aria-hidden="true"]')).toHaveCount(0);
  await expect(share).toBeFocused();
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

test('manual payout setup keeps tax and destination steps private, gated and independently retryable', async ({
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
  await expect(page.locator('.partners-shell')).toHaveAttribute('inert', '');
  await expect(page.locator('[data-partners-payout-close]').first()).toBeFocused();

  const fiscalStep = dialog.locator('[data-partners-fiscal-step]');
  await expect(fiscalStep.getByRole('heading', { name: 'Confirm your tax residence' }))
    .toBeVisible();
  await expect(fiscalStep).toContainText('France · FR');
  await expect(fiscalStep.locator('input[type="text"], textarea')).toHaveCount(0);
  const fiscalSubmit = fiscalStep.getByRole('button', { name: 'Submit self-certification' });
  await expect(fiscalSubmit).toBeDisabled();
  await fiscalStep.locator('[data-partners-fiscal-confirm]').check();
  await expect(fiscalSubmit).toBeEnabled();
  await fiscalSubmit.click();
  await expect(fiscalStep).toContainText('Finance review pending');
  await expect(dialog.locator('[data-partners-onboarding-step]')).toContainText(
    'Waiting for tax-residence review',
  );
  const fiscalCalls = await page.evaluate(() => window.__partnerCalls.submitFiscalProfile);
  expect(fiscalCalls).toHaveLength(1);
  expect(fiscalCalls[0]).toMatchObject({
    countryCode: 'FR',
    declarationAccepted: true,
    declarationVersion: 'partners-tax-self-certification-v1',
  });
  expect(fiscalCalls[0].idempotencyKey).toMatch(/^norva\.fiscal-profile\./);
  expect(JSON.stringify(fiscalCalls[0])).not.toMatch(/taxId|document|upload/i);

  // Replacing the submitted form can transiently leave focus on <body>. The
  // modal-level Escape handler must remain authoritative through that frame.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(payout).toBeFocused();
  await page.evaluate(() => { window.__fiscalState = 'verified'; });
  await payout.click();
  const reopened = page.getByRole('dialog', { name: 'Payout readiness' });
  const onboardingStep = reopened.locator('[data-partners-onboarding-step]');
  await expect(onboardingStep.getByRole('heading', { name: 'Request payout configuration' }))
    .toBeVisible();
  await expect(onboardingStep.locator('input[type="text"], textarea')).toHaveCount(0);
  const onboardingSubmit = onboardingStep.getByRole('button', {
    name: 'Request secure configuration',
  });
  await expect(onboardingSubmit).toBeDisabled();
  await onboardingStep.locator('[data-partners-onboarding-currency]').selectOption('USD');
  await onboardingStep.locator('[data-partners-onboarding-consent]').check();
  await expect(onboardingSubmit).toBeEnabled();
  await onboardingSubmit.click();
  await expect(onboardingStep).toContainText('Waiting for Finance review');
  const onboardingCalls = await page.evaluate(
    () => window.__partnerCalls.requestPayoutOnboarding,
  );
  expect(onboardingCalls).toHaveLength(1);
  expect(onboardingCalls[0]).toMatchObject({ currency: 'USD', contactConsent: true });
  expect(onboardingCalls[0].idempotencyKey).toMatch(/^norva\.payout-onboarding\./);
  expect(JSON.stringify(onboardingCalls[0])).not.toMatch(
    /iban|bank|beneficiary|execution_adapter|tax/i,
  );

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
  await reopened.locator('[data-partners-payout-refresh]').click();
  await expect(reopened.locator('[data-partners-payout-dialog-status]')).toContainText(
    'still unavailable',
  );
  await expect(reopened).not.toContainText('provider timeout detail');

  // Android's native Back bridge invokes the overlay close contract directly.
  const androidBackHandled = await page.evaluate(() => (
    document.querySelector('[data-partners-payout-overlay]')?.__regionClose?.()
  ));
  expect(androidBackHandled).toBe(true);
  await expect(reopened).toBeHidden();
  await expect(payout).toBeFocused();
  await expect(page.locator('.partners-shell')).not.toHaveAttribute('inert', '');
});

test('a revoked completed destination exposes a safe reconfiguration path', async ({ page }) => {
  await mountPartners(page, 'active');
  await page.evaluate(() => {
    window.__fiscalState = 'verified';
    window.__payoutOnboardingState = 'completed';
    window.__payoutOnboardingReconfigurationRequired = true;
  });

  await page.locator('[data-partners-payout-button]').click();
  const dialog = page.getByRole('dialog', { name: 'Payout readiness' });
  const step = dialog.locator('[data-partners-onboarding-step]');
  await expect(step.getByRole('heading', { name: 'Reconfigure your payout destination' }))
    .toBeVisible();
  await expect(step).toContainText('Previous destination is no longer active');
  await expect(step).not.toContainText(/IBAN\s+[A-Z0-9]|beneficiaryTokenRef|ben_tok_/i);

  const submit = step.getByRole('button', { name: 'Request secure reconfiguration' });
  await expect(submit).toBeDisabled();
  await step.locator('[data-partners-onboarding-currency]').selectOption('USD');
  await step.locator('[data-partners-onboarding-consent]').check();
  await submit.click();
  await expect(step).toContainText('Waiting for Finance review');
  const calls = await page.evaluate(() => window.__partnerCalls.requestPayoutOnboarding);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ currency: 'USD', contactConsent: true });
});

test('a legacy expired fiscal row recovers through explicit self-attestation', async ({ page }) => {
  await mountPartners(page, 'active');
  await page.evaluate(() => {
    window.__fiscalState = 'expired';
    window.__fiscalLegacyUnattested = true;
  });

  await page.locator('[data-partners-payout-button]').click();
  const dialog = page.getByRole('dialog', { name: 'Payout readiness' });
  const fiscal = dialog.locator('[data-partners-fiscal-step]');
  await expect(fiscal.getByRole('heading', { name: 'Renew your tax residence attestation' }))
    .toBeVisible();
  await expect(fiscal.locator('input[type="text"], input[type="file"], textarea')).toHaveCount(0);
  await fiscal.locator('[data-partners-fiscal-confirm]').check();
  await fiscal.getByRole('button', { name: 'Submit a new attestation' }).click();
  await expect(fiscal).toContainText('Finance review pending');
  const state = await page.evaluate(() => ({
    fiscal: window.__fiscalState,
    legacy: window.__fiscalLegacyUnattested,
  }));
  expect(state).toEqual({ fiscal: 'pending', legacy: false });
});

test('idempotent mutation replays paint only their authoritative mutation state', async ({
  page,
}) => {
  await mountPartners(page, 'active');
  await page.evaluate(() => {
    window.NorvaCloud.partners.submitFiscalProfile = async (input) => {
      window.__partnerCalls.submitFiscalProfile.push({ ...input });
      window.__fiscalState = 'verified';
      return {
        version: '2026-07-29',
        correlationId: 'e2e-fiscal-stale-replay',
        data: {
          schema_version: 1,
          action: 'fiscal_profile_submitted',
          replayed: true,
          fiscal_profile: {
            exists: true,
            status: 'pending',
            country_code: 'FR',
            declaration_version: 'partners-tax-self-certification-v1',
            submitted_at: '2026-08-02T12:00:00Z',
            reviewed_at: null,
          },
        },
      };
    };
    window.NorvaCloud.partners.requestPayoutOnboarding = async (input) => {
      window.__partnerCalls.requestPayoutOnboarding.push({ ...input });
      window.__payoutOnboardingState = 'rejected';
      window.__payoutOnboardingReasonCode = 'compliance_review';
      return {
        version: '2026-07-29',
        correlationId: 'e2e-payout-stale-replay',
        data: {
          schema_version: 1,
          action: 'payout_onboarding_requested',
          replayed: true,
          payout_onboarding: {
            exists: true,
            status: 'pending',
            currency: input.currency,
            execution_adapter: 'revolut_manual',
            reconfiguration_required: false,
            requested_at: '2026-08-02T12:35:00Z',
            updated_at: '2026-08-02T12:35:00Z',
            reason_code: null,
          },
        },
      };
    };
  });

  await page.locator('[data-partners-payout-button]').click();
  const dialog = page.getByRole('dialog', { name: 'Payout readiness' });
  const fiscal = dialog.locator('[data-partners-fiscal-step]');
  await fiscal.locator('[data-partners-fiscal-confirm]').check();
  await fiscal.getByRole('button', { name: 'Submit self-certification' }).click();
  await expect(fiscal).toContainText('Finance review pending');
  await expect(dialog.locator('[data-partners-payout-dialog-status]')).toContainText(
    'submission confirmed by Norva',
  );
  expect(await page.evaluate(() => window.__partnerCalls.fiscalProfile.length)).toBe(1);

  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.evaluate(() => { window.__fiscalState = 'verified'; });
  await page.locator('[data-partners-payout-button]').click();
  const reopened = page.getByRole('dialog', { name: 'Payout readiness' });

  const payout = reopened.locator('[data-partners-onboarding-step]');
  await payout.locator('[data-partners-onboarding-currency]').selectOption('USD');
  await payout.locator('[data-partners-onboarding-consent]').check();
  await payout.getByRole('button', { name: 'Request secure configuration' }).click();
  await expect(payout.getByRole('heading', { name: 'Configuration request received' })).toBeVisible();
  await expect(reopened.locator('[data-partners-payout-dialog-status]')).toContainText(
    'request confirmed by Norva',
  );
  const calls = await page.evaluate(() => ({
    fiscalGets: window.__partnerCalls.fiscalProfile.length,
    payoutGets: window.__partnerCalls.payoutOnboarding.length,
  }));
  expect(calls.fiscalGets).toBe(2);
  expect(calls.payoutGets).toBe(2);
});

test('tax self-certification never falls back to the legacy payout-profile country', async ({
  page,
}) => {
  await mountPartners(page, 'active');
  await page.evaluate(() => {
    window.__partnersPage._dashboardPages = [{ account: { country_code: null } }];
    if (window.__partnersPage.bootstrapEnvelope?.envelope?.data) {
      window.__partnersPage.bootstrapEnvelope.envelope.data.policy = null;
    }
  });

  await page.locator('[data-partners-payout-button]').click();
  const dialog = page.getByRole('dialog', { name: 'Payout readiness' });
  await expect(dialog.locator('[data-partners-fiscal-step]')).toContainText(
    'Account country unavailable',
  );
  await expect(dialog.locator('[data-partners-fiscal-form]')).toHaveCount(0);
  await expect(dialog.locator('[data-partners-fiscal-step]')).not.toContainText(
    'Country on your Norva account',
  );
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
