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
};
