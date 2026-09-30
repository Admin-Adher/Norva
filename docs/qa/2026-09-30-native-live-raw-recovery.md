# Native Live network recovery — local routing correction

Base: `510163f2fa8a33044607c11d59ce99c38b221fc0`.
Prepared in `codex/native-live-raw-recovery-20260930`, then integrated into
`live-inflight-cancel-20260930` with the preparation-cancellation changes.

## Cause and change

Native Live recovery after `provider_html_response` or
`ERROR_CODE_IO_BAD_HTTP_STATUS` already requested `mode=engine`. The client
converted that into a relay request with `enginePipe=true`. Unlike native VOD,
Live did not carry the explicit `nativeNetworkRecovery` flag. Server routing
then promoted a resolved `ts` container to HLS, even though ExoPlayer can consume
the original TS stream through the existing authenticated raw transport.

The native recovery launcher now supplies the explicit flag for those two
network refusal reasons. The API forwards it only when a native bridge exists.
The server uses a separate `nativeLiveNetworkRecovery` condition, requiring all
of: the explicit flag, engine pipe, relay mode, and Live item type. That condition
only suppresses browser TS promotion. The existing VOD condition and its native
MP4 grant/lease path are unchanged.

The destination remains the owned target resolved by the server. Entitlement,
source generation, owner/device coordination, release barrier, raw capability,
receipt and cancellation rules are not weakened or replaced. This patch does
not add a provider connection or a codec probe. Browser requests do not acquire
the native flag; ordinary native Live still uses its original direct route.

## Verification

The tests execute the actual standalone recovery, API request builder, Edge
routing declarations and complete generic raw-return branch. They demonstrate:

- explicit native recovery selects raw; ordinary native Live stays direct;
- a browser-supplied recovery option does not become a native request;
- missing flag or missing engine pipe retains server TS promotion;
- Live never enters the finite native-MP4 route or acquires its lease marker;
- raw coordination keeps the original owner, source, device and exact target;
- release wait precedes the raw grant, then commit and receipt;
- the same abort signal reaches the client request, and the exact preparation
  reaches the raw capability; cancellation before commit prevents a response;
- no finite-file metadata/probe route is opened for Live;
- existing VOD, token deadlines, Back and stale-intent tests still pass.

```text
node --test tests/native-network-recovery-edge.test.js tests/dense-vod-routing.test.js tests/native-playback-recovery.test.js tests/native-live-close-intent.test.js tests/vod-container-self-heal.test.js
```

The isolated routing patch passed **138 tests, 0 failed, 0 skipped**. The
integrated run below additionally covers the exact preparation context.

```text
node --test tests/native-network-recovery-edge.test.js tests/dense-vod-routing.test.js tests/native-playback-recovery.test.js tests/native-live-close-intent.test.js tests/vod-container-self-heal.test.js tests/playback-preparation-auth.test.js tests/playback-preparation-cancellation.test.js tests/playback-cancel-receipt.test.js tests/live-preparation-edge.test.js tests/live-preparation-gateway.test.js tests/live-preparation-gateway-routes.test.js
```

Integrated result: **186 passed, 0 failed, 0 skipped**. JavaScript syntax checks
for `api.js` and `standalone.js`, plus `git diff --check`, passed.

No production mutation, provider playback, commit or deployment was performed.
Actual TF1 startup time and native decoding must be replayed after integration.
The in-flight preparation/cancellation patch retains its raw-route cancellation
coverage. Regenerate the official WebView asset manifest after combining client
changes.
