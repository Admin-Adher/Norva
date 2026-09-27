# Exact episode native recovery — 2026-09-27

The native recovery lane previously required a movie-only exact profile and rejected owned episodes. The Edge now reads the exact episode profile using the verified provider identity and episode ID, or prepares it through the authenticated Gateway after the playback coordinator has drained the previous reader. The probe lease is released only with a provider-drain attestation. Caller profiles are never authoritative. The resulting opaque native session is bound to the current catalogue receipt, including episode membership.

Normalized persisted MP4/Matroska family names are accepted by the finite native proof validator. Browser codec admission remains unchanged.

Validation:
- 19 focused Node tests pass: foreign membership, lease busy, undrained probe, timeout, malformed/stale profile, cached normalized profile, and existing opaque session/lease contracts.
- Isolated production-data replay: exact owned Dino episode returns 201 native-raw-recovery, then HTTP 206 for 65,536 actual video bytes; session expired successfully.
- First probe/preparation: 11.6 seconds. Reuse of persisted exact profile: 1.066 seconds.
- Current bytes are MP4, 1,757,518,339 bytes and 2,985.92 seconds, despite an earlier MPEG-TS observation. Provider resource URL is preserved.
- Both production Edge instances run health version 84 from `/home/adrien/.norva/releases/edge-20260927-episode-recovery/functions`. Playback SHA-256: `c68241f5fcc0bf2b6faae393ae10de054f7aae3d383c051e76abb67694746c6e`.
- Production replica replay: cached preparation 849 ms; original video range returns HTTP 206, followed by successful session closure.
- Physical phone, Google Play 1.3.26 (39): Dino series S1 E1 resumed at 163 seconds (2:43), displayed actual video and advanced normally. After Back, history recorded 248 seconds (4:08); reopening advanced to 262.8 seconds. Back closed the second playback.
- Full physical startup remains approximately 18 seconds, including failure of the provider direct response and native recovery. Server preparation timing is not time to first frame.
- Exact MPEG-TS admission is unit-tested. The currently served real episode is MP4; this replay does not certify a currently served MPEG-TS resource.
- No Android update, transcoding change, or Gateway restart was required.
