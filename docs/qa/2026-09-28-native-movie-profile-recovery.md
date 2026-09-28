# Native movie exact profile recovery and startup measurements — 2026-09-28

The native movie recovery path used only the tenant playback hint. Dino movie 1385392 had no tenant codec profile although its exact verified provider file profile was already available. Recovery returned 503 after the phone detected an HTML response on the direct route.

The Edge now reads the server-observed profile for the exact movie/provider identity, after checking the owner's visible variant. It retains origin, age, container and byte-length validation plus the normal prepared playback receipt. No provider probe or client-supplied authority is introduced.

Validation:
- 22 focused tests pass, including invisible ownership, stale/caller evidence and database failure.
- Isolated real request: 201 native-raw-recovery; HTTP 206, 65,536 bytes, file length 1,078,712,040, prefix 47400010 (TS).
- Actual phone 1.3.26 (39): selected Dino / Albanian / TS version of The Super Mario Galaxy Movie; actual video advances around 24 fps. Initial playback takes approximately 10–12 seconds including direct-route refusal.
- Back saved 124 seconds; reopening eventually showed PLAYING at 145.032 seconds. Reopen took longer than 25 seconds; do not claim instant resume. Both physical sessions were closed with Back.
- Both production Edge instances use `/home/adrien/.norva/releases/edge-20260928-native-movie-profile/functions`, health 84, playback SHA-256 `652e8137b6f7ae51d366daeda14da90dd7f16d7e7ee77fc669cec1ed0ebbe1ab`.

Separate MP4 startup finding: episode 704734 direct HTML rejection occurs around 1.5 seconds after tap, recovery session created around 3 seconds. Transport trace shows a 4.264-second first response, tail index read (2,151,886 bytes), two interrupted 8 MiB windows, and two 2.5-second release delays. The bounded-header optimization below addresses these unnecessary reopenings.


## Gateway startup optimization deployed globally

The native finite transport now uses a 128 KiB initial header window and allows up to 750 ms to finish a bounded abandoned read. Normal sequential windows remain 8 MiB. Full session cancellation remains immediate; provider-slot coordination, ownership, exact-byte checks and release protection are unchanged.

- Deterministic real-provider extraction sequence: 10,130 ms baseline, then 4,387 ms and 4,775 ms with the change. All four range hashes match across runs. This is a transport benchmark, not phone tap-to-play latency.
- Broker/native regression suite: 102 passed, 2 skipped, no failures. Includes session cancellation and absence of overlapping provider connections.
- Physical phone MP4 replay after production rollout: tap 02:06:15.893, first rendered video buffer 02:06:24.982: **9.089 seconds**, versus **19.268 seconds** before (01:35:07.338 to 01:35:26.606). Subsequent moving frames start at 02:06:28.616: **12.723 seconds** after tap. A 3.635-second initial buffering interval therefore remains; first image is not the same as continuous playback.
- Actual video verified visually and continued near 25 fps. Direct provider HTML rejection still triggers the authorized native byte relay; there is no video transcoding in this path.
- Physical real TS replay after rollout: tap 02:07:18.356, first rendered frame 02:07:46.635: **28.279 seconds**. Video and resume verified (02:42 on screen, subsequently PLAYING at 171.627 seconds, no terminal error). This TS startup remains slow. Trace shows multiple extractor range searches and six interrupted provider fetches. The MP4 improvement must not be generalized to TS seek performance.
- Both sessions closed with Android Back. These are individual measurements, not statistical startup guarantees or WebView FPS certification.

Production Gateways both run image `sha256:2c75b04b927c12205079b55eba8227a76ad1d3d6b6da6d4778ba9f4fb031ba98`, revision `18ad6d5a94a6aaa76f36bf39025f7c8ff98e59da`, health 169. Only the Gateway entry file changed relative to the previous production image. No Android update required.

Sequential idle-only rollout receipts:
- Secondary: `/home/adrien/.norva/gateway-reference-rollout/20260928T000209906742Z`.
- Main: `/home/adrien/.norva/gateway-reference-rollout/20260928T000239367350Z`.

The rollout retained full configuration, mounts, devices, feature flags and rollback containers. The exact shared movie profile correction is also live on both Edge instances as documented above.
