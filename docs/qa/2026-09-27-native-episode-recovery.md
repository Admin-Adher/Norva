# Exact episode native recovery — 2026-09-27

The native recovery lane previously required a movie-only exact profile and rejected owned episodes. The Edge now reads the exact episode profile using the verified provider identity and episode ID, or prepares it through the authenticated Gateway after the playback coordinator has drained the previous reader. The probe lease is released only with a provider-drain attestation. Caller profiles are never authoritative. The resulting opaque native session is bound to the current catalogue receipt, including episode membership.

Normalized persisted MP4/Matroska family names are accepted by the finite native proof validator. Browser codec admission remains unchanged.

Validation so far:
- 19 focused Node tests pass: foreign membership, lease busy, undrained probe, timeout, malformed/stale profile, cached normalized profile, and existing opaque session/lease contracts.
- Isolated production-data replay: exact owned Dino episode returns 201 native-raw-recovery, then HTTP 206 for 65,536 actual video bytes; session expired successfully.
- First probe/preparation: 11.6 seconds. Reuse of persisted exact profile: 1.066 seconds.
- Current bytes are MP4, 1,757,518,339 bytes and 2,985.92 seconds, despite an earlier MPEG-TS observation. Provider resource URL is preserved.
- Physical replay and production receipt will be added after rollout.
