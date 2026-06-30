/* Norva — discreet premium starfield.
 *
 * A single full-viewport canvas painted BEHIND all content (z-index:-1) so the
 * page's glass cards frost it through their backdrop-filter. Stars twinkle
 * slowly and out of phase, with light scroll-parallax for depth and a few
 * brighter "glints". Additive blending keeps it subtle over the dark gradient.
 *
 * Cheap and considerate: DPR-capped, star count scaled to viewport area,
 * paused when the tab is hidden, and fully static under prefers-reduced-motion.
 *
 * Star positions are stored as viewport fractions (0..1) and seeded ONCE, so a
 * resize only rescales the field — it never reshuffles. That matters on mobile:
 * iOS Safari fires `resize` whenever its toolbar collapses/expands during
 * scroll, and a reshuffle there would be very visible.
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

    var canvas = document.createElement('canvas');
    canvas.className = 'norva-stars';
    canvas.setAttribute('aria-hidden', 'true');
    // Essentials inline so the field works even if the CSS rule is missing.
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

    var dpr = 1, W = 0, H = 0, stars = [], glints = [], raf = 0;
    var scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    var running = false;

    function rand(a, b) { return a + Math.random() * (b - a); }

    // Resize the backing store to the viewport. Does NOT touch the star data,
    // so it is safe to call on every resize (incl. mobile toolbar churn).
    function fit() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Generate the field once. Positions are fractions of the viewport.
    function seed() {
      var count = Math.max(36, Math.min(220, Math.round((W * H) / 9200)));
      stars = [];
      for (var i = 0; i < count; i++) {
        var depth = Math.random(); // 0 = far, 1 = near
        stars.push({
          nx: Math.random(),
          ny: Math.random(),
          r: rand(0.4, 1.4) * (0.7 + depth * 0.6),
          base: rand(0.10, 0.42) * (0.55 + depth * 0.6),
          amp: rand(0.25, 0.6),
          sp: rand(0.35, 1.25),
          ph: rand(0, 6.2832),
          par: 0.012 + depth * 0.055,
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
          par: 0.035 + Math.random() * 0.05,
          tint: Math.random() < 0.5
        });
      }
    }

    function wrap(y, span) {
      y = y % span;
      if (y < 0) y += span;
      return y - 100;
    }

    function draw(t) {
      if (!running) return;
      var time = t * 0.001, sc = scrollY, spanS = H + 200, i, st, a, x, y;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';

      for (i = 0; i < stars.length; i++) {
        st = stars[i];
        a = st.base + st.amp * st.base * Math.sin(time * st.sp + st.ph);
        if (a <= 0.012) continue;
        y = wrap(st.ny * spanS - sc * st.par, spanS);
        ctx.beginPath();
        ctx.fillStyle = (st.tint ? 'rgba(150,196,255,' : 'rgba(255,255,255,') + Math.min(0.78, a) + ')';
        ctx.arc(st.nx * W, y, st.r, 0, 6.2832);
        ctx.fill();
      }

      for (i = 0; i < glints.length; i++) {
        st = glints[i];
        a = st.base + st.amp * st.base * Math.sin(time * st.sp + st.ph);
        if (a <= 0.02) continue;
        x = st.nx * W;
        y = wrap(st.ny * spanS - sc * st.par, spanS);
        var col = st.tint ? '120,210,255' : '255,255,255';
        var halo = st.r * 6;
        var g = ctx.createRadialGradient(x, y, 0, x, y, halo);
        g.addColorStop(0, 'rgba(' + col + ',' + Math.min(0.85, a) + ')');
        g.addColorStop(0.45, 'rgba(' + col + ',' + Math.min(0.3, a * 0.35) + ')');
        g.addColorStop(1, 'rgba(' + col + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, halo, 0, 6.2832);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = (st.tint ? 'rgba(150,210,255,' : 'rgba(255,255,255,') + Math.min(0.92, a) + ')';
        ctx.arc(x, y, st.r * 0.7, 0, 6.2832);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
      raf = window.requestAnimationFrame(draw);
    }

    function drawStatic() {
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < stars.length; i++) {
        var st = stars[i];
        ctx.beginPath();
        ctx.fillStyle = (st.tint ? 'rgba(150,196,255,' : 'rgba(255,255,255,') + Math.min(0.55, st.base + st.amp * st.base * 0.5) + ')';
        ctx.arc(st.nx * W, st.ny * H, st.r, 0, 6.2832);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function start() {
      window.cancelAnimationFrame(raf);
      if (motionQuery.matches) { running = false; drawStatic(); return; }
      running = true;
      raf = window.requestAnimationFrame(draw);
    }

    function stop() {
      running = false;
      window.cancelAnimationFrame(raf);
    }

    window.addEventListener('scroll', function () {
      scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    }, { passive: true });

    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        fit(); // rescale only — fractional star positions are preserved
        if (motionQuery.matches) drawStatic();
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
