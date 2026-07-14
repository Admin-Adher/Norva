(function () {
  'use strict';

  /*
   * Norva consent banner.
   *
   * Gates the marketing loader (window.NorvaMarketing) behind an explicit
   * opt-in. No analytics/advertising tag can fire until the visitor clicks
   * "Accept": marketing-config.js ships with consentMode: 'denied', and this
   * banner is the only thing that flips it to 'granted'. The choice is stored
   * locally so the banner only shows once per decision.
   */

  var cfg = window.NORVA_MARKETING_CONFIG || {};
  var STORAGE_KEY = 'norva_consent';
  var VERSION = 1;

  var T = {
    text: 'We use analytics and advertising cookies to measure how Norva is used and improve our ads. You can accept or decline — this won’t affect how the site works.',
    accept: 'Accept',
    refuse: 'Decline',
    more: 'Learn more',
    aria: 'Cookie consent'
  };

  var privacyHref = '/privacy.html';

  function read() {
    try {
      var parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!parsed || parsed.v !== VERSION) return null;
      return parsed.status === 'granted' ? 'granted' : 'denied';
    } catch (e) {
      return null;
    }
  }

  function write(status) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ status: status, v: VERSION, ts: Date.now() }));
    } catch (e) { /* storage unavailable: fall back to per-session choice */ }
  }

  function apply(status) {
    if (window.NorvaMarketing && typeof window.NorvaMarketing.setConsent === 'function') {
      window.NorvaMarketing.setConsent(status);
    }
  }

  var el = null;

  function hide() {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
  }

  function decide(status) {
    write(status);
    apply(status);
    hide();
  }

  function injectStyle() {
    if (document.getElementById('norva-consent-style')) return;
    var css = [
      '.norva-consent{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;display:flex;justify-content:center;padding:16px;padding-bottom:calc(16px + env(safe-area-inset-bottom));pointer-events:none}',
      '.norva-consent__card{pointer-events:auto;max-width:760px;width:100%;box-sizing:border-box;background:#0a1124;color:#f4f7ff;border:1px solid rgba(150,172,230,0.20);border-radius:20px;box-shadow:0 18px 50px rgba(0,0,0,0.5);padding:18px 20px;display:flex;flex-wrap:wrap;align-items:center;gap:12px 22px;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}',
      '.norva-consent__text{margin:0;flex:1 1 320px;font-size:13.5px;line-height:1.55;color:#aab4cf}',
      '.norva-consent__link{color:#5b9bff;text-decoration:underline;white-space:nowrap}',
      '.norva-consent__actions{display:flex;gap:10px;flex:0 0 auto;margin-left:auto}',
      '.norva-consent__btn{font:inherit;font-size:14px;font-weight:600;line-height:1;border-radius:12px;padding:11px 20px;cursor:pointer;border:1px solid transparent;color:#f4f7ff;transition:background-color .15s ease,border-color .15s ease,opacity .15s ease}',
      '.norva-consent__btn--ghost{background:transparent;color:#cdd6ec;border-color:rgba(150,172,230,0.34)}',
      '.norva-consent__btn--ghost:hover{border-color:rgba(150,172,230,0.6);background:rgba(255,255,255,0.04)}',
      '.norva-consent__btn--solid{background-image:linear-gradient(135deg,#1769d3 0%,#5538c8 100%);color:#fff}',
      '.norva-consent__btn--solid:hover{opacity:.92}',
      '.norva-consent__btn:focus-visible{outline:2px solid #5b9bff;outline-offset:2px}',
      '@keyframes norva-consent-in{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}',
      '.norva-consent__card{animation:norva-consent-in .28s ease both}',
      '@media (max-width:560px){.norva-consent__actions{width:100%;margin-left:0}.norva-consent__btn{flex:1 1 auto}}',
      '@media (prefers-reduced-motion:reduce){.norva-consent__card{animation:none}.norva-consent__btn{transition:none}}'
    ].join('');
    var s = document.createElement('style');
    s.id = 'norva-consent-style';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  function show() {
    if (el) return;
    injectStyle();
    el = document.createElement('div');
    el.className = 'norva-consent';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', T.aria);
    el.innerHTML =
      '<div class="norva-consent__card">' +
        '<p class="norva-consent__text">' + T.text +
          ' <a class="norva-consent__link" href="' + privacyHref + '">' + T.more + '</a></p>' +
        '<div class="norva-consent__actions">' +
          '<button type="button" class="norva-consent__btn norva-consent__btn--ghost" data-consent="denied">' + T.refuse + '</button>' +
          '<button type="button" class="norva-consent__btn norva-consent__btn--solid" data-consent="granted">' + T.accept + '</button>' +
        '</div>' +
      '</div>';
    el.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest && event.target.closest('[data-consent]');
      if (!btn) return;
      decide(btn.getAttribute('data-consent') === 'granted' ? 'granted' : 'denied');
    });
    (document.body || document.documentElement).appendChild(el);
  }

  function init() {
    var stored = read();
    if (stored) { apply(stored); return; } // returning visitor: honour the saved choice silently
    if (!cfg.enabled) return;               // marketing disabled: nothing to consent to yet
    show();
  }

  /* Let a "Manage cookies" link re-open the banner: NorvaConsent.reset(). */
  window.NorvaConsent = {
    open: function () { show(); },
    reset: function () { try { localStorage.removeItem(STORAGE_KEY); } catch (e) {} apply('denied'); show(); },
    get: function () { return read(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
