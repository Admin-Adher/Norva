# Gateway audio-language probing: cache + in-band header parse

Fixes the "multi-audio file shows real languages one time, `Audio 1/2/3` the next"
flicker (e.g. *The Secret Life of Pets*), whose root cause on a **single-slot
provider** is connection contention: the in-browser engine streams the file through
the gateway's `/raw` byte-pipe (holding the provider's one connection slot), and the
*separate* codec probe (a second connection) gets refused (HTTP 458), so the audio
languages come back blank that load.

The engine's libav build can't read per-stream language locally, so engine-path audio
labels always come from a gateway/relay probe. This change makes that probe cheap and,
optionally, connection-free.

## Stage 1 — codec-profile cache (always on)

`probeCodecProfile()` now caches each **successful** ffprobe profile keyed by source
URL, so repeated probes of the same file (audio-menu re-open, `/subtitle`
enumeration, a new session) are served from memory with **no provider hit**.

- `CODEC_PROFILE_CACHE_TTL_MS` (default `3600000` = 1 h; `0` disables)
- `CODEC_PROFILE_CACHE_MAX` (default `5000` entries; oldest evicted past the cap)

Failures/empty profiles are **not** cached, so a transient 458 still retries. Expired
entries are evicted lazily on read and swept every 60 s.

## Stage 2 — in-band header parse (off by default)

When enabled, `/raw` tees the file's **leading bytes** (which the engine fetches first
anyway) into memory; a codec probe then runs `ffprobe` on those **local** bytes
instead of opening a second provider connection. Zero extra connection ⇒ no 458.

- `INBAND_HEADER_PARSE` (default `false`) — master switch
- `INBAND_HEADER_BYTES` (default `4000000` = 4 MB captured per file)
- `INBAND_HEADER_CACHE_MAX` (default `16` files buffered; worst-case memory ≈
  `INBAND_HEADER_BYTES × INBAND_HEADER_CACHE_MAX` ≈ 64 MB)
- `INBAND_HEADER_TTL_MS` (default `300000` = 5 min; buffers are only needed around
  playback start)

Resolution order in `probeCodecProfile`, cheapest first:

1. codec-profile cache (memory) → `probeStats.cacheHits`
2. in-band header bytes (local ffprobe) → `probeStats.inbandHits`, **no provider conn**
3. provider probe (opens a connection) → `probeStats.successes`

**Coverage:** works for MKV and faststart MP4 (header at the front — verified: ffprobe
on the leading 200 KB of an MKV reports the same streams as the full file). For an MP4
whose `moov` is at the **end**, the leading bytes don't parse, so step 2 returns null
and it falls back to the provider probe (step 3) — correct, just not connection-free.

**Safety:** with `INBAND_HEADER_PARSE=false` the `/raw` capture and the in-band branch
are both skipped — behaviour is identical to stage 1. The tee never throws into the
byte pipe, is attached before `pipe()` (no missed leading chunk), and respects pipe
backpressure (no bytes flow while the client is paused).

## Rollout

The media-gateway has **no CI deploy workflow** — deploy it on the gateway infra
(`services/media-gateway`, its own Dockerfile). Suggested order:

1. Deploy with stage 1 only (cache on, `INBAND_HEADER_PARSE` unset). Watch
   `GET /health` → `probeStats.cacheHits` climb and 458-driven flicker drop.
2. Enable `INBAND_HEADER_PARSE=true` on one instance. Confirm playback is unaffected
   and `probeStats.inbandHits` climbs (and provider `attempts` drop) for MKV titles.
3. Roll out widely. To disable instantly, unset `INBAND_HEADER_PARSE` (or set `false`).

`GET /health` exposes `probeStats` (`cacheHits`, `inbandHits`, `successes`,
`attempts`…), `codecProfileCacheSize`, `inbandHeaderParse`, and `headerByteCacheSize`.

## Relationship to the client self-heal

The client already persists discovered languages to `catalog_file_tracks` (so a title
is deterministic after one success). This gateway work removes the *second connection*
needed for that first discovery on a maxed single-slot account — it's the optimization
layer beneath the self-heal, not a replacement for it.
