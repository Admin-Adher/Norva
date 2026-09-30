# Selection audio failure diagnostics

## Production evidence motivating the change

The deployed worker manifest contains 2,329 files, 715 with incomplete audio.
An exact manifest-ID/URL-digest join found 715 existing jobs: 192 completed,
523 failed, none missing. All failures exhausted eight attempts. A broader
catalogue query is not evidence of missing eligible jobs because it omits the
audited-file registry.

Bounded probes on one existing failed file per feed returned a valid profile
for Herbert (9,961 ms) and Klysmgt (6,574 ms), but HTTP 502 with
`codec_probe_timeout` for Sandro (14,598 ms). These are profile probes, not
verified-language results. A separate capture-status check returned HTTP 200
with no stored capture and confirmed drain; it did not extract audio.

## Change

The worker previously reported `retry_wait` after an eighth retryable failure
although SQL stored a terminal failure. It also reported a result when the
failure save lost its lease. Reporting now follows the existing eight-attempt
ceiling, persisted interruption retry decision and finish CAS result.

Operational diagnostics retain only a fixed operation name, numeric HTTP error
status and a literal allowlist of protocol error codes. They omit arbitrary
upstream codes, messages, URLs, credentials, account IDs and speech. The log
boundary sanitizes again. Existing database error codes and retry/admission
policies are unchanged. This does not recover historical lost error details.

## Verification and remaining work

34 focused gateway/worker tests passed, zero skipped. New cases cover the
eighth attempt, interruption, lease loss, probe timeout, transport errors and
private/unrecognized upstream payloads. `git diff --check` passed.

No failed job was reset, no new attempt was granted, and no Selection flag was
enabled. History-preserving recovery and real capture/inference/hydration
validation remain required. This document does not claim production deployment.
