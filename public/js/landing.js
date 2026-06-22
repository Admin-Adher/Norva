(function () {
  function hasUsableNorvaSession() {
    try {
      const session = JSON.parse(localStorage.getItem('norva-cloud-session') || 'null');
      const now = Math.floor(Date.now() / 1000);
      return Boolean(
        session &&
        session.access_token &&
        session.refresh_token &&
        session.user &&
        session.user.id &&
        (!session.expires_at || Number(session.expires_at) > now + 30)
      ) || Boolean(localStorage.getItem('norva-cloud-device-token'));
    } catch (_) {
      return false;
    }
  }

  function resolveNorvaHomeHref() {
    return hasUsableNorvaSession() ? '/app#home' : '/';
  }

  const nav = document.querySelector('.landing-nav');
  const toggle = document.querySelector('.nav-toggle');

  document.querySelectorAll('[data-norva-home-link]').forEach(link => {
    link.setAttribute('href', resolveNorvaHomeHref());
    link.addEventListener('click', event => {
      const target = resolveNorvaHomeHref();
      link.setAttribute('href', target);
      if (target === '/app#home') {
        event.preventDefault();
        window.location.assign(target);
      }
    });
  });

  toggle?.addEventListener('click', () => {
    const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });

  document.querySelectorAll('.landing-nav a').forEach(link => {
    link.addEventListener('click', () => {
      nav?.classList.remove('open');
      toggle?.setAttribute('aria-expanded', 'false');
    });
  });

  document.querySelectorAll('.faq-item').forEach(item => {
    item.addEventListener('click', () => {
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach(openItem => {
        if (openItem !== item) openItem.classList.remove('open');
      });
      item.classList.toggle('open', !isOpen);
    });
  });

  function setupBillingToggle() {
    const opts = Array.from(document.querySelectorAll('.billing-opt'));
    if (!opts.length) return;
    const prices = Array.from(document.querySelectorAll('.pricing-grid .price'));

    function apply(period) {
      const isAnnual = period === 'annual';
      opts.forEach(opt => {
        const active = opt.dataset.period === period;
        opt.classList.toggle('is-active', active);
        opt.setAttribute('aria-pressed', String(active));
      });
      prices.forEach(price => {
        const amount = price.querySelector('.price-amount');
        const suffix = price.querySelector('.price-period');
        if (amount && price.dataset.monthly && price.dataset.annual) {
          amount.textContent = isAnnual ? price.dataset.annual : price.dataset.monthly;
        }
        if (suffix) {
          suffix.textContent = isAnnual
            ? (price.dataset.annualSuffix || '/yr')
            : (price.dataset.monthlySuffix || '/mo');
        }
        const note = price.nextElementSibling;
        if (note && note.classList.contains('price-note')) {
          note.textContent = isAnnual ? (note.dataset.annualNote || '') : (note.dataset.monthlyNote || '');
        }
      });
    }

    opts.forEach(opt => opt.addEventListener('click', () => apply(opt.dataset.period)));
    apply('monthly');
  }

  function setupScrollReveal() {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || !('IntersectionObserver' in window)) {
      document.documentElement.classList.add('reveal-ready');
      return;
    }

    const groups = [
      ['.hero-content', 'left'],
      ['.hero-visual', 'right'],
      ['.trust-grid article', 'up'],
      ['.split-section > div:first-child', 'left'],
      ['.split-section .sync-panel', 'right'],
      ['.steps-section > .eyebrow, .steps-section > h2, .steps-section > .section-copy', 'up'],
      ['.step-grid article', 'up'],
      ['.recommendation-section > div:first-child', 'left'],
      ['.recommendation-section .poster-row article', 'up'],
      ['.features-section > .eyebrow, .features-section > h2, .features-section > .section-copy', 'up'],
      ['.feature-grid article', 'up'],
      ['.devices-section > .eyebrow, .devices-section > h2, .devices-section > .section-copy', 'up'],
      ['.device-grid article', 'up'],
      ['.clarity-section > .eyebrow, .clarity-section > h2, .clarity-section > .section-copy', 'up'],
      ['.clarity-grid article, .warning-note', 'up'],
      ['.pricing-section > .eyebrow, .pricing-section > h2, .pricing-section > .section-copy', 'up'],
      ['.pricing-grid article, .pricing-section > small', 'up'],
      ['.faq-section > .eyebrow, .faq-section > h2', 'up'],
      ['.faq-item', 'up'],
      ['.final-cta', 'up'],
      ['.landing-footer > *', 'up']
    ];

    const revealItems = [];
    groups.forEach(([selector, direction]) => {
      document.querySelectorAll(selector).forEach((element, index) => {
        if (element.classList.contains('scroll-reveal')) return;
        element.classList.add('scroll-reveal', `reveal-${direction}`);
        element.style.setProperty('--reveal-delay', `${Math.min(index, 5) * 70}ms`);
        revealItems.push(element);
      });
    });

    if (!revealItems.length) return;

    document.documentElement.classList.add('reveal-ready');

    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, {
      rootMargin: '0px 0px -8% 0px',
      threshold: 0.12
    });

    requestAnimationFrame(() => {
      revealItems.forEach(element => observer.observe(element));
    });
  }

  setupBillingToggle();
  setupScrollReveal();
})();
