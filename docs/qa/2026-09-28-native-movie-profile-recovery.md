# Native movie exact profile recovery and startup measurements — 2026-09-28

The native movie recovery path used only the tenant playback hint. Dino movie 1385392 had no tenant codec profile although its exact verified provider file profile was already available. Recovery returned 503 after the phone detected an HTML response on the direct route.

The Edge now reads the server-observed profile for the exact movie/provider identity, after checking the owner's visible variant. It retains origin, age, container and byte-length validation plus the normal prepared playback receipt. No provider probe or client-supplied authority is introduced.

Validation:
- 22 focused tests pass, including invisible ownership, stale/caller evidence and database failure.
- Isolated real request: 201 native-raw-recovery; HTTP 206, 65,536 bytes, file length 1,078,712,040, prefix 47400010 (TS).
- Actual phone 1.3.26 (39): selected Dino / Albanian / TS version of The Super Mario Galaxy Movie; actual video advances around 24 fps. Initial playback takes approximately 10–12 seconds including direct-route refusal.
- Back saved 124 seconds; reopening eventually showed PLAYING at 145.032 seconds. Reopen took longer than 25 seconds; do not claim instant resume. Both physical sessions were closed with Back.
- Both production Edge instances use `/home/adrien/.norva/releases/edge-20260928-native-movie-profile/functions`, health 84, playback SHA-256 `652e8137b6f7ae51d366daeda14da90dd7f16d7e7ee77fc669cec1ed0ebbe1ab`.

Separate MP4 startup finding: episode 704734 direct HTML rejection occurs around 1.5 seconds after tap, recovery session created around 3 seconds. Transport trace shows a 4.264-second first response, tail index read (2,151,886 bytes), two interrupted 8 MiB windows, and two 2.5-second release delays. A bounded initial header window is being measured separately; no performance improvement is claimed here.
