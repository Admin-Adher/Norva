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
  // Generic fallbacks if extradata parsing yields an unsupported string.
  const VIDEO_FALLBACKS = {
    h264: ['avc1.640028', 'avc1.4d4028', 'avc1.42e01e'],
    hevc: ['hvc1.1.6.L150.90', 'hvc1.2.4.L150.90', 'hev1.1.6.L150.90'],
    vp9: ['vp09.00.10.08'],
    av1: ['av01.0.08M.08'],
  };

  const ENGINE_VERSION = 15;

  class NorvaEngine {
    constructor(videoEl, opts = {}) {
      this.video = videoEl;
      this.report = typeof opts.report === 'function' ? opts.report : () => {};
      this.log = typeof opts.log === 'function' ? opts.log : () => {};
      this.onReady = typeof opts.onReady === 'function' ? opts.onReady : () => {};
      this.onSeek = typeof opts.onSeek === 'function' ? opts.onSeek : () => {};
      this._cueIndex = null;      // [{t, off}] time→byte index from MKV cues
      this._prefetching = false;  // single-flight guard for scrub prefetch
      this._smallNextRead = false;// next demuxer read after a seek uses a small window
      // The muxer re-bases output to 0; _tsAnchor is the real time muxer-0 maps to,
      // applied via SourceBuffer.timestampOffset so seeks/resume land on target.
      this._tsAnchor = 0; this._tsApplied = 0; this._firstVpktPending = false;
      this._skipSeekTo = null;    // suppress the self-induced seeking event on resume
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
      this.timings.wasmMs = Math.round(performance.now() - t0);
      this.log(`libav prêt (${this.lib.libavjsMode}) en ${(this.timings.wasmMs / 1000).toFixed(1)}s`);

      let m = performance.now();
      await prefetchP;
      if (!this.size) this.size = await this._probeSize(url);
      this.timings.probeMs = Math.round(performance.now() - m);
      m = performance.now(); await this._openInput(); this.timings.openInputMs = Math.round(performance.now() - m);
      m = performance.now(); await this._detectStreams(); this.mime = await this._chooseMime(); this.timings.detectMimeMs = Math.round(performance.now() - m);
      m = performance.now(); await this._attachMediaSource(); this.timings.mediaSourceMs = Math.round(performance.now() - m);
      m = performance.now(); if (this.copyAudio === false && this.aS) await this._initEncoder(); this.timings.encoderMs = Math.round(performance.now() - m);
      m = performance.now(); await this._initMuxer(); this.timings.muxerMs = Math.round(performance.now() - m);
      m = performance.now();
      if (startTime > 0.25) {
        // Resume: anchor the SB to the resume point (refined to the real keyframe
        // PTS by _setVideoDts) so data lands at startTime, not at 0.
        this._tsAnchor = startTime; this._firstVpktPending = true;
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
      } catch (_) { /* load()'s fallback probe / _openInput surface the real error */ }
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
        this._firstVpktPending = true;
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

    destroy() {
      this.destroyed = true;
      this._stopRequested = true;
      if (this._gate) { this._gate(); this._gate = null; }
      try { this.video.removeEventListener('seeking', this._onSeeking); } catch (_) {}
      try { this.video.removeEventListener('timeupdate', this._onTimeUpdate); } catch (_) {}
      try { if (this.ms && this.ms.readyState === 'open') this.ms.endOfStream(); } catch (_) {}
      try { if (this.video.src && this.video.src.startsWith('blob:')) URL.revokeObjectURL(this.video.src); } catch (_) {}
      try { if (this.lib && this.lib.terminate) this.lib.terminate(); } catch (_) {}
      this.lib = null;
    }

    // ---- setup -------------------------------------------------------------
    async _probeSize(url) {
      // Bound the probe so a stalled gateway/provider can't hang the engine.
      const ac = new AbortController();
      const to = setTimeout(() => { try { ac.abort(); } catch (_) {} }, 30000);
      let r;
      try {
        r = await fetch(url, { headers: { Range: 'bytes=0-1' }, signal: ac.signal });
      } catch (e) {
        throw new Error('PROBE_FETCH:' + String((e && e.message) || e));
      } finally {
        clearTimeout(to);
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
      let fmtCtx, streams;
      try {
        [fmtCtx, streams] = await lib.ff_init_demuxer_file('input');
      } catch (e) {
        // Surface the real fetch reason (RANGE_UNSUPPORTED / BLOCK_HTTP_xxx)
        // instead of libav's generic "error opening input".
        throw new Error(this._lastReadError
          ? String(this._lastReadError.message || this._lastReadError)
          : ('DEMUX_OPEN:' + String((e && e.message) || e)));
      }
      this.fmtCtx = fmtCtx; this._streams = streams;
      try {
        const durUs = to64(await lib.AVFormatContext_duration(fmtCtx), await lib.AVFormatContext_durationhi(fmtCtx));
        this.durationSec = durUs > 0 ? durUs / 1e6 : 0;
      } catch (_) { this.durationSec = 0; }
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
      const to = setTimeout(() => { try { ac.abort(); } catch (_) {} }, 60000);
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
      // Enumerate subtitle streams (index + codec) for the player's CC menu. libav
      // here can't read the per-stream LANGUAGE, so the language is filled by the
      // gateway probe (same split as audio). Also logs the full stream list.
      this._subStreams = [];
      try {
        const TY = { 0: 'video', 1: 'audio', 2: 'data', 3: 'subtitle', 4: 'attachment' };
        const parts = [];
        for (const s of (this._streams || [])) {
          let nm = '?';
          try { nm = await lib.avcodec_get_name(s.codec_id); } catch (_) { /* ignore */ }
          parts.push(`${s.index}:${TY[s.codec_type] ?? s.codec_type}=${nm}`);
          if (s.codec_type === 3) this._subStreams.push({ index: s.index, codec: nm });
        }
        this.log('streams: ' + parts.join('  '));
      } catch (_) { /* best-effort */ }
    }

    // All audio stream indices (absolute container order) + the selected one, so the
    // player can build a switchable language menu and re-load on a chosen track.
    audioStreamIndices() { return (this._streams || []).filter((s) => s.codec_type === 1).map((s) => s.index); }
    currentAudioIndex() { return this.aS ? this.aS.index : null; }
    // Subtitle streams the container carries (absolute index + codec name), so the
    // player can list them and request extraction of a chosen text track from the
    // gateway. Language is not available here (libav limit) — the gateway fills it.
    subtitleStreams() { return Array.isArray(this._subStreams) ? this._subStreams : []; }

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
      }
      const aTag = this.aS ? (this.copyAudio ? (AUDIO_MIME[this.aName] || 'mp4a.40.2') : 'mp4a.40.2') : null;
      const hasMSE = ('MediaSource' in window) && typeof MediaSource.isTypeSupported === 'function';
      for (const v of cands) {
        const mime = 'video/mp4; codecs="' + v + (aTag ? ',' + aTag : '') + '"';
        if (hasMSE && MediaSource.isTypeSupported(mime)) { this.log('mime: ' + mime); return mime; }
      }
      throw new Error('NO_SUPPORTED_MIME:' + this.vName + '/' + (this.aName || 'novideoaudio') + ' cands=' + cands.join('|'));
    }

    async _attachMediaSource() {
      this.ms = new MediaSource();
      this.video.src = URL.createObjectURL(this.ms);
      await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error('SOURCEOPEN_TIMEOUT')), 15000);
        this.ms.addEventListener('sourceopen', () => { clearTimeout(to); res(); }, { once: true });
      });
      this.sb = this.ms.addSourceBuffer(this.mime);
      this.sb.mode = 'segments';
      if (this.durationSec > 0) { try { this.ms.duration = this.durationSec; } catch (_) {} }
      this.sb.addEventListener('updateend', () => this._drain());
      this.sb.addEventListener('error', () => this.log('SourceBuffer error'));
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
      // ff_init_muxer(device:true) re-creates the 'output' writer device; remove
      // any stale one from a prior init (e.g. a re-seek) or it can collide.
      try { await lib.unlink('output'); } catch (_) {}
      lib.onwrite = (name, pos, data) => { written += data.length; this.queue.push(data.slice(0)); this._drain(); };
      const muxRet = await lib.ff_init_muxer(
        { format_name: 'mp4', filename: 'output', open: true, device: true, codecpars: true }, streamCtxs);
      this.oc = muxRet[0];
      await lib.av_opt_set(this.oc, 'movflags', 'frag_keyframe+empty_moov+default_base_moof', lib.AV_OPT_SEARCH_CHILDREN);
      await lib.avformat_write_header(this.oc, 0);
      if (!this.pkt) this.pkt = await lib.av_packet_alloc();
      // reset video DTS grid for this (re)start
      this.vBase = null; this.vCum = 0; this.vFd0 = 0; this.vOffset = 0;
      this.fg = null; this.fsrc = null; this.fsink = null; // filter is lazy per run
    }

    async _seekDemuxer(t) {
      const lib = this.lib;
      const s = this.vS || this.aS;
      const tb = s.time_base_den / s.time_base_num;
      const ts = Math.max(0, Math.round(t * tb));
      const [lo, hi] = from64(ts);
      await lib.avformat_seek_file_approx(this.fmtCtx, s.index, lo, hi, 0);
      this.log(`seek demuxer → ${t.toFixed(1)}s`);
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
        for (const k in packets) for (const p of packets[k]) {
          if (this.vS && p.stream_index === this.vS.index) {
            p.stream_index = this.V_IDX; this._setVideoDts(p); writeList.push(p);
          } else if (this.aS && p.stream_index === this.aS.index) {
            if (this.copyAudio) { p.stream_index = this.A_IDX; writeList.push(p); }
            else {
              const fr = await lib.ff_decode_multi(this.decCtx, this.decPkt, this.decFrame, [p], false);
              const enc = await this._encodeAudio(fr, false);
              for (const ep of enc) writeList.push(ep);
            }
          }
        }
        if (writeList.length) await lib.ff_write_multi(this.oc, this.pkt, writeList);
        if (++guard > 5000000) { this.report({ stage: 'pump', message: 'guard' }); break; }
      } while ((res === 0 || res === -lib.EAGAIN) && !this._stopRequested && !this.destroyed);

      if (this._stopRequested || this.destroyed) return;
      // EOF: flush audio + trailer + endOfStream
      if (this.aS && !this.copyAudio) {
        const fr = await lib.ff_decode_multi(this.decCtx, this.decPkt, this.decFrame, [], true);
        const enc = await this._encodeAudio(fr, true);
        if (enc.length) await lib.ff_write_multi(this.oc, this.pkt, enc);
      }
      await lib.av_write_trailer(this.oc);
      this.ended = true; this._drain();
      this.log('flux terminé (EOF)');
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
        // Real keyframe PTS → exact placement of the re-based-to-0 output.
        this._tsAnchor = pts * this.vS.time_base_num / this.vS.time_base_den;
        this._firstVpktPending = false;
      }
      if (this.vBase === null) { this.vBase = pts; this.vFd0 = (p.duration || 0) > 0 ? p.duration : 1; this.vOffset = D_REORDER * this.vFd0; }
      const [lo, hi] = from64(this.vBase + this.vCum - this.vOffset);
      p.dts = lo; p.dtshi = hi;
      this.vCum += (p.duration || 0) > 0 ? p.duration : 1;
    }

    // ---- MSE buffer plumbing ----------------------------------------------
    _drain() {
      const sb = this.sb;
      if (!sb || sb.updating) return;
      // Apply the seek/resume placement offset before appending media (only when
      // idle; harmless on the sample-less init segment).
      if (this._tsAnchor !== this._tsApplied) { try { sb.timestampOffset = this._tsAnchor; this._tsApplied = this._tsAnchor; } catch (_) {} }
      if (this.queue.length) { try { sb.appendBuffer(this.queue.shift()); } catch (e) { this.log('append err ' + errStr(e)); } }
      else if (this.ended && this.ms && this.ms.readyState === 'open') { try { this.ms.endOfStream(); } catch (_) {} }
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
