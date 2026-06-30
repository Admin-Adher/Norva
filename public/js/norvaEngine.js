/*
 * NorvaEngine — client-side MKV streaming engine ("the browser is the media
 * server"). Reads a remote file by HTTP byte-range, demuxes it, copies the
 * video (the browser decodes H.264/HEVC/VP9/AV1 natively) and transcodes any
 * audio the browser can't decode (AC-3/E-AC-3/DTS/TrueHD/...) to AAC on the
 * fly, then feeds a fragmented MP4 to a MediaSource. No transcode server.
 *
 * Powered by a custom libav.js variant (public/webengine/vendor/libav). Runs
 * the heavy work in a Web Worker (the loader picks worker mode automatically),
 * so the UI stays responsive.
 *
 * Public API:
 *   const eng = new NorvaEngine(videoEl, { report });
 *   await eng.load(url, { startTime });   // startTime>0 = resume
 *   await eng.seek(t);                    // re-seek outside the buffered range
 *   eng.destroy();
 */
(function () {
  'use strict';

  const LIBAV_LOADER = '/webengine/vendor/libav/libav-norva.mjs';
  const LIBAV_BASE = '/webengine/vendor/libav';

  // Audio codecs the browser decodes natively inside fMP4 → copy (no transcode).
  const AUDIO_COPY = new Set(['aac', 'opus', 'flac']);
  const AUDIO_MIME = { aac: 'mp4a.40.2', opus: 'opus', flac: 'flac' };
  // Subtitle codecs whose packet payload IS text (so we can turn demuxed packets into
  // cues with no decoder and no provider connection). Image subs (pgs/dvdsub/dvb) need
  // OCR and are excluded here.
  const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'vtt']);

  // How far ahead of currentTime we keep the SourceBuffer filled. The pump
  // pauses above MAX and resumes below MIN → bounded memory/CPU on long films.
  const BUFFER_AHEAD_MAX = 45; // seconds
  const BUFFER_AHEAD_MIN = 20; // seconds

  // Read-ahead cache. A single-slot provider 401s rapid per-block connections
  // (even with gateway retries that's slow), so fetch large windows and serve
  // libav's small block reads from memory — sequential playback then uses ~1
  // upstream connection per window instead of one per ~64 KB block.
  const RA_WINDOW = 4 * 1024 * 1024;        // bytes fetched per steady-state window
  const RA_FIRST_WINDOW = 2 * 1024 * 1024;  // smaller first window → faster startup
  const RA_WINDOWS = 4;                      // windows kept (header + cues + playhead)

  const AAC_SAMPLE_RATE = 48000;
  const AAC_CHANNEL_LAYOUT = 3; // stereo
  const AAC_BIT_RATE = 192000;
  const D_REORDER = 16; // video DTS reconstruction reorder depth (frames)

  const to64 = (lo, hi) => hi * 4294967296 + (lo >>> 0);
  const from64 = (v) => { const hi = Math.floor(v / 4294967296); return [(v - hi * 4294967296) >>> 0, hi]; };
  const hex2 = (n) => n.toString(16).padStart(2, '0');

  // ---- minimal EBML/Matroska reader (builds a time→byte cue index so we can
  //      prefetch the bytes for a seek target while the user is still scrubbing).
  const MKV = {
    Segment: 0x18538067, SeekHead: 0x114D9B74, Seek: 0x4DBB, SeekID: 0x53AB, SeekPosition: 0x53AC,
    Info: 0x1549A966, TimestampScale: 0x2AD7B1, Cues: 0x1C53BB6B,
    CuePoint: 0xBB, CueTime: 0xB3, CueTrackPositions: 0xB7, CueClusterPosition: 0xF1,
  };
  // Read an EBML element ID (keeps the length-descriptor bits, matching MKV.* ids).
  function ebmlId(b, p) {
    if (p >= b.length) return null;
    const b0 = b[p];
    const len = b0 & 0x80 ? 1 : b0 & 0x40 ? 2 : b0 & 0x20 ? 3 : b0 & 0x10 ? 4 : 0;
    if (!len || p + len > b.length) return null;
    let id = 0; for (let i = 0; i < len; i++) id = id * 256 + b[p + i];
    return { id, len };
  }
  // Read an EBML size (VINT); strips the marker bit. unknown=all-ones size.
  function ebmlSize(b, p) {
    if (p >= b.length) return null;
    const b0 = b[p];
    let mask = 0x80, len = 1;
    while (len <= 8 && !(b0 & mask)) { mask >>= 1; len++; }
    if (len > 8 || p + len > b.length) return null;
    let val = b0 & (mask - 1); let unknown = (b0 & (mask - 1)) === (mask - 1);
    for (let i = 1; i < len; i++) { val = val * 256 + b[p + i]; if (b[p + i] !== 0xff) unknown = false; }
    return { val, len, unknown };
  }
  function ebmlUint(b, p, n) { let v = 0; for (let i = 0; i < n && p + i < b.length; i++) v = v * 256 + b[p + i]; return v; }

  // libav.js rejects with bare objects/numbers; String(e) → "[object Object]".
  // Squeeze out whatever detail there is so failures are diagnosable.
  function errStr(e) {
    if (e == null) return 'null';
    if (typeof e === 'string' || typeof e === 'number') return String(e);
    if (e.stack) return String(e.stack);
    if (e.message) return String(e.message);
    try { const j = JSON.stringify(e); if (j && j !== '{}') return j; } catch (_) {}
    try { const k = Object.keys(e); if (k.length) return k.map((x) => x + '=' + String(e[x])).join(' '); } catch (_) {}
    return Object.prototype.toString.call(e);
  }

  // Walk the top-level ISO-BMFF/fMP4 boxes in a chunk so a rejected append can be
  // described by what it actually contained (ftyp/moov = init segment;
  // styp/moof/mdat = media fragment). Returns e.g. "ftyp(28) moov(1037)" or, on a
  // malformed/truncated box, a "?" marker — diagnostics only, never throws.
  function mp4Boxes(data, limit = 8) {
    const out = [];
    try {
      const b = data instanceof Uint8Array ? data : new Uint8Array(data);
      let p = 0;
      while (p + 8 <= b.length && out.length < limit) {
        let size = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
        const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
        // Non-printable type → not a box boundary (we're mid-stream / desynced).
        if (!/^[\x20-\x7e]{4}$/.test(type)) { out.push('?@' + p); break; }
        let hdr = 8;
        if (size === 1) { // 64-bit largesize
          size = (((b[p + 8] << 24) | (b[p + 9] << 16) | (b[p + 10] << 8) | b[p + 11]) >>> 0) * 4294967296
               + (((b[p + 12] << 24) | (b[p + 13] << 16) | (b[p + 14] << 8) | b[p + 15]) >>> 0);
          hdr = 16;
        } else if (size === 0) { size = b.length - p; } // to end of chunk
        out.push(type + '(' + size + ')');
        if (size < hdr) { out.push('!badsize'); break; }
        p += size;
      }
    } catch (_) { out.push('!err'); }
    return out.join(' ');
  }

  let libavLoaderPromise = null;
  function loadLibavFactory() {
    if (!libavLoaderPromise) libavLoaderPromise = import(LIBAV_LOADER);
    return libavLoaderPromise;
  }

  // ---- codec-string builders (for MediaSource mime) -------------------------
  function avcCodecString(ed) {
    if (!ed || ed.length < 4 || ed[0] !== 1) return null;
    return 'avc1.' + hex2(ed[1]) + hex2(ed[2]) + hex2(ed[3]);
  }
  function hevcCodecString(ed) {
    if (!ed || ed.length < 23 || ed[0] !== 1) return null;
    const gps = (ed[1] >> 6) & 0x3, tier = (ed[1] >> 5) & 0x1, pidc = ed[1] & 0x1f;
    let compat = ((ed[2] << 24) | (ed[3] << 16) | (ed[4] << 8) | ed[5]) >>> 0;
    let rev = 0; for (let i = 0; i < 32; i++) { rev = ((rev << 1) | (compat & 1)) >>> 0; compat >>>= 1; }
    const space = gps === 0 ? '' : String.fromCharCode(64 + gps);
    const level = ed[12];
    const cons = []; for (let i = 6; i <= 11; i++) cons.push(ed[i]);
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    const consStr = cons.length ? '.' + cons.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('.') : '';
    return 'hvc1.' + space + pidc + '.' + rev.toString(16).toUpperCase() + '.' + (tier ? 'H' : 'L') + level + consStr;
  }
  // Split an annexb H.264 bitstream into NAL units (payload after each 00 00 01 / 00 00 00 01
  // start code). Used to lift the in-band SPS/PPS out of an MPEG-TS keyframe.
  function annexbNals(buf) {
    const out = []; let i = 0;
    while (i < buf.length - 3) {
      if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
        const sc = buf[i + 2] === 1 ? 3 : 4; let j = i + sc;
        while (j < buf.length - 3 && !(buf[j] === 0 && buf[j + 1] === 0 && (buf[j + 2] === 1 || (buf[j + 2] === 0 && buf[j + 3] === 1)))) j++;
        out.push(buf.slice(i + sc, j === buf.length - 3 ? buf.length : j)); i = j;
      } else i++;
    }
    return out;
  }
  // Convert an annexb H.264 access unit (start-code-delimited NALs, as MPEG-TS delivers) into AVCC
  // (4-byte-length-prefixed NALs, as MP4/movenc needs). movenc copies TS video as-is, so without this
  // the mdat holds annexb and MSE reads a start code as a NAL length → CHUNK_DEMUXER_ERROR. AUD (9)
  // and the parameter sets SPS (7) / PPS (8) are dropped — the params live in the avcC, matching
  // ffmpeg's mp4 output. (Only TS sources are converted — the caller gates on _convertAnnexb.)
  function annexbToAvcc(data) {
    const ns = annexbNals(data);
    const drop = (t) => t === 9 || t === 7 || t === 8;
    let tot = 0;
    for (const n of ns) { if (drop(n[0] & 0x1f)) continue; tot += 4 + n.length; }
    const out = new Uint8Array(tot); let o = 0;
    for (const n of ns) {
      if (drop(n[0] & 0x1f)) continue;
      out[o] = (n.length >>> 24) & 0xff; out[o + 1] = (n.length >>> 16) & 0xff;
      out[o + 2] = (n.length >>> 8) & 0xff; out[o + 3] = n.length & 0xff;
      out.set(n, o + 4); o += 4 + n.length;
    }
    return out;
  }
  // High-profile avcC extension (chroma_format_idc + bit_depths) parsed from the SPS. profile_idc
  // 100/110/122/244/… carry these, and strict MP4 parsers (Chromium MSE) REQUIRE them in the avcC —
  // omitting them is why a High-profile (avc1.64xxxx) TS failed while Main worked. Reads only the
  // leading Exp-Golomb fields of the de-emulated RBSP. null when no extension applies.
  const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
  function spsHighExt(sps) {
    if (!HIGH_PROFILES.has(sps[1])) return null;
    const r = [];
    for (let i = 1; i < sps.length; i++) { if (i >= 3 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue; r.push(sps[i]); }
    let bp = 3, bit = 0; // skip profile_idc / constraint_flags / level_idc
    const u1 = () => { const b = (r[bp] >> (7 - bit)) & 1; bit++; if (bit === 8) { bit = 0; bp++; } return b; };
    const ue = () => { let z = 0; while (u1() === 0 && z < 32) z++; let v = 0; for (let i = 0; i < z; i++) v = (v << 1) | u1(); return v + (1 << z) - 1; };
    try {
      ue();                 // seq_parameter_set_id
      const cf = ue();      // chroma_format_idc
      if (cf === 3) u1();   // separate_colour_plane_flag
      const bl = ue();      // bit_depth_luma_minus8
      const bc = ue();      // bit_depth_chroma_minus8
      return { cf, bl, bc };
    } catch (_) { return null; }
  }
  // Build an avcC (AVCDecoderConfigurationRecord) from one SPS + one PPS NAL. profile/compat/level
  // come from SPS bytes 1..3; 4-byte NAL length (0xFF). MPEG-TS doesn't carry it (SPS/PPS are in-band),
  // so we synthesise it — including the High-profile extension when the SPS calls for it.
  function buildAvcC(sps, pps) {
    const a = [
      1, sps[1], sps[2], sps[3], 0xff, 0xe0 | 1,
      (sps.length >> 8) & 0xff, sps.length & 0xff, ...sps,
      1, (pps.length >> 8) & 0xff, pps.length & 0xff, ...pps,
    ];
    const e = spsHighExt(sps);
    if (e) a.push(0xfc | (e.cf & 3), 0xf8 | (e.bl & 7), 0xf8 | (e.bc & 7), 0 /* numSPSExt */);
    return new Uint8Array(a);
  }
  // MPEG-TS carries AAC as ADTS frames (7/9-byte header per frame), but mp4 needs RAW AAC
  // with the config in the esds (AudioSpecificConfig) — the aac_adtstoasc transform. Without
  // it the moov's esds is empty AND the mdat samples keep their ADTS headers, so MSE rejects
  // the audio (CHUNK_DEMUXER_ERROR_APPEND_FAILED) the same way an empty avcC breaks video.
  // Synthesise the 2-byte ASC from one ADTS header (audioObjectType, sampleRateIndex, channels).
  function adtsToAsc(d) {
    if (!(d && d.length >= 4 && d[0] === 0xff && (d[1] & 0xf0) === 0xf0)) return null;
    const aot = ((d[2] >> 6) & 0x3) + 1;          // MPEG-4 Audio Object Type (profile + 1)
    const freq = (d[2] >> 2) & 0xf;               // sampling_frequency_index
    const chan = ((d[2] & 1) << 2) | ((d[3] >> 6) & 0x3); // channel_configuration
    return new Uint8Array([(aot << 3) | (freq >> 1), ((freq & 1) << 7) | (chan << 3)]);
  }
  // Strip the ADTS header(s) from an AAC packet, returning the concatenated raw frame payload(s).
  // One TS packet is usually one frame, but loop to be robust. Pass-through if not ADTS.
  function stripAdts(d) {
    if (!(d && d.length >= 7 && d[0] === 0xff && (d[1] & 0xf0) === 0xf0)) return d;
    const parts = [];
    let i = 0;
    while (i + 7 <= d.length && d[i] === 0xff && (d[i + 1] & 0xf0) === 0xf0) {
      const hlen = (d[i + 1] & 1) ? 7 : 9; // protection_absent ? no CRC (7) : CRC (9)
      const flen = ((d[i + 3] & 3) << 11) | (d[i + 4] << 3) | ((d[i + 5] >> 5) & 7);
      if (flen < hlen || i + flen > d.length) break;
      parts.push(d.subarray(i + hlen, i + flen));
      i += flen;
    }
    if (!parts.length) return d;
    if (parts.length === 1) return parts[0];
    let tot = 0; for (const p of parts) tot += p.length;
    const out = new Uint8Array(tot); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  // Generic fallbacks if extradata parsing yields an unsupported string.
  const VIDEO_FALLBACKS = {
    h264: ['avc1.640028', 'avc1.4d4028', 'avc1.42e01e'],
    hevc: ['hvc1.1.6.L150.90', 'hvc1.2.4.L150.90', 'hev1.1.6.L150.90'],
    vp9: ['vp09.00.10.08'],
    av1: ['av01.0.08M.08'],
  };

  const ENGINE_VERSION = 37;

  class NorvaEngine {
    constructor(videoEl, opts = {}) {
      this.video = videoEl;
      this.report = typeof opts.report === 'function' ? opts.report : () => {};
      this.log = typeof opts.log === 'function' ? opts.log : () => {};
      this.onReady = typeof opts.onReady === 'function' ? opts.onReady : () => {};
      this.onSeek = typeof opts.onSeek === 'function' ? opts.onSeek : () => {};
      // libav log verbosity. Default ERROR: libav's INFO default floods the
      // console AND costs real CPU — FFmpeg formats + writes every line through
      // the Emscripten TTY once per block, and the matroska demuxer logs a
      // benign warning for every MKV block carrying BlockAdditions without a
      // MaxBlockAdditionID. Raising the threshold makes FFmpeg skip that work at
      // the source (measured ~2× faster demux on affected files). Real errors
      // still surface. Pass opts.verbose (or set window.NORVA_LIBAV_VERBOSE) to
      // restore full libav logging when debugging.
      this._verbose = opts.verbose === true ||
        (typeof window !== 'undefined' && window.NORVA_LIBAV_VERBOSE === true);
      this._cueIndex = null;      // [{t, off}] time→byte index from MKV cues
      this._prefetching = false;  // single-flight guard for scrub prefetch
      this._smallNextRead = false;// next demuxer read after a seek uses a small window
      // The muxer re-bases output to 0; _tsAnchor is the real time muxer-0 maps to,
      // applied via SourceBuffer.timestampOffset so seeks/resume land on target.
      this._tsAnchor = 0; this._tsApplied = 0; this._firstVpktPending = false;
      // MPEG-TS PTS carries an arbitrary epoch (e.g. the PCR start), so a "playback time t"
      // is NOT t*time_base in the stream — it is epoch + t*time_base. mp4/mkv start at ~0, so
      // this stays 0 for them. Captured from the first video PTS on TS; used by _seekDemuxer
      // (add it to the seek target) and _setVideoDts (subtract it to get a playback-relative
      // anchor that matches video.currentTime). Without it, resume/seek on TS lands the data
      // at the wrong timeline position → the playhead starves while MB buffer elsewhere.
      this._ptsEpoch = 0; // in the video stream's time_base ticks
      this._gopFloorPts = null;   // after a seek, drop video PTS below the landing keyframe (open-GOP leading B-frames)
      this._convertAnnexb = false; // MPEG-TS: convert each annexb video access unit to AVCC for the mp4 muxer
      this._stripAdts = false;     // MPEG-TS: strip ADTS headers from AAC packets (raw AAC for the mp4 esds)
      // In-band text-subtitle capture: turn demuxed subtitle packets into cues with no
      // provider connection (reuses bytes the engine already streams). Dormant until the
      // player calls enableSubtitleCapture(); flag-off = zero cost in the pump loop.
      this._subCapture = false;
      // When set, capture is auto-armed in _detectStreams (before the pump starts) so the
      // cue buffer is filled from the first demuxed packet — no gap when a track is picked.
      this._subCaptureWanted = opts.inbandSubtitles === true;
      this._subMeta = null;        // streamIndex -> { codec, tbNum, tbDen, text }
      this._subCues = new Map();   // streamIndex -> [{ startSrc, endSrc, text }] in SOURCE seconds
      this._subTextDecoder = null;
      this._skipSeekTo = null;    // suppress the self-induced seeking event on resume
      this._nudgeDone = true;     // one-shot: nudge the playhead onto the first buffered byte after a seek/resume (set false on seek/resume)
      this.lib = null;
      this.url = null;
      this.size = 0;
      this.mime = null;
      this.ms = null;
      this.sb = null;
      this.queue = [];
      this.ended = false;
      this.destroyed = false;
      this._pumpRunning = false;
      this._stopRequested = false;
      this._gate = null;          // resolver while pump waits for buffer to drain
      this._seeking = false;
      this._initSegPending = false;
      // libav handles
      this.fmtCtx = null; this.vS = null; this.aS = null;
      this.copyAudio = false;
      this._lastReadError = null; // precise reason a byte-range fetch failed
      this._raCache = [];         // read-ahead windows (filled before _openInput)
      this.timings = {};          // per-stage startup timings (ms)
      this._fetchCount = 0; this._fetchBytes = 0; this._fetchMs = 0;
      this.decCtx = null; this.decPkt = null; this.decFrame = null;
      this.encCtx = null; this.encFrame = null; this.encPkt = null; this.frameSize = 0; this.encCodecpar = null;
      this.fg = null; this.fsrc = null; this.fsink = null;
      this.oc = null; this.pkt = null;
      this.vBase = null; this.vCum = 0; this.vFd0 = 0; this.vOffset = 0;
      this._onSeeking = this._handleSeeking.bind(this);
      this._onTimeUpdate = this._handleTimeUpdate.bind(this);
      // Engine-wide abort: destroy() fires it so EVERY in-flight byte-range fetch is
      // cancelled at once. Without this a torn-down engine's fetch keeps running to its
      // own 30–60s timeout, holding the single provider slot and making the NEXT title
      // 458 ("max connections"). Aborting on destroy frees the slot in ~8s instead.
      this._ac = new AbortController();
      // Deep diagnostics for CHUNK_DEMUXER_ERROR_APPEND_FAILED on VOD open: a
      // running record of the exact bytes/boxes/codec decisions that fed MSE, so a
      // rejected append can be explained instead of just observed. Pure accounting,
      // no effect on playback. Surfaced via engineSnapshot().
      this._dropWrites = false;       // when true, muxer onwrite bytes are discarded (trailer)
      this._diag = {
        mime: null, videoCodecString: null, videoCands: null, audioTag: null,
        vName: null, aName: null, copyAudio: null, durationSec: null,
        initBoxes: null, initBytes: 0,
        firstMediaBoxes: null, firstMediaBytes: 0,
        firstVideoPkt: null,          // { pts, dts, key, idx }
        appendCount: 0, appendBytes: 0,
        recentAppends: [],            // ring of last appended chunks' box layouts (find the failing one)
        appendErrors: [],             // [{ n, bytes, boxes, err, sbUpdating, msState }]
        sbErrorEvents: 0,
        droppedOpenGop: 0,
        pumpExitReason: null, pumpExitRes: null, lastReadError: null,
        trailerBytesDropped: 0,
      };
    }

    // ---- public ------------------------------------------------------------
    async load(url, { startTime = 0, audioStreamIndex = null } = {}) {
      this.url = url;
      this._wantAudioIndex = Number.isInteger(audioStreamIndex) ? audioStreamIndex : null;
      const t0 = performance.now();
      this.loadStartedAt = t0;
      // Kick off wasm AND the initial network at the same time: the wasm compile
      // (~3 MB) overlaps the single first-window fetch (which also yields the
      // file size), so _openInput's demuxer reads hit the cache, not the net.
      const factoryP = loadLibavFactory();
      const prefetchP = this._prefetchStart();
      const factory = await factoryP;
      const LibAV = factory.LibAV || factory.default.LibAV;
      this.lib = await LibAV({ base: LIBAV_BASE });
      // Quiet libav at the source before any demuxing (see _verbose above). The
      // call proxies into the worker, so it governs the thread that does the work.
      // FATAL (not ERROR) for the normal path: MPEG-TS sources emit ERROR-level
      // "Invalid timestamps" per packet (a benign source quirk libav clamps), which
      // floods the console with hundreds of lines and buries real diagnostics. The
      // engine surfaces genuine failures via telemetry + engineSnapshot, not libav logs.
      try { await this.lib.av_log_set_level(this._verbose ? this.lib.AV_LOG_VERBOSE : this.lib.AV_LOG_FATAL); } catch (_) {}
      this.timings.wasmMs = Math.round(performance.now() - t0);
      this.log(`libav prêt (${this.lib.libavjsMode}) en ${(this.timings.wasmMs / 1000).toFixed(1)}s`);

      let m = performance.now();
      await prefetchP;
      if (!this.size) {
        // The first-window fetch already failed. If it was a provider slot/auth block
        // (401/403/429/458), do NOT open a SECOND connection to re-probe the size: it
        // will hit the same block and just hammers a single-slot provider (doubling the
        // /raw load per attempt, which keeps the slot from going quiet). Surface it now
        // and let the player's retry wait for the slot, then try cleanly.
        const pe = this._prefetchError;
        if (pe && /_(401|403|429|458)\b/.test(String((pe && pe.message) || pe))) throw pe;
        this.size = await this._probeSize(url);
      }
      this.timings.probeMs = Math.round(performance.now() - m);
      m = performance.now(); await this._openInput(); this.timings.openInputMs = Math.round(performance.now() - m);
      m = performance.now(); await this._detectStreams(); await this._ensureVideoExtradata(); this.mime = await this._chooseMime(); this.timings.detectMimeMs = Math.round(performance.now() - m);
      m = performance.now(); await this._attachMediaSource(); this.timings.mediaSourceMs = Math.round(performance.now() - m);
      m = performance.now(); if (this.copyAudio === false && this.aS) await this._initEncoder(); this.timings.encoderMs = Math.round(performance.now() - m);
      m = performance.now(); await this._initMuxer(); this.timings.muxerMs = Math.round(performance.now() - m);
      m = performance.now();
      if (startTime > 0.25) {
        // Resume: anchor the SB to the resume point (refined to the real keyframe
        // PTS by _setVideoDts) so data lands at startTime, not at 0.
        this._tsAnchor = startTime; this._firstVpktPending = true; this._nudgeDone = false;
        await this._seekDemuxer(startTime);
        // We've positioned the demuxer/pump; ignore the seeking event this fires.
        this._skipSeekTo = startTime;
        setTimeout(() => { if (this._skipSeekTo === startTime) this._skipSeekTo = null; }, 5000);
        try { this.video.currentTime = startTime; } catch (_) {}
      }
      this.timings.seekMs = Math.round(performance.now() - m);
      this.timings.loadTotalMs = Math.round(performance.now() - t0);
      this.timings.fetches = this._fetchCount;
      this.timings.fetchMB = Math.round((this._fetchBytes / 1048576) * 10) / 10;
      this.timings.fetchMs = Math.round(this._fetchMs);
      this.timings.audio = this.copyAudio ? 'copy' : 'aac';
      this.timings.video = this.vName || null;
      this.timings.engineVersion = ENGINE_VERSION;
      this.log('timings ' + JSON.stringify(this.timings));
      // Emit timings the instant the engine is ready — unambiguous proof of
      // version + per-stage breakdown, independent of the first_frame path.
      try { this.onReady(this.timings); } catch (_) {}
      this.video.addEventListener('seeking', this._onSeeking);
      this.video.addEventListener('timeupdate', this._onTimeUpdate);
      this._startPump();
      // Build the cue index in the background (enables prefetch-on-scrub). Delayed
      // so it never competes with the first frame's fetches on the single-slot link.
      setTimeout(() => { if (!this.destroyed) this._buildCueIndex(); }, 2500);
    }

    // Fetch file size + first window (+ MKV tail for cues) up front so they're
    // cached by the time the demuxer reads. Runs in parallel with the wasm load;
    // failures are swallowed here and re-surfaced by _openInput's real reads.
    async _prefetchStart() {
      try {
        // One sequential fetch of the first window: it also yields the file size
        // via Content-Range (no separate probe), and a single connection avoids
        // the parallel collision on the single-slot provider. The MKV tail (cues)
        // is fetched lazily on the first seek — the demuxer doesn't need it to open.
        await this._cacheWindow(0, RA_FIRST_WINDOW);
        this._prefetchError = null;
      } catch (e) { this._prefetchError = e; /* load() decides: re-probe, or surface a slot/auth block */ }
    }

    async seek(t) {
      if (this.destroyed || this._seeking || !this.oc) return;
      // Within the buffered range → let the native element seek, no rework.
      if (this._isBuffered(t)) return;
      this._seeking = true;
      const st0 = performance.now();
      const f0 = this._fetchCount, b0 = this._fetchBytes;
      const off = this._offsetForTime(t);
      const warm = off != null && this._raCache.some((w) => off >= w.start && off < w.end);
      let step = 'stopPump';
      try {
        await this._stopPump();
        step = 'reset'; await this._resetForSeek();
        this._smallNextRead = true;        // reach the first frame faster on a cold seek
        step = 'demux'; await this._seekDemuxer(t);
        step = 'clearSB'; await this._clearSourceBuffer();
        // The fresh muxer re-bases its output timeline to 0. Anchor the SourceBuffer
        // to the cue time as a fallback, then _setVideoDts refines it to the real
        // keyframe PTS so the seek lands exactly on target (not at 0 → spinner).
        this._tsAnchor = this._cueTimeForTime(t); if (this._tsAnchor == null) this._tsAnchor = t;
        this._firstVpktPending = true; this._nudgeDone = false;
        step = 'initMuxer'; await this._initMuxer();   // fresh init segment → onwrite
        this._startPump();
        this.seekTimings = {
          warm, setupMs: Math.round(performance.now() - st0),
          fetches: this._fetchCount - f0, fetchKB: Math.round((this._fetchBytes - b0) / 1024),
        };
        this.log('seek ' + JSON.stringify(this.seekTimings));
        try { this.onSeek(this.seekTimings); } catch (_) {}
      } catch (e) {
        this.report({ stage: 'seek:' + step, message: errStr(e) });
      } finally {
        this._seeking = false;
      }
    }

    // Prefetch the bytes for seek target `t` into the read-ahead cache *while the
    // user is still scrubbing*, so the real seek on release hits a warm cache and
    // feels instant. No-op (graceful) when there's no cue index or it's cached.
    async prefetchAt(t) {
      if (this.destroyed || this._prefetching || this._seeking) return;
      const off = this._offsetForTime(t);
      if (off == null || off >= this.size) return;
      for (const w of this._raCache) if (off >= w.start && off < w.end) return; // already warm
      this._prefetching = true;
      try {
        await this._cacheWindow(off, Math.min(RA_FIRST_WINDOW, this.size - off));
        this.log(`prefetch t=${t.toFixed(0)}s off=${off}`);
      } catch (_) { /* a real seek will fetch it */ } finally { this._prefetching = false; }
    }

    // Largest cue offset whose timestamp is ≤ t (the cluster the demuxer will seek to).
    _offsetForTime(t) {
      const idx = this._cueIndex;
      if (!idx || !idx.length) return null;
      if (t <= idx[0].t) return idx[0].off;
      let lo = 0, hi = idx.length - 1, ans = idx[0].off;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (idx[m].t <= t) { ans = idx[m].off; lo = m + 1; } else hi = m - 1; }
      return ans;
    }

    // Largest cue timestamp ≤ t — the real time of the keyframe the demuxer lands
    // on, i.e. where the muxer's re-based-to-0 output must be placed in the SB.
    _cueTimeForTime(t) {
      const idx = this._cueIndex;
      if (!idx || !idx.length) return null;
      if (t <= idx[0].t) return idx[0].t;
      let lo = 0, hi = idx.length - 1, ans = idx[0].t;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (idx[m].t <= t) { ans = idx[m].t; lo = m + 1; } else hi = m - 1; }
      return ans;
    }

    // Seconds of SOURCE time that the player's currentTime is shifted FROM. The muxer
    // re-bases its output to 0 and the SourceBuffer places it at _tsAnchor, so a source
    // frame with PTS S is shown at currentTime (S - vBase) + _tsAnchor. A separate
    // windowed subtitle extractor seeks the SOURCE by absolute time, so to line cues up
    // with the picture it must seek at sourceTime = localTime + (vBase - _tsAnchor).
    // On a FRESH play _tsAnchor is 0, so this equals the file's first-frame PTS — the
    // reason subtitles drift from 00:00 on files whose stream doesn't start at 0. After a
    // resume/seek _initMuxer re-bases vBase to the landed keyframe and _setVideoDts sets
    // _tsAnchor to the same PTS, so it converges to 0. Always ≥ 0; returns 0 until the
    // first video packet has been demuxed (vBase still unknown) or when the stream starts
    // at 0 (the common case), making the subtitle path a no-op for files that already sync.
    subtitleSourceOffset() {
      if (this.vBase == null || !this.vS) return 0;
      const baseSeconds = this.vBase * this.vS.time_base_num / this.vS.time_base_den;
      const offset = baseSeconds - (this._tsAnchor || 0);
      return Number.isFinite(offset) && offset > 0 ? offset : 0;
    }

    destroy() {
      this.destroyed = true;
      this._stopRequested = true;
      // Cancel every in-flight byte-range fetch so the provider connection drops now and
      // the single slot is released for the next title (instead of lingering to timeout).
      try { this._ac.abort(); } catch (_) {}
      if (this._gate) { this._gate(); this._gate = null; }
      try { this.video.removeEventListener('seeking', this._onSeeking); } catch (_) {}
      try { this.video.removeEventListener('timeupdate', this._onTimeUpdate); } catch (_) {}
      // Stop draining: drop any pending segments so a late updateend can't append to the
      // old SourceBuffer after we've detached (fast media-switch race — the real fix for
      // CHUNK_DEMUXER_ERROR_APPEND_FAILED, together with the destroyed-guard in _drain()).
      this.queue.length = 0;
      try { if (this.ms && this.ms.readyState === 'open') this.ms.endOfStream(); } catch (_) {}
      try { if (this._objectUrl) URL.revokeObjectURL(this._objectUrl); } catch (_) {}
      // We deliberately do NOT removeAttribute('src')+load() here: the next engine's
      // _attachMediaSource sets a fresh src, which already runs the media element's reset
      // (drops buffered ranges + pending appends). Clearing it here left an empty-src window
      // where togglePlay()'s video.play() threw "NotSupportedError: no supported sources".
      try { if (this.lib && this.lib.terminate) this.lib.terminate(); } catch (_) {}
      this.lib = null;
    }

    // ---- setup -------------------------------------------------------------
    async _probeSize(url) {
      // Bound the probe so a stalled gateway/provider can't hang the engine; also abort
      // it if the engine is destroyed (so the slot is released immediately).
      const ac = new AbortController();
      const onAbort = () => { try { ac.abort(); } catch (_) {} };
      this._ac.signal.addEventListener('abort', onAbort, { once: true });
      const to = setTimeout(onAbort, 30000);
      let r;
      try {
        r = await fetch(url, { headers: { Range: 'bytes=0-1' }, signal: ac.signal });
      } catch (e) {
        throw new Error('PROBE_FETCH:' + String((e && e.message) || e));
      } finally {
        clearTimeout(to);
        try { this._ac.signal.removeEventListener('abort', onAbort); } catch (_) {}
      }
      const cr = r.headers.get('content-range');
      // A range-honouring origin replies 206 + Content-Range. A 200 means the
      // provider ignored Range and is about to stream the WHOLE file — abort
      // before the body buffers gigabytes and hangs the engine forever.
      if (r.status === 200 && !cr) { try { ac.abort(); } catch (_) {} throw new Error('RANGE_UNSUPPORTED'); }
      if (r.status !== 206 && !r.ok) { try { ac.abort(); } catch (_) {} throw new Error('PROBE_HTTP_' + r.status); }
      const size = cr && cr.includes('/')
        ? parseInt(cr.split('/')[1], 10)
        : parseInt(r.headers.get('content-length') || '0', 10);
      try { ac.abort(); } catch (_) {} // headers are all we need
      if (!Number.isFinite(size) || size <= 0) throw new Error('PROBE_NO_SIZE');
      return size;
    }

    async _openInput() {
      const lib = this.lib, url = this.url, size = this.size;
      await lib.mkblockreaderdev('input', size);
      // _raCache was primed by _prefetchStart in parallel with the wasm load.
      lib.onblockread = async (name, pos, len) => {
        try {
          const want = Math.min(len, Math.max(0, size - pos));
          const data = await this._readRange(pos, want);
          await lib.ff_block_reader_dev_send('input', pos, data);
        } catch (e) {
          this._lastReadError = e;
          await lib.ff_block_reader_dev_send('input', pos, null, { error: e });
        }
      };
      // Capture the source head now (from the prefetched first window) so a demux-open failure can
      // be diagnosed: a real container header vs a provider/proxy error document (HTML/JSON) served
      // with a faked 206 — the usual reason a fully-fetched, authenticated source still "can't be
      // opened" with no read error. Cheap, cache-only, no extra connection.
      this._captureSourceHead();
      // MPEG-TS is now demuxable in-browser (this libav build carries the mpegts demuxer + the
      // h264/hevc/aac parsers it needs), so we no longer bail on a TS head — libav opens it and we
      // remux it like any other container. A TS the engine still can't play (e.g. MPEG-2 video, which
      // we copy but the browser can't decode) fails the SourceBuffer append later, and the player's
      // existing fallback re-routes it to the gateway transcode.
      let fmtCtx, streams;
      try {
        [fmtCtx, streams] = await lib.ff_init_demuxer_file('input');
      } catch (e) {
        // A real read error (RANGE_UNSUPPORTED / BLOCK_HTTP_xxx) wins — surface it verbatim.
        if (this._lastReadError) throw new Error(String(this._lastReadError.message || this._lastReadError));
        // Bytes fetched fine but aren't a video: the provider returned an error page/JSON, not the
        // stream. Surface that precisely so the friendly-error layer can say so (and we stop blaming
        // libav). Otherwise keep the generic DEMUX_OPEN for a genuinely unparseable container.
        const head = this._diag && this._diag.sourceHead;
        if (head && head.notMedia) {
          throw new Error('SOURCE_NOT_MEDIA:' + head.kind + ':' + String(head.ascii || '').trim().slice(0, 48));
        }
        throw new Error('DEMUX_OPEN:' + String((e && e.message) || e));
      }
      this.fmtCtx = fmtCtx; this._streams = streams;
      try {
        const durUs = to64(await lib.AVFormatContext_duration(fmtCtx), await lib.AVFormatContext_durationhi(fmtCtx));
        this.durationSec = durUs > 0 ? durUs / 1e6 : 0;
      } catch (_) { this.durationSec = 0; }
    }

    // MPEG-TS detector: a 188-byte transport stream repeats the 0x47 sync byte every 188 bytes; a
    // 192-byte M2TS has the sync at offset 4. Two aligned sync bytes is a reliable tell (no false
    // positive on mkv/mp4, whose first byte is EBML magic / a box size). Cache-only, no fetch.
    _sourceLooksLikeMpegTs() {
      try {
        const w = this._raCache && this._raCache.find((x) => x.start === 0);
        const b = w && w.buf;
        if (!b || b.length < 189) return false;
        if (b[0] === 0x47 && b[188] === 0x47) return true;                       // 188-byte TS
        if (b.length >= 197 && b[4] === 0x47 && b[196] === 0x47) return true;    // 192-byte M2TS
        return false;
      } catch (_) { return false; }
    }

    // Snapshot the first bytes of the source (from the cached first window — no extra fetch) and
    // classify an obviously non-media head: a provider/proxy that 206s an HTML error page or a JSON
    // error instead of the file. Real containers start with a non-printable box-size / EBML magic,
    // so '<' or '{'/'[' as the first printable byte is a reliable non-media tell (no false positive
    // on mp4/mkv). Stored on the diagnostic snapshot and used to throw a precise SOURCE_NOT_MEDIA.
    _captureSourceHead(n = 64) {
      try {
        if (!this._diag || this._diag.sourceHead) return;
        const w = this._raCache && this._raCache.find((x) => x.start === 0);
        if (!w || !w.buf || !w.buf.length) return;
        const head = w.buf.subarray(0, Math.min(n, w.buf.length));
        let hex = '', ascii = '';
        for (let i = 0; i < head.length; i++) {
          const b = head[i];
          hex += b.toString(16).padStart(2, '0');
          ascii += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.';
        }
        let i0 = 0;
        while (i0 < head.length && (head[i0] === 0x20 || head[i0] === 0x09 || head[i0] === 0x0a || head[i0] === 0x0d)) i0++;
        const c = head[i0];
        let kind = null;
        if (c === 0x3c) kind = 'html';                       // '<'
        else if (c === 0x7b || c === 0x5b) kind = 'json';    // '{' or '['
        this._diag.sourceHead = { hex, ascii, len: head.length, kind, notMedia: !!kind };
      } catch (_) { /* diagnostic only — never throws */ }
    }

    // Serve [pos, pos+len) from a cached window, fetching a fresh RA_WINDOW-sized
    // window from the origin when needed. Collapses libav's many small block
    // reads into a few large upstream requests (key for single-slot providers).
    async _readRange(pos, len) {
      const end = pos + len; // exclusive
      for (const w of this._raCache) {
        if (pos >= w.start && end <= w.end) { this._raTouch(w); return w.buf.subarray(pos - w.start, end - w.start); }
      }
      const small = this._smallNextRead; this._smallNextRead = false;
      const winEnd = Math.min(pos + Math.max(small ? RA_FIRST_WINDOW : RA_WINDOW, len), this.size);
      const w = await this._cacheWindow(pos, winEnd - pos);
      const sliceEnd = Math.min(end, w.end);
      return w.buf.subarray(pos - w.start, Math.max(pos - w.start, sliceEnd - w.start));
    }

    // Fetch [start, start+len) and insert it as a read-ahead window (LRU).
    async _cacheWindow(start, len) {
      const buf = await this._fetchRange(start, start + len);
      const w = { start, end: start + buf.length, buf };
      this._raCache.push(w);
      while (this._raCache.length > RA_WINDOWS) this._raCache.shift();
      return w;
    }

    _raTouch(w) {
      const i = this._raCache.indexOf(w);
      if (i >= 0 && i !== this._raCache.length - 1) { this._raCache.splice(i, 1); this._raCache.push(w); }
    }

    // Build a time→byte index from the Matroska cues so prefetchAt() can map a
    // scrub target to the exact cluster offset. Fully defensive: any failure
    // leaves _cueIndex null and seeking falls back to its normal (cold) path.
    async _buildCueIndex() {
      try {
        if (!this.size || this._cueIndex) return;
        const head = await this._readRange(0, Math.min(RA_FIRST_WINDOW, this.size));
        const segStart = this._findSegmentDataStart(head);
        if (segStart < 0) return;
        const { scaleNs, cuesPos } = this._scanSegmentHead(head, segStart);
        if (cuesPos < 0 || cuesPos >= this.size) return;
        const hdr = await this._readRange(cuesPos, Math.min(16, this.size - cuesPos));
        const idr = ebmlId(hdr, 0); if (!idr || idr.id !== MKV.Cues) return;
        const szr = ebmlSize(hdr, idr.len); if (!szr || szr.unknown) return;
        const dataStart = cuesPos + idr.len + szr.len;
        const dataLen = Math.min(szr.val, this.size - dataStart);
        if (dataLen <= 0 || dataLen > 16 * 1048576) return; // sanity bound
        const cues = await this._readRange(dataStart, dataLen);
        const index = this._parseCuePoints(cues, segStart, scaleNs || 1e6);
        if (index && index.length) { index.sort((a, b) => a.t - b.t); this._cueIndex = index; this.log('cue index: ' + index.length + ' points'); }
      } catch (_) { this._cueIndex = null; }
    }

    // Walk top-level EBML (EBML header, then Segment); return Segment data start.
    _findSegmentDataStart(b) {
      let p = 0;
      while (p < b.length) {
        const idr = ebmlId(b, p); if (!idr) break;
        const szr = ebmlSize(b, p + idr.len); if (!szr) break;
        const dataStart = p + idr.len + szr.len;
        if (idr.id === MKV.Segment) return dataStart;
        if (szr.unknown) break;
        p = dataStart + szr.val;
      }
      return -1;
    }

    // Scan Segment children present in `b` for TimestampScale (Info) and the
    // Cues byte position (via SeekHead, or an inline Cues element).
    _scanSegmentHead(b, segStart) {
      let p = segStart, scaleNs = 1e6, cuesPos = -1;
      while (p < b.length) {
        const idr = ebmlId(b, p); if (!idr) break;
        const szr = ebmlSize(b, p + idr.len); if (!szr) break;
        const ds = p + idr.len + szr.len;
        const de = szr.unknown ? b.length : ds + szr.val;
        if (idr.id === MKV.Info) { const v = this._findChildUint(b, ds, Math.min(de, b.length), MKV.TimestampScale); if (v) scaleNs = v; }
        else if (idr.id === MKV.SeekHead) { const c = this._findCuesInSeekHead(b, ds, Math.min(de, b.length), segStart); if (c >= 0) cuesPos = c; }
        else if (idr.id === MKV.Cues) { cuesPos = p; }
        if (de > b.length) break; // element runs past our buffer
        p = de;
      }
      return { scaleNs, cuesPos };
    }

    _findCuesInSeekHead(b, start, end, segStart) {
      let p = start;
      while (p < end) {
        const idr = ebmlId(b, p); if (!idr) break;
        const szr = ebmlSize(b, p + idr.len); if (!szr) break;
        const ds = p + idr.len + szr.len, de = ds + szr.val;
        if (idr.id === MKV.Seek) {
          let seekId = -1, seekPos = -1, q = ds;
          while (q < de && q < end) {
            const i2 = ebmlId(b, q); if (!i2) break;
            const s2 = ebmlSize(b, q + i2.len); if (!s2) break;
            const d2 = q + i2.len + s2.len;
            if (i2.id === MKV.SeekID) seekId = ebmlUint(b, d2, s2.val);
            else if (i2.id === MKV.SeekPosition) seekPos = ebmlUint(b, d2, s2.val);
            q = d2 + s2.val;
          }
          if (seekId === MKV.Cues && seekPos >= 0) return segStart + seekPos;
        }
        p = de;
      }
      return -1;
    }

    _findChildUint(b, start, end, targetId) {
      let p = start;
      while (p < end) {
        const idr = ebmlId(b, p); if (!idr) break;
        const szr = ebmlSize(b, p + idr.len); if (!szr) break;
        const ds = p + idr.len + szr.len;
        if (idr.id === targetId) return ebmlUint(b, ds, szr.val);
        p = ds + szr.val;
      }
      return 0;
    }

    _parseCuePoints(b, segStart, scaleNs) {
      const out = []; let p = 0;
      while (p < b.length) {
        const idr = ebmlId(b, p); if (!idr) break;
        const szr = ebmlSize(b, p + idr.len); if (!szr) break;
        const ds = p + idr.len + szr.len, de = Math.min(ds + szr.val, b.length);
        if (idr.id === MKV.CuePoint) {
          let time = -1, clusterPos = -1, q = ds;
          while (q < de) {
            const i2 = ebmlId(b, q); if (!i2) break;
            const s2 = ebmlSize(b, q + i2.len); if (!s2) break;
            const d2 = q + i2.len + s2.len, e2 = Math.min(d2 + s2.val, de);
            if (i2.id === MKV.CueTime) time = ebmlUint(b, d2, s2.val);
            else if (i2.id === MKV.CueTrackPositions) {
              let r = d2;
              while (r < e2) {
                const i3 = ebmlId(b, r); if (!i3) break;
                const s3 = ebmlSize(b, r + i3.len); if (!s3) break;
                const d3 = r + i3.len + s3.len;
                if (i3.id === MKV.CueClusterPosition) clusterPos = ebmlUint(b, d3, s3.val);
                r = d3 + s3.val;
              }
            }
            q = e2;
          }
          if (time >= 0 && clusterPos >= 0) out.push({ t: time * scaleNs / 1e9, off: segStart + clusterPos });
        }
        p = de;
      }
      return out;
    }

    // Fetch [start, end) (exclusive) as one ranged request, bounded by a timeout.
    async _fetchRange(start, end) {
      const ac = new AbortController();
      const onAbort = () => { try { ac.abort(); } catch (_) {} };
      this._ac.signal.addEventListener('abort', onAbort, { once: true });
      const to = setTimeout(onAbort, 60000);
      const ft0 = performance.now();
      try {
        const r = await fetch(this.url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: ac.signal });
        // 200 without Content-Range → provider ignored Range and would stream the
        // whole file; bail before buffering gigabytes.
        const cr = r.headers.get('content-range');
        if (r.status === 200 && !cr) { try { ac.abort(); } catch (_) {} throw new Error('RANGE_UNSUPPORTED'); }
        if (r.status !== 206 && r.status !== 200) throw new Error('BLOCK_HTTP_' + r.status);
        // Learn the total file size for free from Content-Range, so the first
        // window fetch doubles as the size probe (one request instead of two).
        if (!this.size && cr && cr.includes('/')) {
          const total = parseInt(cr.split('/')[1], 10);
          if (Number.isFinite(total) && total > 0) this.size = total;
        }
        const out = new Uint8Array(await r.arrayBuffer());
        this._fetchCount += 1; this._fetchBytes += out.length; this._fetchMs += performance.now() - ft0;
        return out;
      } finally {
        clearTimeout(to);
        try { this._ac.signal.removeEventListener('abort', onAbort); } catch (_) {}
      }
    }

    async _detectStreams() {
      const lib = this.lib;
      this.vS = this._streams.find((s) => s.codec_type === 0) || null;
      const audios = this._streams.filter((s) => s.codec_type === 1);
      // Honour a requested audio stream (audio-track switch); else the first audio.
      this.aS = (this._wantAudioIndex != null ? audios.find((s) => s.index === this._wantAudioIndex) : null) || audios[0] || null;
      this.vName = this.vS ? await lib.avcodec_get_name(this.vS.codec_id) : null;
      this.aName = this.aS ? await lib.avcodec_get_name(this.aS.codec_id) : null;
      this.copyAudio = !!(this.aS && AUDIO_COPY.has(this.aName));
      this.V_IDX = 0; this.A_IDX = this.vS ? 1 : 0;
      this.log(`vidéo=${this.vName}${this.aS ? `, audio=${this.aName} (${this.copyAudio ? 'copie' : 'transcodage AAC'})` : ''}`);
    }

    // MPEG-TS carries the H.264 SPS/PPS IN-BAND (annexb), not in the container header — so the video
    // codecpar has no extradata, and the mp4 muxer would write an empty avcC into the moov, which MSE
    // rejects (CHUNK_DEMUXER_ERROR_APPEND_FAILED). Lift the SPS/PPS out of the first keyframe, build
    // the avcC, and inject it onto the stream BEFORE the muxer is set up. No-op for mkv/mp4 (extradata
    // already present) and for non-H.264 video (HEVC TS would need hvcC — handled by gateway fallback).
    async _ensureVideoExtradata() {
      const lib = this.lib;
      if (!this.vS || this.vName !== 'h264') return;
      const cp = await lib.ff_copyout_codecpar(this.vS.codecpar);
      if (cp.extradata && cp.extradata.length > 0) return;
      if (!this.pkt) this.pkt = await lib.av_packet_alloc();
      // AAC stream-copied from TS is ADTS-framed with no esds config — needs the same in-band
      // lift as the video SPS/PPS. Only when copying AAC and the container gave no extradata.
      const acp = (this.aS && this.copyAudio && this.aName === 'aac') ? await lib.ff_copyout_codecpar(this.aS.codecpar) : null;
      const wantAdts = !!(acp && !(acp.extradata && acp.extradata.length > 0));
      try { await this._seekDemuxer(0); } catch (_) { /* read from wherever the demuxer is */ }
      let sps = null, pps = null, asc = null;
      for (let i = 0; i < 24 && !(sps && pps && (asc || !wantAdts)); i++) {
        let res, packets;
        try { [res, packets] = await lib.ff_read_frame_multi(this.fmtCtx, this.pkt, { limit: 256 * 1024 }); }
        catch (_) { break; }
        for (const k in packets) for (const p of packets[k]) {
          if (p.stream_index === this.vS.index) {
            // First video PTS at the stream start = the MPEG-TS epoch (see _ptsEpoch).
            if (this._ptsEpoch === 0) { const e = to64(p.pts, p.ptshi); if (Number.isFinite(e) && e > 0) this._ptsEpoch = e; }
            for (const n of annexbNals(p.data)) {
              const t = n[0] & 0x1f;
              if (t === 7 && !sps) sps = n; else if (t === 8 && !pps) pps = n;
            }
          } else if (wantAdts && p.stream_index === this.aS.index && !asc) {
            asc = adtsToAsc(p.data);
          }
        }
        if (res !== 0 && res !== -lib.EAGAIN) break;
      }
      // Rewind so the pump starts cleanly (the caller seeks to the resume point afterwards).
      try { await this._seekDemuxer(0); } catch (_) {}
      // Audio: inject the AudioSpecificConfig (esds) and arm ADTS-header stripping in the pump,
      // so the mp4 carries raw AAC + a valid config (else MSE rejects the audio).
      if (wantAdts && asc) {
        const aptr = await lib.malloc(asc.length);
        await lib.copyin_u8(aptr, asc);
        await lib.AVCodecParameters_extradata_s(this.aS.codecpar, aptr);
        await lib.AVCodecParameters_extradata_size_s(this.aS.codecpar, asc.length);
        // Force the codecpar sample_rate + channels to MATCH the esds config we just injected.
        // movenc writes the mp4a sample entry from the codecpar; if the TS parser left those 0/
        // stale (or they disagree with the esds), Chrome rejects the audio —
        // PIPELINE_ERROR_DECODE "Failed to send audio packet for decoding". Derived from the ASC.
        const freqIdx = ((asc[0] & 0x7) << 1) | (asc[1] >> 7);
        const chan = (asc[1] >> 3) & 0xf;
        const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
        const sr = AAC_RATES[freqIdx] || 0;
        const ch = chan === 7 ? 8 : chan;
        try { if (sr) await lib.AVCodecParameters_sample_rate_s(this.aS.codecpar, sr); } catch (_) {}
        if (ch) {
          try { await lib.AVCodecParameters_channels_s(this.aS.codecpar, ch); } catch (_) {}
          try { await lib.AVCodecParameters_ch_layout_nb_channels_s(this.aS.codecpar, ch); } catch (_) {}
        }
        this._stripAdts = true;
        if (this._diag) {
          this._diag.injectedAudioAsc = asc.length;
          this._diag.audioCfg = { asc: Array.from(asc).map((b) => (b < 16 ? '0' : '') + b.toString(16)).join(''), sr, ch, aot: (asc[0] >> 3) & 0x1f };
        }
        this.log('TS: injected AAC esds (' + asc.length + ' B, ' + sr + 'Hz/' + ch + 'ch) + armed ADTS strip');
      }
      if (!sps || !pps) { this.log('TS: no in-band SPS/PPS found — H.264 config unavailable'); return; }
      const avcc = buildAvcC(sps, pps);
      const ptr = await lib.malloc(avcc.length);
      await lib.copyin_u8(ptr, avcc);
      await lib.AVCodecParameters_extradata_s(this.vS.codecpar, ptr);
      await lib.AVCodecParameters_extradata_size_s(this.vS.codecpar, avcc.length);
      if (this._diag) this._diag.injectedExtradata = avcc.length;
      // The TS video is annexb; movenc copies it as-is, so the pump must convert each access unit to
      // AVCC (length-prefixed) to match the avcC we just injected — else MSE rejects the mdat.
      this._convertAnnexb = true;
      this.log('TS: injected H.264 avcC (' + avcc.length + ' B) from in-band SPS/PPS');
      // Enumerate subtitle streams (index + codec) for the player's CC menu. libav
      // here can't read the per-stream LANGUAGE, so the language is filled by the
      // gateway probe (same split as audio). Also logs the full stream list.
      this._subStreams = [];
      this._subMeta = new Map();
      try {
        const TY = { 0: 'video', 1: 'audio', 2: 'data', 3: 'subtitle', 4: 'attachment' };
        const parts = [];
        for (const s of (this._streams || [])) {
          let nm = '?';
          try { nm = await lib.avcodec_get_name(s.codec_id); } catch (_) { /* ignore */ }
          parts.push(`${s.index}:${TY[s.codec_type] ?? s.codec_type}=${nm}`);
          if (s.codec_type === 3) {
            const text = TEXT_SUB_CODECS.has(nm);
            this._subStreams.push({ index: s.index, codec: nm, text });
            this._subMeta.set(s.index, { codec: nm, tbNum: s.time_base_num, tbDen: s.time_base_den, text });
          }
        }
        this.log('streams: ' + parts.join('  '));
      } catch (_) { /* best-effort */ }
      // Arm subtitle capture BEFORE the pump starts so no early text-subtitle packet is
      // missed (the demuxer runs ahead of playback; arming late would leave a gap that the
      // playhead has to consume before cues appear — the "delay after selecting" symptom).
      if (this._subCaptureWanted && this.hasInbandSubtitles()) this._subCapture = true;
    }

    // All audio stream indices (absolute container order) + the selected one, so the
    // player can build a switchable language menu and re-load on a chosen track.
    audioStreamIndices() { return (this._streams || []).filter((s) => s.codec_type === 1).map((s) => s.index); }
    currentAudioIndex() { return this.aS ? this.aS.index : null; }
    // Subtitle streams the container carries (absolute index + codec name), so the
    // player can list them and request extraction of a chosen text track from the
    // gateway. Language is not available here (libav limit) — the gateway fills it.
    subtitleStreams() { return Array.isArray(this._subStreams) ? this._subStreams : []; }

    // True when the container carries at least one TEXT subtitle stream we can turn into
    // cues in-band (no provider connection). Image subs (PGS…) don't count — they need OCR.
    hasInbandSubtitles() {
      return !!(this._subMeta && [...this._subMeta.values()].some((m) => m.text));
    }

    // The player calls this when a text subtitle is selected. From then on the pump loop
    // collects every text-subtitle packet (cheap — text is tiny) so the chosen track's
    // cues are available without the gateway's 2nd provider connection (which 458s on a
    // single-slot source). Idempotent.
    enableSubtitleCapture() { this._subCapture = true; }

    // Cues for a subtitle stream in player-LOCAL seconds (already rebased to currentTime),
    // so the caller can addCue() directly. Empty until the first video packet sets vBase.
    getSubtitleCues(streamIndex) {
      const arr = this._subCues.get(Number(streamIndex));
      if (!arr || !arr.length || this.vBase == null || !this.vS) return [];
      const vBaseSec = this.vBase * this.vS.time_base_num / this.vS.time_base_den;
      const anchor = this._tsAnchor || 0;
      const out = [];
      for (const c of arr) {
        const start = (c.startSrc - vBaseSec) + anchor;
        const end = (c.endSrc - vBaseSec) + anchor;
        if (Number.isFinite(start) && end > start) out.push({ start, end, text: c.text });
      }
      return out;
    }

    // Demux-loop hook: append a text-subtitle packet to its stream's cue buffer (SOURCE
    // time). Best-effort; never throws into the remux path.
    _captureSubtitlePacket(p) {
      const meta = this._subMeta && this._subMeta.get(p.stream_index);
      if (!meta || !meta.text || !p.data || !p.data.length || !meta.tbDen) return;
      const arr = this._subCues.get(p.stream_index) || [];
      if (arr.length >= 20000) return; // safety cap (a long film is ~1-2k cues)
      const text = this._subtitlePacketText(p.data, meta.codec);
      if (!text) return;
      const tb = meta.tbNum / meta.tbDen;
      const startSrc = to64(p.pts, p.ptshi) * tb;
      const durTicks = (p.duration && p.duration > 0) ? p.duration : 0;
      const endSrc = durTicks > 0 ? startSrc + durTicks * tb : startSrc + 4; // 4s default when no duration
      if (!Number.isFinite(startSrc)) return;
      arr.push({ startSrc, endSrc, text });
      if (!this._subCues.has(p.stream_index)) this._subCues.set(p.stream_index, arr);
    }

    // Convert a text-subtitle packet payload to plain cue text per codec.
    _subtitlePacketText(data, codec) {
      const dec = this._subTextDecoder || (this._subTextDecoder = new TextDecoder('utf-8', { fatal: false }));
      let raw;
      if (codec === 'mov_text') {
        // tx3g: 2-byte big-endian length prefix + UTF-8 text (+ optional style boxes after).
        if (data.length < 2) return '';
        const len = (data[0] << 8) | data[1];
        raw = dec.decode(data.subarray(2, 2 + Math.min(len, data.length - 2)));
      } else if (codec === 'ass' || codec === 'ssa') {
        // MKV ASS packet: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
        const line = dec.decode(data);
        const parts = line.split(',');
        raw = parts.length >= 9 ? parts.slice(8).join(',') : line;
        raw = raw.replace(/\{\\[^}]*\}/g, '').replace(/\\[Nn]/g, '\n'); // strip override tags, unescape line breaks
      } else {
        raw = dec.decode(data); // subrip / srt / webvtt / text: payload is the text
      }
      return raw.replace(/\r/g, '').replace(/<[^>]+>/g, '').trim();
    }

    async _chooseMime() {
      const lib = this.lib;
      let cands = [];
      if (this.vS) {
        const cp = await lib.ff_copyout_codecpar(this.vS.codecpar);
        const ed = cp.extradata;
        let exact = null;
        if (this.vName === 'h264') exact = avcCodecString(ed);
        else if (this.vName === 'hevc') exact = hevcCodecString(ed);
        if (exact) cands.push(exact);
        cands = cands.concat(VIDEO_FALLBACKS[this.vName] || []);
        this._diag.videoCodecString = exact;
      }
      const aTag = this.aS ? (this.copyAudio ? (AUDIO_MIME[this.aName] || 'mp4a.40.2') : 'mp4a.40.2') : null;
      this._diag.videoCands = cands.slice();
      this._diag.audioTag = aTag;
      this._diag.vName = this.vName; this._diag.aName = this.aName;
      this._diag.copyAudio = this.copyAudio; this._diag.durationSec = this.durationSec;
      const hasMSE = ('MediaSource' in window) && typeof MediaSource.isTypeSupported === 'function';
      for (const v of cands) {
        const mime = 'video/mp4; codecs="' + v + (aTag ? ',' + aTag : '') + '"';
        if (hasMSE && MediaSource.isTypeSupported(mime)) { this.log('mime: ' + mime); this._diag.mime = mime; return mime; }
      }
      throw new Error('NO_SUPPORTED_MIME:' + this.vName + '/' + (this.aName || 'novideoaudio') + ' cands=' + cands.join('|'));
    }

    async _attachMediaSource() {
      // The browser sometimes DEFERS opening a freshly-attached MediaSource (intermittent
      // SOURCEOPEN_TIMEOUT → spinner; a manual retry then works). Two defences: call load()
      // to force the resource-selection algorithm to run NOW, and retry the attach once with
      // a fresh MediaSource before giving up (the player's gateway fallback catches a 2nd miss).
      let lastErr = null;
      for (let attempt = 0; attempt < 2 && !this.destroyed; attempt++) {
        try {
          if (this._objectUrl) { try { URL.revokeObjectURL(this._objectUrl); } catch (_) {} this._objectUrl = null; }
          this.ms = new MediaSource();
          this._objectUrl = URL.createObjectURL(this.ms);
          this.video.src = this._objectUrl;
          try { this.video.load(); } catch (_) {}
          await new Promise((res, rej) => {
            const to = setTimeout(() => rej(new Error('SOURCEOPEN_TIMEOUT')), attempt === 0 ? 8000 : 15000);
            this.ms.addEventListener('sourceopen', () => { clearTimeout(to); res(); }, { once: true });
          });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          this.log('attachMediaSource try ' + (attempt + 1) + ' failed: ' + (e && e.message));
        }
      }
      if (lastErr) throw lastErr;
      this.sb = this.ms.addSourceBuffer(this.mime);
      this.sb.mode = 'segments';
      if (this.durationSec > 0) { try { this.ms.duration = this.durationSec; } catch (_) {} }
      this.sb.addEventListener('updateend', () => this._drain());
      this.sb.addEventListener('error', () => {
        this._diag.sbErrorEvents++;
        try { this.log('SourceBuffer error — snapshot ' + JSON.stringify(this.engineSnapshot())); }
        catch (_) { this.log('SourceBuffer error'); }
      });
    }

    async _initEncoder() {
      const lib = this.lib;
      const r = await lib.ff_init_encoder('aac', {
        ctx: { bit_rate: AAC_BIT_RATE, sample_fmt: lib.AV_SAMPLE_FMT_FLTP, sample_rate: AAC_SAMPLE_RATE, channel_layout: AAC_CHANNEL_LAYOUT },
        time_base: [1, AAC_SAMPLE_RATE],
      });
      this.encCtx = r[1]; this.encFrame = r[2]; this.encPkt = r[3]; this.frameSize = r[4];
      this.encCodecpar = await lib.avcodec_parameters_alloc();
      await lib.avcodec_parameters_from_context(this.encCodecpar, this.encCtx);
      const d = await lib.ff_init_decoder(this.aS.codec_id, this.aS.codecpar);
      this.decCtx = d[1]; this.decPkt = d[2]; this.decFrame = d[3];
    }

    async _initMuxer() {
      const lib = this.lib;
      const streamCtxs = [];
      if (this.vS) streamCtxs.push([this.vS.codecpar, this.vS.time_base_num, this.vS.time_base_den]);
      if (this.aS) streamCtxs.push(this.copyAudio ? [this.aS.codecpar, this.aS.time_base_num, this.aS.time_base_den]
                                                  : [this.encCodecpar, 1, AAC_SAMPLE_RATE]);
      let written = 0;
      this._initSegPending = true;
      // Diagnostics: a fresh muxer emits a new init segment (ftyp+moov) then media
      // fragments. Reset the per-segment capture, bump the init counter, and mark the
      // header-write phase so onwrite can tell init bytes from media bytes.
      const d = this._diag;
      d.muxerInits = (d.muxerInits || 0) + 1;
      d.initBoxes = null; d.initBytes = 0; d.firstMediaBoxes = null; d.firstMediaBytes = 0;
      d.firstVideoPkt = null;
      // Cumulative top-level box walker over the muxer's full output stream (it writes
      // in fixed AVIO blocks that do NOT align to fragment boundaries, so per-chunk
      // box parsing is useless — this stitches them). Reveals the real structure
      // Chromium sees: ftyp moov moof mdat moof mdat … and flags any anomaly (a 2nd
      // moov/ftyp = spurious re-init; a box whose size doesn't add up).
      this._boxCarry = null; d.boxRemain = 0; d.boxSeq = []; d.boxBad = null;
      d.moofCount = 0; d.moovCount = 0; d.ftypCount = 0; d.boxTotal = 0;
      // Write-position trace. A streaming muxer must write strictly forward; if movenc
      // seeks BACK (pos < the running high-water mark) to patch a box size, appending
      // the chunks in call-order to MSE produces a corrupt byte stream (a chunk valid
      // in isolation, broken once concatenated) → CHUNK_DEMUXER_ERROR_APPEND_FAILED.
      // This records the first writes + counts backward seeks so we can prove it.
      d.writes = []; d.seekWrites = 0; d.writeHighWater = 0; d.firstSeek = null;
      this._diagHeaderPhase = true;
      // Remove any stale 'output' device from a prior init (e.g. a re-seek) — it would
      // collide with the fresh device below.
      try { await lib.unlink('output'); } catch (_) {}
      // CRITICAL: create the output as a NON-SEEKABLE stream writer (mkstreamwriterdev),
      // not the seekable writer ff_init_muxer(device:true) would install. On a seekable
      // output movenc patches box sizes by seeking BACKWARD after writing a fragment;
      // since the engine forwards onwrite chunks to MediaSource in call-order, those
      // late patches land at the wrong byte offset and corrupt the stream
      // (CHUNK_DEMUXER_ERROR_APPEND_FAILED — confirmed via seekWrites>0 in diagnostics).
      // A non-seekable output forces movenc into pure streaming mode: it computes every
      // box size up front (frag_keyframe buffers each fragment) and writes strictly
      // forward — exactly what fMP4-over-MSE needs. ff_init_muxer then opens this device
      // instead of creating its own (device:false, open:true).
      await lib.mkstreamwriterdev('output');
      lib.onwrite = (name, pos, data) => {
        // The MP4 trailer (mfra/mfro, written by av_write_trailer) is file-seeking
        // metadata, NOT a media segment. Appending it to the SourceBuffer makes
        // Chromium's parser fail (CHUNK_DEMUXER_ERROR_APPEND_FAILED). It must never
        // be enqueued — endOfStream() finalises the buffer instead.
        if (this._dropWrites) { d.trailerBytesDropped = (d.trailerBytesDropped || 0) + data.length; return; }
        // libav.js hands `data` as a signed Int8Array view into the Emscripten HEAP.
        // Copy it out as an UNSIGNED Uint8Array (reinterpret the same bytes) — the bytes
        // are identical for MSE, but every byte ≥128 must read unsigned or box-size math
        // (b<<24|…) goes negative and corrupts the diagnostics (e.g. 0xA1 -> 0xFFFFFFA1).
        const chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
        // Trace write position vs the running high-water mark BEFORE consuming.
        try {
          const isSeek = pos < d.writeHighWater;
          if (isSeek) { d.seekWrites++; if (d.firstSeek == null) d.firstSeek = { pos, len: chunk.length, highWater: d.writeHighWater, atWrite: d.writes.length }; }
          if (d.writes.length < 40) {
            const rec = { pos, len: chunk.length, seek: isSeek };
            // Small writes are the structural ones (box headers / moof / size fields) —
            // capture their full bytes so the failing tail can be read directly.
            if (chunk.length <= 600) {
              let hx = ''; for (let i = 0; i < chunk.length; i++) hx += (chunk[i] < 16 ? '0' : '') + chunk[i].toString(16);
              rec.hex = hx;
            }
            d.writes.push(rec);
          }
          if (pos + chunk.length > d.writeHighWater) d.writeHighWater = pos + chunk.length;
        } catch (_) {}
        written += chunk.length;
        try {
          if (this._diagHeaderPhase) {
            d.initBytes += chunk.length;
            const boxes = mp4Boxes(chunk);
            d.initBoxes = d.initBoxes ? d.initBoxes + ' + ' + boxes : boxes;
          } else if (d.firstMediaBoxes == null) {
            d.firstMediaBytes = chunk.length;
            d.firstMediaBoxes = mp4Boxes(chunk);
            // Hex of this same chunk's first 16 bytes — compare against boxHex[1]
            // (what the cumulative walker reads at the 2nd box) to confirm whether the
            // call-order concatenation matches the chunk seen in isolation.
            let fh = '';
            for (let i = 0; i < Math.min(16, chunk.length); i++) fh += (chunk[i] < 16 ? '0' : '') + chunk[i].toString(16);
            d.firstMediaHex = fh;
          }
          this._diagTrackBoxes(chunk);
        } catch (_) {}
        this.queue.push(chunk); this._drain();
      };
      const muxRet = await lib.ff_init_muxer(
        { format_name: 'mp4', filename: 'output', open: true, device: false, codecpars: true }, streamCtxs);
      this.oc = muxRet[0];
      // Align the HEVC sample-entry fourcc with the codec string we advertised to
      // MediaSource. ff_init_muxer resets codec_tag to 0 and movenc then defaults
      // HEVC to 'hev1' — but _chooseMime advertises 'hvc1.*' (preferred), and
      // Chromium rejects a 'hev1' init under an 'hvc1' SourceBuffer
      // (CHUNK_DEMUXER_ERROR_APPEND_FAILED). Force the output tag to match the
      // chosen mime. Video is stream 0 when present; H.264 ('avc1') needs nothing.
      if (this.vS && this.vName === 'hevc') {
        const tag = (this.mime && this.mime.includes('hev1')) ? 0x31766568 /* 'hev1' */ : 0x31637668 /* 'hvc1' */;
        const vcp = await lib.AVStream_codecpar(muxRet[3][0]);
        await lib.AVCodecParameters_codec_tag_s(vcp, tag);
      }
      await lib.av_opt_set(this.oc, 'movflags', 'frag_keyframe+empty_moov+default_base_moof', lib.AV_OPT_SEARCH_CHILDREN);
      await lib.avformat_write_header(this.oc, 0);
      // Header (ftyp+moov init segment) flushed; subsequent onwrite chunks are media.
      this._diagHeaderPhase = false;
      this.log('diag init seg: ' + (d.initBoxes || '(none)') + ' bytes=' + d.initBytes + ' mime=' + (this.mime || '?'));
      if (!this.pkt) this.pkt = await lib.av_packet_alloc();
      // reset video DTS grid for this (re)start
      this.vBase = null; this.vCum = 0; this.vFd0 = 0; this.vOffset = 0;
      this.fg = null; this.fsrc = null; this.fsink = null; // filter is lazy per run
      // Drop captured cues: a seek re-demuxes from the new point and re-bases vBase/_tsAnchor,
      // so old-epoch cues would convert to the wrong local time. The player keeps the cues it
      // already added (correct for their times) and re-accumulates as the new region demuxes.
      if (this._subCues) this._subCues.clear();
    }

    async _seekDemuxer(t) {
      const lib = this.lib;
      const s = this.vS || this.aS;
      const tb = s.time_base_den / s.time_base_num;
      // avformat_seek_file wants an ABSOLUTE timestamp (stream epoch + playback time). For
      // MPEG-TS the epoch is non-zero, so omitting it seeks before the stream start and the
      // demuxer clamps to the beginning — the resume reads the wrong region. (epoch is in the
      // video time_base; only add it when seeking that stream; 0 for mp4/mkv → unchanged.)
      const epoch = (s === this.vS) ? (this._ptsEpoch || 0) : 0;
      const ts = Math.max(0, Math.round(t * tb) + epoch);
      const [lo, hi] = from64(ts);
      await lib.avformat_seek_file_approx(this.fmtCtx, s.index, lo, hi, 0);
      this.log(`seek demuxer → ${t.toFixed(1)}s (abs ts ${ts}${epoch ? ', epoch ' + epoch : ''})`);
    }

    // ---- teardown for re-seek ---------------------------------------------
    async _resetForSeek() {
      const lib = this.lib;
      try { if (this.oc) await lib.ff_free_muxer(this.oc); } catch (_) {}
      this.oc = null;
      if (!this.copyAudio && this.aS) {
        try { if (this.fg) await lib.avfilter_graph_free_js(this.fg); } catch (_) {}
        try { if (this.decCtx) await lib.avcodec_flush_buffers(this.decCtx); } catch (_) {}
        // recreate encoder (clean state) — keep decoder (flushed above)
        try { if (this.encCtx) await lib.ff_free_encoder(this.encCtx, this.encFrame, this.encPkt); } catch (_) {}
        const r = await lib.ff_init_encoder('aac', {
          ctx: { bit_rate: AAC_BIT_RATE, sample_fmt: lib.AV_SAMPLE_FMT_FLTP, sample_rate: AAC_SAMPLE_RATE, channel_layout: AAC_CHANNEL_LAYOUT },
          time_base: [1, AAC_SAMPLE_RATE],
        });
        this.encCtx = r[1]; this.encFrame = r[2]; this.encPkt = r[3]; this.frameSize = r[4];
      }
    }

    async _clearSourceBuffer() {
      const sb = this.sb;
      try { sb.abort(); } catch (_) {}
      this.queue.length = 0;
      await new Promise((res) => {
        const done = () => { sb.removeEventListener('updateend', done); res(); };
        try {
          if (sb.buffered.length) { sb.addEventListener('updateend', done); sb.remove(0, Infinity); }
          else res();
        } catch (_) { res(); }
      });
    }

    // ---- the pump (demand-driven remux) ------------------------------------
    _startPump() {
      if (this._pumpRunning) return;
      this._pumpRunning = true; this._stopRequested = false; this.ended = false;
      this._pump().catch((e) => {
        if (this.destroyed) return;
        this.report({ stage: 'pump', message: errStr(e) });
      }).finally(() => { this._pumpRunning = false; });
    }

    async _stopPump() {
      this._stopRequested = true;
      if (this._gate) { this._gate(); this._gate = null; }
      let guard = 0;
      while (this._pumpRunning && guard++ < 2000) await new Promise((r) => setTimeout(r, 5));
    }

    async _pump() {
      const lib = this.lib;
      let res, guard = 0;
      do {
        if (this._stopRequested || this.destroyed) return;
        if (this._bufferedAhead() > BUFFER_AHEAD_MAX) { await this._waitForDrain(); continue; }
        let packets;
        [res, packets] = await lib.ff_read_frame_multi(this.fmtCtx, this.pkt, { limit: 512 * 1024 });
        const writeList = [];
        // Process the video stream FIRST in each batch, so its keyframe gate anchors vBase before any
        // audio in the same batch is evaluated (keeps fresh-start audio while letting a mid-GOP resume
        // hold audio until the keyframe).
        const pktKeys = Object.keys(packets);
        if (this.vS) pktKeys.sort((a, b) => (Number(a) === this.vS.index ? -1 : (Number(b) === this.vS.index ? 1 : 0)));
        for (const k of pktKeys) for (const p of packets[k]) {
          if (this.vS && p.stream_index === this.vS.index) {
            // MSE requires the first video sample of a media segment to be a keyframe. A precise seek
            // (mkv index) lands on one, but an APPROXIMATE seek — MPEG-TS has no exact keyframe index —
            // lands mid-GOP, so the first packet read is a non-keyframe. Drop leading non-key video
            // until the first keyframe BEFORE anchoring vBase, or Chromium rejects the non-IDR first
            // append (CHUNK_DEMUXER_ERROR_APPEND_FAILED — why resuming a .ts failed but a fresh start
            // did not). AV_PKT_FLAG_KEY === 1.
            if (this.vBase === null && !(p.flags & 1)) { this._diag.droppedPreKey = (this._diag.droppedPreKey || 0) + 1; continue; }
            // Open-GOP: after the keyframe, drop leading B-frames whose PTS is BEFORE it (they
            // reference pre-seek frames), so the keyframe is first in presentation order too.
            if (this.vBase !== null && this._gopFloorPts !== null && to64(p.pts, p.ptshi) < this._gopFloorPts) { this._diag.droppedOpenGop++; continue; }
            p.stream_index = this.V_IDX;
            if (this._convertAnnexb) p.data = annexbToAvcc(p.data); // MPEG-TS: annexb → AVCC for mp4
            this._setVideoDts(p); writeList.push(p);
          } else if (this.aS && p.stream_index === this.aS.index) {
            // Hold audio until the first video keyframe is anchored, so a mid-GOP resume starts A/V
            // ALIGNED at the keyframe (no audio lead → no MSE stall). No-op on a fresh start (video is
            // processed first and anchors vBase before any audio) and when there's no video stream.
            if (this.vS && this.vBase === null) { this._diag.droppedPreKeyAudio = (this._diag.droppedPreKeyAudio || 0) + 1; continue; }
            if (this.copyAudio) { p.stream_index = this.A_IDX; if (this._stripAdts) p.data = stripAdts(p.data); writeList.push(p); }
            else {
              const fr = await lib.ff_decode_multi(this.decCtx, this.decPkt, this.decFrame, [p], false);
              const enc = await this._encodeAudio(fr, false);
              for (const ep of enc) writeList.push(ep);
            }
          } else if (this._subCapture && this._subMeta && this._subMeta.has(p.stream_index)) {
            // In-band text subtitles: collect the cue, never mux it (subtitles aren't in
            // the fMP4 output). Best-effort so a malformed packet never breaks playback.
            try { this._captureSubtitlePacket(p); } catch (_) { /* ignore */ }
          }
        }
        if (writeList.length) await lib.ff_write_multi(this.oc, this.pkt, writeList);
        if (++guard > 5000000) { this.report({ stage: 'pump', message: 'guard' }); break; }
      } while ((res === 0 || res === -lib.EAGAIN) && !this._stopRequested && !this.destroyed);

      if (this._stopRequested || this.destroyed) return;
      // Why the read loop ended. A clean AVERROR_EOF is normal end-of-file; anything
      // else means the byte source stopped early (single-slot 458 / dropped provider
      // connection), which is the real cause when a title "ends" after a few seconds.
      const isEof = (typeof lib.AVERROR_EOF === 'number') ? res === lib.AVERROR_EOF : res < 0;
      this._diag.pumpExitReason = this._stopRequested ? 'stop' : (isEof ? 'eof' : 'readerr');
      this._diag.pumpExitRes = res;
      this._diag.lastReadError = this._lastReadError ? errStr(this._lastReadError).slice(0, 200) : null;
      this._diag.exitFetches = this._fetchCount;
      this._diag.exitFetchMB = Math.round((this._fetchBytes / 1048576) * 10) / 10;
      if (!isEof) this.log('pump exit (read stopped early) res=' + res + ' fetched=' + this._diag.exitFetchMB + 'MB lastReadErr=' + (this._diag.lastReadError || '-'));
      // EOF: flush audio + trailer + endOfStream
      if (this.aS && !this.copyAudio) {
        const fr = await lib.ff_decode_multi(this.decCtx, this.decPkt, this.decFrame, [], true);
        const enc = await this._encodeAudio(fr, true);
        if (enc.length) await lib.ff_write_multi(this.oc, this.pkt, enc);
      }
      // Drop the trailer's bytes (mfra/mfro): they are file-seeking metadata, NOT a
      // valid MSE media segment. Appending them is what produced
      // CHUNK_DEMUXER_ERROR_APPEND_FAILED on an early/partial read. endOfStream()
      // below finalises the buffer cleanly without them.
      this._dropWrites = true;
      try { await lib.av_write_trailer(this.oc); } finally { this._dropWrites = false; }
      this.ended = true; this._drain();
      this.log('flux terminé (' + this._diag.pumpExitReason + ')');
    }

    async _encodeAudio(frames, fin) {
      const lib = this.lib;
      if (!this.fg && frames.length) {
        const fr = frames[0];
        const itb = (fr.time_base_den > 0) ? [fr.time_base_num, fr.time_base_den] : [this.aS.time_base_num, this.aS.time_base_den];
        const g = await lib.ff_init_filter_graph('anull',
          { type: 1, sample_rate: fr.sample_rate, sample_fmt: fr.format, channel_layout: fr.channel_layout, time_base: itb },
          { type: 1, sample_rate: AAC_SAMPLE_RATE, sample_fmt: lib.AV_SAMPLE_FMT_FLTP, channel_layout: AAC_CHANNEL_LAYOUT, frame_size: this.frameSize });
        this.fg = g[0]; this.fsrc = g[1]; this.fsink = g[2];
      }
      if (!this.fg) return [];
      const ff = await lib.ff_filter_multi(this.fsrc, this.fsink, this.encFrame, frames, !!fin);
      const pk = await lib.ff_encode_multi(this.encCtx, this.encFrame, this.encPkt, ff, !!fin);
      for (const p of pk) p.stream_index = this.A_IDX;
      return pk;
    }

    _setVideoDts(p) {
      const pts = to64(p.pts, p.ptshi);
      if (this._firstVpktPending && this.vS) {
        // Real keyframe PTS → exact placement of the re-based-to-0 output. Subtract the MPEG-TS
        // epoch so the anchor is PLAYBACK-relative (matching video.currentTime); 0 for mp4/mkv.
        this._tsAnchor = (pts - (this._ptsEpoch || 0)) * this.vS.time_base_num / this.vS.time_base_den;
        this._firstVpktPending = false;
      }
      if (this.vBase === null) { this.vBase = pts; this.vFd0 = (p.duration || 0) > 0 ? p.duration : 1; this.vOffset = D_REORDER * this.vFd0; this._gopFloorPts = pts; }
      const [lo, hi] = from64(this.vBase + this.vCum - this.vOffset);
      p.dts = lo; p.dtshi = hi;
      this.vCum += (p.duration || 0) > 0 ? p.duration : 1;
      // Diagnostics: the first video packet of a segment must be a keyframe in
      // presentation order, or Chromium rejects the media fragment append. Record it.
      if (this._diag && this._diag.firstVideoPkt == null) {
        this._diag.firstVideoPkt = {
          ptsSrc: pts, dtsHL: hi + ':' + lo, key: !!(p.flags & 1),
          dur: p.duration || 0, anchor: this._tsAnchor, gopFloor: this._gopFloorPts,
        };
      }
    }

    // ---- MSE buffer plumbing ----------------------------------------------
    _drain() {
      if (this.destroyed) return; // a late updateend after destroy must not append to a dead pipe
      const sb = this.sb;
      if (!sb || sb.updating) return;
      // Resume/seek lands on the nearest keyframe, which an APPROXIMATE seek can place AFTER the
      // requested time — so the first buffered byte sits ahead of video.currentTime, the playhead
      // is in a gap with no data, and the element stalls forever ("calé", no audio, frozen). Once
      // the first media is buffered, nudge the playhead onto it. One-shot per seek/resume; the
      // target is inside the buffer so _handleSeeking ignores it (no re-demux).
      // NB: do NOT guard on !video.seeking — on resume the element is STUCK seeking to the
      // (dataless) requested time, so seeking stays true forever and the guard would block the
      // very nudge that unsticks it. Setting currentTime here just retargets that pending seek.
      if (!this._nudgeDone && this.video && sb.buffered.length) {
        try {
          const bs = sb.buffered.start(0);
          if (this.video.currentTime < bs - 0.5) {
            this._skipSeekTo = bs + 0.05;
            this.log('nudge playhead ' + this.video.currentTime.toFixed(2) + ' → ' + (bs + 0.05).toFixed(2) + ' (seek landed past target)');
            this.video.currentTime = bs + 0.05;
          }
          this._nudgeDone = true;
        } catch (_) { /* retry on the next drain */ }
      }
      // Apply the seek/resume placement offset before appending media (only when
      // idle; harmless on the sample-less init segment).
      if (this._tsAnchor !== this._tsApplied) { try { sb.timestampOffset = this._tsAnchor; this._tsApplied = this._tsAnchor; } catch (_) {} }
      if (this.queue.length) {
        const chunk = this.queue.shift();
        const d = this._diag;
        try {
          sb.appendBuffer(chunk);
          d.appendCount++; d.appendBytes += chunk.length;
          // Keep the box layout of the last few appends. The fatal
          // CHUNK_DEMUXER_ERROR_APPEND_FAILED is reported asynchronously on the
          // element (not thrown here), so the chunk that broke the parser is the most
          // recent append at the time the 'error' event fires — this ring exposes it.
          d.recentAppends.push({ n: d.appendCount, bytes: chunk.length, boxes: mp4Boxes(chunk), tsOffset: this._tsApplied });
          if (d.recentAppends.length > 6) d.recentAppends.shift();
        } catch (e) {
          // The synchronous throw here is usually QuotaExceededError / InvalidState;
          // a bad-bytes rejection arrives later on the element as
          // CHUNK_DEMUXER_ERROR_APPEND_FAILED. Capture both, with what the chunk held.
          const rec = {
            n: d.appendCount, bytes: chunk.length, boxes: mp4Boxes(chunk),
            err: errStr(e), sbUpdating: sb.updating,
            msState: this.ms && this.ms.readyState, tsOffset: this._tsApplied,
          };
          if (d.appendErrors.length < 8) d.appendErrors.push(rec);
          this.log('append err #' + d.appendCount + ' [' + rec.boxes + '] ' + rec.err);
        }
      } else if (this.ended && this.ms && this.ms.readyState === 'open') { try { this.ms.endOfStream(); } catch (_) {} }
    }

    _bufferedAhead() {
      try {
        const sb = this.sb, t = this.video.currentTime;
        for (let i = 0; i < sb.buffered.length; i++) {
          if (sb.buffered.start(i) <= t + 0.25 && sb.buffered.end(i) >= t) return sb.buffered.end(i) - t;
        }
      } catch (_) {}
      return 0;
    }

    // Stitch the muxer's AVIO-block writes back into a top-level box sequence. State
    // lives on this._boxCarry (a partial box header straddling two blocks) and
    // this._diag.boxRemain (bytes left in the box currently being skipped). Diagnostics
    // only; swallows everything.
    _diagTrackBoxes(chunk) {
      const d = this._diag;
      d.boxTotal += chunk.length;
      let buf = chunk;
      if (this._boxCarry && this._boxCarry.length) {
        buf = new Uint8Array(this._boxCarry.length + chunk.length);
        buf.set(this._boxCarry, 0); buf.set(chunk, this._boxCarry.length);
        this._boxCarry = null;
      }
      let p = 0;
      const len = buf.length;
      let steps = 0;
      while (steps++ < 100000) {
        if (d.boxRemain > 0) {                 // inside a box body → skip
          const skip = Math.min(d.boxRemain, len - p);
          d.boxRemain -= skip; p += skip;
          if (p >= len) return;                // body continues into next block
        }
        if (len - p < 8) { this._boxCarry = p < len ? buf.slice(p) : null; return; }
        let size = ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;
        const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
        let hdr = 8;
        if (size === 1) {
          if (len - p < 16) { this._boxCarry = buf.slice(p); return; }
          size = (((buf[p + 8] << 24) | (buf[p + 9] << 16) | (buf[p + 10] << 8) | buf[p + 11]) >>> 0) * 4294967296
               + (((buf[p + 12] << 24) | (buf[p + 13] << 16) | (buf[p + 14] << 8) | buf[p + 15]) >>> 0);
          hdr = 16;
        } else if (size === 0) { size = (len - p); }
        // Raw hex of the first few box headers — the ground truth of what bytes are
        // actually at each boundary (settles any size/type ambiguity).
        if (!d.boxHex) d.boxHex = [];
        if (d.boxHex.length < 6) {
          let hx = '';
          for (let i = p; i < Math.min(p + 16, len); i++) hx += (buf[i] < 16 ? '0' : '') + buf[i].toString(16);
          d.boxHex.push(hx);
        }
        if (!/^[\x20-\x7e]{4}$/.test(type) || size < hdr) {
          if (!d.boxBad) d.boxBad = 'bad box after ' + d.boxSeq.length + ' boxes (~' + Math.round(d.boxTotal / 1024) + 'KB) type="' + type + '" size=' + size;
          return;                              // desynced — stop, the bad-box marker is the finding
        }
        if (type === 'moof') d.moofCount++;
        else if (type === 'moov') d.moovCount++;
        else if (type === 'ftyp') d.ftypCount++;
        // Keep a compact sequence: collapse runs of moof/mdat so it stays readable.
        if (d.boxSeq.length < 60) d.boxSeq.push(type + '(' + size + ')');
        else if (d.boxSeq[d.boxSeq.length - 1] !== '…') d.boxSeq.push('…');
        p += hdr; d.boxRemain = size - hdr;
      }
    }

    // Full picture of what the engine fed MediaSource + the live element/buffer state.
    // Built for the CHUNK_DEMUXER_ERROR_APPEND_FAILED post-mortem: pairs the codec/box
    // decisions (from _diag) with the current SourceBuffer/MediaSource/video status so a
    // rejected append is explained, not just reported. Read-only, never throws.
    engineSnapshot() {
      const d = this._diag || {};
      const snap = {
        engineVersion: ENGINE_VERSION,
        url: this.url ? String(this.url).slice(0, 120) : null,
        size: this.size,
        // codec / mime decisions
        mime: d.mime, vName: d.vName, aName: d.aName,
        videoCodecString: d.videoCodecString, videoCands: d.videoCands, audioTag: d.audioTag,
        copyAudio: d.copyAudio, durationSec: d.durationSec,
        // what the muxer emitted
        muxerInits: d.muxerInits, initBoxes: d.initBoxes, initBytes: d.initBytes,
        firstMediaBoxes: d.firstMediaBoxes, firstMediaBytes: d.firstMediaBytes,
        firstVideoPkt: d.firstVideoPkt, droppedOpenGop: d.droppedOpenGop,
        droppedPreKey: d.droppedPreKey || 0, droppedPreKeyAudio: d.droppedPreKeyAudio || 0,
        injectedExtradata: d.injectedExtradata || 0, injectedAudioAsc: d.injectedAudioAsc || 0, stripAdts: !!this._stripAdts, audioCfg: d.audioCfg || null,
        // full top-level box stream the muxer produced (stitched across AVIO blocks)
        boxSeq: d.boxSeq, boxBad: d.boxBad, boxTotalKB: d.boxTotal != null ? Math.round(d.boxTotal / 1024) : null,
        moofCount: d.moofCount, moovCount: d.moovCount, ftypCount: d.ftypCount,
        boxHex: d.boxHex, firstMediaHex: d.firstMediaHex,
        // first bytes of the source (set on a demux-open failure): tells a real container apart
        // from a provider error page/JSON served with a faked 206 (the no-read-error open failure).
        sourceHead: d.sourceHead,
        // True when the source bytes are MPEG-TS (0x47 sync stride). The engine now demuxes TS, but a
        // TS whose video the browser can't decode (MPEG-2, unsupported HEVC) fails at append — the
        // player uses this to fall back to the gateway transcode instead of a dead-end banner.
        looksLikeMpegTs: this._sourceLooksLikeMpegTs(),
        // write-position trace: backward seeks here mean the muxer is NOT streaming
        // linearly and call-order concatenation corrupts the stream.
        writes: d.writes, seekWrites: d.seekWrites, firstSeek: d.firstSeek, writeHighWater: d.writeHighWater,
        // append accounting
        appendCount: d.appendCount, appendBytes: d.appendBytes,
        recentAppends: d.recentAppends, appendErrors: d.appendErrors,
        sbErrorEvents: d.sbErrorEvents, trailerBytesDropped: d.trailerBytesDropped,
        queueLen: this.queue ? this.queue.length : null,
        // why the read loop stopped (early stop = source died, e.g. single-slot 458)
        pumpExitReason: d.pumpExitReason, pumpExitRes: d.pumpExitRes,
        lastReadError: d.lastReadError, exitFetches: d.exitFetches, exitFetchMB: d.exitFetchMB,
        // pipeline / timing state
        tsAnchor: this._tsAnchor, tsApplied: this._tsApplied, ptsEpoch: this._ptsEpoch,
        vBase: this.vBase, gopFloorPts: this._gopFloorPts,
        ended: this.ended, destroyed: this.destroyed,
        pumpRunning: this._pumpRunning, seeking: this._seeking,
        timings: this.timings,
      };
      try {
        const sb = this.sb;
        if (sb) {
          const ranges = [];
          for (let i = 0; i < sb.buffered.length; i++) ranges.push([+sb.buffered.start(i).toFixed(2), +sb.buffered.end(i).toFixed(2)]);
          snap.sb = { updating: sb.updating, mode: sb.mode, timestampOffset: sb.timestampOffset, buffered: ranges };
        } else snap.sb = null;
      } catch (e) { snap.sb = 'err:' + errStr(e); }
      try { snap.ms = this.ms ? { readyState: this.ms.readyState, duration: this.ms.duration, sbCount: this.ms.sourceBuffers && this.ms.sourceBuffers.length } : null; }
      catch (e) { snap.ms = 'err:' + errStr(e); }
      try {
        const v = this.video;
        let vbuf = [];
        try { for (let i = 0; i < v.buffered.length; i++) vbuf.push([+v.buffered.start(i).toFixed(2), +v.buffered.end(i).toFixed(2)]); } catch (_) {}
        snap.video = v ? {
          readyState: v.readyState, networkState: v.networkState,
          currentTime: +(.0 + v.currentTime).toFixed(2), paused: v.paused, buffered: vbuf,
          error: v.error ? { code: v.error.code, message: v.error.message || '' } : null,
          hasSrc: !!v.src, currentSrcKind: v.currentSrc ? (v.currentSrc.startsWith('blob:') ? 'blob' : 'other') : null,
        } : null;
      } catch (e) { snap.video = 'err:' + errStr(e); }
      return snap;
    }

    _isBuffered(t) {
      try {
        const sb = this.sb;
        for (let i = 0; i < sb.buffered.length; i++) if (sb.buffered.start(i) <= t && sb.buffered.end(i) > t + 0.5) return true;
      } catch (_) {}
      return false;
    }

    _waitForDrain() {
      return new Promise((res) => {
        let done = false;
        const finish = () => { if (done) return; done = true; this._gate = null; res(); };
        this._gate = finish;
        // safety: also re-check on a timer in case timeupdate stalls (paused)
        const tick = () => {
          if (done) return;
          if (this._stopRequested || this.destroyed || this._bufferedAhead() < BUFFER_AHEAD_MIN) finish();
          else setTimeout(tick, 250);
        };
        setTimeout(tick, 250);
      });
    }

    _handleTimeUpdate() {
      if (this._gate && this._bufferedAhead() < BUFFER_AHEAD_MIN) { const g = this._gate; this._gate = null; g(); }
    }

    _handleSeeking() {
      const t = this.video.currentTime;
      // Ignore the self-induced seeking event from the engine's own resume
      // currentTime set (load already positioned the demuxer + pump there).
      if (this._skipSeekTo != null && Math.abs(t - this._skipSeekTo) < 1.5) { this._skipSeekTo = null; return; }
      if (!this._isBuffered(t)) this.seek(t);
    }
  }

  window.NorvaEngine = NorvaEngine;
  // Warm the libav module import as soon as this script loads, so the dynamic
  // import + parse is done (and the browser can start fetching the wasm) before
  // the user presses play. Errors are ignored; load() retries/​surfaces them.
  try { loadLibavFactory().catch(() => {}); } catch (_) {}
})();
