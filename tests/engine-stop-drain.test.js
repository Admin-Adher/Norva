const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function engine() {
  const ctx = { window: {}, navigator: {}, performance, console, URL, fetch, AbortController,
    setTimeout: (fn, ms) => ms === 5 ? queueMicrotask(fn) : setTimeout(fn, ms),
    clearTimeout, queueMicrotask, TextDecoder, crypto };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/norvaEngine.js'), 'utf8'), ctx);
  return new ctx.window.NorvaEngine({});
}

test('stop waits for an unresolved worker read beyond the former polling guard', async () => {
  const e = engine(), read = deferred();
  e._pump = () => read.promise;
  e._startPump();
  let stopped = false;
  const stopping = e._stopPump().then(() => { stopped = true; });
  // Microtask timers exhaust the former 2,000 x 5 ms guard before this turn.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false, 'the decoder must remain owned by the pending read');
  assert.equal(e._pumpRunning, true);
  read.resolve(); await stopping;
  assert.equal(e._pumpRunning, false);
});

test('a read failing during stop settles the drain before the decoder can be reused', async () => {
  const e = engine(), read = deferred();
  e._pump = () => read.promise;
  e._startPump();
  const stopping = e._stopPump();
  read.reject(new Error('bounded network timeout'));
  await stopping;
  assert.equal(e._pumpRunning, false);
  assert.equal(e._pumpPromise, null);
});

test('packets arriving after stop are discarded before subtitle capture or mux writes', async () => {
  const e = engine(), read = deferred();
  let captured = 0, written = 0;
  e._bufferedAhead = () => 0;
  e.lib = { ff_read_frame_multi: () => read.promise };
  e._subCapture = true; e._subMeta = new Map([[2, {}]]);
  e._captureSubtitlePacket = () => { captured++; };
  e._writePacketsChecked = async () => { written++; return true; };
  e._startPump();
  const stopping = e._stopPump();
  read.resolve([0, { 2: [{ stream_index: 2 }] }]);
  await stopping;
  assert.equal(captured, 0); assert.equal(written, 0);
});
