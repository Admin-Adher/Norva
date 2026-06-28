#!/usr/bin/env node
'use strict';

/**
 * Re-applies Norva's libav.js log filter to the vendored Emscripten glue.
 *
 * Why this exists
 * ---------------
 * The custom libav.js builds under public/webengine/vendor/libav are GENERATED
 * Emscripten artifacts. While demuxing MKV/WebM, FFmpeg's matroska demuxer emits
 * a benign per-block warning for tracks that carry BlockAdditions without a
 * MaxBlockAdditionID:
 *
 *   [matroska,webm @ ...] Unexpected BlockAdditions found in a Block from Track
 *   with TrackNumber N where MaxBlockAdditionID is 0
 *
 * Upstream FFmpeg only logs it (AV_LOG_WARNING) and keeps demuxing in non-strict
 * mode, so it is pure console noise — but it fires once per block, flooding the
 * console. libav runs in a Web Worker and routes av_log to stderr, which the
 * Emscripten glue funnels through its `err` sink (default console.error).
 *
 * We wrap that `err` sink so it drops ONLY this exact message (it must contain
 * both "Unexpected BlockAdditions" and "MaxBlockAdditionID") and forwards every
 * other libav line untouched, with a single one-time console.debug notice.
 *
 * Because the glue is regenerated on every libav rebuild, a hand-edit would be
 * silently lost. This script re-asserts the filter idempotently so the fix
 * survives rebuilds. Run it after dropping in a new libav build — it is wired
 * into `npm run deploy:cloudflare` and `npm run build:desktop`.
 *
 * Idempotent: re-running on already-patched files is a no-op.
 */

const fs = require('fs');
const path = require('path');

const LIBAV_DIR = path.join(__dirname, '..', 'public', 'webengine', 'vendor', 'libav');

// The default Emscripten stderr sink we replace (must appear exactly once).
const ANCHOR = 'var out=console.log.bind(console);var err=console.error.bind(console);';
// Presence of this marker means the glue is already patched.
const MARKER = '__norvaBlockAddWarned';
// Filtered sink: drop the benign matroska warning, forward everything else.
const REPLACEMENT =
  'var out=console.log.bind(console);' +
  'var __norvaBlockAddWarned=false;' +
  'var err=function(){' +
  'var __m=arguments.length===1?arguments[0]:Array.prototype.join.call(arguments," ");' +
  'if(typeof __m==="string"&&__m.indexOf("Unexpected BlockAdditions")!==-1&&__m.indexOf("MaxBlockAdditionID")!==-1){' +
  'if(!__norvaBlockAddWarned){__norvaBlockAddWarned=true;' +
  'console.debug("[norva] libav: benign matroska BlockAdditions/MaxBlockAdditionID warnings suppressed (demux continues).");}' +
  'return;}' +
  'return console.error.apply(console,arguments);' +
  '};';

let patched = 0, already = 0, skipped = 0, errors = 0;

let files;
try {
  files = fs.readdirSync(LIBAV_DIR).filter((f) => f.endsWith('.wasm.mjs')).sort();
} catch (e) {
  console.error(`[patch-libav] cannot read ${LIBAV_DIR}: ${e.message}`);
  process.exit(1);
}

for (const name of files) {
  const file = path.join(LIBAV_DIR, name);
  const src = fs.readFileSync(file, 'utf8');

  if (src.includes(MARKER)) {
    already += 1;
    console.log(`[patch-libav] ${name}: already patched`);
    continue;
  }

  const n = src.split(ANCHOR).length - 1;
  if (n === 0) {
    // Neither patched nor matching the known anchor: the Emscripten output shape
    // changed. Don't break the build, but make it loud so the filter gets ported.
    skipped += 1;
    console.warn(`[patch-libav] ${name}: WARNING anchor not found — log filter NOT applied (Emscripten output changed?)`);
    continue;
  }
  if (n > 1) {
    errors += 1;
    console.error(`[patch-libav] ${name}: ERROR anchor found ${n}x (expected 1) — refusing to patch`);
    continue;
  }

  fs.writeFileSync(file, src.replace(ANCHOR, REPLACEMENT));
  patched += 1;
  console.log(`[patch-libav] ${name}: patched`);
}

console.log(`[patch-libav] done — patched ${patched}, already ${already}, skipped ${skipped}, error ${errors}`);
process.exit(errors ? 1 : 0);
