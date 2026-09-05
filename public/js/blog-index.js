'use strict';

(() => {
  const root = document.querySelector('[data-blog-index]');
  if (!root) return;

  const highlights = root.querySelector('[data-index-highlights]');
  const form = root.querySelector('[data-library-search]');
  const input = root.querySelector('[data-library-query]');
  const clearButton = root.querySelector('[data-library-clear]');
  const resetButton = root.querySelector('[data-library-reset]');
  const emptyResetButton = root.querySelector('[data-library-empty-reset]');
  const status = root.querySelector('[data-library-status]');
  const emptyState = root.querySelector('[data-library-empty]');
  const moreButton = root.querySelector('[data-library-more]');
  const topicButtons = Array.from(root.querySelectorAll('[data-topic-filter]'));
  const items = Array.from(root.querySelectorAll('[data-library-item]'));

  if (!form || !input || !status || !emptyState || !moreButton || !items.length) return;

  const pageSize = 12;
  let activeTopic = 'all';
  let visibleLimit = pageSize;

  const normalise = (value) => String(value || '')
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  const matchesQuery = (item, query) => {
    if (!query) return true;
    const haystack = normalise(item.textContent);
    return query.split(/\s+/).every((token) => haystack.includes(token));
  };

  function render({ resetLimit = false } = {}) {
    if (resetLimit) visibleLimit = pageSize;

    const query = normalise(input.value);
    const filtering = Boolean(query) || activeTopic !== 'all';
    const matches = items.filter((item) => {
      const topicMatches = activeTopic === 'all' || item.dataset.topic === activeTopic;
      return topicMatches && matchesQuery(item, query);
    });
    const candidates = filtering
      ? matches
      : matches.filter((item) => item.dataset.highlighted !== 'true');

    const visibleItems = new Set(candidates.slice(0, visibleLimit));
    items.forEach((item) => { item.hidden = !visibleItems.has(item); });

    if (highlights) highlights.hidden = filtering;
    if (clearButton) clearButton.hidden = !query;
    if (resetButton) resetButton.hidden = !filtering;
    emptyState.hidden = matches.length !== 0;
    moreButton.hidden = candidates.length <= visibleLimit;

    if (filtering) {
      status.textContent = (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_e7a1132e823a", {defaultValue: "{{p0}} guide{{p1}} found", p0:(matches.length),p1:(matches.length === 1 ? '' : 's')}) : `${matches.length} guide${matches.length === 1 ? '' : 's'} found`);
    } else {
      status.textContent = (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_62122262e673", {defaultValue: "{{p0}} more guide{{p1}} · newest first", p0:(candidates.length),p1:(candidates.length === 1 ? '' : 's')}) : `${candidates.length} more guide${candidates.length === 1 ? '' : 's'} · newest first`);
    }
  }

  function resetFilters({ focusSearch = false } = {}) {
    input.value = '';
    activeTopic = 'all';
    topicButtons.forEach((button) => {
      const active = button.dataset.topicFilter === 'all';
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    render({ resetLimit: true });
    if (focusSearch) input.focus();
  }

  form.addEventListener('submit', (event) => event.preventDefault());
  input.addEventListener('input', () => render({ resetLimit: true }));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && input.value) {
      input.value = '';
      render({ resetLimit: true });
    }
  });

  clearButton?.addEventListener('click', () => {
    input.value = '';
    render({ resetLimit: true });
    input.focus();
  });

  topicButtons.forEach((button) => {
    button.addEventListener('click', () => {
      activeTopic = button.dataset.topicFilter || 'all';
      topicButtons.forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle('is-active', active);
        candidate.setAttribute('aria-pressed', String(active));
      });
      render({ resetLimit: true });
    });
  });

  resetButton?.addEventListener('click', () => resetFilters({ focusSearch: true }));
  emptyResetButton?.addEventListener('click', () => resetFilters({ focusSearch: true }));
  moreButton.addEventListener('click', () => {
    visibleLimit += pageSize;
    render();
  });

  root.classList.add('is-enhanced');
  render({ resetLimit: true });
})();
