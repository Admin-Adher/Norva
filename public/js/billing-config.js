/**
 * Norva billing configuration (web / RevenueCat Web Billing).
 *
 * Fill these once the RevenueCat project exists — see docs/roadmap/billing-setup.md §8.
 * Until `webBillingEnabled` is true with a real public key, the web purchase
 * path stays inert (the paywall shows "billing not configured") and nothing
 * breaks. Native (Android) purchases use the Play Billing bridge instead and do
 * NOT read this file.
 */
window.NORVA_BILLING_CONFIG = {
  // RevenueCat Web Billing public key (starts with "rcb_").
  revenueCatWebPublicKey: '',
  // Flip to true once the key above is set and Stripe is connected in RevenueCat.
  webBillingEnabled: false,
  // RevenueCat offering to read packages from.
  offeringId: 'default',
  // Optional override for where the RevenueCat Web SDK is loaded from.
  purchasesJsUrl: 'https://esm.sh/@revenuecat/purchases-js@1',
  // Where web subscribers manage / cancel / update their card (a RevenueCat
  // customer-center or Stripe billing-portal link). Empty = no web "manage"
  // button until configured. Native uses the Google Play subscriptions page.
  webCustomerPortalUrl: '',

  // ── Revolut Merchant (new web rail — see docs/BILLING-REVOLUT-MIGRATION.md) ──
  // Inert until `enabled:true` AND the REVOLUT_SECRET_KEY edge secret is set. When
  // enabled, the web checkout routes to /checkout-revolut.html, which mounts the
  // RevolutCheckout card field (embedded, PCI-safe) and saves the card for
  // merchant-initiated renewals. Sandbox vs prod is decided by `mode` here AND the
  // edge key (sk_… on sandbox-merchant.revolut.com → sandbox); real cards only work
  // once the prod key + REVOLUT_API_BASE=https://merchant.revolut.com are set.
  revolut: {
    enabled: true,                                  // LIVE — web checkout routes to Revolut (2026-07-11)
    mode: 'prod',                                   // widget also auto-follows the server's sandbox flag
    checkoutUrl: '/functions/v1/norva-revolut/checkout',
    confirmUrl: '/functions/v1/norva-revolut/confirm',
    profileUrl: '/functions/v1/norva-revolut/profile',
    // RevolutCheckout widget ESM module, loaded on demand (nothing costs until checkout).
    sdkUrl: 'https://unpkg.com/@revolut/checkout/esm',
    // Display prices per plan/period (amounts are charged server-side in cents).
    plans: {
      plus:   { monthly: '4.99', annual: '41.99' },
      family: { monthly: '8.99', annual: '75.99' },
    },
  },
};
