/* A checked signup choice is bound to the verified email, never to an arbitrary
   next session. Authentication/OTP success must not depend on marketing. */
(function () {
  'use strict';
  const key = 'norva-signup-email-choice-v1';
  function remember(email, checked) {
    try {
      sessionStorage.removeItem(key);
      if (checked === true) sessionStorage.setItem(key, JSON.stringify({
        email: String(email || '').trim().toLowerCase(), at: Date.now()
      }));
    } catch (_) { /* no inferred consent when storage is unavailable */ }
  }
  async function apply() {
    let choice;
    try { choice = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (_) { return; }
    if (!choice) return;
    // Consume once. A failed opt-in must not block signup or unexpectedly replay
    // after a later unsubscribe. The account switch remains available.
    sessionStorage.removeItem(key);
    if (!choice.email || !(Date.now() - choice.at >= 0 && Date.now() - choice.at < 2 * 60 * 60 * 1000)) return;
    try {
      const auth = window.NorvaAuth;
      const user = await auth.getUser();
      if (!user?.email_confirmed_at || String(user.email).toLowerCase() !== choice.email) return;
      const token = await auth.getAccessToken();
      if (!token) return;
      const base = String(auth.supabaseUrl || 'https://api.norva.tv').replace(/\/+$/, '');
      await fetch(base + '/functions/v1/norva-lifecycle/preferences', {
        method: 'POST', signal: AbortSignal.timeout(3000),
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
          ...(auth.publishableKey ? { apikey: auth.publishableKey } : {}) },
        body: JSON.stringify({ marketing_email: true, source: 'signup_checkbox' })
      });
    } catch (_) { /* optional: the account settings remain authoritative */ }
  }
  window.NorvaSignupEmailPreference = { remember, apply };
}());
