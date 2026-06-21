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
  const RA_WINDOW = 4 * 1024 * 1024; // bytes fetched per window
  const RA_WINDOWS = 4;              // windows kept (header + cues + playhead)

  const AAC_SAMPLE_RATE = 48000;
  const AAC_CHANNEL_LAYOUT = 3; // stereo
  const AAC_BIT_RATE = 192000;
  const D_REORDER = 16; // video DTS reconstruction reorder depth (frames)

  const to64 = (lo, hi) => hi * 4294967296 + (lo >>> 0);
  const from64 = (v) => { const hi = Math.floor(v / 4294967296); return [(v - hi * 4294967296) >>> 0, hi]; };
  const hex2 = (n) => n.toString(16).padStart(2, '0');

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

  class NorvaEngine {
    constructor(videoEl, opts = {}) {
      this.video = videoEl;
      this.report = typeof opts.report === 'function' ? opts.report : () => {};
      this.log = typeof opts.log === 'function' ? opts.log : () => {};
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
    async load(url, { startTime = 0 } = {}) {
      this.url = url;
      const t0 = performance.now();
      this.loadStartedAt = t0;
      // Kick off wasm AND the initial network at the same time: the wasm compile
      // (~3 MB) overlaps fetching the file size + first window + MKV tail, so
      // _openInput's demuxer reads hit the cache instead of waiting on the net.
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
        await this._seekDemuxer(startTime);
        try { this.video.currentTime = startTime; } catch (_) {}
      }
      this.timings.seekMs = Math.round(performance.now() - m);
      this.timings.loadTotalMs = Math.round(performance.now() - t0);
      this.timings.fetches = this._fetchCount;
      this.timings.fetchMB = Math.round((this._fetchBytes / 1048576) * 10) / 10;
      this.timings.fetchMs = Math.round(this._fetchMs);
      this.timings.audio = this.copyAudio ? 'copy' : 'aac';
      this.log('timings ' + JSON.stringify(this.timings));
      this.video.addEventListener('seeking', this._onSeeking);
      this.video.addEventListener('timeupdate', this._onTimeUpdate);
      this._startPump();
    }

    // Fetch file size + first window (+ MKV tail for cues) up front so they're
    // cached by the time the demuxer reads. Runs in parallel with the wasm load;
    // failures are swallowed here and re-surfaced by _openInput's real reads.
    async _prefetchStart() {
      try {
        this.size = await this._probeSize(this.url);
        if (!this.size) return;
        const jobs = [this._readRange(0, Math.min(RA_WINDOW, this.size))];
        if (this.size > RA_WINDOW + 1048576) {
          const tailLen = Math.min(1048576, this.size);
          jobs.push(this._readRange(this.size - tailLen, tailLen));
        }
        await Promise.allSettled(jobs);
      } catch (_) { /* _openInput surfaces the real error */ }
    }

    async seek(t) {
      if (this.destroyed || this._seeking || !this.oc) return;
      // Within the buffered range → let the native element seek, no rework.
      if (this._isBuffered(t)) return;
      this._seeking = true;
      try {
        await this._stopPump();
        await this._resetForSeek();
        await this._seekDemuxer(t);
        await this._clearSourceBuffer();
        await this._initMuxer();           // fresh init segment → onwrite
        this._startPump();
      } catch (e) {
        this.report({ stage: 'seek', message: String(e && (e.message || e)) });
      } finally {
        this._seeking = false;
      }
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
      const winStart = pos;
      const winEnd = Math.min(pos + Math.max(RA_WINDOW, len), this.size);
      const buf = await this._fetchRange(winStart, winEnd);
      const w = { start: winStart, end: winStart + buf.length, buf };
      this._raCache.push(w);
      while (this._raCache.length > RA_WINDOWS) this._raCache.shift();
      const sliceEnd = Math.min(end, w.end);
      return buf.subarray(pos - w.start, Math.max(pos - w.start, sliceEnd - w.start));
    }

    _raTouch(w) {
      const i = this._raCache.indexOf(w);
      if (i >= 0 && i !== this._raCache.length - 1) { this._raCache.splice(i, 1); this._raCache.push(w); }
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
        if (r.status === 200 && !r.headers.get('content-range')) { try { ac.abort(); } catch (_) {} throw new Error('RANGE_UNSUPPORTED'); }
        if (r.status !== 206 && r.status !== 200) throw new Error('BLOCK_HTTP_' + r.status);
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
      this.aS = this._streams.find((s) => s.codec_type === 1) || null;
      this.vName = this.vS ? await lib.avcodec_get_name(this.vS.codec_id) : null;
      this.aName = this.aS ? await lib.avcodec_get_name(this.aS.codec_id) : null;
      this.copyAudio = !!(this.aS && AUDIO_COPY.has(this.aName));
      this.V_IDX = 0; this.A_IDX = this.vS ? 1 : 0;
      this.log(`vidéo=${this.vName}${this.aS ? `, audio=${this.aName} (${this.copyAudio ? 'copie' : 'transcodage AAC'})` : ''}`);
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
        this.report({ stage: 'pump', message: String(e && (e.stack || e.message || e)) });
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
      if (this.vBase === null) { this.vBase = pts; this.vFd0 = (p.duration || 0) > 0 ? p.duration : 1; this.vOffset = D_REORDER * this.vFd0; }
      const [lo, hi] = from64(this.vBase + this.vCum - this.vOffset);
      p.dts = lo; p.dtshi = hi;
      this.vCum += (p.duration || 0) > 0 ? p.duration : 1;
    }

    // ---- MSE buffer plumbing ----------------------------------------------
    _drain() {
      const sb = this.sb;
      if (!sb || sb.updating) return;
      if (this.queue.length) { try { sb.appendBuffer(this.queue.shift()); } catch (e) { this.log('append err ' + e.message); } }
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
      if (!this._isBuffered(t)) this.seek(t);
    }
  }

  window.NorvaEngine = NorvaEngine;
  // Warm the libav module import as soon as this script loads, so the dynamic
  // import + parse is done (and the browser can start fetching the wasm) before
  // the user presses play. Errors are ignored; load() retries/​surfaces them.
  try { loadLibavFactory().catch(() => {}); } catch (_) {}
})();
