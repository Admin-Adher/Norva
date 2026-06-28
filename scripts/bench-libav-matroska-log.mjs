#!/usr/bin/env node
'use strict';

/**
 * Reproducible benchmark for the matroska "BlockAdditions / MaxBlockAdditionID
 * is 0" log handling. Documents docs/WEBENGINE-LIBAV-LOGGING.md.
 *
 * It builds a synthetic, demuxable MKV whose every block carries BlockAdditions
 * but whose track declares no MaxBlockAdditionID (the exact shape that makes
 * FFmpeg's matroska_parse_frame() log the benign per-block warning), then demuxes
 * it through the vendored norva WASM twice:
 *   - at the libav default level (AV_LOG_INFO) — the warning fires, FFmpeg formats
 *     and writes every line through the Emscripten TTY once per block; and
 *   - at AV_LOG_ERROR — FFmpeg's default callback returns before vsnprintf, so the
 *     whole per-block log path is skipped at the source.
 *
 * Expect the ERROR run to be ~2x faster with 0 warnings. Run:
 *   node scripts/bench-libav-matroska-log.mjs [numBlocks] [repeats]
 *
 * Pure Node, no deps. Uses the committed vendor glue, so re-run it after any
 * libav rebuild to confirm the behavior still holds.
 */

import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, '..', 'public', 'webengine', 'vendor', 'libav');
const GLUE = join(VENDOR, 'libav-6.8.8.0-norva.wasm.mjs');
const WASM = join(VENDOR, 'libav-6.8.8.0-norva.wasm.wasm');

const NUM_BLOCKS = parseInt(process.argv[2] || '8000', 10);
const REPEATS = parseInt(process.argv[3] || '8', 10);

// ---- minimal EBML writer → synthetic MKV with BlockAdditions, no MaxBlockAdditionID
function buildMkv(numBlocks) {
  const id = (h) => Buffer.from(h.replace(/\s/g, ''), 'hex');
  const vint = (n) => {
    for (let L = 1; L <= 8; L++) {
      if (BigInt(n) < 2n ** BigInt(7 * L) - 1n) {
        const b = Buffer.alloc(L); let v = BigInt(n) | (1n << BigInt(7 * L));
        for (let i = L - 1; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b;
      }
    } throw new Error('vint too big');
  };
  const el = (h, d) => Buffer.concat([id(h), vint(d.length), d]);
  const uint = (n) => { if (!n) return Buffer.from([0]); const a = []; let v = n; while (v > 0) { a.unshift(v & 0xff); v = Math.floor(v / 256); } return Buffer.from(a); };
  const f32 = (n) => { const b = Buffer.alloc(4); b.writeFloatBE(n); return b; };

  const ebml = el('1A45DFA3', Buffer.concat([
    el('4286', uint(1)), el('42F7', uint(1)), el('42F2', uint(4)), el('42F3', uint(8)),
    el('4282', Buffer.from('matroska')), el('4287', uint(4)), el('4285', uint(2)),
  ]));
  const info = el('1549A966', Buffer.concat([el('2AD7B1', uint(1000000)), el('4D80', Buffer.from('norva-bench'))]));
  const trackEntry = el('AE', Buffer.concat([
    el('D7', uint(1)), el('73C5', uint(1)), el('83', uint(2)), el('9C', uint(0)),
    el('86', Buffer.from('A_PCM/INT/LIT')),
    el('E1', Buffer.concat([el('B5', f32(48000)), el('9F', uint(2)), el('6264', uint(16))])),
  ]));
  const tracks = el('1654AE6B', trackEntry);

  const payload = Buffer.alloc(8), additional = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const clusters = []; let made = 0;
  while (made < numBlocks) {
    const n = Math.min(1000, numBlocks - made), g = [el('E7', uint(made))];
    for (let i = 0; i < n; i++) {
      const block = Buffer.concat([vint(1), Buffer.from([(i >> 8) & 0xff, i & 0xff, 0x00]), payload]);
      g.push(el('A0', Buffer.concat([
        el('A1', block), el('9B', uint(1)),
        el('75A1', el('A6', Buffer.concat([el('EE', uint(1)), el('A5', additional)]))),
      ])));
    }
    clusters.push(el('1F43B675', Buffer.concat(g))); made += n;
  }
  return Buffer.concat([ebml, el('18538067', Buffer.concat([info, tracks, ...clusters]))]);
}

// ---- console spy
let blockAddErr = 0, otherErr = 0;
const realLog = console.log.bind(console);
console.error = (...a) => {
  const s = a.length === 1 && typeof a[0] === 'string' ? a[0] : a.join(' ');
  if (s.includes('Unexpected BlockAdditions') && s.includes('MaxBlockAdditionID')) blockAddErr++; else otherErr++;
};
console.debug = () => {};

const mkv = new Uint8Array(buildMkv(NUM_BLOCKS));
const dir = mkdtempSync(join(tmpdir(), 'norva-bench-'));
writeFileSync(join(dir, 'in.mkv'), mkv);

const factory = (await import(pathToFileURL(GLUE).href)).default;
const mod = await factory({ wasmurl: pathToFileURL(WASM).href });
const call = (fn, ...a) => Promise.resolve(mod[fn](...a));

async function demux() {
  try { await call('unlink', 'in.mkv'); } catch {}
  await call('writeFile', 'in.mkv', mkv);
  const [fmtCtx] = await call('ff_init_demuxer_file', 'in.mkv');
  const pkt = await call('av_packet_alloc');
  let res, total = 0, guard = 0;
  do {
    let packets; [res, packets] = await call('ff_read_frame_multi', fmtCtx, pkt, { limit: 1 << 20 });
    for (const k in packets) total += packets[k].length;
    if (++guard > 2000000) break;
  } while (res === 0 || res === -mod.EAGAIN);
  await call('av_packet_free_js', pkt).catch(() => {});
  await call('avformat_close_input_js', fmtCtx).catch(() => {});
  return total;
}

async function run(level) {
  await call('av_log_set_level', level);
  await demux(); // warm
  blockAddErr = 0; otherErr = 0;
  const t0 = process.hrtime.bigint();
  let pkts = 0; for (let i = 0; i < REPEATS; i++) pkts += await demux();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { warnings: blockAddErr, msPerRun: +(ms / REPEATS).toFixed(1), pkts: pkts / REPEATS };
}

const INFO = 32, ERROR = 16;
const a = await run(INFO);
const b = await run(ERROR);

realLog(`\nnorva libav matroska BlockAdditions log benchmark`);
realLog(`  blocks/run=${NUM_BLOCKS}  repeats=${REPEATS}  packets/run=${a.pkts}\n`);
realLog(`  level=INFO  (libav default) : ${String(a.msPerRun).padStart(7)} ms/run`);
realLog(`  level=ERROR (norva default) : ${String(b.msPerRun).padStart(7)} ms/run`);
const speedup = a.msPerRun / b.msPerRun;
realLog(`\n  => ERROR is ${speedup.toFixed(2)}x faster: it skips the per-block log work at the`);
realLog(`     source (vsnprintf + stderr + byte-by-byte TTY), once per block.`);
realLog(`  note: console warning counts are not shown here — the committed glue's`);
realLog(`        sink-filter already drops this message at INFO too, so the timing`);
realLog(`        (per-block CPU) is the honest metric. (console warnings INFO=${a.warnings}, ERROR=${b.warnings})\n`);
try { mod.terminate?.(); } catch {}
process.exit(0);
