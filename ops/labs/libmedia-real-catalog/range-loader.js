// Research only. One session, one serialized source transport.
class NorvaAVPlayerRangeLoader extends AVPlayer.IOLoader.CustomIOLoader {
 constructor(url, ext) {
  super(); Object.assign(this, { url, extension: ext, total: null, position: 0,
   windows: [], closed: false, tail: Promise.resolve(), controller: null,
   stream: null, pending: null, windowBytes: 2 * 1024 * 1024 });
  record.transport = { reads: 0, deliveredBytes: 0, wireBytes: 0,
   headerWaitMs: 0, bodyWaitMs: 0, readWaitMs: 0, ranges: 0, cacheBytes: 0 };
 }
 get ext() { return this.extension; }
 get name() { return 'NorvaRange'; }
 get flags() { return 5; }
 serial(fn) { const next = this.tail.then(fn); this.tail = next.catch(() => {}); return next; }
 async response(start, end) {
  if (this.closed) throw Error('Loader closed');
  const ac = new AbortController(); this.controller = ac;
  const deadline = setTimeout(() => ac.abort(), 60000), began = clock();
  try {
   const r = await fetch(this.url, { headers: { Range: `bytes=${start}-${end}` },
    credentials: 'omit', signal: ac.signal, cache: 'no-store' });
   record.transport.ranges++; record.transport.headerWaitMs += clock() - began;
   const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('content-range') || '');
   if (r.status !== 206 || !cr || +cr[1] !== start || +cr[2] !== end
    || !Number.isSafeInteger(+cr[3]) || +cr[3] <= end
    || this.total !== null && this.total !== +cr[3]) throw Error('Invalid range response');
   const declared = r.headers.get('content-length');
   if (declared !== null && +declared !== end - start + 1) throw Error('Invalid range length');
   this.total = +cr[3];
   return { reader: r.body.getReader(), start, end, received: 0, chunks: [], controller: ac, deadline };
  } catch (e) { clearTimeout(deadline); ac.abort(); throw e; }
 }
 async open() {
  this.init ??= this.serial(async () => {
   const s = await this.response(0, 1); let n = 0;
   try {
    for (;;) { const x = await s.reader.read(); if (x.done) break; n += x.value.length;
     if (n > 2) throw Error('Oversized probe'); }
    if (n !== 2) throw Error('Incomplete probe'); return 0;
   } finally { clearTimeout(s.deadline); s.controller.abort(); this.controller = null; }
  }); return this.init;
 }
 async size() { await this.open(); event('ioSize', { total: this.total }); return BigInt(this.total); }
 async discard() {
  const s = this.stream; this.stream = null; this.pending = null;
  if (s) { clearTimeout(s.deadline); s.controller.abort(); await s.reader.cancel().catch(() => {}); }
  this.controller = null;
 }
 async seek(position) {
  return this.serial(async () => {
   const p = Number(position); event('ioSeek', { position: p });
   if (!Number.isSafeInteger(p) || p < 0 || p > this.total || this.closed) return -2;
   if (p !== this.position) await this.discard(); this.position = p; return 0;
  });
 }
 async chunk() {
  const s = this.stream;
  for (;;) {
   const began = clock(), x = await s.reader.read(); record.transport.bodyWaitMs += clock() - began;
   if (this.closed) throw Error('Loader closed');
   if (x.done) {
    clearTimeout(s.deadline);
    if (s.received !== s.end - s.start + 1) throw Error('Truncated range');
    const data = new Uint8Array(s.received); let offset = 0;
    for (const c of s.chunks) { data.set(c, offset); offset += c.length; }
    this.windows.push({ start: s.start, data }); if (this.windows.length > 4) this.windows.shift();
    this.stream = null; this.controller = null; return null;
   }
   if (!x.value.length) continue;
   s.received += x.value.length; record.transport.wireBytes += x.value.length;
   if (s.received > s.end - s.start + 1) { await this.discard(); throw Error('Oversized range'); }
   s.chunks.push(x.value); return x.value;
  }
 }
 async read(buffer) {
  return this.serial(async () => {
   const began = clock(); record.transport.reads++;
   try {
    if (this.closed) return -2;
    if (this.position >= this.total) { if (this.stream) await this.chunk(); return -1048576; }
    const w = this.windows.find(w => this.position >= w.start && this.position < w.start + w.data.length);
    if (w && !this.stream && !this.pending) {
     const at = this.position - w.start, n = Math.min(buffer.length, w.data.length - at);
     buffer.set(w.data.subarray(at, at + n), 0); this.position += n;
     record.transport.deliveredBytes += n; record.transport.cacheBytes += n; return n;
    }
    // Coalesce small chunks to limit RPC cost, without awaiting the whole response.
    const goal = Math.min(buffer.length, 64 * 1024); let n = 0;
    while (n < goal) {
     if (!this.pending) {
      if (!this.stream) this.stream = await this.response(this.position,
       Math.min(this.position + this.windowBytes - 1, this.total - 1));
      this.pending = await this.chunk();
      if (!this.pending) { if (n) break; if (this.position >= this.total) return -1048576; continue; }
     }
     const count = Math.min(goal - n, this.pending.length);
     buffer.set(this.pending.subarray(0, count), n);
     this.pending = count === this.pending.length ? null : this.pending.subarray(count);
     n += count; this.position += count;
    }
    record.transport.deliveredBytes += n; return n;
   } finally { record.transport.readWaitMs += clock() - began; }
  });
 }
 async stop() { this.closed = true; this.controller?.abort(); await this.tail;
  await this.discard(); this.windows = []; }
}
