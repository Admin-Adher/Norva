#!/usr/bin/env node
'use strict';

/**
 * Re-applies Norva's safety patches to the vendored Emscripten glue.
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
 * The glue also ships a convenience ff_write_multi helper that historically
 * discarded the return value of av_interleaved_write_frame. movenc can emit a
 * partial moof before returning an AVERROR (for example ESPIPE while patching a
 * non-seekable output). Ignoring that result lets a malformed MP4 tail reach
 * MediaSource. The second patch makes the helper throw a typed error immediately.
 *
 * Because the glue is regenerated on every libav rebuild, hand-edits would be
 * silently lost. This script re-asserts both patches idempotently so they survive
 * rebuilds. Run it after dropping in a new libav build — it is wired into
 * `npm run deploy:cloudflare` and `npm run build:desktop`.
 *
 * Idempotent: re-running on already-patched files is a no-op.
 */

const fs = require('fs');
const path = require('path');

const LIBAV_DIR = path.join(__dirname, '..', 'public', 'webengine', 'vendor', 'libav');

// The default Emscripten stderr sink we replace (must appear exactly once).
const LOG_ANCHOR = 'var out=console.log.bind(console);var err=console.error.bind(console);';
// Presence of this marker means the glue is already patched.
const LOG_MARKER = '__norvaBlockAddWarned';
// Filtered sink: drop the benign matroska warning, forward everything else.
const LOG_REPLACEMENT =
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

// Exact generated helper tail present once in each supported *.wasm.mjs build.
// Unref before throwing because the helper's final cleanup is skipped by throw.
const MUX_ANCHOR = 'step(oc,pkt);av_packet_unref(pkt)';
const MUX_MARKER = 'MUX_PACKET_WRITE_FAILED:';
const MUX_REPLACEMENT =
  'var __norvaMuxWriteRet=step(oc,pkt);' +
  'if(__norvaMuxWriteRet<0){' +
  'av_packet_unref(pkt);' +
  'throw new Error("MUX_PACKET_WRITE_FAILED:"+__norvaMuxWriteRet+":"+ff_error(__norvaMuxWriteRet));' +
  '}' +
  'av_packet_unref(pkt)';

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
  let src = fs.readFileSync(file, 'utf8');
  let changed = false;
  const statuses = [];

  if (src.includes(LOG_MARKER)) {
    already += 1;
    statuses.push('log already');
  } else {
    const n = src.split(LOG_ANCHOR).length - 1;
    if (n === 0) {
      // Some custom variants use Module.print/printErr instead of the default
      // sink. This was already a supported no-op for the noise-filter patch.
      skipped += 1;
      statuses.push('log anchor absent');
    } else if (n > 1) {
      errors += 1;
      statuses.push(`ERROR log anchor ${n}x`);
    } else {
      src = src.replace(LOG_ANCHOR, LOG_REPLACEMENT);
      patched += 1;
      changed = true;
      statuses.push('log patched');
    }
  }

  if (src.includes(MUX_MARKER)) {
    already += 1;
    statuses.push('mux already');
  } else {
    const n = src.split(MUX_ANCHOR).length - 1;
    if (n === 0) {
      errors += 1;
      statuses.push('ERROR mux anchor absent');
    } else if (n > 1) {
      errors += 1;
      statuses.push(`ERROR mux anchor ${n}x`);
    } else {
      src = src.replace(MUX_ANCHOR, MUX_REPLACEMENT);
      patched += 1;
      changed = true;
      statuses.push('mux patched');
    }
  }

  if (changed) fs.writeFileSync(file, src);
  console.log(`[patch-libav] ${name}: ${statuses.join(', ')}`);
}

console.log(`[patch-libav] done — patched ${patched}, already ${already}, skipped ${skipped}, error ${errors}`);
process.exit(errors ? 1 : 0);
