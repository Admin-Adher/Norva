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
    window.NorvaRegions = {
      COUNTRIES: [
        { kind: 'country', code: 'FR', name: 'France', flag: '🇫🇷' },
        { kind: 'country', code: 'US', name: 'United States', flag: '🇺🇸' },
      ],
    };
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
      join: [],
      creditQuote: [],
      creditRedeem: [],
      bindPayoutCountry: [],
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
      if (['member-discovery', 'member-active', 'member-cash-locked'].includes(current)) {
        const active = current !== 'member-discovery';
        const cashPilotAllowed = current !== 'member-cash-locked';
        return {
          version: '2026-07-29',
          correlationId: `e2e-bootstrap-${current}`,
          data: {
            schema_version: 2,
            flags: {
              partners_enabled: true,
              partners_invite_only: false,
              partners_cash_pilot_allowlist_only: true,
              partners_earnings_enabled: true,
              partners_credit_redemptions_enabled: true,
              partners_payouts_live: false,
            },
            eligibility: {
              visible: true,
              eligible: true,
              reason: 'available',
            },
            membership: {
              exists: active,
              status: active ? 'active' : 'not_joined',
              joined_at: active ? '2026-08-04T12:00:00Z' : null,
              verification_status: active ? 'not_started' : null,
            },
            program: {
              commission_rate_bps: 2000,
              attribution_window_days: 30,
              maturation_days: 45,
              terms_version: 'partners-global-v1',
              disclosure_version: 'partners-global-v1',
            },
            link: active ? {
              status: 'active',
              share_url: shareUrl,
              created_at: '2026-08-04T12:00:00Z',
            } : null,
            credit_readiness: {
              ready: active,
              reason: active ? null : 'membership_required',
            },
            cash_readiness: {
              ready: false,
              reason: active
                ? (cashPilotAllowed ? 'payout_country_required' : 'cash_pilot_not_allowed')
                : 'membership_required',
            },
          },
        };
      }
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

    const membershipDashboardEnvelope = (
      status = 'all',
      cashReason = 'payout_country_required',
    ) => ({
      version: '2026-07-29',
      correlationId: `e2e-membership-dashboard-${status}`,
      data: {
        schema_version: 2,
        flags: {
          partners_enabled: true,
          partners_invite_only: false,
          partners_cash_pilot_allowlist_only: true,
          partners_earnings_enabled: true,
          partners_credit_redemptions_enabled: true,
          partners_payouts_live: false,
        },
        membership: {
          exists: true,
          status: 'active',
          joined_at: '2026-08-04T12:00:00Z',
          verification_status: 'not_started',
        },
        program: {
          commission_rate_bps: 2000,
          attribution_window_days: 30,
          maturation_days: 45,
          terms_version: 'partners-global-v1',
          disclosure_version: 'partners-global-v1',
        },
        link: {
          status: 'active',
          share_url: shareUrl,
          created_at: '2026-08-04T12:00:00Z',
        },
        balances: [{
          currency: 'USD',
          currency_exponent: 2,
          pending_minor: 1200,
          available_minor: 1497,
          recovery_due_minor: 0,
          redeemed_minor: 0,
        }],
        next_maturation_at: '2026-09-18T12:00:00Z',
        credit_readiness: {
          ready: true,
          reason: null,
          catalog: {
            catalog_key: 'acc_p0_usd_plus_month_v1',
            plan_code: 'plus',
            currency: 'USD',
            currency_exponent: 2,
            unit_amount_minor: 499,
            unit_duration_days: 30,
            minimum_months: 1,
            maximum_months: 12,
            reference_currency: 'USD',
            reference_currency_exponent: 2,
            reference_unit_amount_minor: 499,
            fx_rate_snapshot_key: null,
            fx_rate_source: null,
            fx_observed_at: null,
            fx_valid_until: null,
          },
        },
        cash_readiness: { ready: false, reason: cashReason },
        provider: {
          provider: null,
          status: null,
          active: false,
          hard_block: false,
          reason: 'subscription_required',
          fail_open: false,
          current_period_end: null,
          trial_ends_at: null,
          fail_open_until: null,
          last_verified_at: null,
        },
        overlay: {
          status: 'none',
          active_grant: null,
          queued_grants: 0,
          remaining_seconds: 0,
        },
        history: { status, items: [], next_cursor: null },
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
        async join(input) {
          window.__partnerCalls.join.push({ ...input });
          window.__partnerState = 'member-active';
          return {
            version: '2026-07-29',
            correlationId: 'e2e-membership-join',
            data: {
              schema_version: 2,
              action: 'membership_joined',
              replayed: false,
              membership: {
                status: 'active',
                joined_at: '2026-08-04T12:00:00Z',
                verification_status: 'not_started',
              },
              program: {
                commission_rate_bps: 2000,
                attribution_window_days: 30,
                maturation_days: 45,
                terms_version: 'partners-global-v1',
                disclosure_version: 'partners-global-v1',
              },
              link: {
                status: 'active',
                share_url: shareUrl,
                created_at: '2026-08-04T12:00:00Z',
              },
              cash_readiness: {
                ready: false,
                reason: 'payout_country_required',
              },
              next_action: 'share_link',
            },
          };
        },
        credit: {
          async quote(input) {
            window.__partnerCalls.creditQuote.push({ ...input });
            return {
              version: '2026-07-29',
              correlationId: 'e2e-credit-quote',
              data: {
                schema_version: 2,
                action: 'access_credit_quoted',
                replayed: false,
                quote: {
                  key: `crq_${'a'.repeat(24)}`,
                  status: 'open',
                  currency: 'USD',
                  currency_exponent: 2,
                  plan_code: 'plus',
                  months: input.months,
                  unit_amount_minor: 499,
                  total_amount_minor: 499 * input.months,
                  reference_currency: 'USD',
                  reference_currency_exponent: 2,
                  reference_unit_amount_minor: 499,
                  reference_total_amount_minor: 499 * input.months,
                  fx_rate_snapshot_key: null,
                  fx_rate_source: null,
                  fx_observed_at: null,
                  fx_valid_until: null,
                  duration_days: 30 * input.months,
                  expires_at: '2026-08-04T12:10:00Z',
                },
                balance: {
                  currency: 'USD',
                  currency_exponent: 2,
                  available_minor: 1497,
                },
              },
            };
          },
          async redeem(input) {
            window.__partnerCalls.creditRedeem.push({ ...input });
            return {
              version: '2026-07-29',
              correlationId: 'e2e-credit-redeem',
              data: {
                schema_version: 2,
                action: 'access_credit_redeemed',
                replayed: false,
                redemption: {
                  key: `crd_${'b'.repeat(24)}`,
                  status: 'granted',
                  currency: 'USD',
                  currency_exponent: 2,
                  amount_minor: 499,
                  reference_currency: 'USD',
                  reference_currency_exponent: 2,
                  reference_amount_minor: 499,
                  fx_rate_snapshot_key: null,
                  fx_rate_source: null,
                  fx_observed_at: null,
                  months: 1,
                },
                grant: {
                  key: `cag_${'c'.repeat(24)}`,
                  status: 'queued',
                  plan_code: 'plus',
                  duration_days: 30,
                  remaining_seconds: 2592000,
                  active_from: null,
                  active_until: null,
                },
                balance: {
                  currency: 'USD',
                  currency_exponent: 2,
                  available_minor: 998,
                },
                overlay: {
                  status: 'queued',
                  active_grant: null,
                  queued_grants: 1,
                  remaining_seconds: 0,
                },
              },
            };
          },
        },
        async bindPayoutCountry(input) {
          window.__partnerCalls.bindPayoutCountry.push({ ...input });
          return {
            version: '2026-07-29',
            correlationId: 'e2e-payout-country',
            data: {
              schema_version: 1,
              action: 'payout_country_bound',
              replayed: false,
              account: {
                id: `prt_${'d'.repeat(24)}`,
                status: 'pending_verification',
                country_code: input.countryCode,
              },
              cash_readiness: { ready: false, reason: 'kyc_required' },
            },
          };
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
          return ['member-active', 'member-cash-locked'].includes(window.__partnerState)
            ? membershipDashboardEnvelope(
              input.status || 'all',
              window.__partnerState === 'member-cash-locked'
                ? 'cash_pilot_not_allowed'
                : 'payout_country_required',
            )
            : dashboardEnvelope(input.status || 'all');
        },
        async payoutProfile(input = {}) {
          window.__partnerCalls.payoutProfile.push({ hasSignal: Boolean(input.signal) });
          return {
            version: '2026-07-29',
            correlationId: 'e2e-payout-profile',
            data: {
              schema_version: 1,
              account: {
                id: `prt_${'a'.repeat(24)}`,
                status: 'active',
                country_code: ['member-active', 'member-cash-locked']
                  .includes(window.__partnerState) ? null : 'FR',
              },
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

test('public membership stays fully usable when the supervised cash pilot is unavailable', async ({
  page,
}) => {
  await mountPartners(page, 'member-cash-locked');

  await expect(page.getByRole('heading', { name: 'Your Partners balance' }))
    .toBeVisible();
  await expect(page.locator('[data-partners-link]')).toHaveValue(
    `https://norva.tv/r/${'A'.repeat(32)}`,
  );
  await expect(page.getByRole('heading', { name: 'Convert to Norva Plus' }))
    .toBeVisible();

  const cash = page.locator('[data-partners-cash-button]');
  await expect(cash).toHaveText('Cash transfer pilot');
  await cash.click();

  const dialog = page.getByRole('dialog', {
    name: 'Cash transfers are in a supervised pilot',
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    'membership, referral link, earnings and Norva-access conversions remain fully available',
  );
  await expect(dialog).toContainText(
    'No payout country, identity check, tax profile or banking detail is requested.',
  );

  const calls = await page.evaluate(() => window.__partnerCalls);
  expect(calls.join).toHaveLength(0);
  expect(calls.startKyc).toHaveLength(0);
  expect(calls.bindPayoutCountry).toHaveLength(0);
  expect(calls.payoutProfile).toHaveLength(0);
});

test('confirmed user joins and receives a referral link without KYC or country inference', async ({
  page,
}) => {
  await mountPartners(page, 'member-discovery');

  await expect(page.getByRole('heading', {
    name: /Share Norva\. Earn 20% on eligible renewals/i,
  })).toBeVisible();
  await expect(page.getByText('No identity documents, tax details or payout destination are requested when you join.'))
    .toBeVisible();

  const join = page.locator('[data-partners-membership-join]');
  await expect(join).toBeDisabled();
  await page.locator('[data-partners-terms-confirm]').check();
  await expect(join).toBeDisabled();
  await page.locator('[data-partners-disclosure-confirm]').check();
  await expect(join).toBeEnabled();
  await join.click();

  await expect(page.getByRole('heading', { name: 'Your Partners balance' }))
    .toBeVisible();
  await expect(page.locator('[data-partners-link]')).toHaveValue(
    `https://norva.tv/r/${'A'.repeat(32)}`,
  );
  const calls = await page.evaluate(() => window.__partnerCalls);
  expect(calls.join).toHaveLength(1);
  expect(calls.join[0]).toMatchObject({
    termsAccepted: true,
    disclosureAccepted: true,
  });
  expect(calls.join[0].idempotencyKey).toMatch(/^norva\.membership-join\./);
  expect(Object.keys(calls.join[0]).sort()).toEqual([
    'disclosureAccepted',
    'idempotencyKey',
    'termsAccepted',
  ]);
  expect(calls.startKyc).toHaveLength(0);
  expect(calls.bindPayoutCountry).toHaveLength(0);
  expect(calls.bootstrap.every((call) => (
    call.countryCode === null && call.subdivisionCode === null
  ))).toBe(true);
});

test('available balance converts to Norva Plus without KYC', async ({ page }) => {
  await mountPartners(page, 'member-active');

  await expect(page.getByRole('heading', { name: 'Convert to Norva Plus' }))
    .toBeVisible();
  await expect(page.getByText(/references \$4\.99/))
    .toBeVisible();
  await page.locator('[data-partners-credit-quote]').click();

  const dialog = page.getByRole('dialog', {
    name: 'Convert to 1 month of Norva Plus?',
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('$4.99');
  await expect(dialog).toContainText('Identity verification');
  await expect(dialog).toContainText('Not required');
  await expect(page.locator('.partners-shell')).toHaveAttribute('inert', '');
  await page.locator('[data-partners-credit-confirm]').click();

  await expect(page.getByRole('heading', {
    name: '1 month of Norva Plus secured',
  })).toBeVisible();
  const calls = await page.evaluate(() => window.__partnerCalls);
  expect(calls.creditQuote).toHaveLength(1);
  expect(calls.creditQuote[0]).toMatchObject({ months: 1 });
  expect(calls.creditQuote[0].idempotencyKey).toMatch(/^norva\.credit-quote-1\./);
  expect(calls.creditRedeem).toHaveLength(1);
  expect(calls.creditRedeem[0].quoteKey).toMatch(/^crq_/);
  expect(calls.creditRedeem[0].idempotencyKey).toMatch(/^norva\.credit-redeem-crq_/);
  expect(calls.startKyc).toHaveLength(0);
});

test('cash journey asks for an explicit country before offering Didit KYC', async ({ page }) => {
  await mountPartners(page, 'member-active');

  const cash = page.locator('[data-partners-cash-button]');
  await expect(cash).toBeVisible();
  await cash.click();

  const countryDialog = page.getByRole('dialog', { name: 'Choose your payout country' });
  await expect(countryDialog).toBeVisible();
  await expect(countryDialog).toContainText(
    'Norva never infers this from your IP address, device or locale.',
  );
  await expect(page.locator('.partners-shell')).toHaveAttribute('inert', '');
  expect(await page.evaluate(() => window.__partnerCalls.startKyc.length)).toBe(0);

  await page.locator('[data-partners-cash-country]').selectOption('FR');
  await page.locator('[data-partners-cash-country-submit]').click();

  const kycDialog = page.getByRole('dialog', { name: 'Verify only when you want cash' });
  await expect(kycDialog).toBeVisible();
  await expect(kycDialog).toContainText('Secure verification with Didit');
  await expect(kycDialog).toContainText(
    'membership, referral link, earnings and Norva-access conversions already work without KYC',
  );
  const calls = await page.evaluate(() => window.__partnerCalls);
  expect(calls.bindPayoutCountry).toHaveLength(1);
  expect(calls.bindPayoutCountry[0]).toMatchObject({ countryCode: 'FR' });
  expect(calls.bindPayoutCountry[0].idempotencyKey)
    .toMatch(/^norva\.payout-country-FR\./);
  expect(Object.keys(calls.bindPayoutCountry[0]).sort()).toEqual([
    'countryCode',
    'idempotencyKey',
    'signal',
  ]);
  expect(calls.startKyc).toHaveLength(0);

  await kycDialog.evaluate((element) => element.dispatchEvent(new KeyboardEvent(
    'keydown',
    { key: 'BrowserBack', bubbles: true },
  )));
  await expect(kycDialog).toBeHidden();
  await expect(cash).toBeFocused();
  await expect(page.locator('.partners-shell')).not.toHaveAttribute('inert', '');
});

test('legacy v1 discovery fails closed and cannot create membership or start KYC', async ({
  page,
}) => {
  await mountPartners(page, 'discovery');

  await expect(page.getByRole('heading', {
    name: /Refresh to load the current Partners contract/i,
  })).toBeVisible();
  await expect(page.getByText(
    /will not start identity verification or create a membership from stale rules/i,
  )).toBeVisible();
  await expect(page.locator('[data-partners-retry]')).toBeVisible();
  await expect(page.locator(
    '[data-partners-join], [data-partners-membership-join], [data-partners-start-kyc]',
  )).toHaveCount(0);

  const calls = await page.evaluate(() => window.__partnerCalls);
  expect(calls.apply).toHaveLength(0);
  expect(calls.acceptTerms).toHaveLength(0);
  expect(calls.join).toHaveLength(0);
  expect(calls.startKyc).toHaveLength(0);
  expect(JSON.stringify(calls)).not.toMatch(
    /userId|user_id|verification_reference/i,
  );
});

test('legacy v1 Didit hand-off requires fresh identity and capacity confirmations', async ({ page }) => {
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

test('legacy v1 refresh upgrades to v2 membership without posting legacy writes', async ({
  page,
}) => {
  await mountPartners(page, 'discovery');
  await page.evaluate(() => {
    window.__partnerState = 'member-discovery';
  });

  await page.locator('[data-partners-retry]').click();

  await expect(page.getByRole('heading', {
    name: /Share Norva\. Earn 20% on eligible renewals/i,
  })).toBeVisible();
  await expect(page.locator('[data-partners-membership-join]')).toBeDisabled();
  const calls = await page.evaluate(() => window.__partnerCalls);
  expect(calls.bootstrap.length).toBeGreaterThanOrEqual(2);
  expect(calls.apply).toHaveLength(0);
  expect(calls.acceptTerms).toHaveLength(0);
  expect(calls.startKyc).toHaveLength(0);
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

  const copy = page.locator('[data-partners-copy]');
  await expect(copy).toHaveText('Copy share text');

  const qr = page.locator('[data-partners-qr]');
  await qr.focus();
  await qr.click();
  const dialog = page.getByRole('dialog', { name: 'Scan to open Norva' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute(
    'aria-describedby',
    'partners-qr-disclosure partners-qr-copy',
  );
  await expect(page.locator('[data-partners-qr-disclosure]')).toContainText(
    'I may receive 20%',
  );
  await expect(page.locator('[data-partners-qr-disclosure]')).toContainText(
    'Earnings are not guaranteed',
  );
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

test('Copy share text keeps the disclosure and URL in one canonical payload', async ({
  page,
}) => {
  await mountPartners(page, 'active');
  await page.evaluate(() => {
    window.__partnerClipboardCopy = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(value) { window.__partnerClipboardCopy = value; },
      },
    });
  });

  const copy = page.locator('[data-partners-copy]');
  await copy.focus();
  await copy.click();

  const url = `https://norva.tv/r/${'A'.repeat(32)}`;
  const expected = [
    'Discover Norva — one media ecosystem across Web, Android and TV.',
    '',
    'Advertising — Norva partner link · I may receive 20% of eligible Norva payments excluding tax. Earnings are not guaranteed. Norva is a media player; no content or TV subscription is included.',
    url,
  ].join('\n');
  expect(await page.evaluate(() => window.__partnerClipboardCopy)).toBe(expected);
  expect(await page.evaluate(() => window.__partnerClipboardCopy)).not.toBe(url);
  await expect(page.locator('[data-partners-action-status]')).toContainText(
    'Referral message and required disclosure copied',
  );
  await expect(copy).toBeEnabled();
  await expect(copy).toBeFocused();
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
      value: {
        async writeText() {
          window.__partnerClipboardAttempts += 1;
          const error = new Error('clipboard permission denied');
          error.name = 'NotAllowedError';
          throw error;
        },
      },
    });
    window.__partnerClipboardAttempts = 0;
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
    'Advertising — Norva partner link · I may receive 20% of eligible Norva payments excluding tax. Earnings are not guaranteed. Norva is a media player; no content or TV subscription is included.',
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
  expect(await page.evaluate(() => window.__partnerClipboardAttempts)).toBe(1);
  await expect(page.locator('textarea[aria-hidden="true"]')).toHaveCount(0);
  await expect(share).toBeFocused();
});

test('copy failure reports an alert and never implies that sharing succeeded', async ({ page }) => {
  await mountPartners(page, 'active');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText() { throw new Error('clipboard unavailable'); },
      },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => false,
    });
  });

  const share = page.locator('[data-partners-share]');
  await share.focus();
  await share.click();

  const status = page.locator('[data-partners-action-status]');
  await expect(status).toHaveAttribute('role', 'alert');
  await expect(status).toContainText(
    'Copying is unavailable in this browser. No referral message was copied.',
  );
  await expect(status).not.toContainText('required disclosure were copied');
  await expect(status).not.toContainText('Share sheet opened');
  await expect(page.locator('textarea[aria-hidden="true"]')).toHaveCount(0);
  await expect(share).toBeEnabled();
  await expect(share).not.toHaveAttribute('aria-busy', 'true');
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
