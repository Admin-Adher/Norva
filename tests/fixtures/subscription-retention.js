/* Offline web billing fixture. No network, real identity or payment. */
(() => {
  const q = new URLSearchParams(location.search);
  const key = 'retention-proof-' + (q.get('run') || 'default');
  window.NorvaI18n?.setPreference(q.get('lang') || 'fr');
  localStorage.setItem('norva-cloud-session', JSON.stringify({ user: { id: 'offline-retention' } }));
  const state = () => sessionStorage.getItem(key) === 'accept' ? 'active' : q.get('expired') ? 'expired' : 'cancelled_at_period_end';
  const decision = () => ({ status: state(), planCode: 'plus', enforced: true,
    projection: { provider: q.get('play') ? 'google_play' : 'revolut', plan_code: 'plus', current_period_end: '2026-10-01T06:23:00Z' } });
  window.fetch = async () => ({ ok: true, json: async () => ({ marketing_email: false }) });
  window.NorvaAuth = { getAccessToken: async () => 'offline-only' };
  window.NorvaCloud = { entitlements: { get: async () => decision(), device: async () => decision() } };
  window.NorvaBilling = {
    isNative: () => q.get('native') === '1', isTvShell: () => false, hasNativeBilling: () => false,
    revolutProfile: async () => ({ amount_cents: state() === 'active' ? 399 : 499, base_amount_cents: 499, promo_cycles_left: state() === 'active' ? 3 : null, period: 'monthly', plan: 'plus', card_last4: '1234' }),
    revolutRetentionOffer: async () => {
      if (sessionStorage.getItem(key)) return null;
      if (q.get('support')) return { support: true };
      return { id: '00000000-0000-4000-8000-000000000001', plan: 'plus', period: q.get('annual') ? 'annual' : 'monthly',
        amount_cents: q.get('annual') ? 3779 : 399, base_amount_cents: q.get('annual') ? 4199 : 499,
        currency: 'USD', cycles: q.get('annual') ? 1 : 3, access_until: '2026-10-01T06:23:00Z', expires_at: '2026-10-08T06:23:00Z',
        charge_mode: q.get('expired') ? 'immediate' : 'next_cycle' };
    },
    revolutRetentionAction: async (_id, action) => {
      if (q.get('fail') && !sessionStorage.getItem(key + '-failed')) {
        sessionStorage.setItem(key + '-failed', '1'); throw Error('private-diagnostic');
      }
      sessionStorage.setItem(key, action);
    },
  };
})();
