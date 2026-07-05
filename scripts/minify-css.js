#!/usr/bin/env node
'use strict';

/**
 * Conservative, dependency-free CSS minifier used at deploy time.
 *
 * It only takes the SAFE wins — strip /* comments *\/ and collapse every run of
 * insignificant whitespace to a single space — while protecting the bytes inside
 * strings and url(...). It deliberately does NOT remove spaces around ':' or
 * combinators, because this codebase uses descendant selectors like
 * `html.norva-lite :is(...)` and calc() expressions like `calc(50vw - 560px)`
 * where a stray space removal would change meaning. Single spaces are preserved,
 * so selectors and values keep their semantics — the output renders identically.
 *
 * Source stays readable in git; the CI minifies public/css/landing.css in place
 * before hashing + deploying.
 */

const fs = require('fs');
const path = require('path');

function minifyCss(css) {
  let out = '';
  let i = 0;
  const n = css.length;
  const ws = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
  while (i < n) {
    const c = css[i];
    // comment
    if (c === '/' && css[i + 1] === '*') {
      i += 2;
      while (i < n && !(css[i] === '*' && css[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // string (single or double quoted) — copy verbatim
    if (c === '"' || c === "'") {
      const q = c;
      out += c; i++;
      while (i < n && css[i] !== q) {
        if (css[i] === '\\') { out += css[i]; i++; }
        if (i < n) { out += css[i]; i++; }
      }
      out += q; i++;
      continue;
    }
    // url( ... ) — copy contents verbatim (may itself contain strings)
    if ((c === 'u' || c === 'U') && css.slice(i, i + 4).toLowerCase() === 'url(') {
      out += css.slice(i, i + 4); i += 4;
      while (i < n && css[i] !== ')') {
        if (css[i] === '"' || css[i] === "'") {
          const q = css[i]; out += css[i]; i++;
          while (i < n && css[i] !== q) { out += css[i]; i++; }
          if (i < n) { out += css[i]; i++; }
        } else { out += css[i]; i++; }
      }
      if (i < n) { out += ')'; i++; }
      continue;
    }
    // whitespace run -> single space
    if (ws(c)) {
      while (i < n && ws(css[i])) i++;
      out += ' ';
      continue;
    }
    out += c; i++;
  }
  return out.trim();
}

function main() {
  const targets = process.argv.slice(2);
  if (!targets.length) targets.push(path.join(__dirname, '..', 'public', 'css', 'landing.css'));
  for (const t of targets) {
    const src = fs.readFileSync(t, 'utf8');
    const min = minifyCss(src);
    fs.writeFileSync(t, min);
    console.log(`[minify-css] ${path.basename(t)}: ${src.length} -> ${min.length} bytes`);
  }
}

if (require.main === module) main();
module.exports = { minifyCss };
