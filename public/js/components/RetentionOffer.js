(function () {
  'use strict';
  function text(key, fallback, values) {
    return window.NorvaI18n?.t(key, { defaultValue: fallback, ...values })
      ?? fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''));
  }
  function element(tag, className, label) {
    const node = document.createElement(tag);
    node.className = className;
    if (label) node.textContent = label;
    return node;
  }
  function money(cents, currency) {
    return new Intl.NumberFormat(document.documentElement.lang || 'en', { style: 'currency', currency }).format(cents / 100);
  }
  function date(value) {
    return new Date(value).toLocaleDateString(document.documentElement.lang || 'en', { year: 'numeric', month: 'long', day: 'numeric' });
  }
  async function mount(parent) {
    const billing = window.NorvaBilling;
    if (!billing?.revolutRetentionOffer || billing.isNative?.() || billing.isTvShell?.()) return;
    const card = element('section', 'card retention-offer');
    card.setAttribute('aria-live', 'polite');
    card.appendChild(element('p', 'msg', text('ui_ret_loading', 'Checking available offers…')));
    parent.insertBefore(card, parent.querySelector(':scope > .actions'));
    const standardActions = parent.querySelectorAll('[data-retention-alternative]');
    function showOffer(visible) {
      document.body.classList.toggle('has-retention-offer', visible);
      standardActions.forEach(action => { action.hidden = visible; });
    }
    async function load(restoreFocus = false) {
      card.replaceChildren(element('p', 'msg', text('ui_ret_loading', 'Checking available offers…')));
      try {
        const offer = await billing.revolutRetentionOffer();
        if (!offer) {
          showOffer(false); card.remove();
          if (restoreFocus) standardActions[0]?.focus();
          return;
        }
        card.replaceChildren();
        if (offer.support) {
          showOffer(false);
          card.appendChild(element('p', 'msg', text('ui_ret_support', 'A playback problem? We can help you resolve it.')));
          const help = element('a', 'btn ghost', text('ui_ret_contact', 'Contact support'));
          help.href = 'mailto:support@norva.tv';
          card.appendChild(help);
          if (restoreFocus) help.focus();
          return;
        }
        if (!Number.isInteger(offer.amount_cents) || !Number.isInteger(offer.base_amount_cents)
          || offer.amount_cents >= offer.base_amount_cents || !['monthly', 'annual'].includes(offer.period)) throw new Error('Invalid offer');
        showOffer(true);
        const heading = element('h2', 'retention-title', text('ui_ret_title', 'Your personal offer'));
        heading.id = 'retention-title'; card.setAttribute('aria-labelledby', heading.id);
        card.appendChild(heading);
        const values = { amount: money(offer.amount_cents, offer.currency), base: money(offer.base_amount_cents, offer.currency), cycles: offer.cycles };
        card.appendChild(element('p', 'retention-price', offer.period === 'monthly'
          ? text('ui_ret_price_monthly', '{{amount}}/month', values)
          : text('ui_ret_price_annual', '{{amount}}/year', values)));
        card.appendChild(element('p', 'retention-duration', offer.period === 'monthly'
          ? text('ui_ret_duration_monthly', 'For {{cycles}} months, then {{base}}/month.', values)
          : text('ui_ret_duration_annual', 'For one year, then {{base}}/year.', values)));
        const immediate = offer.charge_mode === 'immediate';
        card.appendChild(element('p', 'retention-timing', immediate
          ? text('ui_ret_now', 'Payment of {{amount}} when you confirm checkout.', values)
          : text('ui_ret_later', 'Nothing charged today. First payment on {{date}}.', { date: date(offer.access_until) })));
        card.appendChild(element('p', 'retention-renewal', text('ui_ret_renewal', 'Automatic renewal. Cancel anytime.')));
        const actions = element('div', 'actions');
        const accept = element(immediate ? 'a' : 'button', 'btn', immediate
          ? text('ui_ret_checkout', 'View offer and resubscribe')
          : text('ui_ret_accept', 'Reactivate at this price'));
        const decline = element('button', 'btn retention-decline', text('ui_ret_decline', 'No thanks'));
        const status = element('p', 'note retention-status');
        status.setAttribute('role', 'status');
        if (immediate) {
          accept.href = '/checkout-revolut.html?' + new URLSearchParams({
            plan: offer.plan, period: offer.period, retentionOffer: offer.id, returnTo: '/subscription.html'
          }).toString();
        } else {
          accept.addEventListener('click', () => act('accept'));
        }
        decline.addEventListener('click', () => act('decline'));
        async function act(action) {
          if (accept.disabled || decline.disabled) return;
          accept.disabled = true; decline.disabled = true;
          accept.setAttribute('aria-disabled', 'true');
          if (immediate) accept.removeAttribute('href');
          status.textContent = text('ui_ret_saving', 'Confirming your choice…');
          try {
            await billing.revolutRetentionAction(offer.id, action);
            if (action === 'accept') { window.location.reload(); return; }
            showOffer(false);
            card.replaceChildren(element('p', 'msg', text('ui_ret_declined', 'Your choice is saved. No reminders for this offer.')));
            card.tabIndex = -1; card.focus();
          } catch (_) {
            accept.disabled = false; decline.disabled = false;
            accept.removeAttribute('aria-disabled');
            status.textContent = text('ui_ret_error', 'We could not confirm this offer. Refresh the page and try again.');
            // Reload the current offer before another financial acceptance.
            accept.remove(); decline.remove();
            const retry = element('button', 'btn ghost', text('ui_ret_retry', 'Check again'));
            retry.addEventListener('click', () => load(true)); actions.appendChild(retry); retry.focus();
          }
        }
        actions.append(accept, decline); card.append(actions, status);
        const details = element('details', 'retention-conditions');
        details.appendChild(element('summary', '', text('ui_ret_conditions', 'Offer conditions')));
        details.appendChild(element('p', '', text('ui_ret_terms', 'Your remaining access is preserved. Offer available until {{date}}.', { date: date(offer.expires_at) })));
        details.appendChild(element('p', '', text('ui_ret_personal', 'Personal offer, cannot be combined with other discounts. Once every 12 months.')));
        card.appendChild(details);
        if (restoreFocus) accept.focus();
      } catch (_) {
        showOffer(false);
        card.replaceChildren(element('p', 'msg', text('ui_ret_error', 'We could not confirm this offer. Refresh the page and try again.')));
        const retry = element('button', 'btn ghost', text('ui_ret_retry', 'Check again'));
        retry.addEventListener('click', () => load(true)); card.appendChild(retry);
        if (restoreFocus) retry.focus();
      }
    }
    await load();
  }
  window.NorvaRetentionOffer = { mount };
}());
