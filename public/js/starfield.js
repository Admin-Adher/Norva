/* Norva — discreet premium starfield.
 *
 * A single full-viewport canvas painted BEHIND all content (z-index:-1). Stars
 * twinkle slowly and out of phase, with light scroll-parallax for depth and a
 * few brighter "glints". Additive blending keeps it subtle over the dark page.
 *
 * Performance:
 *  - Stars are drawn from a pre-rendered sprite via drawImage (no per-frame
 *    arc()/createRadialGradient()/string allocation).
 *  - On constrained devices (html.norva-lite, set early in <head>) DPR is capped
 *    to 1, fewer stars are used, parallax is off, the loop is throttled to
 *    ~30fps, and rendering PAUSES during scroll so the main thread is free for
 *    a smooth scroll (parallax is off there, so nothing visible is lost).
 *  - Paused when the tab is hidden; fully static under prefers-reduced-motion.
 *  - Positions are viewport fractions seeded ONCE, so a resize only rescales.
 */
(function () {
  'use strict';

  if (!document.body) {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  function init() {
    var motionQuery = window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : { matches: false, addEventListener: function () {}, addListener: function () {} };

    // "lite" is decided in the <head> inline script (html.norva-lite); fall back
    // to a local check so the field still behaves if that script didn't run.
    var coarse = false;
    try {
      coarse = document.documentElement.classList.contains('norva-lite') ||
        (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
        Math.min(window.innerWidth, window.innerHeight) <= 1024;
    } catch (e) { coarse = window.innerWidth <= 1024; }

    var DPR_CAP = coarse ? 1 : 2;
    var DENSITY = coarse ? 16000 : 9200; // larger = fewer stars
    var PARALLAX = coarse ? 0 : 1;       // no scroll-coupled redraw on touch
    var FRAME_MIN = coarse ? 32 : 0;     // ~30fps cap on constrained devices

    var canvas = document.createElement('canvas');
    canvas.className = 'norva-stars';
    canvas.setAttribute('aria-hidden', 'true');
    var cs = canvas.style;
    cs.position = 'fixed';
    cs.top = cs.left = '0';
    cs.width = '100%';
    cs.height = '100%';
    cs.zIndex = '-1';
    cs.pointerEvents = 'none';
    cs.display = 'block';
    document.body.appendChild(canvas);

    var ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    function makeSprite(rgb) {
      var S = 32;
      var c = document.createElement('canvas');
      c.width = c.height = S;
      var g = c.getContext('2d');
      var grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      grd.addColorStop(0, 'rgba(' + rgb + ',1)');
      grd.addColorStop(0.35, 'rgba(' + rgb + ',0.5)');
      grd.addColorStop(1, 'rgba(' + rgb + ',0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, S, S);
      return c;
    }
    var spriteWhite = makeSprite('255,255,255');
    var spriteBlue = makeSprite('150,200,255');

    var dpr = 1, W = 0, H = 0, stars = [], glints = [], raf = 0, lastPaint = 0;
    var scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    var running = false, paused = false;

    function rand(a, b) { return a + Math.random() * (b - a); }

    function fit() {
      dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function seed() {
      var count = Math.max(28, Math.min(coarse ? 110 : 220, Math.round((W * H) / DENSITY)));
      stars = [];
      for (var i = 0; i < count; i++) {
        var depth = Math.random();
        stars.push({
          nx: Math.random(),
          ny: Math.random(),
          r: rand(0.5, 1.5) * (0.7 + depth * 0.6),
          base: rand(0.10, 0.42) * (0.55 + depth * 0.6),
          amp: rand(0.25, 0.6),
          sp: rand(0.35, 1.25),
          ph: rand(0, 6.2832),
          par: (0.012 + depth * 0.055) * PARALLAX,
          tint: Math.random() < 0.18
        });
      }
      glints = [];
      var gc = Math.max(2, Math.round(count / 30));
      for (var j = 0; j < gc; j++) {
        glints.push({
          nx: Math.random(),
          ny: Math.random(),
          r: rand(1.0, 1.7),
          base: rand(0.26, 0.5),
          amp: rand(0.4, 0.7),
          sp: rand(0.45, 1.0),
          ph: rand(0, 6.2832),
          par: (0.035 + Math.random() * 0.05) * PARALLAX,
          tint: Math.random() < 0.5
        });
      }
    }

    function wrap(y, span) {
      y = y % span;
      if (y < 0) y += span;
      return y - 100;
    }

    function paint(twinkle) {
      var time = twinkle ? performance.now() * 0.001 : 0;
      var sc = scrollY, spanS = H + 200, i, st, a, x, y, size;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';

      for (i = 0; i < stars.length; i++) {
        st = stars[i];
        a = twinkle ? st.base + st.amp * st.base * Math.sin(time * st.sp + st.ph) : st.base + st.amp * st.base * 0.5;
        if (a <= 0.012) continue;
        x = st.nx * W;
        y = st.par ? wrap(st.ny * spanS - sc * st.par, spanS) : st.ny * H;
        size = st.r * 5;
        ctx.globalAlpha = a < 0.78 ? a : 0.78;
        ctx.drawImage(st.tint ? spriteBlue : spriteWhite, x - size / 2, y - size / 2, size, size);
      }

      for (i = 0; i < glints.length; i++) {
        st = glints[i];
        a = twinkle ? st.base + st.amp * st.base * Math.sin(time * st.sp + st.ph) : st.base;
        if (a <= 0.02) continue;
        x = st.nx * W;
        y = st.par ? wrap(st.ny * spanS - sc * st.par, spanS) : st.ny * H;
        size = st.r * 11;
        ctx.globalAlpha = a < 0.95 ? a : 0.95;
        ctx.drawImage(st.tint ? spriteBlue : spriteWhite, x - size / 2, y - size / 2, size, size);
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    function loop(now) {
      if (!running || paused) return;
      raf = window.requestAnimationFrame(loop);
      if (FRAME_MIN && now - lastPaint < FRAME_MIN) return;
      lastPaint = now;
      paint(true);
    }

    function start() {
      window.cancelAnimationFrame(raf);
      paused = false;
      if (motionQuery.matches) { running = false; paint(false); return; }
      running = true;
      lastPaint = 0;
      raf = window.requestAnimationFrame(loop);
    }

    function stop() {
      running = false;
      window.cancelAnimationFrame(raf);
    }

    var scrollIdle;
    window.addEventListener('scroll', function () {
      scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
      // On constrained devices, freeze the canvas while scrolling so the main
      // thread is free. Parallax is off there, so nothing visible is lost.
      if (coarse && running && !motionQuery.matches) {
        if (!paused) { paused = true; window.cancelAnimationFrame(raf); }
        clearTimeout(scrollIdle);
        scrollIdle = setTimeout(function () {
          paused = false;
          if (running && !document.hidden) {
            lastPaint = 0;
            raf = window.requestAnimationFrame(loop);
          }
        }, 220);
      }
    }, { passive: true });

    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        fit();
        if (motionQuery.matches) paint(false);
      }, 200);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop();
      else start();
    });

    var onMotionChange = function () { start(); };
    if (motionQuery.addEventListener) motionQuery.addEventListener('change', onMotionChange);
    else if (motionQuery.addListener) motionQuery.addListener(onMotionChange);

    fit();
    seed();
    start();
  }
})();
