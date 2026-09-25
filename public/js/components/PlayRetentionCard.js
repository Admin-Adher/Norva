(function () {
  'use strict';
  let generation = 0;
  const copy = () => {
    const fr = String(window.NorvaI18n?.language || navigator.language).startsWith('fr');
    return fr ? {
      title: 'Continuez avec votre offre Google Play', view: 'Voir mon offre', buy: 'Continuer avec Google Play', no: 'Non merci',
      loading: 'Vérification de votre offre…', retry: 'Réessayer', error: 'La confirmation est momentanément indisponible. Vérifiez l’état de votre abonnement dans Google Play avant de réessayer.',
      pending: 'Confirmation Google Play reçue. Votre accès est en cours de synchronisation. Ne recommencez pas le paiement.',
      cancelled: 'Achat annulé. Votre abonnement reste résilié. Vous pourrez réessayer dans quelques minutes.',
      monthly: (p, r) => `${p}/mois pendant 3 mois, puis ${r}/mois.`, annual: (p, r) => `${p} pour la prochaine année, puis ${r}/an.`,
      timing: d => `Votre accès actuel est conservé jusqu’au ${d}. Premier paiement réduit à cette date.`,
      expired: 'Le paiement aura lieu après votre confirmation Google Play.',
      terms: 'Renouvellement automatique, résiliable dans Google Play. Offre personnelle, non cumulable, une fois sur douze mois.',
      push: 'Recevoir les offres de mon abonnement Google Play par notification',
      update: 'Mettez Norva à jour sur Android pour consulter votre offre.', open: 'Ouvrir Google Play',
      support: 'Un problème de lecture ? Contactez le support pour le résoudre.',
      declined: 'Offre refusée. Aucun rappel ne sera envoyé.',
    } : {
      title: 'Continue with your Google Play offer', view: 'View my offer', buy: 'Continue with Google Play', no: 'No thanks',
      loading: 'Checking your offer…', retry: 'Try again', error: 'Confirmation is temporarily unavailable. Check your subscription in Google Play before trying again.',
      pending: 'Google Play confirmation received. Your access is syncing. Please do not pay again.',
      cancelled: 'Purchase cancelled. Your subscription stays cancelled. You can try again in a few minutes.',
      monthly: (p, r) => `${p}/month for 3 months, then ${r}/month.`, annual: (p, r) => `${p} for your next year, then ${r}/year.`,
      timing: d => `Your current access is preserved until ${d}. First discounted payment on that date.`,
      expired: 'Payment follows your Google Play confirmation.',
      terms: 'Automatically renews; cancel in Google Play. Personal, non-stackable offer, once every twelve months.',
      push: 'Receive offers for my Google Play subscription by notification',
      update: 'Update Norva on Android to view your offer.', open: 'Open Google Play',
      support: 'Playback problem? Contact support to resolve it.', declined: 'Offer declined. No reminders will be sent.',
    };
  };
  const node = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text || ''; if (className) el.className = className; return el; };

  async function refresh(app, decision) {
    const seq = ++generation;
    const root = document.getElementById('settings-play-retention');
    if (!root) return;
    root.replaceChildren(); root.hidden = true;
    if (decision?.projection?.provider !== 'google_play' || app?.currentUser?.device) return;
    const uid = String(app?.currentUser?.id || app?.currentUser?.userId || '');
    const text = copy(), billing = window.NorvaBilling;
    if (!billing) return;
    const current = () => seq === generation && uid === String(app?.currentUser?.id || app?.currentUser?.userId || '');
    const status = node('p', '', 'setting-hint'); status.setAttribute('role', 'status');
    const content = node('div', '', 'play-retention-content');
    root.append(content, status);
    let offer;
    const button = (label, fn, primary = false) => {
      const el = node('button', label, primary ? 'btn btn-primary' : 'btn btn-secondary');
      el.type = 'button'; el.addEventListener('click', fn); return el;
    };
    async function load() {
      root.hidden = false; content.replaceChildren(); status.textContent = text.loading;
      try {
        const response = billing.hasPlayRetention() ? await billing.playRetentionOffer(uid) : await billing.playRetentionAction();
        if (!current()) return;
        offer = response?.offer; status.textContent = '';
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
              if (current()) { status.textContent = text.pending; actions.replaceChildren(); }
            } catch (error) {
              if (!current()) return;
              status.textContent = error?.code === 'cancelled' ? text.cancelled : text.error;
              buy.disabled = false; decline.disabled = false;
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
