#!/usr/bin/env node
'use strict';

/**
 * Deploy-time critical-path optimization: inline public/css/landing.css directly
 * into the HTML entry points that use it (index.html, landing.html), replacing
 * the render-blocking external <link> with a <style> block.
 *
 * Why: landing.css is the ONLY render-blocking request in the <head>, so it sits
 * alone on the critical request chain (HTML -> CSS) and delays first paint by a
 * full extra round-trip. The sheet is small (~42KB minified) and only these two
 * pages reference it, so inlining removes the extra request AND the chain — the
 * page paints as soon as the HTML arrives, with zero FOUC (every rule is present
 * before first paint, so nothing flashes unstyled).
 *
 * Runs in CI AFTER minify:css (so the inlined bytes are already minified) and
 * after hash:assets. It is fail-loud: if a target's <link> can't be found it
 * throws, so a broken pipeline never ships an un-styled page. It is also
 * idempotent — a target that already carries the inline marker is skipped, so
 * re-running is safe.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CSS_FILE = path.join(PUBLIC_DIR, 'css', 'landing.css');
const TARGETS = ['index.html', 'landing.html'];

// Matches the landing.css stylesheet link regardless of its ?v= hash, e.g.
//   <link rel="stylesheet" href="/css/landing.css?v=115baae01a">
const LINK_RE = /<link\b[^>]*href="\/css\/landing\.css[^"]*"[^>]*>/i;
const MARKER = 'data-inlined="landing.css"';

function main() {
  const css = fs.readFileSync(CSS_FILE, 'utf8').trim();
  // A literal </style> inside the CSS would break out of the inline block. The
  // minifier never emits one, but refuse to ship rather than corrupt the page.
  if (/<\/style/i.test(css)) {
    throw new Error('[inline-css] landing.css contains "</style" — cannot safely inline');
  }

  let inlined = 0;
  for (const name of TARGETS) {
    const file = path.join(PUBLIC_DIR, name);
    let html;
    try {
      html = fs.readFileSync(file, 'utf8');
    } catch (_) {
      console.log(`[inline-css] ${name}: not found, skipping`);
      continue;
    }

    if (html.includes(MARKER)) {
      console.log(`[inline-css] ${name}: already inlined, skipping`);
      continue;
    }
    if (!LINK_RE.test(html)) {
      throw new Error(
        `[inline-css] ${name}: could not find <link ... href="/css/landing.css...">; ` +
        'aborting so we never ship an un-styled page',
      );
    }

    const out = html.replace(LINK_RE, `<style ${MARKER}>${css}</style>`);
    fs.writeFileSync(file, out);
    inlined += 1;
    console.log(`[inline-css] ${name}: inlined ${css.length} bytes of CSS, dropped the external link`);
  }

  console.log(`[inline-css] done: ${inlined} file(s) inlined`);
}

if (require.main === module) main();
module.exports = { minifyTarget: main, LINK_RE, MARKER };
