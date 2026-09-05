(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NorvaPlanSelectionUi = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function text(node) {
    return node ? String(node.textContent || '').trim() : '';
  }

  // Presentation only: values are supplied by the verified billing catalogue.
  function message(key, values, fallback) {
    const options = Object.assign({ defaultValue: fallback }, values);
    return globalThis.NorvaI18n?.t(key, options)
      ?? fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name] ?? ''));
  }
  function number(value, options) {
    return new Intl.NumberFormat(globalThis.NorvaI18n?.language || 'en', options).format(value);
  }
  function money(value) {
    // The complete money token is isolated by its DOM/paragraph host. Do not
    // retain ICU's outer direction marks inside that isolated token.
    return number(Number(value), { style: 'currency', currency: 'USD' }).replace(/[\u061c\u200e\u200f]/g, '');
  }
  function isolated(value) { return '\u2068' + value + '\u2069'; }
  function cadence(period) {
    return period === 'annual'
      ? message('ui_sub_per_year', {}, '/yr')
      : message('ui_sub_per_month', {}, '/mo');
  }
  function planName(plan) {
    return plan === 'family' ? message('ui_sub_family', {}, 'Norva Family') : 'Norva';
  }
  function savePercent(min, max) {
    const format = value => number(value / 100, { style: 'percent', maximumFractionDigits: 0 });
    const percent = max && max !== min ? format(min) + '–' + format(max) : format(min);
    return message('ui_sub_save_percent', { percent: isolated(percent) }, 'Save {{percent}}');
  }
  const copy = Object.freeze({ message, money, isolated, cadence, planName, savePercent, number,
    annualNote: value => message('ui_sub_annual_note', { amount: isolated(money(value)) }, '{{amount}} per month, billed annually.'),
    continueWith: plan => message('ui_sub_continue', { plan: planName(plan) }, 'Continue with {{plan}}'),
    selected: (plan, profiles) => message(profiles === '2' ? 'ui_sub_selected_two' : 'ui_sub_selected_five',
      { plan: planName(plan) }, profiles === '2' ? '{{plan}} · 2 profiles' : '{{plan}} · 5 profiles'),
  });

  function init(options) {
    const config = options || {};
    const root = document.querySelector(config.rootSelector || '#plans');
    if (!root) return null;

    const cards = Array.from(root.querySelectorAll('.card[data-plan]'));
    const decision = root.querySelector('.plan-decision');
    const continueButton = root.querySelector('#continue-plan');
    const selectedPlanLabel = root.querySelector('#selected-plan');
    const selectedCurrency = root.querySelector('#selected-currency');
    const selectedAmount = root.querySelector('#selected-amount');
    const selectedPeriod = root.querySelector('#selected-period');
    if (!cards.length || !decision || !continueButton) return null;

    let selectedPlan = String(config.defaultPlan || 'plus');

    function cardFor(plan) {
      return cards.find(function (card) { return card.dataset.plan === plan; }) || null;
    }

    function selectedCard() {
      return cardFor(selectedPlan) || cards[0] || null;
    }

    function sync() {
      const card = selectedCard();
      if (!card) return;

      const sourceButton = card.querySelector('.buy');
      const profiles = card.dataset.profiles || '';
      const currency = text(card.querySelector('.cur'));
      const amount = text(card.querySelector('.amount'));
      const cadence = text(card.querySelector('.per'));

      if (selectedPlanLabel) {
        selectedPlanLabel.removeAttribute('data-i18n');
        selectedPlanLabel.textContent = copy.selected(card.dataset.plan, profiles);
      }
      if (selectedCurrency) selectedCurrency.textContent = currency;
      if (selectedAmount) selectedAmount.textContent = amount;
      if (selectedPeriod) selectedPeriod.textContent = cadence;

      const sourceHidden = !sourceButton || sourceButton.hidden;
      decision.hidden = sourceHidden;
      continueButton.disabled = sourceHidden || Boolean(sourceButton && sourceButton.disabled);
      const sourceText = sourceButton ? text(sourceButton) : '';
      const mirrorSourceState = Boolean(sourceButton && (
        sourceButton.disabled || sourceButton.getAttribute('aria-busy') === 'true'
      ));
      continueButton.removeAttribute('data-i18n');
      continueButton.textContent = mirrorSourceState && sourceText
        ? sourceText
        : copy.continueWith(card.dataset.plan);
      continueButton.setAttribute('aria-busy', sourceButton && sourceButton.getAttribute('aria-busy') === 'true' ? 'true' : 'false');
      updateDecisionSpace();
    }

    function updateDecisionSpace() {
      if (typeof getComputedStyle !== 'function') return;
      const fixed = !decision.hidden && getComputedStyle(decision).position === 'fixed';
      const space = fixed ? Math.ceil(decision.getBoundingClientRect().height) + 24 : 0;
      document.documentElement.style.setProperty('--plan-decision-space', space + 'px');
    }
    function revealFocus() {
      const active = document.activeElement;
      if (!active || decision.contains(active) || getComputedStyle(decision).position !== 'fixed') return;
      const bounds = active.getBoundingClientRect();
      const edge = decision.getBoundingClientRect().top;
      if (bounds.bottom > edge) window.scrollBy({ top: bounds.bottom - edge + 16, behavior: 'instant' });
    }
    if (typeof ResizeObserver === 'function') new ResizeObserver(updateDecisionSpace).observe(decision);
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', updateDecisionSpace);
      document.addEventListener('focusin', () => requestAnimationFrame(revealFocus));
      document.fonts?.ready.then(updateDecisionSpace);
    }

    function select(plan, options) {
      const card = cardFor(plan);
      if (!card) return false;
      selectedPlan = card.dataset.plan;
      cards.forEach(function (item) {
        const on = item === card;
        const input = item.querySelector('.plan-choice-input');
        item.classList.toggle('selected', on);
        item.classList.remove('preselected');
        if (input) input.checked = on;
      });
      sync();
      if (options && options.focus) {
        const input = card.querySelector('.plan-choice-input');
        if (input) input.focus({ preventScroll: true });
      }
      return true;
    }

    cards.forEach(function (card) {
      const input = card.querySelector('.plan-choice-input');
      const sourceButton = card.querySelector('.buy');
      if (input) {
        input.addEventListener('change', function () {
          if (input.checked) select(card.dataset.plan);
        });
        input.addEventListener('keydown', function (event) {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
          const nextIndex = (cards.indexOf(card) + direction + cards.length) % cards.length;
          select(cards[nextIndex].dataset.plan, { focus: true });
        });
      }
      if (sourceButton && typeof MutationObserver === 'function') {
        new MutationObserver(sync).observe(sourceButton, {
          attributes: true,
          attributeFilter: ['disabled', 'hidden', 'aria-busy'],
          childList: true,
          subtree: true,
        });
      }
    });

    continueButton.addEventListener('click', function () {
      const card = selectedCard();
      const sourceButton = card && card.querySelector('.buy');
      if (!sourceButton || sourceButton.disabled || sourceButton.hidden) return;
      sourceButton.click();
      sync();
    });

    const initiallyChecked = cards.find(function (card) {
      const input = card.querySelector('.plan-choice-input');
      return Boolean(input && input.checked);
    });
    if (initiallyChecked) selectedPlan = initiallyChecked.dataset.plan;
    select(selectedPlan);

    return Object.freeze({
      select: select,
      sync: sync,
      selectedCard: selectedCard,
      selectedPlan: function () { return selectedPlan; },
    });
  }

  return Object.freeze({ init: init, copy: copy });
});
