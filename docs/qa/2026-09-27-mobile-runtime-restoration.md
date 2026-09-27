# Restore the mobile VOD recovery runtime (27 September 2026)

Physical release1.3.26(39) reproduced MAX OTT and Dino failures: direct provider HTML, then three unsuccessful recovery sessions. The active Edge containers were recreated on26September18:00UTC from the old checkout, serving playback version61 and returning an internal Gateway address. The maintained runtime at /home/adrien/.norva/resume-cache-edge-pilot-20260918/functions contains version83, the signed native-raw-recovery transport, and the current catalogue helpers.

An isolated container using that runtime and the current credentials first exposed missing public-origin settings. With the two origins read from the actual Gateways, both exact owned movie sessions returned201, native-raw-recovery, public media.norva.tv URLs, and valid206 byte ranges. Every QA session was explicitly expired.

The180 runtime files were copied to /home/adrien/.norva/releases/edge-20260927-mobile-recovery/functions with a SHA256 manifest. The two replicas were recreated sequentially against this release, preserving every existing environment value and adding only the verified NORVA_NATIVE_MP4_PUBLIC_BASE_URL and NORVA_NATIVE_MP4_PILOT_PUBLIC_BASE_URL. Both attest playback version83. A real public byte-range probe succeeded between the two rollouts. Config and env backups are private on the server.

Compose now supports NORVA_EDGE_FUNCTIONS_ROOT for both replicas and carries the public origins through the shared environment anchor. This prevents an ordinary compose recreation from silently remounting the legacy checkout when the release-root is configured. It does not certify or reactivate every feature flag lost in the earlier recreation: media-cache settings require a separate reconciliation.

Physical replay and FPS evidence are still being collected. Do not treat the byte-range probe as proof of playback or resume.
