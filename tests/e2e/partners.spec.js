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
      dashboard: [],
      rotateLink: [],
      share: [],
      navigation: [],
    };

    const accountFor = (current) => {
      if (current === 'discovery') {
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
      return {
        version: '2026-07-29',
        correlationId: `e2e-bootstrap-${current}`,
        data: {
          schema_version: 1,
          flags: {
            partners_enabled: true,
            partners_invite_only: false,
            partners_shadow_mode: true,
            partners_payouts_live: false,
            partners_tv_relay_enabled: false,
          },
          visibility: {
            visible: true,
            reason: current === 'discovery' ? 'available' : 'existing_account',
          },
          eligibility: { eligible: true, reason: 'eligible' },
          program: {
            version_key: 'p0-2026-07',
            commission_rate_bps: 2000,
            attribution_window_days: 30,
            maturation_days: 45,
            payout_thresholds: { USD: 1000, EUR: 1000 },
            effective_from: '2026-07-29T00:00:00Z',
            effective_until: null,
          },
          policy: {
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
          allowlist: { required: false, included: true },
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
        async apply(input) {
          window.__partnerCalls.apply.push({ ...input });
          window.__partnerState = 'pending';
          return {
            version: '2026-07-29',
            correlationId: 'e2e-application',
            data: {
              schema_version: 1,
              action: 'application_submitted',
              replayed: false,
              account: accountFor('pending'),
              next_action: 'start_verification',
            },
          };
        },
        async acceptTerms(input) {
          window.__partnerCalls.acceptTerms.push({ ...input });
          return {
            version: '2026-07-29',
            correlationId: 'e2e-terms',
            data: {
              schema_version: 1,
              action: 'terms_accepted',
              replayed: false,
              account: accountFor('pending'),
              next_action: 'await_verification',
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

test('individual application stays gated by explicit confirmations and ends pending KYC', async ({
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
    name: /partner profile is being checked/i,
  })).toBeVisible();
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
