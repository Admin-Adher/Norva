(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NorvaPromoUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const events = Object.freeze({
    black_friday: Object.freeze({ label: (globalThis.NorvaI18n?.t("ui_web_1e988458eef2", { defaultValue: "Black Friday" }) ?? 'Black Friday'), filename: 'black-friday-v2.png' }),
    cyber_monday: Object.freeze({ label: (globalThis.NorvaI18n?.t("ui_web_2b45d53582c8", { defaultValue: "Cyber Monday" }) ?? 'Cyber Monday'), filename: 'cyber-monday-v2.png' }),
    winter_sale: Object.freeze({ label: (globalThis.NorvaI18n?.t("ui_web_b492b69d24cb", { defaultValue: "Winter Sale" }) ?? 'Winter Sale'), filename: 'winter-sale-v2.png' }),
    summer_sale: Object.freeze({ label: (globalThis.NorvaI18n?.t("ui_web_b5a6898e4b72", { defaultValue: "Summer Sale" }) ?? 'Summer Sale'), filename: 'summer-sale-v2.png' }),
    christmas: Object.freeze({ label: (globalThis.NorvaI18n?.t("ui_web_fd4b769d1ebf", { defaultValue: "Christmas Sale" }) ?? 'Christmas Sale'), filename: 'christmas-v2.png' }),
    new_year: Object.freeze({ label: (globalThis.NorvaI18n?.t("ui_web_1a7f43a8d0f1", { defaultValue: "New Year Sale" }) ?? 'New Year Sale'), filename: 'new-year-v2.png' }),
    lunar_new_year: Object.freeze({ label: (globalThis.NorvaI18n?.t("ui_web_36be8a0d2b9b", { defaultValue: "Lunar New Year" }) ?? 'Lunar New Year'), filename: 'lunar-new-year-v2.png' }),
    eid: Object.freeze({ label: (globalThis.NorvaI18n?.t("ui_web_7d953595c71a", { defaultValue: "Eid Sale" }) ?? 'Eid Sale'), filename: 'eid-v2.png' }),
    easter: Object.freeze({ label: (globalThis.NorvaI18n?.t("ui_web_df9df9f8a1c6", { defaultValue: "Easter Sale" }) ?? 'Easter Sale'), filename: 'easter-v2.png' }),
    halloween: Object.freeze({ label: (globalThis.NorvaI18n?.t("ui_web_0163726a63b1", { defaultValue: "Halloween Sale" }) ?? 'Halloween Sale'), filename: 'halloween-v2.png' }),
    valentines: Object.freeze({ label: (globalThis.NorvaI18n?.t("ui_web_04dcb05d5b07", { defaultValue: "Valentine's Sale" }) ?? "Valentine's Sale"), filename: 'valentines-v2.png' }),
    back_to_school: Object.freeze({ label: (globalThis.NorvaI18n?.t("ui_web_193a2ce2a817", { defaultValue: "Back to School" }) ?? 'Back to School'), filename: 'back-to-school-v2.png' }),
    birthday: Object.freeze({ label: (globalThis.NorvaI18n?.t("ui_web_e47bdd9503f9", { defaultValue: "Birthday Sale" }) ?? 'Birthday Sale'), filename: 'birthday-v2.png' }),
    flash: Object.freeze({ label: (globalThis.NorvaI18n?.t("ui_web_88ccbfe6d3f1", { defaultValue: "Flash Sale" }) ?? 'Flash Sale'), filename: 'flash-v2.png' }),
  });

  const themes = Object.freeze({
    black_friday: Object.freeze({ badge: 'linear-gradient(135deg,#ffb800,#ff6a00)', glow: 'rgba(255,184,0,.16)', border: 'rgba(255,184,0,.5)' }),
    cyber_monday: Object.freeze({ badge: 'linear-gradient(135deg,#22d3ee,#6366f1)', glow: 'rgba(34,211,238,.14)', border: 'rgba(99,102,241,.55)' }),
    winter_sale: Object.freeze({ badge: 'linear-gradient(135deg,#7dd3fc,#38bdf8)', glow: 'rgba(125,211,252,.13)', border: 'rgba(125,211,252,.5)' }),
    summer_sale: Object.freeze({ badge: 'linear-gradient(135deg,#fbbf24,#fb7185)', glow: 'rgba(251,191,36,.14)', border: 'rgba(251,146,60,.5)' }),
    christmas: Object.freeze({ badge: 'linear-gradient(135deg,#ef4444,#16a34a)', glow: 'rgba(239,68,68,.14)', border: 'rgba(239,68,68,.5)' }),
    new_year: Object.freeze({ badge: 'linear-gradient(135deg,#facc15,#f472b6)', glow: 'rgba(250,204,21,.14)', border: 'rgba(250,204,21,.5)' }),
    lunar_new_year: Object.freeze({ badge: 'linear-gradient(135deg,#ef4444,#f59e0b)', glow: 'rgba(239,68,68,.16)', border: 'rgba(245,158,11,.55)' }),
    eid: Object.freeze({ badge: 'linear-gradient(135deg,#10b981,#facc15)', glow: 'rgba(16,185,129,.15)', border: 'rgba(16,185,129,.5)' }),
    easter: Object.freeze({ badge: 'linear-gradient(135deg,#f9a8d4,#a5b4fc)', glow: 'rgba(249,168,212,.13)', border: 'rgba(165,180,252,.5)' }),
    halloween: Object.freeze({ badge: 'linear-gradient(135deg,#f97316,#7c3aed)', glow: 'rgba(249,115,22,.16)', border: 'rgba(249,115,22,.55)' }),
    valentines: Object.freeze({ badge: 'linear-gradient(135deg,#fb7185,#e11d48)', glow: 'rgba(251,113,133,.15)', border: 'rgba(225,29,72,.5)' }),
    back_to_school: Object.freeze({ badge: 'linear-gradient(135deg,#38bdf8,#fbbf24)', glow: 'rgba(56,189,248,.13)', border: 'rgba(56,189,248,.5)' }),
    birthday: Object.freeze({ badge: 'linear-gradient(135deg,#f472b6,#8b5cf6)', glow: 'rgba(244,114,182,.15)', border: 'rgba(139,92,246,.5)' }),
    flash: Object.freeze({ badge: 'linear-gradient(135deg,#fde047,#f59e0b)', glow: 'rgba(253,224,71,.16)', border: 'rgba(253,224,71,.55)' }),
    other: Object.freeze({ badge: 'linear-gradient(135deg,#ff8067,#b579ff)', glow: 'rgba(181,121,255,.14)', border: 'rgba(181,121,255,.5)' }),
  });

  function cleanLabel(value) {
    const label = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 48);
    return label.length >= 2 ? label : '';
  }

  function labelFor(promo) {
    if (!promo || typeof promo !== 'object') return '';
    return cleanLabel(promo.label)
      || (events[promo.event] && events[promo.event].label)
      || (globalThis.NorvaI18n?.t("ui_web_7519da60f676", { defaultValue: "Limited Offer" }) ?? 'Limited Offer');
  }

  function themeFor(eventKey) {
    return themes[eventKey] || themes.other;
  }

  function wallpaperFor(eventKey, baseUrl) {
    const event = events[eventKey];
    if (!event) return '';
    const rootUrl = String(baseUrl || '/img/promo-wallpapers/').replace(/\/?$/, '/');
    return rootUrl + encodeURIComponent(event.filename);
  }

  function endsAtMs(promo) {
    if (!promo || promo.ends_at === null || promo.ends_at === undefined || promo.ends_at === '') return null;
    const value = new Date(promo.ends_at).getTime();
    return Number.isFinite(value) ? value : NaN;
  }

  function isActive(promo, requestedNowMs) {
    if (!promo || typeof promo !== 'object') return false;
    const endMs = endsAtMs(promo);
    if (Number.isNaN(endMs)) return false;
    const nowMs = Number.isFinite(requestedNowMs) ? requestedNowMs : Date.now();
    return endMs === null || endMs > nowMs;
  }

  function selectPromo(promos, preferredPlan, requestedPeriod, requestedNowMs) {
    const period = requestedPeriod === 'annual' ? 'annual' : 'monthly';
    const preferred = preferredPlan === 'family' ? 'family' : preferredPlan === 'plus' ? 'plus' : '';
    const plans = preferred
      ? [preferred].concat(['plus', 'family'].filter(function (plan) { return plan !== preferred; }))
      : ['plus', 'family'];
    for (const plan of plans) {
      const promo = promos && promos[plan] && promos[plan][period];
      if (!isActive(promo, requestedNowMs)) continue;
      return Object.freeze({
        plan,
        period,
        promo,
        label: labelFor(promo),
        endsAtMs: endsAtMs(promo),
      });
    }
    return null;
  }

  function countdownTo(endsAt, requestedNowMs) {
    if (endsAt === null || endsAt === undefined || endsAt === '') return null;
    const endMs = typeof endsAt === 'number' ? endsAt : new Date(endsAt).getTime();
    if (!Number.isFinite(endMs)) return null;
    const nowMs = Number.isFinite(requestedNowMs) ? requestedNowMs : Date.now();
    const leftMs = endMs - nowMs;
    if (leftMs <= 0) {
      return Object.freeze({ expired: true, urgent: true, text: '00:00:00', ariaText: (globalThis.NorvaI18n?.t("ui_web_790867118b8d", { defaultValue: "Offer ended" }) ?? 'Offer ended') });
    }

    const totalSeconds = Math.ceil(leftMs / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor(totalSeconds / 3600) % 24;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const seconds = totalSeconds % 60;
    const pad = function (value) { return String(value).padStart(2, '0'); };
    const spoken = [];
    if (days) spoken.push(days + ' ' + (days === 1 ? 'day' : 'days'));
    if (days || hours) spoken.push(hours + ' ' + (hours === 1 ? 'hour' : 'hours'));
    if (days || hours || minutes) spoken.push(minutes + ' ' + (minutes === 1 ? 'minute' : 'minutes'));
    spoken.push(seconds + ' ' + (seconds === 1 ? 'second' : 'seconds'));

    return Object.freeze({
      expired: false,
      urgent: leftMs <= 3600000,
      text: (days ? days + 'd ' : '') + pad(hours) + ':' + pad(minutes) + ':' + pad(seconds),
      ariaText: spoken.join(', ') + ' remaining',
    });
  }

  return Object.freeze({
    events,
    themes,
    cleanLabel,
    labelFor,
    themeFor,
    wallpaperFor,
    isActive,
    selectPromo,
    countdownTo,
  });
}));
