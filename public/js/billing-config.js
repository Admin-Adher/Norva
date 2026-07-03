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

  // ── Stancer (web payment rail — see docs/STANCER-BILLING.md) ──────────────
  // Inert until `enabled:true` AND the STANCER_SECRET_KEY edge secret is set.
  // The web checkout (subscribe.html) calls the norva-stancer/checkout function,
  // which returns a Stancer hosted-payment-page URL to redirect to (PCI-safe,
  // 3DS automatic). Card charging + recurring is orchestrated server-side.
  stancer: {
    enabled: false,
    mode: 'test',                                   // 'test' | 'live' (matches the edge key)
    checkoutUrl: '/functions/v1/norva-stancer/checkout',
    // Called by the return page to finalize the checkout without a webhook.
    confirmUrl: '/functions/v1/norva-stancer/confirm',
    // Display prices per plan/period (amounts are charged server-side in cents).
    plans: {
      plus:   { monthly: '4.99', annual: '41.99' },
      family: { monthly: '8.99', annual: '75.99' },
    },
  },
};
