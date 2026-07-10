(function () {
  function hasUsableNorvaSession() {
    try {
      const session = JSON.parse(localStorage.getItem('norva-cloud-session') || 'null');
      // No expiry condition: an expired access token + refresh_token is still a
      // signed-in user (the app refreshes at boot) — don't show them "Sign in".
      return Boolean(
        session &&
        session.access_token &&
        session.refresh_token &&
        session.user &&
        session.user.id
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

  // Direction-aware compact header: scrolling DOWN condenses the bar into the
  // island, scrolling UP brings the full bar back, and it's always full at the
  // very top. rAF-throttled and state-guarded (one class toggle only on a real
  // change) so it stays cheap; the morph itself is a CSS transition.
  function setupCompactNav() {
    if (!nav) return;
    let compact = false;
    let ticking = false;
    let lastY = 0; // avoid reading pageYOffset before first paint (forced reflow)
    const TOP = 40;    // always expanded at/near the top
    const DELTA = 8;   // ignore scroll jitter / tiny moves
    const setCompact = (v) => {
      if (v !== compact) {
        compact = v;
        nav.classList.toggle('compact', compact);
      }
    };
    const update = () => {
      ticking = false;
      const y = Math.max(0, window.pageYOffset || document.documentElement.scrollTop || 0);
      if (y <= TOP) { lastY = y; setCompact(false); return; } // near top → large
      const dy = y - lastY;
      if (Math.abs(dy) < DELTA) return; // not a meaningful move yet; anchor stays so slow scroll still accumulates
      lastY = y;
      setCompact(dy > 0); // down → compact, up → large
    };
    window.addEventListener('scroll', () => {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(update);
      }
    }, { passive: true });
    // Defer the very first scroll-position read until the page is loaded and
    // idle. pageYOffset/scrollTop are layout-flushing reads; running one during
    // load — while layout is still dirty from first render — is a forced reflow
    // (Lighthouse flags it). By load+idle the layout is clean and the page is at
    // its resting scroll position, so the initial compact state is still set
    // correctly, just without blocking first paint.
    const primeInitialState = () => {
      if (window.requestIdleCallback) window.requestIdleCallback(update, { timeout: 1200 });
      else setTimeout(update, 400);
    };
    if (document.readyState === 'complete') primeInitialState();
    else window.addEventListener('load', primeInitialState, { once: true });
  }
  setupCompactNav();

  function setupBillingToggle() {
    const opts = Array.from(document.querySelectorAll('.billing-opt'));
    if (!opts.length) return;
    const prices = Array.from(document.querySelectorAll('.pricing-grid .price'));
    // Plan CTAs carry the chosen plan + period through signup into the plan
    // picker, so the visitor's pricing intent is never lost.
    const planCtas = Array.from(document.querySelectorAll('.pricing-grid a[data-plan]'));

    function apply(period) {
      const isAnnual = period === 'annual';
      planCtas.forEach(a => {
        const dest = '/subscribe.html?plan=' + a.dataset.plan + '&period=' + (isAnnual ? 'annual' : 'monthly');
        a.setAttribute('href', '/account.html?returnTo=' + encodeURIComponent(dest));
      });
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
    const html = document.documentElement;
    // The hero is pre-hidden before first paint by the inline <head> script
    // (html.reveal-armed) so it can never flash in then re-hide when this deferred
    // script runs. Whichever branch we take below, we release that pre-hide: its
    // job is either handed off to `.reveal-ready .scroll-reveal` (an identical
    // hidden state → zero visual jump) or simply dropped so nothing stays hidden.
    const disarm = () => html.classList.remove('reveal-armed');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || !('IntersectionObserver' in window)) {
      disarm();
      html.classList.add('reveal-ready');
      return;
    }

    // [selector, direction, soft?]. `soft` = a shorter, blur-lighter drift for
    // section headers (eyebrow/title/copy) so text leads with a subtle move while
    // cards and visuals travel further — a hierarchy of motion, not one setting
    // applied to everything. Every animatable section is listed here; keep this in
    // sync with landing.html (missing entries = a section that pops with no reveal).
    const groups = [
      ['.hero-content', 'left'],
      ['.hero-visual', 'right'],
      ['.logo-wall .logo-wall-label', 'up', true],
      ['.logo-chip', 'up'],
      ['.compat-strip > .eyebrow, .compat-strip > h2, .compat-strip > .section-copy', 'up', true],
      ['.compat-chip', 'up'],
      ['.compat-note', 'up', true],
      ['.trust-grid article', 'up'],
      ['.split-section > div:first-child', 'left'],
      ['.split-section .sync-stage', 'right'],
      ['.steps-section > .eyebrow, .steps-section > h2, .steps-section > .section-copy', 'up', true],
      ['.step-grid article', 'up'],
      ['.recommendation-section > div:first-child', 'left'],
      ['.recommendation-section .poster-row article', 'up'],
      ['.features-section > .eyebrow, .features-section > h2, .features-section > .section-copy', 'up', true],
      ['.feature-grid article', 'up'],
      ['.devices-section > .eyebrow, .devices-section > h2, .devices-section > .section-copy', 'up', true],
      ['.device-grid article', 'up'],
      ['.get-app-copy > *', 'left'],
      ['.get-app-qr', 'right'],
      ['.infra-banner', 'up'],
      ['.clarity-section > .eyebrow, .clarity-section > h2, .clarity-section > .section-copy', 'up', true],
      ['.clarity-grid article, .warning-note', 'up'],
      ['.pricing-section > .eyebrow, .pricing-section > h2, .pricing-section > .section-copy', 'up', true],
      ['.pricing-grid article, .pricing-section > small', 'up'],
      ['.faq-section > .eyebrow, .faq-section > h2', 'up', true],
      ['.faq-item', 'up'],
      ['.simpler-promo .promo-card', 'up'],
      ['.final-cta', 'up'],
      ['.landing-footer > *', 'up']
    ];

    const revealItems = [];
    groups.forEach(([selector, direction, soft]) => {
      // Stagger restarts at 0 whenever the parent changes, so a selector that
      // spans several containers (e.g. the two `.trust-grid`s) staggers each grid
      // from its own first card instead of inheriting a global running offset.
      let lastParent = null;
      let order = 0;
      document.querySelectorAll(selector).forEach(element => {
        if (element.classList.contains('scroll-reveal')) return;
        if (element.parentElement !== lastParent) {
          lastParent = element.parentElement;
          order = 0;
        }
        element.classList.add('scroll-reveal', `reveal-${direction}`);
        if (soft) element.classList.add('reveal-soft');
        element.style.setProperty('--reveal-delay', `${Math.min(order, 5) * 70}ms`);
        revealItems.push(element);
        order += 1;
      });
    });

    if (!revealItems.length) {
      disarm();
      return;
    }

    html.classList.add('reveal-ready');
    disarm(); // hidden state now comes from `.reveal-ready .scroll-reveal` — identical, no jump

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

    // The -8% bottom rootMargin holds each reveal until the element is clearly on
    // screen — but it also means anything sitting entirely within the last 8% of
    // the page (e.g. the footer copyright line) can never cross the trigger, since
    // the page won't scroll any further, and would stay hidden forever. Once the
    // viewport reaches the very bottom, flush whatever is still hidden: everything
    // above it has already been scrolled through, so only the trapped tail remains.
    let flushed = false;
    const flushTail = () => {
      if (flushed) return;
      if (window.innerHeight + window.pageYOffset < document.documentElement.scrollHeight - 2) return;
      flushed = true;
      window.removeEventListener('scroll', onScroll);
      revealItems.forEach(element => {
        element.classList.add('is-visible');
        observer.unobserve(element);
      });
    };
    let tailTicking = false;
    const onScroll = () => {
      if (tailTicking) return;
      tailTicking = true;
      window.requestAnimationFrame(() => { tailTicking = false; flushTail(); });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    flushTail(); // covers a page that already fits in the viewport (no scroll to come)
  }

  // Pointer-reactive 3D tilt for the device clusters (desktop only). The whole
  // cluster leans toward the cursor in perspective; the idle float lives on the
  // device children, so the two transforms compose instead of fighting. The hero
  // tilt target (.hero-stage) is a child of the reveal target (.hero-visual) and
  // the sync tilt target (.stage-cluster) is a child of the reveal target
  // (.sync-stage), so this never clobbers the reveal transform either. Skipped on
  // touch, constrained (norva-lite) devices and reduced-motion.
  function setupDeviceTilt() {
    const html = document.documentElement;
    if (html.classList.contains('norva-lite')) return;
    if (!window.matchMedia('(pointer: fine)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const targets = [
      { el: document.querySelector('.hero-stage'), host: document.querySelector('.hero-visual'), max: 6 },
      { el: document.querySelector('.sync-stage .stage-cluster'), host: document.querySelector('.sync-stage'), max: 7 }
    ].filter(t => t.el && t.host);

    targets.forEach(({ el, host, max }) => {
      let rect = null;
      let raf = 0;
      let rx = 0;
      let ry = 0;
      const render = () => {
        raf = 0;
        el.style.transform = `perspective(1400px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      };
      const onMove = event => {
        if (!rect) rect = host.getBoundingClientRect();
        const nx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
        const ny = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
        ry = Math.max(-1, Math.min(1, nx)) * max;
        rx = -Math.max(-1, Math.min(1, ny)) * max;
        el.style.transition = 'transform 120ms linear';
        if (!raf) raf = window.requestAnimationFrame(render);
      };
      const onLeave = () => {
        rx = 0;
        ry = 0;
        rect = null;
        el.style.transition = 'transform 600ms cubic-bezier(0.22, 1, 0.36, 1)';
        if (!raf) raf = window.requestAnimationFrame(render);
      };
      host.addEventListener('mousemove', onMove);
      host.addEventListener('mouseleave', onLeave);
      // A scroll shifts the host, so the cached centre is stale — recompute next move.
      window.addEventListener('scroll', () => { rect = null; }, { passive: true });
    });
  }

  setupBillingToggle();
  setupScrollReveal();
  setupDeviceTilt();
})();
