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
      const planName = card.dataset.planName || text(card.querySelector('.plan-name')) || 'Norva';
      const profiles = card.dataset.profiles || '';
      const currency = text(card.querySelector('.cur'));
      const amount = text(card.querySelector('.amount'));
      const cadence = text(card.querySelector('.per'));

      if (selectedPlanLabel) {
        selectedPlanLabel.textContent = planName + (profiles ? ' \u00b7 ' + profiles + ' profiles' : '');
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
      continueButton.textContent = mirrorSourceState && sourceText
        ? sourceText
        : 'Continue with ' + planName;
      continueButton.setAttribute('aria-busy', sourceButton && sourceButton.getAttribute('aria-busy') === 'true' ? 'true' : 'false');
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

  return Object.freeze({ init: init });
});
