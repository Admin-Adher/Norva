(() => {
  'use strict';

  const root = document.documentElement;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const motionEnabled = !reducedMotion.matches && !root.classList.contains('norva-lite');

  if (window.__norvaPremiumRevealFallback) {
    window.clearTimeout(window.__norvaPremiumRevealFallback);
    delete window.__norvaPremiumRevealFallback;
  }

  const revealItems = Array.from(document.querySelectorAll('.reveal'));
  if (!motionEnabled || !('IntersectionObserver' in window)) {
    root.classList.remove('premium-motion');
    revealItems.forEach(item => item.classList.add('visible'));
  } else {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      });
    }, {
      threshold: 0.08,
      rootMargin: '0px 0px -6% 0px'
    });

    revealItems.forEach(item => observer.observe(item));
  }

  const particleField = document.querySelector('.particle-field');
  if (particleField && motionEnabled) {
    const fragment = document.createDocumentFragment();
    const particleCount = finePointer.matches ? 28 : 14;

    for (let index = 0; index < particleCount; index += 1) {
      const particle = document.createElement('i');
      particle.style.setProperty('--x', `${(index * 37 + 11) % 100}%`);
      particle.style.setProperty('--y', `${(index * 61 + 7) % 112}%`);
      particle.style.setProperty('--size', `${1 + ((index * 17) % 24) / 10}px`);
      particle.style.setProperty('--duration', `${18 + ((index * 13) % 28)}s`);
      particle.style.setProperty('--delay', `${-((index * 19) % 40)}s`);
      particle.style.setProperty('--drift', `${-42 + ((index * 29) % 84)}px`);
      fragment.appendChild(particle);
    }

    particleField.appendChild(fragment);
  }

  if (finePointer.matches && motionEnabled) {
    document.querySelectorAll('.bento-card').forEach(card => {
      let frame = 0;
      let nextX = 50;
      let nextY = 50;

      card.addEventListener('pointermove', event => {
        const rect = card.getBoundingClientRect();
        nextX = ((event.clientX - rect.left) / rect.width) * 100;
        nextY = ((event.clientY - rect.top) / rect.height) * 100;

        if (frame) return;
        frame = window.requestAnimationFrame(() => {
          card.style.setProperty('--mx', `${nextX}%`);
          card.style.setProperty('--my', `${nextY}%`);
          frame = 0;
        });
      }, { passive: true });

      card.addEventListener('pointerleave', () => {
        card.style.removeProperty('--mx');
        card.style.removeProperty('--my');
      }, { passive: true });
    });
  }
})();
