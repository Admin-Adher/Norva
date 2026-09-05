# Plex browser playback trials

Plex's public master currently contains 5,014-character rendition URLs. The deployed FFmpeg 5.1.9 binary truncates them to 4,095 characters, producing HTTP 400; the existing proxy separately refuses CONNECT with HTTP 403. These are transport and compatibility failures, not evidence that the whole Plex feed is unavailable.

`selection-live-delivery.mjs` adds browser trials for Action Hollywood Movies and TV5MONDE Info, limited to the already authorized test account by its SHA-256 identity. The existing session authorization, heartbeat, expiry, replacement and exact-media circuit scope remain active.

The resolver accepts a refreshed Plex token only when the persisted target, refreshed target, stable media key, external ID, Plex part, source attribution and deterministic owned Selection source all agree. Both targets must use the exact HTTPS Plex endpoint, canonical paths and exactly one `X-Plex-Token` parameter. Other URL changes fail closed. The complete refreshed URL is passed to the browser; nested playlist URLs retain their provider parameters.

Explicit conversion, track or quality selection, native clients and other owners retain their existing route. The seven earlier browser trials and the two curated Xumo routes are unchanged. This patch does not alter the catalogue, importer, playback entry point, player, proxy configuration or gateway image. No publication gate or catalogue quarantine is included.

## Verification and rollout

Run the Plex routing tests alongside Selection delivery, canary and discovery-source regressions. Evaluate both real owned rows in memory before the rollout; reports must exclude account IDs and media tokens. The final acceptance check uses the authenticated Norva UI and records the actual direct session, first picture, advancing video frames, stalls and replacement/expiry. A successful HTTP response alone is insufficient.

The scoped runtime overlay is prepared from committed files and a fresh r11 runtime snapshot. Only `selection-live-delivery.mjs` changes; the playback entry point and original canary registry are included byte-for-byte as integrity checks. Both Edge replicas are updated sequentially using the existing image. The gateway and every out-of-scope runtime file are checked before and after. The rollback restores the captured r11 mounts, including after a partial rollout.

Broader Plex activation requires successful real playback and a separately reviewed scope. These two trials grant no global provider approval and make no claim about all territories or concurrent-user capacity.
