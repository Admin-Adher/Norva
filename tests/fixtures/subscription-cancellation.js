/* Offline billing fixture: no real credentials, payment or account requests. */
(() => {
  const query = new URLSearchParams(location.search);
  const language = query.get('lang') || 'fr';
  window.NorvaI18n?.setPreference(language);
  localStorage.setItem('norva-cloud-session', JSON.stringify({ user: { id: 'offline-subscription-qa' } }));
  const stateKey = 'offline-cancellation-' + (query.get('run') || 'default');
  const decision = () => ({
    status: sessionStorage.getItem(stateKey) || 'trialing', planCode: 'plus', enforced: true,
    projection: { provider: query.get('play') ? 'google_play' : 'revolut', plan_code: 'plus', trial_ends_at: '2026-10-08T06:23:00Z', current_period_end: '2026-10-08T06:23:00Z' },
  });
  window.fetch = async () => ({ ok: true, json: async () => ({ marketing_email: false }) });
  window.NorvaAuth = { getAccessToken: async () => 'offline-fixture-only' };
  window.NorvaCloud = { entitlements: { get: async () => decision(), device: async () => decision() } };
  window.NorvaBilling = {
    isNative: () => false, isTvShell: () => false, hasNativeBilling: () => false,
    revolutProfile: async () => ({ amount_cents: 499, period: 'monthly', plan: 'plus', card_last4: '1234' }),
    revolutCancel: async (reason) => {
      if (query.get('fail') === '1' && !sessionStorage.getItem(stateKey + '-failed')) {
        sessionStorage.setItem(stateKey + '-failed', '1');
        throw new Error('private-backend-diagnostic-must-not-be-visible');
      }
      sessionStorage.setItem(stateKey, 'cancelled_at_period_end');
      sessionStorage.setItem(stateKey + '-reason', reason);
      return { status: 'cancelled_at_period_end', access_until: '2026-10-08T06:23:00Z' };
    },
    revolutRetentionOffer: async () => {
      if (query.get('offerFail')) throw Error('private-quote-error');
      if (query.get('ineligible') || sessionStorage.getItem(stateKey + '-declined')) return null;
      if (sessionStorage.getItem(stateKey + '-reason') === 'technical') return { support: true };
      const annual = query.get('annual') === '1';
      return { id: '00000000-0000-4000-8000-000000000001', plan: 'plus', period: annual ? 'annual' : 'monthly',
        currency: 'USD', amount_cents: annual ? 3779 : 399, base_amount_cents: annual ? 4199 : 499,
        cycles: annual ? 1 : 3, access_until: '2026-10-08T06:23:00Z', expires_at: '2026-10-15T06:23:00Z', charge_mode: 'next_cycle' };
    },
    revolutRetentionAction: async (_id, action) => {
      if (action === 'accept') sessionStorage.setItem(stateKey, 'trialing');
      else sessionStorage.setItem(stateKey + '-declined', '1');
    },
    revolutResume: async () => { throw new Error('Resubscription is outside this offline cancellation fixture'); },
  };
})();
