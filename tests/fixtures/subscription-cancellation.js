/* Offline billing fixture: no real credentials, payment or account requests. */
(() => {
  const query = new URLSearchParams(location.search);
  const language = query.get('lang') || 'fr';
  window.NorvaI18n?.setPreference(language);
  localStorage.setItem('norva-cloud-session', JSON.stringify({ user: { id: 'offline-subscription-qa' } }));
  const stateKey = 'offline-cancellation-' + (query.get('run') || 'default');
  const decision = () => ({
    status: sessionStorage.getItem(stateKey) || 'trialing', planCode: 'plus', enforced: true,
    projection: { provider: 'revolut', plan_code: 'plus', trial_ends_at: '2026-10-01T06:23:00Z', current_period_end: '2026-10-01T06:23:00Z' },
  });
  window.fetch = async () => ({ ok: true, json: async () => ({ marketing_email: false }) });
  window.NorvaAuth = { getAccessToken: async () => 'offline-fixture-only' };
  window.NorvaCloud = { entitlements: { get: async () => decision(), device: async () => decision() } };
  window.NorvaBilling = {
    isNative: () => false, isTvShell: () => false, hasNativeBilling: () => false,
    revolutProfile: async () => ({ amount_cents: 499, period: 'monthly', plan: 'plus', card_last4: '1234' }),
    revolutCancel: async () => {
      if (query.get('fail') === '1' && !sessionStorage.getItem(stateKey + '-failed')) {
        sessionStorage.setItem(stateKey + '-failed', '1');
        throw new Error('private-backend-diagnostic-must-not-be-visible');
      }
      sessionStorage.setItem(stateKey, 'cancelled_at_period_end');
    },
    revolutResume: async () => { throw new Error('Resubscription is outside this offline cancellation fixture'); },
  };
})();
