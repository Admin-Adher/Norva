#!/usr/bin/env node
'use strict';

/**
 * Automatic cache-busting for the static frontend.
 *
 * Rewrites every `?v=…` query string on a LOCAL asset reference (href/src to a
 * "/…" path) inside public/ HTML to a short content hash of that asset. Run at
 * deploy time so that whenever a CSS/JS/img file changes, its URL changes and
 * caches (CDN + webview) invalidate automatically — no more manual `?v=N` bumps,
 * and no more "fresh app.html + stale cached CSS/JS" breakage.
 *
 * Notes:
 *  - Only refs that ALREADY carry `?v=` are touched (preserves exactly which
 *    assets are versioned today; minimal, surgical).
 *  - External refs (https://, //cdn…) and missing files are left untouched.
 *  - Idempotent: re-running on unchanged files yields the same hashes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// matches: href="/css/main.css?v=49"  or  src="/js/app.js?v=31"
const REF_RE = /\b(href|src)="(\/[^"?]+)\?v=[^"]*"/g;

const hashCache = new Map();
function assetHash(assetPath) {
  if (hashCache.has(assetPath)) return hashCache.get(assetPath);
  let h = null;
  try {
    const abs = path.join(PUBLIC_DIR, assetPath);
    h = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 10);
  } catch (_) {
    h = null; // asset not on disk (e.g. protocol-relative CDN) -> leave as-is
  }
  hashCache.set(assetPath, h);
  return h;
}

function listHtml(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listHtml(full));
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

let filesChanged = 0;
let refsHashed = 0;
let missing = 0;

for (const file of listHtml(PUBLIC_DIR)) {
  const src = fs.readFileSync(file, 'utf8');
  const out = src.replace(REF_RE, (m, attr, assetPath) => {
    const h = assetHash(assetPath);
    if (!h) { missing += 1; return m; }
    refsHashed += 1;
    return `${attr}="${assetPath}?v=${h}"`;
  });
  if (out !== src) {
    fs.writeFileSync(file, out);
    filesChanged += 1;
  }
}

console.log(
  `[hash-assets] hashed ${refsHashed} ref(s) across ${filesChanged} file(s)` +
  (missing ? `; ${missing} unresolved ref(s) left unchanged` : ''),
);
