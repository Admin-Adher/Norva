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
    text: ((globalThis.NorvaI18n?.t("ui_web_f7d909a256a1", { defaultValue: "We use analytics, including privacy-masked session replay, and advertising cookies to understand friction and improve Norva. You can accept or decline — this won’t affect how the site works." }) ?? 'We use analytics, including privacy-masked session replay, and advertising cookies to understand friction and improve Norva. You can accept or decline — this won’t affect how the site works.')),
    accept: (globalThis.NorvaI18n?.t("ui_web_89713b9c9c1b", { defaultValue: "Accept" }) ?? 'Accept'),
    refuse: (globalThis.NorvaI18n?.t("ui_web_a2d285b35287", { defaultValue: "Decline" }) ?? 'Decline'),
    more: (globalThis.NorvaI18n?.t("ui_web_1445799c033a", { defaultValue: "Learn more" }) ?? 'Learn more'),
    aria: (globalThis.NorvaI18n?.t("ui_web_8d5e02d16834", { defaultValue: "Cookie consent" }) ?? 'Cookie consent')
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
    var nativeSurface = Boolean(window.NorvaNativeAnalytics
      && typeof window.NorvaNativeAnalytics.available === 'function'
      && window.NorvaNativeAnalytics.available());
    if (nativeSurface) {
      // Enable/disable the native SDKs before ProductAnalytics publishes any
      // same-page lifecycle or business event. Browser GA/Ads stays disabled
      // in Android WebViews to avoid a second, platform=web event stream.
      window.NorvaNativeAnalytics.setConsent(status);
      if (window.NorvaProductAnalytics && typeof window.NorvaProductAnalytics.setConsent === 'function') {
        window.NorvaProductAnalytics.setConsent(status);
      }
      return;
    }
    if (window.NorvaMarketing && typeof window.NorvaMarketing.setConsent === 'function') {
      window.NorvaMarketing.setConsent(status);
    }
    if (window.NorvaProductAnalytics && typeof window.NorvaProductAnalytics.setConsent === 'function') {
      window.NorvaProductAnalytics.setConsent(status);
    }
  }

  var el = null;
  var origin = null;
  var tv = false;
  var background = [];
  var backgroundObserver = null;
  var confirmPendingRelease = false;
  var backBridgeInstalled = false;

  function installBackBridge() {
    if (backBridgeInstalled) return;
    backBridgeInstalled = true;
    // Pairing/account pages do not load the SPA D-pad module. The native shell
    // still calls this same Back bridge before navigating or showing its exit UI.
    window.__norvaTV = window.__norvaTV || {};
    var previous = window.__norvaTV.handleBack;
    window.__norvaTV.handleBack = function () {
      if (el && tv) { hide(); return 'modal'; }
      return typeof previous === 'function' ? previous() : 'none';
    };
  }

  function releaseConfirm(event) {
    if (event.type === 'keyup' && event.key !== 'Enter') return;
    confirmPendingRelease = false;
    document.removeEventListener('keydown', swallowHeldConfirm, true);
    document.removeEventListener('keyup', releaseConfirm, true);
    window.removeEventListener('blur', releaseConfirm);
  }

  function swallowHeldConfirm(event) {
    if (!confirmPendingRelease || event.key !== 'Enter') return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }

  function containBackground() {
    Array.prototype.forEach.call(document.body.children, function (node) {
      if (node === el || background.some(function (entry) { return entry.node === node; })) return;
      background.push({ node: node, inert: node.inert });
      node.inert = true;
    });
  }

  function focusDefault() {
    var button = el && el.querySelector('[data-consent="denied"]');
    if (button) button.focus();
  }

  function keepFocus(event) {
    if (el && tv && !el.contains(event.target)) focusDefault();
  }

  // Shared with tvNavigation so capture-listener registration order is irrelevant.
  function handleKey(event) {
    if (swallowHeldConfirm(event)) return true;
    if (!el || !tv) return false;
    var key = event.key;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Tab',
         'Escape', 'GoBack', 'BrowserBack'].indexOf(key) < 0) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (key === 'Escape' || key === 'GoBack' || key === 'BrowserBack') {
      hide(); // Dismissal never grants or overwrites an existing decision.
      return true;
    }
    var controls = Array.prototype.slice.call(el.querySelectorAll('[data-consent], .norva-consent__link'));
    // Keep the remote's primary path deterministic, independent of card geometry.
    controls.sort(function (a, b) {
      function rank(node) { return node.getAttribute('data-consent') === 'denied' ? 0 : node.getAttribute('data-consent') === 'granted' ? 1 : 2; }
      return rank(a) - rank(b);
    });
    var index = controls.indexOf(document.activeElement);
    if (index < 0) { focusDefault(); return true; }
    if (key === 'Enter') {
      if (!event.repeat) {
        // A held OK must not activate the restored catalogue/fiche after closing.
        confirmPendingRelease = true;
        document.addEventListener('keydown', swallowHeldConfirm, true);
        document.addEventListener('keyup', releaseConfirm, true);
        window.addEventListener('blur', releaseConfirm);
        controls[index].click();
      }
    } else {
      var rtl = getComputedStyle(el).direction === 'rtl';
      var backwards = key === 'ArrowUp' || (key === 'Tab' && event.shiftKey) ||
        (key === (rtl ? 'ArrowRight' : 'ArrowLeft'));
      controls[(index + (backwards ? -1 : 1) + controls.length) % controls.length].focus();
    }
    return true;
  }

  function hide() {
    if (backgroundObserver) backgroundObserver.disconnect();
    backgroundObserver = null;
    if (tv) {
      document.removeEventListener('keydown', handleKey, true);
      document.removeEventListener('focusin', keepFocus, true);
    }
    background.forEach(function (entry) { entry.node.inert = entry.inert; });
    background = [];
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
    if (tv && origin && origin.isConnected && !origin.closest('[inert], [hidden], .hidden')) origin.focus();
    origin = null;
  }

  function decide(status) {
    if (!el) return;
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
      '.norva-consent--tv{padding:24px 48px;box-sizing:border-box}',
      '.norva-consent--tv .norva-consent__card{max-width:960px;padding:24px;gap:16px 24px;border-radius:var(--radius-lg,16px);background:var(--color-bg-secondary,var(--surface,var(--panel)));color:var(--color-text-primary,var(--text));border-color:var(--color-border-light,var(--line,var(--border,currentColor)));box-shadow:var(--shadow-lg,none)}',
      '.norva-consent--tv .norva-consent__text{flex:1 1 400px;font-size:20px;line-height:1.45;color:var(--color-text-secondary,var(--muted))}',
      '.norva-consent--tv .norva-consent__actions{gap:16px}',
      '.norva-consent--tv .norva-consent__btn{min-height:56px;min-width:144px;padding:16px 24px;font-size:20px;border-radius:var(--radius-md,10px);background:var(--color-bg-tertiary,var(--surface-2,var(--surface2,var(--panel-2,var(--surface)))));background-image:none;color:var(--color-text-primary,var(--text));border:2px solid var(--color-border-light,var(--line,var(--border,currentColor)))}',
      '.norva-consent--tv .norva-consent__link{display:inline-flex;align-items:center;min-height:48px;font-size:18px;color:var(--color-text-secondary,var(--muted));border-radius:var(--radius-sm,6px)}',
      '.norva-consent--tv .norva-consent__btn:focus,.norva-consent--tv .norva-consent__link:focus{outline:4px solid var(--color-accent-hover,var(--accent-hi,var(--accent)))!important;outline-offset:4px!important;box-shadow:none!important;transform:none!important}',
      '.norva-consent--tv .norva-consent__btn:focus{background:var(--color-bg-active,var(--surface-2,var(--surface2,var(--panel-2,var(--surface,var(--panel,var(--color-bg-tertiary)))))));border-color:var(--color-text-primary,var(--text))}',
      '.norva-consent--tv .norva-consent__btn:active{background:var(--color-accent-dim,var(--surface2,var(--panel-2)))}',
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
    tv = isTvSurface();
    origin = document.activeElement;
    el = document.createElement('div');
    el.className = 'norva-consent' + (tv ? ' norva-consent--tv' : '');
    el.setAttribute('role', tv ? 'dialog' : 'region');
    if (tv) {
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-describedby', 'norva-consent-description');
    }
    el.setAttribute('aria-label', T.aria);
    el.setAttribute('data-i18n-aria-label', 'ui_web_8d5e02d16834');
    el.innerHTML =
      '<div class="norva-consent__card">' +
        '<p id="norva-consent-description" class="norva-consent__text"><span data-i18n="' + (tv ? 'ui_tv_consent_summary' : 'ui_web_f7d909a256a1') + '">' + (tv ? (globalThis.NorvaI18n?.t('ui_tv_consent_summary', { defaultValue: 'Allow analytics and advertising cookies? Your choice does not affect playback.' }) ?? 'Allow analytics and advertising cookies? Your choice does not affect playback.') : T.text) + '</span>' +
          ' <a class="norva-consent__link" data-i18n="ui_web_1445799c033a" href="' + privacyHref + '">' + T.more + '</a></p>' +
        '<div class="norva-consent__actions">' +
          '<button type="button" class="norva-consent__btn norva-consent__btn--ghost" data-i18n="ui_web_a2d285b35287" data-consent="denied">' + T.refuse + '</button>' +
          '<button type="button" class="norva-consent__btn norva-consent__btn--solid" data-i18n="ui_web_89713b9c9c1b" data-consent="granted">' + T.accept + '</button>' +
        '</div>' +
      '</div>';
    el.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest && event.target.closest('[data-consent]');
      if (!btn) return;
      decide(btn.getAttribute('data-consent') === 'granted' ? 'granted' : 'denied');
    });
    (document.body || document.documentElement).appendChild(el);
    if (tv) {
      installBackBridge();
      containBackground();
      backgroundObserver = new MutationObserver(containBackground);
      backgroundObserver.observe(document.body, { childList: true });
      document.addEventListener('keydown', handleKey, true);
      document.addEventListener('focusin', keepFocus, true);
      var decline = el.querySelector('[data-consent="denied"]');
      if (decline) decline.focus();
    }
  }

  /*
   * TV uses a contained remote-first dialog with initial focus on Decline. A TV must never imply consent or reuse another device's
   * choice: every native installation keeps its own explicit decision.
   */
  function isTvSurface() {
    try {
      var ua = navigator.userAgent || '';
      if (/NorvaTV-AndroidTV/i.test(ua)) return true;
      if (/\b(Android\s?TV|SmartTV|Smart-TV|Tizen|Web0S|WebOS|NetCast|BRAVIA|CrKey|GoogleTV|HbbTV|AFT[A-Z]{2,})\b/i.test(ua)) return true;
      if (new URLSearchParams(location.search).has('tv')) return true;
      if (/[?&#]device=tv\b/i.test(location.search + location.hash)) return true;
    } catch (e) { /* default to non-TV */ }
    return false;
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
    close: hide,
    handleKey: handleKey,
    reset: function () { try { localStorage.removeItem(STORAGE_KEY); } catch (e) {} apply('denied'); show(); },
    get: function () { return read(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
