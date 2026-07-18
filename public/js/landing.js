(function () {
  // Never gate the above-the-fold content on JavaScript. Older versions of the
  // page armed a pre-paint reveal class from the document head; release it as
  // early as this deferred bundle can run and keep the hero out of scroll reveal.
  document.documentElement.classList.remove('reveal-armed');

  const TRACKING_PARAM = /^(?:utm_[a-z0-9_]+|gclid|fbclid|msclkid)$/i;
  const ATTRIBUTION_PARAMS = (() => {
    const params = new URLSearchParams();
    try {
      new URLSearchParams(window.location.search).forEach((value, key) => {
        if (value && TRACKING_PARAM.test(key)) params.set(key, value.slice(0, 250));
      });
    } catch (_) {}
    return params;
  })();

  function emitLandingEvent(name, data) {
    const safe = {};
    const allowed = new Set([
      'source', 'cta', 'target', 'plan', 'period', 'question',
      'interaction', 'position', 'authenticated', 'section', 'message_id',
      'state', 'reason'
    ]);
    Object.entries(data || {}).forEach(([key, value]) => {
      if (!allowed.has(key)) return;
      if (typeof value === 'string') safe[key] = value.slice(0, 120);
      else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
      else if (typeof value === 'boolean') safe[key] = value;
    });

    const detail = { event: name, ...safe };
    try {
      window.dispatchEvent(new CustomEvent('norva:landing-event', { detail }));
    } catch (_) {}
    if (Array.isArray(window.dataLayer)) window.dataLayer.push(detail);
  }

  function sameOriginBase() {
    return window.location.origin && window.location.origin !== 'null'
      ? window.location.origin
      : 'https://norva.tv';
  }

  function relativeInternalUrl(url) {
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function mergeAttribution(url) {
    ATTRIBUTION_PARAMS.forEach((value, key) => {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    });
  }

  // Keep campaign attribution through both the account page and its encoded
  // returnTo destination. Only first-party, same-origin links are decorated.
  function decorateConversionHref(href) {
    try {
      const base = sameOriginBase();
      const url = new URL(href, base);
      if (url.origin !== base) return href;

      const returnTo = url.searchParams.get('returnTo');
      if (returnTo && returnTo.startsWith('/')) {
        const destination = new URL(returnTo, base);
        mergeAttribution(destination);
        url.searchParams.set('returnTo', relativeInternalUrl(destination));
      }
      mergeAttribution(url);
      return relativeInternalUrl(url);
    } catch (_) {
      return href;
    }
  }

  function replaceLinkLabel(link, label) {
    const labelTarget = link.querySelector('[data-auth-label]');
    if (labelTarget) {
      labelTarget.textContent = label;
      link.setAttribute('aria-label', label);
      return;
    }
    const decoration = Array.from(link.children).filter(child =>
      child.matches('[aria-hidden="true"]')
    );
    link.replaceChildren(document.createTextNode(label));
    decoration.forEach(child => {
      link.append(document.createTextNode(' '), child);
    });
    link.setAttribute('aria-label', label);
  }

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
  const signedIn = hasUsableNorvaSession();

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

  function setupSessionAwareLinks() {
    const accountLinks = Array.from(document.querySelectorAll(
      'a[data-auth-action], a[href*="/account.html"]'
    ));
    accountLinks.forEach(link => {
      if (link.matches('[data-plan]')) return;
      const label = link.textContent.trim().replace(/\s+/g, ' ');
      const isAuthCta = link.matches('[data-auth-action], .login-link, .nav-cta, .primary-btn, .get-app-cta') ||
        /^(?:sign in|create my space|open norva(?: in your browser)?)$/i.test(label);

      if (signedIn && isAuthCta) {
        const isAccountLink = link.matches('.login-link') || /^sign in$/i.test(label);
        link.setAttribute('href', isAccountLink ? '/app#settings' : '/app#home');
        replaceLinkLabel(link, isAccountLink ? 'Account' : 'Open Norva');
      } else {
        link.setAttribute('href', decorateConversionHref(link.getAttribute('href')));
      }
    });
  }

  function setupMobileNavigation() {
    if (!nav || !toggle) return;
    const explicitPanels = Array.from(nav.querySelectorAll('[data-nav-panel]'));
    const panels = explicitPanels.length
      ? explicitPanels
      : [nav.querySelector('.nav-links'), nav.querySelector('.nav-actions')].filter(Boolean);
    const panel = panels[0] || null;
    panels.forEach((controlled, index) => {
      if (!controlled.id) controlled.id = index ? `landing-navigation-actions-${index}` : 'landing-navigation';
    });
    if (panels.length) toggle.setAttribute('aria-controls', panels.map(controlled => controlled.id).join(' '));

    let lastFocus = null;
    let previousOverflow = '';
    let previousPaddingRight = '';
    let previousPosition = '';
    let previousTop = '';
    let previousLeft = '';
    let previousRight = '';
    let lockedScrollY = 0;
    let scrollLocked = false;

    const isModalPanel = () => {
      if (!panel) return false;
      if (nav.dataset.menuModal === 'true' || panels.some(controlled => controlled.getAttribute('aria-modal') === 'true')) return true;
      try {
        return window.matchMedia('(max-width: 1100px)').matches &&
          (window.getComputedStyle(nav).position === 'fixed' ||
            panels.some(controlled => window.getComputedStyle(controlled).position === 'fixed'));
      } catch (_) {
        return false;
      }
    };

    const setScrollLock = locked => {
      if (locked === scrollLocked) return;
      scrollLocked = locked;
      document.body.classList.toggle('nav-menu-open', locked);
      if (locked) {
        lockedScrollY = Math.max(0, window.scrollY || window.pageYOffset || 0);
        previousOverflow = document.body.style.overflow;
        previousPaddingRight = document.body.style.paddingRight;
        previousPosition = document.body.style.position;
        previousTop = document.body.style.top;
        previousLeft = document.body.style.left;
        previousRight = document.body.style.right;
        const gap = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.top = `-${lockedScrollY}px`;
        document.body.style.left = '0';
        document.body.style.right = '0';
        if (gap) document.body.style.paddingRight = `${gap}px`;
      } else {
        nav.dataset.restoringScroll = 'true';
        document.body.style.overflow = previousOverflow;
        document.body.style.paddingRight = previousPaddingRight;
        document.body.style.position = previousPosition;
        document.body.style.top = previousTop;
        document.body.style.left = previousLeft;
        document.body.style.right = previousRight;
        const previousScrollBehavior = document.documentElement.style.scrollBehavior;
        document.documentElement.style.scrollBehavior = 'auto';
        window.scrollTo(0, lockedScrollY);
        document.documentElement.style.scrollBehavior = previousScrollBehavior;
        window.setTimeout(() => {
          delete nav.dataset.restoringScroll;
        }, 350);
      }
    };

    const setOpen = (open, options) => {
      const settings = options || {};
      if (open && !nav.classList.contains('open')) {
        lastFocus = document.activeElement;
        try {
          const navStyle = window.getComputedStyle(nav);
          const flowSpace = nav.getBoundingClientRect().height +
            (Number.parseFloat(navStyle.marginTop) || 0) +
            (Number.parseFloat(navStyle.marginBottom) || 0);
          document.documentElement.style.setProperty('--landing-nav-flow-space', `${flowSpace}px`);
        } catch (_) {}
      }
      nav.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
      panels.forEach(controlled => {
        controlled.setAttribute('aria-hidden', String(!open && window.matchMedia('(max-width: 1100px)').matches));
      });
      setScrollLock(open && isModalPanel());

      if (open && isModalPanel()) {
        requestAnimationFrame(() => {
          const first = nav.querySelector('.nav-links a, .nav-actions a, [data-nav-panel] a, [data-nav-panel] button');
          first?.focus({ preventScroll: true });
        });
      } else if (!open && settings.restoreFocus) {
        const target = lastFocus && lastFocus.isConnected ? lastFocus : toggle;
        target.focus({ preventScroll: true });
      }
    };

    toggle.addEventListener('click', () => {
      setOpen(!nav.classList.contains('open'), { restoreFocus: false });
    });

    nav.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', event => {
        const href = link.getAttribute('href') || '';
        const shouldResolveAnchor = href.startsWith('#') && nav.classList.contains('open') && isModalPanel();
        if (!shouldResolveAnchor) {
          setOpen(false, { restoreFocus: false });
          return;
        }

        let target = null;
        try {
          target = document.getElementById(decodeURIComponent(href.slice(1)));
        } catch (_) {}
        if (!target) {
          setOpen(false, { restoreFocus: true });
          return;
        }

        // The body is position-locked while the mobile menu is open. Let the
        // menu restore the original scroll position first, then perform one
        // deterministic anchor jump so a long smooth scroll cannot appear
        // frozen on mobile devices.
        event.preventDefault();
        setOpen(false, { restoreFocus: false });
        window.requestAnimationFrame(() => {
          const previousBehavior = document.documentElement.style.scrollBehavior;
          document.documentElement.style.scrollBehavior = 'auto';
          target.scrollIntoView({ block: 'start' });
          if (window.history && window.history.pushState) window.history.pushState(null, '', href);
          else window.location.hash = href;

          const focusTarget = target.querySelector('h1, h2') || target;
          const previousTabindex = focusTarget.getAttribute('tabindex');
          if (!focusTarget.matches('a, button, input, select, textarea, [tabindex]')) {
            focusTarget.setAttribute('tabindex', '-1');
          }
          focusTarget.focus({ preventScroll: true });
          focusTarget.addEventListener('blur', () => {
            if (previousTabindex === null) focusTarget.removeAttribute('tabindex');
            else focusTarget.setAttribute('tabindex', previousTabindex);
          }, { once: true });

          window.requestAnimationFrame(() => {
            document.documentElement.style.scrollBehavior = previousBehavior;
          });
        });
      });
    });

    document.addEventListener('pointerdown', event => {
      if (!nav.classList.contains('open') || nav.contains(event.target)) return;
      setOpen(false, { restoreFocus: isModalPanel() });
    });

    document.addEventListener('keydown', event => {
      if (!nav.classList.contains('open')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false, { restoreFocus: true });
        return;
      }
      if (event.key !== 'Tab' || !isModalPanel()) return;

      const focusable = Array.from(nav.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(element => !element.hidden && element.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    const mobile = window.matchMedia('(max-width: 1100px)');
    const syncViewport = () => {
      if (!mobile.matches) {
        setOpen(false, { restoreFocus: false });
        panels.forEach(controlled => controlled.setAttribute('aria-hidden', 'false'));
      } else if (!nav.classList.contains('open')) {
        panels.forEach(controlled => controlled.setAttribute('aria-hidden', 'true'));
      }
    };
    if (mobile.addEventListener) mobile.addEventListener('change', syncViewport);
    else mobile.addListener(syncViewport);
    syncViewport();
  }

  function setupAccessibleFaq() {
    const items = Array.from(document.querySelectorAll('.faq-item'));
    if (!items.length) return;

    const entries = items.map((item, index) => {
      const trigger = item.matches('button')
        ? item
        : item.querySelector('[data-faq-trigger], .faq-question, button');
      const answer = item.matches('button')
        ? item.querySelector('[data-faq-answer], .faq-answer, p')
        : item.querySelector('[data-faq-answer], .faq-answer, p');
      if (!trigger || !answer) return null;

      if (!trigger.id) trigger.id = `faq-question-${index + 1}`;
      if (!answer.id) answer.id = `faq-answer-${index + 1}`;
      trigger.setAttribute('aria-controls', answer.id);
      answer.setAttribute('role', 'region');
      answer.setAttribute('aria-labelledby', trigger.id);

      const icon = trigger.querySelector('[data-faq-icon], .faq-icon') ||
        Array.from(trigger.querySelectorAll('span')).find(span => /^[+\u2212-]$/.test(span.textContent.trim()));
      if (icon && !answer.contains(icon)) icon.setAttribute('aria-hidden', 'true');

      const questionClone = trigger.cloneNode(true);
      questionClone.querySelectorAll('[data-faq-answer], .faq-answer, p, [aria-hidden="true"]').forEach(node => node.remove());
      const question = (trigger.dataset.question || questionClone.textContent || `Question ${index + 1}`)
        .trim()
        .replace(/\s+/g, ' ');
      return { item, trigger, answer, question, index };
    }).filter(Boolean);

    const setEntryOpen = (entry, open) => {
      entry.item.classList.toggle('open', open);
      entry.trigger.setAttribute('aria-expanded', String(open));
      entry.answer.hidden = !open;
      entry.answer.setAttribute('aria-hidden', String(!open));
    };

    let initialOpenUsed = false;
    entries.forEach(entry => {
      const initiallyOpen = !initialOpenUsed && entry.item.classList.contains('open');
      if (initiallyOpen) initialOpenUsed = true;
      setEntryOpen(entry, initiallyOpen);
      entry.trigger.addEventListener('click', () => {
        const willOpen = entry.trigger.getAttribute('aria-expanded') !== 'true';
        entries.forEach(other => setEntryOpen(other, willOpen && other === entry));
        if (willOpen) {
          emitLandingEvent('faq_open', {
            question: entry.question,
            position: entry.index + 1
          });
        }
      });
    });
  }

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
      if (document.body.classList.contains('nav-menu-open') || nav.dataset.restoringScroll === 'true') return;
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

    const toggleGroup = opts[0].closest('.billing-toggle') || opts[0].parentElement;
    let status = document.querySelector('[data-billing-status], .pricing-status');
    if (!status) {
      status = document.createElement('span');
      status.className = 'sr-only billing-status';
      status.dataset.billingStatus = '';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
      toggleGroup?.insertAdjacentElement('afterend', status);
    }

    let currentPeriod = 'monthly';
    // Capsule coulissante du toggle : anime le passage Monthly ↔ Annual. Si la
    // géométrie n'est pas mesurable (layout caché, vieux moteur), has-thumb
    // saute et le bouton actif porte lui-même le dégradé (repli CSS).
    let thumb = null;
    if (toggleGroup) {
      thumb = document.createElement('span');
      thumb.className = 'toggle-thumb';
      thumb.setAttribute('aria-hidden', 'true');
      toggleGroup.prepend(thumb);
      window.addEventListener('resize', () => positionThumb());
      window.addEventListener('load', () => positionThumb());
    }
    function positionThumb() {
      if (!thumb || !toggleGroup) return;
      const act = opts.find(o => o.classList.contains('is-active'));
      if (!act || !act.offsetWidth) { toggleGroup.classList.remove('has-thumb'); return; }
      toggleGroup.classList.add('has-thumb');
      thumb.style.width = `${act.offsetWidth}px`;
      thumb.style.transform = `translateX(${act.offsetLeft}px)`;
    }
    // Promos actives (catalogue live billing_prices) : { plan: { period: { base_cents, event, label } } }.
    let livePromos = null;
    // Badge labels (copy anglaise du site) + couleurs par événement — alignés sur
    // la page de vente (subscribe.html PROMO_LABELS / PROMO_THEMES).
    const PROMO_LABELS = {
      black_friday: 'Black Friday', cyber_monday: 'Cyber Monday', winter_sale: 'Winter Sale',
      summer_sale: 'Summer Sale', christmas: 'Christmas Sale', new_year: 'New Year Sale',
      lunar_new_year: 'Lunar New Year', eid: 'Eid Sale', easter: 'Easter Sale',
      halloween: 'Halloween Sale', valentines: "Valentine's Sale", back_to_school: 'Back to School',
      birthday: 'Birthday Sale', flash: 'Flash Sale', other: 'Limited Offer'
    };
    const PROMO_BADGE_BG = {
      black_friday: 'linear-gradient(135deg,#ffb800,#ff6a00)', cyber_monday: 'linear-gradient(135deg,#22d3ee,#6366f1)',
      winter_sale: 'linear-gradient(135deg,#7dd3fc,#38bdf8)', summer_sale: 'linear-gradient(135deg,#fbbf24,#fb7185)',
      christmas: 'linear-gradient(135deg,#ef4444,#16a34a)', new_year: 'linear-gradient(135deg,#facc15,#f472b6)',
      lunar_new_year: 'linear-gradient(135deg,#ef4444,#f59e0b)', eid: 'linear-gradient(135deg,#10b981,#facc15)',
      easter: 'linear-gradient(135deg,#f9a8d4,#a5b4fc)', halloween: 'linear-gradient(135deg,#f97316,#7c3aed)',
      valentines: 'linear-gradient(135deg,#fb7185,#e11d48)', back_to_school: 'linear-gradient(135deg,#38bdf8,#fbbf24)',
      birthday: 'linear-gradient(135deg,#f472b6,#8b5cf6)', flash: 'linear-gradient(135deg,#fde047,#f59e0b)',
      other: 'linear-gradient(135deg,#ff8067,#b579ff)'
    };
    // Habillage par événement : bordure/halo de la card en promo, teinte
    // d'accent (ink : gros prix, CTA, coches) — mêmes teintes que PROMO_THEMES
    // sur la page de vente — et picto du badge/chrono.
    const PROMO_EDGE = {
      black_friday: { border: 'rgba(255,184,0,.5)', glow: 'rgba(255,184,0,.28)', ink: '#ffb800' },
      cyber_monday: { border: 'rgba(99,102,241,.55)', glow: 'rgba(34,211,238,.26)', ink: '#22d3ee' },
      winter_sale: { border: 'rgba(125,211,252,.5)', glow: 'rgba(125,211,252,.26)', ink: '#7dd3fc' },
      summer_sale: { border: 'rgba(251,146,60,.5)', glow: 'rgba(251,191,36,.26)', ink: '#fbbf24' },
      christmas: { border: 'rgba(239,68,68,.5)', glow: 'rgba(239,68,68,.26)', ink: '#f87171' },
      new_year: { border: 'rgba(250,204,21,.5)', glow: 'rgba(250,204,21,.26)', ink: '#facc15' },
      lunar_new_year: { border: 'rgba(245,158,11,.55)', glow: 'rgba(239,68,68,.28)', ink: '#f59e0b' },
      eid: { border: 'rgba(16,185,129,.5)', glow: 'rgba(16,185,129,.26)', ink: '#34d399' },
      easter: { border: 'rgba(165,180,252,.5)', glow: 'rgba(249,168,212,.24)', ink: '#f9a8d4' },
      halloween: { border: 'rgba(249,115,22,.55)', glow: 'rgba(249,115,22,.28)', ink: '#fb923c' },
      valentines: { border: 'rgba(225,29,72,.5)', glow: 'rgba(251,113,133,.26)', ink: '#fb7185' },
      back_to_school: { border: 'rgba(56,189,248,.5)', glow: 'rgba(56,189,248,.24)', ink: '#38bdf8' },
      birthday: { border: 'rgba(139,92,246,.5)', glow: 'rgba(244,114,182,.26)', ink: '#f472b6' },
      flash: { border: 'rgba(253,224,71,.55)', glow: 'rgba(253,224,71,.28)', ink: '#fbbf24' },
      other: { border: 'rgba(181,121,255,.5)', glow: 'rgba(181,121,255,.26)', ink: '#b579ff' }
    };
    const PROMO_ICONS = {
      black_friday: '🛍️', cyber_monday: '💻', winter_sale: '❄️', summer_sale: '☀️',
      christmas: '🎄', new_year: '🎆', lunar_new_year: '🧧', eid: '🌙', easter: '🐣',
      halloween: '🎃', valentines: '💘', back_to_school: '🎒', birthday: '🎂',
      flash: '⚡', other: '✨'
    };
    function planOfPrice(price) {
      return price.closest('article')?.querySelector('a[data-plan]')?.dataset.plan || '';
    }

    function buildPlanHref(plan, period) {
      const base = sameOriginBase();
      const destination = new URL('/subscribe.html', base);
      destination.searchParams.set('plan', plan);
      destination.searchParams.set('period', period);
      mergeAttribution(destination);

      if (signedIn) return relativeInternalUrl(destination);
      const account = new URL('/account.html', base);
      account.searchParams.set('returnTo', relativeInternalUrl(destination));
      mergeAttribution(account);
      return relativeInternalUrl(account);
    }

    function apply(period, announce) {
      const isAnnual = period === 'annual';
      currentPeriod = isAnnual ? 'annual' : 'monthly';
      planCtas.forEach(a => {
        a.setAttribute('href', buildPlanHref(a.dataset.plan, currentPeriod));
      });
      opts.forEach(opt => {
        const active = opt.dataset.period === currentPeriod;
        opt.classList.toggle('is-active', active);
        opt.setAttribute('aria-pressed', String(active));
      });
      prices.forEach(price => {
        const amount = price.querySelector('.price-amount');
        const suffix = price.querySelector('.price-period');
        const currency = price.querySelector('.price-cur')?.textContent.trim() || '';
        if (amount && price.dataset.monthly && price.dataset.annual) {
          amount.textContent = isAnnual ? price.dataset.annual : price.dataset.monthly;
        }
        if (suffix) {
          suffix.textContent = isAnnual
            ? (price.dataset.annualSuffix || '/yr')
            : (price.dataset.monthlySuffix || '/mo');
        }
        const note = price.parentElement?.querySelector('.price-note') || price.nextElementSibling;
        if (note && note.classList.contains('price-note')) {
          const annual = Number.parseFloat(String(price.dataset.annual || '').replace(',', '.'));
          const exactMonthly = Number.isFinite(annual) ? (annual / 12).toFixed(2) : '';
          note.textContent = isAnnual
            ? (exactMonthly
              ? `That's about ${currency}${exactMonthly}/mo, billed yearly.`
              : (note.dataset.annualNote || ''))
            : (note.dataset.monthlyNote || '');
        }
        const terms = price.parentElement?.querySelector('.pricing-terms');
        if (terms) {
          terms.textContent = isAnnual
            ? (terms.dataset.annualTerms || terms.textContent)
            : (terms.dataset.monthlyTerms || terms.textContent);
        }
        if (amount) {
          const amountText = (isAnnual ? price.dataset.annual : price.dataset.monthly) || amount.textContent;
          price.setAttribute('aria-label', `${currency}${amountText} ${isAnnual ? 'per year' : 'per month'}`.trim());
        }
        // Promo active sur ce plan+période : la card s'habille aux couleurs de
        // l'événement (maquette) — badge « ⚡ ÉVÉNEMENT − X% » en tête, ligne
        // « You save … » au-dessus du titre, prix de référence barré au-dessus
        // du gros prix teinté (obligation Omnibus : l'ancien prix visible),
        // bordure/halo, CTA et coches assortis via --promo-ink (landing.css).
        const promo = livePromos && livePromos[planOfPrice(price)] && livePromos[planOfPrice(price)][currentPeriod];
        const article = price.closest('article');
        let flag = article?.querySelector('.promo-flag');
        let save = article?.querySelector('.promo-save');
        let wasLine = article?.querySelector('.promo-was');
        if (promo && promo.base_cents && article) {
          const effRaw = Number.parseFloat(String(isAnnual ? price.dataset.annual : price.dataset.monthly).replace(',', '.'));
          const effCents = Number.isFinite(effRaw) ? Math.round(effRaw * 100) : promo.base_cents;
          const pct = Math.max(1, Math.round(100 - (effCents / promo.base_cents) * 100));
          const edge = PROMO_EDGE[promo.event] || PROMO_EDGE.other;
          if (!flag) {
            flag = document.createElement('span');
            flag.className = 'promo-flag';
            article.prepend(flag);
          }
          const label = (promo.label && String(promo.label).trim()) || PROMO_LABELS[promo.event] || PROMO_LABELS.other;
          flag.textContent = `${PROMO_ICONS[promo.event] || PROMO_ICONS.other} ${label} − ${pct}%`;
          flag.style.background = PROMO_BADGE_BG[promo.event] || PROMO_BADGE_BG.other;
          flag.style.boxShadow = `0 6px 16px -6px rgba(0,0,0,.5), 0 0 20px ${edge.glow}`;
          if (!save) {
            save = document.createElement('small');
            save.className = 'promo-save';
            flag.insertAdjacentElement('afterend', save);
          }
          let saveTxt = `You save ${currency}${((promo.base_cents - effCents) / 100).toFixed(2)}${isAnnual ? '/yr' : '/mo'}`;
          if (promo.cycles) {
            const unit = isAnnual ? 'year' : 'month';
            saveTxt += promo.cycles === 1 ? ` for your first ${unit}` : ` for your first ${promo.cycles} ${unit}s`;
          }
          save.textContent = saveTxt;
          if (!wasLine) {
            wasLine = document.createElement('div');
            wasLine.className = 'promo-was';
            wasLine.appendChild(document.createElement('s'));
            wasLine.appendChild(document.createElement('span'));
            price.insertAdjacentElement('beforebegin', wasLine);
          }
          wasLine.querySelector('s').textContent = `${currency}${(promo.base_cents / 100).toFixed(2)}`;
          wasLine.querySelector('span').textContent = isAnnual ? '/yr' : '/mo';
          article.classList.add('has-promo');
          article.style.borderColor = edge.border;
          article.style.boxShadow = `inset 0 1px 0 rgba(255,255,255,.08), 0 25px 60px rgba(0,0,0,.45), 0 0 40px ${edge.glow}`;
          article.style.setProperty('--promo-ink', edge.ink);
        } else {
          if (flag) flag.remove();
          if (save) save.remove();
          if (wasLine) wasLine.remove();
          if (article) {
            article.classList.remove('has-promo');
            article.style.borderColor = '';
            article.style.boxShadow = '';
            article.style.removeProperty('--promo-ink');
          }
        }
      });

      if (announce && status) {
        status.textContent = `${isAnnual ? 'Annual' : 'Monthly'} billing selected. Prices and checkout links updated.`;
      }
      positionThumb();
    }

    opts.forEach(opt => opt.addEventListener('click', () => {
      const period = opt.dataset.period === 'annual' ? 'annual' : 'monthly';
      if (period === currentPeriod) return;
      apply(period, true);
      emitLandingEvent('billing_period_change', { period });
    }));

    // Catalogue live (source unique billing_prices, servie par norva-revolut
    // /prices) : la landing affiche les MÊMES prix effectifs et promos que la
    // page de vente — une promo en cours ne doit jamais être invisible sur la
    // vitrine. Les valeurs statiques du HTML restent le repli hors-ligne.
    (function loadLivePrices() {
      const api = (window.NORVA_API_BASE || 'https://api.norva.tv').replace(/\/+$/, '');
      fetch(`${api}/functions/v1/norva-revolut/prices`)
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          if (!d || !d.ok || !d.prices) return;
          prices.forEach(price => {
            const pl = d.prices[planOfPrice(price)];
            if (!pl || !pl.monthly || !pl.annual) return;
            price.dataset.monthly = (pl.monthly / 100).toFixed(2);
            price.dataset.annual = (pl.annual / 100).toFixed(2);
            // Les mentions légales sous la carte portent le prix réellement
            // facturé — et pour une promo « N premières périodes », l'après-promo
            // en toutes lettres (« for your first 3 months, then US$4.99/month »).
            const terms = price.parentElement?.querySelector('.pricing-terms');
            if (terms) {
              // Version d'origine mémorisée : si la promo expire pendant la
              // visite, expirePromosNow() re-dérive les mentions du prix de
              // base à partir du texte statique, pas du texte déjà réécrit.
              if (!terms.dataset.monthlyTermsOrig && terms.dataset.monthlyTerms) terms.dataset.monthlyTermsOrig = terms.dataset.monthlyTerms;
              if (!terms.dataset.annualTermsOrig && terms.dataset.annualTerms) terms.dataset.annualTermsOrig = terms.dataset.annualTerms;
              const promoOf = per => (d.promos && d.promos[planOfPrice(price)] && d.promos[planOfPrice(price)][per]) || null;
              const pm = promoOf('monthly');
              const pa = promoOf('annual');
              if (terms.dataset.monthlyTerms) {
                const eff = `US$${(pl.monthly / 100).toFixed(2)}`;
                terms.dataset.monthlyTerms = (pm && pm.cycles)
                  ? terms.dataset.monthlyTerms.replace(/US\$[0-9]+(?:\.[0-9]+)?\/month until canceled/,
                      `${eff}/month for your first ${pm.cycles === 1 ? 'month' : pm.cycles + ' months'}, then US$${(pm.base_cents / 100).toFixed(2)}/month until canceled`)
                  : terms.dataset.monthlyTerms.replace(/US\$[0-9]+(?:\.[0-9]+)?/, eff);
              }
              if (terms.dataset.annualTerms) {
                const eff = `US$${(pl.annual / 100).toFixed(2)}`;
                terms.dataset.annualTerms = (pa && pa.cycles)
                  ? terms.dataset.annualTerms.replace(/US\$[0-9]+(?:\.[0-9]+)?\/year until canceled/,
                      `${eff}/year for your first ${pa.cycles === 1 ? 'year' : pa.cycles + ' years'}, then US$${(pa.base_cents / 100).toFixed(2)}/year until canceled`)
                  : terms.dataset.annualTerms.replace(/US\$[0-9]+(?:\.[0-9]+)?/, eff);
              }
            }
          });
          livePromos = d.promos || null;
          refreshToggleSaveBadge();
          apply(currentPeriod, false);
          startPromoCountdown();
        })
        .catch(() => { /* prix statiques conservés */ });
    })();

    // Badge « Save X% » du toggle annuel : recalculé depuis les prix affichés
    // (datasets), donc juste aussi bien en promo qu'après son expiration.
    function refreshToggleSaveBadge() {
      const saveBadge = document.querySelector('.billing-toggle .save-badge');
      if (!saveBadge) return;
      let best = 0;
      prices.forEach(price => {
        const m = Number.parseFloat(String(price.dataset.monthly || '').replace(',', '.'));
        const a = Number.parseFloat(String(price.dataset.annual || '').replace(',', '.'));
        if (m > 0 && a > 0) best = Math.max(best, 1 - a / (12 * m));
      });
      if (best > 0.01) saveBadge.textContent = `Save ${Math.round(best * 100)}%`;
    }

    // Compte à rebours RÉEL jusqu'à la fin de la promo la plus proche —
    // l'instant exact où le serveur l'auto-désactive (promo_ends_at). Jamais un
    // faux timer qui se réinitialise (dark pattern sanctionné). Chip verre
    // fumé sous le toggle, aux couleurs de l'événement ; coral + pulsation
    // sous une heure ; à zéro la vitrine revient d'elle-même aux prix de base.
    let countdownTimer = 0;
    function startPromoCountdown() {
      clearInterval(countdownTimer);
      const old = document.getElementById('promo-countdown');
      if (old) old.remove();
      if (!livePromos || !toggleGroup) return;
      let soonest = null, soonestPromo = null;
      Object.keys(livePromos).forEach(pl => {
        Object.keys(livePromos[pl] || {}).forEach(per => {
          const p = livePromos[pl][per];
          if (!p || !p.ends_at) return;
          const t = new Date(p.ends_at).getTime();
          if (Number.isFinite(t) && t > Date.now() && (soonest === null || t < soonest)) { soonest = t; soonestPromo = p; }
        });
      });
      if (!soonest) return; // promo sans échéance → pas de compte à rebours
      const box = document.createElement('div');
      box.id = 'promo-countdown';
      const ev = document.createElement('span');
      ev.className = 'cd-ev';
      const cdLabel = (soonestPromo.label && String(soonestPromo.label).trim()) || PROMO_LABELS[soonestPromo.event] || PROMO_LABELS.other;
      ev.textContent = `${PROMO_ICONS[soonestPromo.event] || PROMO_ICONS.other} ${cdLabel}`;
      ev.style.background = PROMO_BADGE_BG[soonestPromo.event] || PROMO_BADGE_BG.other;
      const txt = document.createElement('span');
      txt.textContent = 'ends in';
      const clock = document.createElement('b');
      box.appendChild(ev);
      box.appendChild(txt);
      box.appendChild(clock);
      toggleGroup.insertAdjacentElement('afterend', box);
      const pad = x => String(x).padStart(2, '0');
      const tick = () => {
        const left = soonest - Date.now();
        if (left <= 0) {
          clearInterval(countdownTimer);
          box.remove();
          expirePromosNow();
          return;
        }
        const d2 = Math.floor(left / 86400000);
        const h = Math.floor(left / 3600000) % 24;
        const m = Math.floor(left / 60000) % 60;
        const s = Math.floor(left / 1000) % 60;
        clock.textContent = (d2 > 0 ? d2 + 'd ' : '') + pad(h) + ':' + pad(m) + ':' + pad(s);
        box.classList.toggle('urgent', left < 3600000);
      };
      tick();
      countdownTimer = setInterval(tick, 1000);
    }

    // À zéro : retour honnête aux prix de base sans rechargement — le serveur
    // a déjà basculé de son côté (auto-désactivation à promo_ends_at).
    function expirePromosNow() {
      if (!livePromos) return;
      prices.forEach(price => {
        const pl = planOfPrice(price);
        const terms = price.parentElement?.querySelector('.pricing-terms');
        ['monthly', 'annual'].forEach(per => {
          const p = livePromos && livePromos[pl] && livePromos[pl][per];
          if (!p || !p.base_cents) return;
          const base = (p.base_cents / 100).toFixed(2);
          if (per === 'annual') price.dataset.annual = base; else price.dataset.monthly = base;
          if (terms) {
            const key = per === 'monthly' ? 'monthlyTerms' : 'annualTerms';
            const orig = terms.dataset[key + 'Orig'];
            if (orig) terms.dataset[key] = orig.replace(/US\$[0-9]+(?:\.[0-9]+)?/, `US$${base}`);
          }
        });
      });
      livePromos = null;
      refreshToggleSaveBadge();
      apply(currentPeriod, false);
    }

    planCtas.forEach(link => {
      link.addEventListener('click', () => {
        const eventData = {
          plan: link.dataset.plan || 'unknown',
          period: currentPeriod,
          source: 'pricing',
          authenticated: signedIn
        };
        emitLandingEvent('plan_cta', eventData);
        if (!signedIn) emitLandingEvent('signup_started', eventData);
      });
    });

    const initial = opts.find(opt => opt.getAttribute('aria-pressed') === 'true')?.dataset.period;
    apply(initial === 'annual' ? 'annual' : 'monthly', false);
  }

  function setupScrollReveal() {
    const html = document.documentElement;
    // The hero is pre-hidden before first paint by the inline <head> script
    // (html.reveal-armed) so it can never flash in then re-hide when this deferred
    // script runs. Whichever branch we take below, we release that pre-hide: its
    // job is either handed off to `.reveal-ready .scroll-reveal` (an identical
    // hidden state → zero visual jump) or simply dropped so nothing stays hidden.
    const disarm = () => html.classList.remove('reveal-armed');
    document.querySelectorAll('.hero-content, .hero-visual').forEach(element => {
      element.classList.remove(
        'scroll-reveal', 'reveal-left', 'reveal-right', 'reveal-up', 'reveal-soft'
      );
      element.classList.add('is-visible');
      element.style.removeProperty('--reveal-delay');
    });
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

  function setupContextGuide() {
    const root = document.querySelector('[data-norva-guide]');
    if (!root) return;

    const card = root.querySelector('.norva-guide__card');
    const compact = root.querySelector('[data-guide-compact]');
    const launcher = root.querySelector('[data-guide-launcher]');
    const minimize = root.querySelector('[data-guide-minimize]');
    const dismiss = root.querySelector('[data-guide-dismiss]');
    const pause = root.querySelector('[data-guide-pause]');
    const next = root.querySelector('[data-guide-next]');
    const guideControls = pause?.parentElement || null;
    const title = root.querySelector('[data-guide-title]');
    const compactTitle = root.querySelector('[data-guide-compact-title]');
    const message = root.querySelector('[data-guide-message]');
    const contextLabel = root.querySelector('[data-guide-context-label]');
    const cta = root.querySelector('[data-guide-cta]');
    const ctaLabel = root.querySelector('[data-guide-cta-label]');
    const status = root.querySelector('[data-guide-status]');
    const previewTriggers = Array.from(document.querySelectorAll('[data-guide-preview]'));
    const previewLinks = Array.from(document.querySelectorAll('a[href="#product-preview"]'));
    const sections = Array.from(document.querySelectorAll('[data-guide-context]'));
    if (!card || !compact || !launcher || !title || !compactTitle || !message || !cta || !ctaLabel) return;

    const STORAGE_KEY = 'norva-context-guide:v1';
    const REVEAL_DELAY = 5500;
    const ROTATION_DELAY = 9000;
    const AUTO_COMPACT_DELAY = 7600;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const messages = {
      hero: [
        {
          id: 'available-now', label: 'Available now', title: 'Norva is available now',
          body: 'Use Norva on the Web, mobile and TV with one synchronized account.',
          cta: 'See supported screens', href: '#availability'
        },
        {
          id: 'one-space', label: 'One experience', title: 'One Norva space, every screen',
          body: 'Keep your catalog, progress, favorites and preferences together across supported devices.',
          cta: 'Explore the benefits', href: '#features'
        }
      ],
      availability: [
        {
          id: 'apps-ready', label: 'Ready on your screens', title: 'Web, mobile and TV are ready',
          body: 'The Norva experience is available now across supported Web, mobile and TV devices.',
          cta: 'See how it stays in sync', href: '#features'
        },
        {
          id: 'same-account', label: 'One account', title: 'Move between screens naturally',
          body: 'Your account keeps the same catalog, progress and preferences wherever you use Norva.',
          cta: 'See the simple setup', href: '#how-it-works'
        }
      ],
      features: [
        {
          id: 'continue-anywhere', label: 'Cross-screen continuity', title: 'Pick up on another screen',
          body: 'Resume from the same progress with the favorites and preferences already in your Norva space.',
          cta: 'See the three steps', href: '#how-it-works'
        },
        {
          id: 'organized-catalog', label: 'Less searching', title: 'A calmer way to browse',
          body: 'Norva organizes the compatible source you connect into one consistent media experience.',
          cta: 'See how Norva works', href: '#how-it-works'
        }
      ],
      steps: [
        {
          id: 'three-steps', label: 'Simple setup', title: 'Your Norva space in three steps',
          body: 'Create your space, connect a compatible source and start watching across supported screens.',
          cta: 'Compare the plans', href: '#pricing'
        },
        {
          id: 'source-control', label: 'You stay in control', title: 'Your compatible source stays yours',
          body: 'Norva provides the software experience while you remain in control of the source you connect.',
          cta: 'Read the clear promise', href: '#trust'
        }
      ],
      preview: [
        {
          id: 'guide-follows', label: 'Guided product tour', title: 'This guide follows your journey',
          body: 'Its message changes with the part of Norva you are exploring, then it folds away when space matters.',
          cta: 'Continue to pricing', href: '#pricing'
        },
        {
          id: 'guide-control', label: 'Always under your control', title: 'Pause, minimize or reopen it',
          body: 'The guide stays available during the scroll without pretending to be a system notification.',
          cta: 'See the trial options', href: '#pricing'
        }
      ],
      pricing: [
        {
          id: 'trial-terms', label: 'Clear trial terms', title: 'Start with a 7-day free trial',
          body: 'Payment method required. We remind you before renewal, and you can cancel anytime.',
          cta: 'Start my 7-day free trial', href: '/account.html?returnTo=%2Fapp%23home', action: 'signup'
        }
      ],
      trust: [
        {
          id: 'clear-role', label: 'A clear service', title: 'Know exactly what Norva does',
          body: 'Your subscription covers the interface, organization, playback and synchronization features.',
          cta: 'Review the service scope', href: '#trust'
        },
        {
          id: 'account-control', label: 'Account controls', title: 'EU-hosted account data',
          body: 'Access or delete your account data with privacy controls designed around GDPR requirements.',
          cta: 'Read the FAQ', href: '#faq'
        }
      ],
      faq: [
        {
          id: 'answers-ready', label: 'Before you start', title: 'Answers are close at hand',
          body: 'Review billing, compatible sources, account controls and device availability in the FAQ.',
          cta: 'Browse the questions', href: '#faq'
        }
      ],
      final: [
        {
          id: 'ready-to-start', label: 'Ready when you are', title: 'Bring every screen together',
          body: 'Create your Norva space and begin with a 7-day free trial.',
          cta: 'Start my 7-day free trial', href: '/account.html?returnTo=%2Fapp%23home', action: 'signup'
        }
      ]
    };

    let saved = {};
    try {
      saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch (_) {}
    const validModes = new Set(['expanded', 'compact', 'dismissed']);
    const hasSavedMode = validModes.has(saved.mode);
    // Expanded is an intentional, temporary state. Returning visitors start
    // compact so the guide stays useful without reopening over the page.
    let mode = hasSavedMode && saved.mode !== 'expanded'
      ? saved.mode
      : 'compact';
    let currentContext = 'hero';
    let currentIndex = 0;
    let visible = false;
    let userPaused = false;
    let pointerPaused = false;
    let focusPaused = false;
    let manuallyExpanded = false;
    let obstructed = false;
    let obstructionOverride = false;
    let pendingContext = '';
    let rotationTimer = 0;
    let compactTimer = 0;
    let revealTimer = 0;
    let viewTimer = 0;
    let impressionSent = false;
    const seenMessages = new Set(Array.isArray(saved.seenMessages) ? saved.seenMessages.slice(0, 30) : []);

    const persist = () => {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
          version: 1,
          mode,
          seenMessages: Array.from(seenMessages).slice(-30)
        }));
      } catch (_) {}
    };

    const activeMessages = () => messages[currentContext] || messages.hero;
    const activeMessage = () => activeMessages()[currentIndex] || activeMessages()[0];
    const effectiveMode = () => (obstructed || currentContext === 'pricing') && !obstructionOverride
      ? 'dismissed' : mode;
    const setInert = (element, inactive) => {
      if (!element) return;
      element.inert = Boolean(inactive);
      element.setAttribute('aria-hidden', String(Boolean(inactive)));
    };

    const stopRotation = () => {
      if (rotationTimer) window.clearTimeout(rotationTimer);
      rotationTimer = 0;
    };

    const stopAutoCompact = () => {
      if (compactTimer) window.clearTimeout(compactTimer);
      compactTimer = 0;
    };

    const canRotate = () => visible && effectiveMode() === 'expanded' && activeMessages().length > 1 &&
      !motion.matches && !userPaused && !pointerPaused && !focusPaused && !document.hidden &&
      !document.body.classList.contains('nav-menu-open');

    const scheduleMessageView = () => {
      if (viewTimer) window.clearTimeout(viewTimer);
      const item = activeMessage();
      if (!visible || effectiveMode() === 'dismissed' || seenMessages.has(item.id)) return;
      viewTimer = window.setTimeout(() => {
        if (document.hidden || effectiveMode() === 'dismissed' || activeMessage().id !== item.id) return;
        seenMessages.add(item.id);
        persist();
        emitLandingEvent('context_widget_message_view', {
          section: currentContext,
          message_id: item.id,
          state: effectiveMode()
        });
      }, 1000);
    };

    const updatePauseControl = () => {
      const hasMultiple = activeMessages().length > 1;
      if (guideControls) guideControls.hidden = !hasMultiple;
      if (next) next.hidden = !hasMultiple;
      if (!pause) return;
      pause.hidden = motion.matches || !hasMultiple;
      pause.setAttribute('aria-pressed', String(userPaused));
      pause.setAttribute('aria-label', userPaused ? 'Resume guide updates' : 'Pause guide updates');
      pause.textContent = userPaused ? 'Resume updates' : 'Pause updates';
    };

    const resolveAction = item => {
      if (item.action === 'signup' && signedIn) {
        return { label: 'Open Norva', href: '/app#home', target: 'app' };
      }
      if (item.action === 'signup') {
        return { label: item.cta, href: decorateConversionHref(item.href), target: 'account' };
      }
      return { label: item.cta, href: item.href, target: (item.href || '').replace(/^#/, '') || 'landing' };
    };

    const renderMessage = (announce, reason) => {
      const item = activeMessage();
      const action = resolveAction(item);
      title.textContent = item.title;
      compactTitle.textContent = item.title;
      message.textContent = item.body;
      if (contextLabel) contextLabel.textContent = item.label;
      ctaLabel.textContent = action.label;
      cta.setAttribute('href', action.href);
      cta.dataset.guideTarget = action.target;
      root.dataset.guideContext = currentContext;
      root.dataset.guideMessage = item.id;
      updatePauseControl();
      if (announce && status) status.textContent = `${item.title}. ${item.body}`;
      if (reason && ['next', 'preview_button', 'preview_link'].includes(reason)) {
        emitLandingEvent('context_widget_action', {
          interaction: reason,
          section: currentContext,
          message_id: item.id,
          position: currentIndex + 1,
          state: effectiveMode()
        });
      }
      scheduleMessageView();
    };

    const scheduleRotation = () => {
      stopRotation();
      if (!canRotate()) return;
      rotationTimer = window.setTimeout(() => {
        currentIndex = (currentIndex + 1) % activeMessages().length;
        renderMessage(false, 'automatic');
        scheduleRotation();
      }, ROTATION_DELAY);
    };

    const renderMode = () => {
      const shownMode = effectiveMode();
      const activeElement = document.activeElement;
      const hiddenFocus = shownMode !== 'expanded' && card.contains(activeElement);
      card.hidden = shownMode !== 'expanded';
      compact.hidden = shownMode !== 'compact';
      launcher.hidden = shownMode !== 'dismissed';
      setInert(card, card.hidden);
      setInert(compact, compact.hidden);
      setInert(launcher, launcher.hidden);
      root.dataset.state = shownMode;
      minimize?.setAttribute('aria-expanded', String(shownMode === 'expanded'));
      compact.setAttribute('aria-expanded', String(shownMode === 'expanded'));
      launcher.setAttribute('aria-expanded', String(shownMode === 'expanded'));
      previewTriggers.forEach(trigger => trigger.setAttribute('aria-expanded', String(shownMode === 'expanded')));
      if (hiddenFocus) {
        window.requestAnimationFrame(() => (shownMode === 'compact' ? compact : launcher).focus({ preventScroll: true }));
      }
      if (shownMode === 'expanded') scheduleRotation();
      else stopRotation();
      scheduleMessageView();
    };

    const setMode = (nextMode, options) => {
      const settings = options || {};
      if (!validModes.has(nextMode)) return;
      mode = nextMode;
      if (settings.manual) manuallyExpanded = nextMode === 'expanded';
      stopAutoCompact();
      persist();
      renderMode();
      if (settings.announce && status) {
        status.textContent = nextMode === 'expanded' ? 'Norva guide expanded.'
          : nextMode === 'compact' ? 'Norva guide minimized.' : 'Norva guide reduced to its icon.';
      }
      if (settings.interaction) {
        emitLandingEvent('context_widget_action', {
          interaction: settings.interaction,
          section: currentContext,
          message_id: activeMessage().id,
          state: nextMode
        });
      }
      if (settings.focus) {
        const target = nextMode === 'expanded' ? minimize : nextMode === 'compact' ? compact : launcher;
        window.requestAnimationFrame(() => target?.focus({ preventScroll: true }));
      }
    };

    const scheduleAutoCompact = () => {
      stopAutoCompact();
      if (!visible || mode !== 'expanded' || manuallyExpanded || motion.matches || pointerPaused || focusPaused) return;
      compactTimer = window.setTimeout(() => {
        if (mode !== 'expanded' || manuallyExpanded || pointerPaused || focusPaused) return;
        setMode('compact', { interaction: 'automatic_minimize' });
      }, AUTO_COMPACT_DELAY);
    };

    const reveal = options => {
      const settings = options || {};
      if (revealTimer) window.clearTimeout(revealTimer);
      window.removeEventListener('scroll', revealOnScroll);
      if (settings.expand) {
        mode = 'expanded';
        manuallyExpanded = Boolean(settings.manual);
        persist();
      }
      if (!visible) {
        visible = true;
        root.hidden = false;
        window.requestAnimationFrame(() => root.classList.add('is-visible'));
      }
      renderMode();
      renderMessage(false, settings.reason || 'reveal');
      scheduleRotation();
      scheduleAutoCompact();
      if (!impressionSent) {
        impressionSent = true;
        emitLandingEvent('context_widget_impression', {
          section: currentContext,
          message_id: activeMessage().id,
          state: effectiveMode()
        });
      }
      if (settings.focus) window.requestAnimationFrame(() => minimize?.focus({ preventScroll: true }));
    };

    const applyContext = context => {
      if (!messages[context] || context === currentContext) return;
      if (pointerPaused || focusPaused) {
        pendingContext = context;
        return;
      }
      pendingContext = '';
      currentContext = context;
      currentIndex = 0;
      obstructionOverride = false;
      renderMessage(false, 'context_change');
      renderMode();
      scheduleRotation();
      if ((context === 'pricing' || context === 'faq') && mode === 'expanded' && !manuallyExpanded) {
        setMode('compact', { interaction: 'conversion_area_minimize' });
      }
    };

    const flushPendingContext = () => {
      if (!pendingContext || pointerPaused || focusPaused) return;
      const nextContext = pendingContext;
      pendingContext = '';
      applyContext(nextContext);
    };

    const revealOnScroll = () => {
      if (visible) return;
      if ((window.scrollY || window.pageYOffset || 0) < window.innerHeight * 0.18) return;
      reveal({ reason: 'scroll_threshold' });
    };

    minimize?.addEventListener('click', () => setMode('compact', {
      manual: true, announce: true, focus: true, interaction: 'minimize'
    }));
    dismiss?.addEventListener('click', () => setMode('dismissed', {
      manual: true, announce: true, focus: true, interaction: 'reduce_to_icon'
    }));
    compact.addEventListener('click', () => {
      obstructionOverride = true;
      setMode('expanded', { manual: true, announce: true, focus: true, interaction: 'expand' });
    });
    launcher.addEventListener('click', () => {
      obstructionOverride = true;
      setMode('expanded', { manual: true, announce: true, focus: true, interaction: 'reopen' });
    });
    pause?.addEventListener('click', () => {
      userPaused = !userPaused;
      updatePauseControl();
      if (userPaused) stopRotation();
      else scheduleRotation();
      if (status) status.textContent = userPaused ? 'Guide updates paused.' : 'Guide updates resumed.';
      emitLandingEvent('context_widget_action', {
        interaction: userPaused ? 'pause' : 'resume',
        section: currentContext,
        message_id: activeMessage().id,
        state: effectiveMode()
      });
    });
    next?.addEventListener('click', () => {
      const list = activeMessages();
      currentIndex = (currentIndex + 1) % list.length;
      renderMessage(true, 'next');
      scheduleRotation();
    });
    cta.addEventListener('click', () => {
      const item = activeMessage();
      emitLandingEvent('context_widget_cta', {
        cta: ctaLabel.textContent.trim(),
        target: cta.dataset.guideTarget || 'landing',
        section: currentContext,
        message_id: item.id,
        authenticated: signedIn
      });
      if (item.action === 'signup' && !signedIn) {
        emitLandingEvent('signup_started', {
          source: 'context_widget',
          cta: ctaLabel.textContent.trim(),
          target: 'account',
          authenticated: false
        });
      }
    });

    previewTriggers.forEach(trigger => trigger.addEventListener('click', () => {
      reveal({ expand: true, manual: true, focus: true, reason: 'preview_button' });
    }));
    previewLinks.forEach(link => link.addEventListener('click', () => {
      window.setTimeout(() => reveal({ expand: true, manual: true, reason: 'preview_link' }), 380);
    }));

    root.addEventListener('pointerenter', () => {
      pointerPaused = true;
      stopRotation();
      stopAutoCompact();
    });
    root.addEventListener('pointerleave', () => {
      pointerPaused = false;
      flushPendingContext();
      scheduleRotation();
      scheduleAutoCompact();
    });
    root.addEventListener('focusin', () => {
      focusPaused = true;
      stopRotation();
      stopAutoCompact();
    });
    root.addEventListener('focusout', event => {
      if (event.relatedTarget && root.contains(event.relatedTarget)) return;
      focusPaused = false;
      flushPendingContext();
      scheduleRotation();
      scheduleAutoCompact();
    });
    root.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || effectiveMode() !== 'expanded') return;
      event.preventDefault();
      setMode('compact', { manual: true, announce: true, focus: true, interaction: 'escape_minimize' });
    });

    if ('IntersectionObserver' in window && sections.length) {
      const intersecting = new Set();
      const contextObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) intersecting.add(entry.target);
          else intersecting.delete(entry.target);
        });
        if (!intersecting.size) return;
        const marker = window.innerHeight * 0.4;
        const candidates = Array.from(intersecting).sort((a, b) =>
          Math.abs(a.getBoundingClientRect().top - marker) - Math.abs(b.getBoundingClientRect().top - marker)
        );
        applyContext(candidates[0].dataset.guideContext);
      }, { rootMargin: '-28% 0px -60% 0px', threshold: [0, 0.01] });
      sections.forEach(section => contextObserver.observe(section));

      const blockers = [document.querySelector('.final-cta'), document.querySelector('.landing-footer')].filter(Boolean);
      const obstructing = new Set();
      const obstructionObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) obstructing.add(entry.target);
          else obstructing.delete(entry.target);
        });
        const nextObstructed = obstructing.size > 0;
        if (nextObstructed === obstructed) return;
        obstructed = nextObstructed;
        if (!obstructed) obstructionOverride = false;
        root.dataset.obstructed = String(obstructed);
        renderMode();
      }, { threshold: 0.08 });
      blockers.forEach(blocker => obstructionObserver.observe(blocker));
    }

    const navStateObserver = new MutationObserver(() => {
      const menuOpen = document.body.classList.contains('nav-menu-open');
      root.inert = menuOpen;
      root.toggleAttribute('inert', menuOpen);
      if (menuOpen) root.setAttribute('aria-hidden', 'true');
      else root.removeAttribute('aria-hidden');
      if (menuOpen) stopRotation();
      else scheduleRotation();
    });
    navStateObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    const onMotionChange = () => {
      updatePauseControl();
      if (motion.matches) {
        stopRotation();
        stopAutoCompact();
      } else {
        scheduleRotation();
        scheduleAutoCompact();
      }
    };
    if (motion.addEventListener) motion.addEventListener('change', onMotionChange);
    else motion.addListener(onMotionChange);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopRotation();
      else scheduleRotation();
    });

    updatePauseControl();
    renderMessage(false, 'initial');
    window.addEventListener('scroll', revealOnScroll, { passive: true });
    revealTimer = window.setTimeout(() => reveal({ reason: 'delay' }),
      hasSavedMode ? 900 : REVEAL_DELAY);
  }

  function setupFunnelInstrumentation() {
    emitLandingEvent('landing_view', { authenticated: signedIn });

    const targetFor = link => {
      const href = link.getAttribute('href') || '';
      if (href.startsWith('#')) return href.slice(1) || 'top';
      if (href.includes('/subscribe.html') || link.matches('[data-plan]')) return 'subscribe';
      if (href.includes('/account.html')) return 'account';
      if (href.includes('/app')) return 'app';
      return 'internal';
    };

    document.querySelectorAll('.hero-actions a').forEach((link, index) => {
      link.addEventListener('click', () => emitLandingEvent('hero_cta', {
        cta: link.textContent.trim().replace(/\s+/g, ' '),
        target: targetFor(link),
        position: index + 1,
        authenticated: signedIn
      }));
    });

    document.querySelectorAll('.landing-nav .nav-cta, .landing-nav .login-link').forEach((link, index) => {
      link.addEventListener('click', () => emitLandingEvent('nav_cta', {
        cta: link.textContent.trim().replace(/\s+/g, ' '),
        target: targetFor(link),
        position: index + 1,
        authenticated: signedIn
      }));
    });

    if (!signedIn) {
      document.querySelectorAll('a[data-auth-action], a[href*="/account.html"]:not([data-plan])').forEach(link => {
        if (link.matches('[data-plan]')) return;
        link.addEventListener('click', () => emitLandingEvent('signup_started', {
          source: link.closest('.landing-nav') ? 'navigation'
            : link.closest('.hero-section') ? 'hero'
              : link.closest('.final-cta') ? 'final_cta'
                : link.closest('.landing-footer') ? 'footer' : 'landing',
          cta: link.textContent.trim().replace(/\s+/g, ' '),
          target: 'account',
          authenticated: false
        }));
      });
    }

    document.addEventListener('click', event => {
      const control = event.target.closest('[data-demo-interaction]');
      if (!control) return;
      emitLandingEvent('demo_interaction', {
        interaction: control.dataset.demoInteraction || control.getAttribute('aria-label') || 'activate',
        target: control.dataset.demoTarget || control.closest('[data-demo]')?.dataset.demo || 'product_demo'
      });
    });

    const pricing = document.querySelector('.pricing-section');
    if (!pricing) return;
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        emitLandingEvent('pricing_view');
        observer.disconnect();
      }, { threshold: 0.25 });
      observer.observe(pricing);
    } else {
      let seen = false;
      const check = () => {
        if (seen) return;
        const rect = pricing.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.75 && rect.bottom > 0) {
          seen = true;
          emitLandingEvent('pricing_view');
          window.removeEventListener('scroll', check);
        }
      };
      window.addEventListener('scroll', check, { passive: true });
      check();
    }
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

  setupSessionAwareLinks();
  setupMobileNavigation();
  setupAccessibleFaq();
  setupBillingToggle();
  setupContextGuide();
  setupFunnelInstrumentation();
  setupScrollReveal();
  setupDeviceTilt();
})();