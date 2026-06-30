/* Norva — discreet premium starfield.
 *
 * A single full-viewport canvas painted BEHIND all content (z-index:-1) so the
 * page's glass cards frost it through their backdrop-filter. Stars twinkle
 * slowly and out of phase, with light scroll-parallax for depth and a few
 * brighter "glints". Additive blending keeps it subtle over the dark gradient.
 *
 * Cheap and considerate: DPR-capped, star count scaled to viewport area,
 * paused when the tab is hidden, and fully static under prefers-reduced-motion.
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
      : { matches: false, addEventListener: function () {} };

    var canvas = document.createElement('canvas');
    canvas.className = 'norva-stars';
    canvas.setAttribute('aria-hidden', 'true');
    // Essentials inline so the field works even if the CSS rule is missing.
    var s = canvas.style;
    s.position = 'fixed';
    s.top = s.left = '0';
    s.width = '100%';
    s.height = '100%';
    s.zIndex = '-1';
    s.pointerEvents = 'none';
    s.display = 'block';
    document.body.appendChild(canvas);

    var ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    var dpr = 1, W = 0, H = 0, stars = [], glints = [], raf = 0;
    var scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    var running = false;

    function rand(a, b) { return a + Math.random() * (b - a); }

    function build() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      var count = Math.max(36, Math.min(220, Math.round((W * H) / 9200)));
      stars = [];
      for (var i = 0; i < count; i++) {
        var depth = Math.random(); // 0 = far, 1 = near
        stars.push({
          x: Math.random() * W,
          y: Math.random() * H,
          r: rand(0.4, 1.4) * (0.7 + depth * 0.6),
          base: rand(0.10, 0.42) * (0.55 + depth * 0.6),
          amp: rand(0.25, 0.6),
          sp: rand(0.35, 1.25),
          ph: rand(0, Math.PI * 2),
          par: 0.012 + depth * 0.055,
          tint: Math.random() < 0.18
        });
      }

      glints = [];
      var gc = Math.max(2, Math.round(count / 30));
      for (var j = 0; j < gc; j++) {
        glints.push({
          x: Math.random() * W,
          y: Math.random() * H,
          r: rand(1.0, 1.7),
          base: rand(0.26, 0.5),
          amp: rand(0.4, 0.7),
          sp: rand(0.45, 1.0),
          ph: rand(0, Math.PI * 2),
          par: 0.035 + Math.random() * 0.05,
          tint: Math.random() < 0.5
        });
      }
    }

    function wrap(y, span) {
      return ((y % span) + span) % span - 100;
    }

    function draw(t) {
      if (!running) return;
      var time = t * 0.001;
      var sc = scrollY;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';

      var spanS = H + 200, i, st, a, y;
      for (i = 0; i < stars.length; i++) {
        st = stars[i];
        a = st.base + st.amp * st.base * Math.sin(time * st.sp + st.ph);
        if (a <= 0.012) continue;
        y = wrap(st.y - sc * st.par, spanS);
        ctx.beginPath();
        ctx.fillStyle = (st.tint ? 'rgba(150,196,255,' : 'rgba(255,255,255,') + Math.min(0.78, a) + ')';
        ctx.arc(st.x, y, st.r, 0, 6.2832);
        ctx.fill();
      }

      for (i = 0; i < glints.length; i++) {
        st = glints[i];
        a = st.base + st.amp * st.base * Math.sin(time * st.sp + st.ph);
        if (a <= 0.02) continue;
        y = wrap(st.y - sc * st.par, spanS);
        var col = st.tint ? '120,210,255' : '255,255,255';
        var halo = st.r * 6;
        var g = ctx.createRadialGradient(st.x, y, 0, st.x, y, halo);
        g.addColorStop(0, 'rgba(' + col + ',' + Math.min(0.85, a) + ')');
        g.addColorStop(0.45, 'rgba(' + col + ',' + Math.min(0.3, a * 0.35) + ')');
        g.addColorStop(1, 'rgba(' + col + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(st.x, y, halo, 0, 6.2832);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = (st.tint ? 'rgba(150,210,255,' : 'rgba(255,255,255,') + Math.min(0.92, a) + ')';
        ctx.arc(st.x, y, st.r * 0.7, 0, 6.2832);
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
        ctx.arc(st.x, st.y, st.r, 0, 6.2832);
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
        build();
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

    build();
    start();
  }
})();
