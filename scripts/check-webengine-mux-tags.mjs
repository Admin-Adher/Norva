#!/usr/bin/env node
'use strict';

/**
 * Regression guard for the webengine remux codec tags. Documents
 * docs/WEBENGINE-HEVC-PLAYBACK.md.
 *
 * It replicates NorvaEngine's copy-remux (video copy + DTS reconstruction + audio
 * copy → fragmented MP4) through the vendored norva WASM on the bundled test
 * clips, and asserts the produced sample-entry fourcc matches what the engine
 * advertises to MediaSource:
 *   - HEVC  -> 'hvc1'  (NOT 'hev1' — Chromium rejects 'hev1' init under an 'hvc1'
 *               SourceBuffer with CHUNK_DEMUXER_ERROR_APPEND_FAILED)
 *   - H.264 -> 'avc1'
 * and that both outputs re-demux cleanly.
 *
 * Run after any libav bump or engine mux change:  node scripts/check-webengine-mux-tags.mjs
 * Pure Node, no deps. Exits non-zero on any failure.
 */

import { pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, '..', 'public', 'webengine', 'vendor', 'libav');
const MEDIA = join(HERE, '..', 'public', 'webengine', 'media');
const WRAP = join(VENDOR, 'libav-norva.mjs');
const WASM = join(VENDOR, 'libav-6.8.8.0-norva.wasm.wasm');
const HVC1 = 0x31637668; // MKTAG('h','v','c','1')

console.debug = () => {};
const { LibAV } = await import(pathToFileURL(WRAP).href);

const to64 = (lo, hi) => hi * 4294967296 + (lo >>> 0);
const from64 = (v) => { const hi = Math.floor(v / 4294967296); return [(v - hi * 4294967296) >>> 0, hi]; };

async function remux(mkv) {
  const libav = await LibAV({ base: pathToFileURL(VENDOR).href, wasmurl: pathToFileURL(WASM).href });
  await libav.av_log_set_level(libav.AV_LOG_ERROR);
  await libav.writeFile('in.mkv', new Uint8Array(readFileSync(mkv)));
  const [fmtCtx, streams] = await libav.ff_init_demuxer_file('in.mkv');
  const vS = streams.find((s) => s.codec_type === 0);
  const aS = streams.find((s) => s.codec_type === 1);
  const vName = vS ? await libav.avcodec_get_name(vS.codec_id) : null;
  const aName = aS ? await libav.avcodec_get_name(aS.codec_id) : null;
  const copyAudio = aS && ['aac', 'opus', 'flac'].includes(aName);

  const streamCtxs = [];
  if (vS) streamCtxs.push([vS.codecpar, vS.time_base_num, vS.time_base_den]);
  if (aS && copyAudio) streamCtxs.push([aS.codecpar, aS.time_base_num, aS.time_base_den]);
  const V_IDX = 0, A_IDX = vS ? 1 : 0;

  const chunks = [];
  const muxRet = await libav.ff_init_muxer({ format_name: 'mp4', filename: 'out', open: true, device: true, codecpars: true }, streamCtxs);
  const oc = muxRet[0];
  // same alignment the engine performs
  if (vS && vName === 'hevc') {
    const vcp = await libav.AVStream_codecpar(muxRet[3][0]);
    await libav.AVCodecParameters_codec_tag_s(vcp, HVC1);
  }
  await libav.av_opt_set(oc, 'movflags', 'frag_keyframe+empty_moov+default_base_moof', libav.AV_OPT_SEARCH_CHILDREN);
  libav.onwrite = (n, p, d) => { chunks.push(d.slice(0)); };
  await libav.avformat_write_header(oc, 0);

  const D_REORDER = 16; let vBase = null, vFd0 = 0, vLastDts = null;
  let pendingVideo = null, lastVideoDuration = null;
  const vPtsWindow = [];
  const setVideoDts = (p) => {
    const pts = to64(p.pts, p.ptshi);
    if (vBase === null) {
      vBase = pts; vFd0 = (p.duration || 0) > 0 ? p.duration : 1;
      for (let i = D_REORDER; i > 0; i--) vPtsWindow.push(pts - i * vFd0);
    }
    vPtsWindow.push(pts); vPtsWindow.sort((a, b) => a - b);
    let dts = vPtsWindow.shift();
    if (vLastDts !== null && dts <= vLastDts && vLastDts + 1 <= pts) dts = vLastDts + 1;
    if ((vLastDts !== null && dts <= vLastDts) || dts > pts) throw new Error(`VIDEO_TIMESTAMP_INVALID:${pts}:${dts}:${vLastDts}`);
    vLastDts = dts;
    const [lo, hi] = from64(dts); p.dts = lo; p.dtshi = hi;
  };
  const prepareVideo = (p) => {
    setVideoDts(p);
    const ready = pendingVideo;
    pendingVideo = p;
    if (!ready) return null;
    const duration = to64(p.dts, p.dtshi) - to64(ready.dts, ready.dtshi);
    if (!(Number.isSafeInteger(duration) && duration > 0 && duration <= 0x7fffffff)) {
      throw new Error(`VIDEO_DURATION_INVALID:${duration}`);
    }
    ready.duration = duration;
    ready.durationhi = 0;
    lastVideoDuration = duration;
    return ready;
  };
  const pkt = await libav.av_packet_alloc();
  let res, guard = 0;
  do {
    let packets;
    [res, packets] = await libav.ff_read_frame_multi(fmtCtx, pkt, { limit: 256 * 1024 });
    const wl = [];
    for (const k in packets) for (const p of packets[k]) {
      if (vS && p.stream_index === vS.index) {
        p.stream_index = V_IDX;
        const ready = prepareVideo(p);
        if (ready) wl.push(ready);
      }
      else if (aS && copyAudio && p.stream_index === aS.index) { p.stream_index = A_IDX; wl.push(p); }
    }
    if (wl.length) await libav.ff_write_multi(oc, pkt, wl);
    if (++guard > 200000) break;
  } while (res === 0 || res === -libav.EAGAIN);
  if (pendingVideo) {
    pendingVideo.duration = lastVideoDuration || vFd0 || 1;
    pendingVideo.durationhi = 0;
    await libav.ff_write_multi(oc, pkt, [pendingVideo]);
    pendingVideo = null;
  }
  await libav.av_write_trailer(oc);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  const has = (tag) => { const t = Buffer.from(tag); for (let j = 0; j + 4 <= buf.length; j++) if (buf[j] === t[0] && buf[j + 1] === t[1] && buf[j + 2] === t[2] && buf[j + 3] === t[3]) return true; return false; };
  // validity
  let reOk = false;
  try { await libav.writeFile('out.mp4', buf); const [fc2] = await libav.ff_init_demuxer_file('out.mp4'); const p2 = await libav.av_packet_alloc(); let r, g = 0, n = 0; do { let ps; [r, ps] = await libav.ff_read_frame_multi(fc2, p2, { limit: 1 << 20 }); for (const k in ps) n += ps[k].length; if (++g > 200000) break; } while (r === 0 || r === -libav.EAGAIN); reOk = n > 0; } catch {}
  libav.terminate?.();
  return { vName, hvc1: has('hvc1'), hev1: has('hev1'), avc1: has('avc1'), reOk };
}

const cases = [
  { mkv: 's_h264_aac.mkv', wantFourcc: 'avc1', vName: 'h264' },
  { mkv: 's_hevc_aac.mkv', wantFourcc: 'hvc1', vName: 'hevc' },
];
let failures = 0;
for (const c of cases) {
  const path = join(MEDIA, c.mkv);
  if (!existsSync(path)) { console.log(`SKIP ${c.mkv} (not present)`); continue; }
  const r = await remux(path);
  const tagOk = c.wantFourcc === 'hvc1' ? (r.hvc1 && !r.hev1) : r[c.wantFourcc];
  const ok = tagOk && r.reOk && r.vName === c.vName;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.mkv}: vName=${r.vName} fourcc{hvc1:${r.hvc1},hev1:${r.hev1},avc1:${r.avc1}} reDemux=${r.reOk} (want ${c.wantFourcc})`);
  if (!ok) failures++;
}
console.log(failures ? `\n${failures} failure(s)` : '\nall mux tags correct');
process.exit(failures ? 1 : 0);
