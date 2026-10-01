(function () {
  'use strict';
  let generation = 0;
  let dispose = () => {};
  const fallback = {
  "en": {
    "title": "Continue with your Google Play offer",
    "buy": "Continue with Google Play",
    "no": "No thanks",
    "loading": "Checking your offer…",
    "retry": "Try again",
    "error": "Confirmation is temporarily unavailable. Check your subscription in Google Play before trying again.",
    "pending": "Google Play confirmation received. Your access is syncing. Please do not pay again.",
    "checking": "Checking with Google Play. Please do not pay again.",
    "confirmed": "Your Google Play promotional purchase is confirmed.",
    "check": "Check confirmation",
    "manage": "Manage in Google Play",
    "cancelled": "Purchase cancelled. Your subscription stays cancelled. You can try again in a few minutes.",
    "monthly": "{{price}}/month for 3 months, then {{regular}}/month.",
    "annual": "{{price}} for your next year, then {{regular}}/year.",
    "timing": "Your current access is preserved until {{date}}. First discounted payment on that date.",
    "expired": "Payment follows your Google Play confirmation.",
    "terms": "Automatically renews; cancel in Google Play. Personal, non-stackable offer, once every twelve months.",
    "push": "Receive offers for my Google Play subscription by notification",
    "update": "Update Norva on Android to view your offer.",
    "open": "Open Google Play",
    "support": "Playback problem? Contact support to resolve it.",
    "declined": "Offer declined. No reminders will be sent."
  },
  "fr": {
    "title": "Continuez avec votre offre Google Play",
    "buy": "Continuer avec Google Play",
    "no": "Non merci",
    "loading": "Vérification de votre offre…",
    "retry": "Réessayer",
    "error": "La confirmation est momentanément indisponible. Vérifiez l’état de votre abonnement dans Google Play avant de réessayer.",
    "pending": "Confirmation Google Play reçue. Votre accès est en cours de synchronisation. Ne recommencez pas le paiement.",
    "checking": "Vérification auprès de Google Play en cours. Ne recommencez pas le paiement.",
    "confirmed": "Votre achat promotionnel Google Play est confirmé.",
    "check": "Vérifier la confirmation",
    "manage": "Gérer dans Google Play",
    "cancelled": "Achat annulé. Votre abonnement reste résilié. Vous pourrez réessayer dans quelques minutes.",
    "monthly": "{{price}}/mois pendant 3 mois, puis {{regular}}/mois.",
    "annual": "{{price}} pour la prochaine année, puis {{regular}}/an.",
    "timing": "Votre accès actuel est conservé jusqu’au {{date}}. Premier paiement réduit à cette date.",
    "expired": "Le paiement aura lieu après votre confirmation Google Play.",
    "terms": "Renouvellement automatique, résiliable dans Google Play. Offre personnelle, non cumulable, une fois sur douze mois.",
    "push": "Recevoir les offres de mon abonnement Google Play par notification",
    "update": "Mettez Norva à jour sur Android pour consulter votre offre.",
    "open": "Ouvrir Google Play",
    "support": "Un problème de lecture ? Contactez le support pour le résoudre.",
    "declined": "Offre refusée. Aucun rappel ne sera envoyé."
  }
};
  const copy = () => {
    const base = String(window.NorvaI18n?.language || navigator.language).startsWith('fr') ? fallback.fr : fallback.en;
    const t = (key, args = {}) => window.NorvaI18n?.t?.('ui_play_retention_' + key, { defaultValue: base[key], ...args })
      ?? base[key].replace(/{{(\w+)}}/g, (_, k) => args[k] ?? '');
    return { ...Object.fromEntries(Object.keys(base).map(key => [key, t(key)])),
      monthly: (price, regular) => t('monthly', { price, regular }),
      annual: (price, regular) => t('annual', { price, regular }),
      timing: date => t('timing', { date }),
    };
  };
  const node = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text || ''; if (className) el.className = className; return el; };

  async function refresh(app, decision, onConfirmed) {
    dispose();
    const seq = ++generation;
    const root = document.getElementById('settings-play-retention');
    if (!root) return;
    root.replaceChildren(); root.hidden = true;
    if (decision?.projection?.provider !== 'google_play' || app?.currentUser?.device) return;
    const uid = String(app?.currentUser?.id || app?.currentUser?.userId || '');
    const text = copy(), billing = window.NorvaBilling;
    if (!billing) return;
    // The native bridge deliberately accepts purchases only on billing pages.
    // Settings may discover an offer over HTTP, then lead to that trusted page.
    const paymentPage = /^\/subscription(?:\.html)?$/.test(window.location?.pathname || '');
    const current = () => root.isConnected && seq === generation && uid === String(app?.currentUser?.id || app?.currentUser?.userId || '');
    const status = node('p', '', 'setting-hint'); status.setAttribute('role', 'status');
    const content = node('div', '', 'play-retention-content');
    root.append(content, status);
    let offer;
    let pendingId = null, checking = false, timer;
    const onVisible = () => { if (!document.hidden && current() && pendingId) verify(); };
    document.addEventListener('visibilitychange', onVisible);
    dispose = () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
    const button = (label, fn, primary = false) => {
      const el = node('button', label, primary ? 'btn btn-primary' : 'btn btn-secondary');
      el.type = 'button'; el.addEventListener('click', fn); return el;
    };
    function pending(id, received = false) {
      pendingId = id;
      content.replaceChildren(node('h3', text.title));
      status.textContent = received ? text.pending : text.checking;
      const actions = node('div', '', 'play-retention-actions');
      const check = button(text.check, () => verify());
      check.dataset.confirmationCheck = 'true';
      const manage = node('a', text.manage, 'btn btn-secondary');
      manage.href = 'https://play.google.com/store/account/subscriptions?package=tv.norva.phone';
      actions.append(check, manage); content.append(actions);
    }
    async function verify(attempt = 0) {
      if (!current() || !pendingId || checking || document.hidden) return;
      clearTimeout(timer); checking = true;
      const check = content.querySelector('[data-confirmation-check]');
      if (check) check.disabled = true;
      try {
        const result = await billing.playRetentionStatus(pendingId);
        if (!current()) return;
        if (result?.confirmation?.state === 'confirmed') {
          pendingId = null; content.replaceChildren(); status.textContent = text.confirmed;
          status.tabIndex = -1; status.focus();
          if (typeof onConfirmed === 'function') onConfirmed();
          return;
        }
        // A missing/delayed webhook never authorizes another payment. The user
        // can check again without opening a new Google Play purchase sheet.
        status.textContent = text.checking;
      } catch (_) { if (current()) status.textContent = text.error; }
      finally {
        checking = false;
        if (current() && check) check.disabled = false;
      }
      const delays = [1000, 2000, 3000, 5000, 8000];
      if (current() && pendingId && attempt < delays.length && !document.hidden) {
        timer = setTimeout(() => verify(attempt + 1), delays[attempt]);
      }
    }
    async function load() {
      root.hidden = false; content.replaceChildren(); status.textContent = text.loading;
      try {
        const response = billing.hasPlayRetention() && paymentPage
          ? await billing.playRetentionOffer(uid) : await billing.playRetentionAction();
        if (!current()) return;
        offer = response?.offer; status.textContent = '';
        if (response?.confirmation?.state === 'confirmed') {
          status.textContent = text.confirmed; return;
        }
        if (response?.confirmation?.state === 'pending') {
          pending(response.confirmation.offerId); verify(); return;
        }
        const label = node('label', '', 'play-retention-preference');
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = response?.pushOptIn === true;
        input.addEventListener('change', async () => {
          input.disabled = true;
          try { await billing.playRetentionAction({action:'push-preference', enabled:input.checked}); }
          catch (_) { input.checked = !input.checked; status.textContent = text.error; }
          finally { input.disabled = false; }
        });
        label.append(input, node('span', text.push));
        if (offer?.support) content.append(node('p', text.support));
        else if (offer?.id && !billing.hasPlayRetention()) {
          content.append(node('p', text.update));
          const link = node('a', text.open, 'btn btn-primary');
          link.href = 'https://play.google.com/store/apps/details?id=tv.norva.phone'; content.append(link);
        } else if (offer?.id && !paymentPage) {
          content.append(node('h3', text.title));
          const link = node('a', text.buy, 'btn btn-primary');
          link.href = '/subscription?returnTo=' + encodeURIComponent('/app#settings');
          content.append(link);
        } else if (offer?.id) {
          content.append(node('h3', text.title), node('p', offer.period === 'monthly'
            ? text.monthly(offer.priceString, offer.regularPriceString) : text.annual(offer.priceString, offer.regularPriceString), 'play-retention-price'));
          const date = new Date(offer.accessUntil).toLocaleDateString(window.NorvaI18n?.language || undefined);
          content.append(node('p', offer.preserveAccess ? text.timing(date) : text.expired, 'setting-hint'));
          const actions = node('div', '', 'play-retention-actions');
          const buy = button(text.buy, async () => {
            buy.disabled = true; decline.disabled = true; status.textContent = text.loading;
            try {
              await billing.purchasePlayRetention(uid, offer);
              if (current()) { pending(offer.id, true); verify(); }
            } catch (error) {
              if (!current()) return;
              if (error?.code === 'cancelled') {
                status.textContent = text.cancelled; buy.disabled = false; decline.disabled = false;
              } else {
                // Distinguish a failure before the claim from an ambiguous
                // result after the purchase sheet opened, using server state.
                try {
                  const result = await billing.playRetentionStatus(offer.id);
                  if (!current()) return;
                  if (result?.confirmation?.state === 'available') {
                    status.textContent = text.error; buy.disabled = false; decline.disabled = false;
                  } else { pending(offer.id); verify(); }
                } catch (_) { if (current()) { pending(offer.id); status.textContent = text.error; } }
              }
            }
          }, true);
          const decline = button(text.no, async () => {
            buy.disabled = true; decline.disabled = true;
            try {
              await billing.playRetentionAction({action:'decline', offerId:offer.id});
              if (current()) { content.replaceChildren(); status.textContent = text.declined; status.tabIndex = -1; status.focus(); }
            } catch (_) { status.textContent = text.error; buy.disabled = false; decline.disabled = false; }
          });
          actions.append(buy, decline); content.append(actions, node('p', text.terms, 'setting-hint'));
        }
        if (billing.hasPlayRetention()) content.append(label);
        if (!content.childNodes.length) root.hidden = true;
      } catch (_) {
        if (!current()) return;
        status.textContent = text.error;
        content.replaceChildren(button(text.retry, load));
      }
    }
    await load();
  }
  window.NorvaPlayRetentionCard = { refresh };
})();
