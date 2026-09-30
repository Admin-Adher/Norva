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

## Production publication — 21:18:13 UTC

PR #516 merged as `e7ffd4169e131d64f807169f0b41f49f9ff57820` after all
Build Norva jobs (run 36777492080) and Partners integration (36777491960)
succeeded. The two deployed modules match candidate
`fe7f8c5e087d593e49e6e14bfc26f5f10407ed21` and the merged source exactly after
line-ending normalization.

The production Selection worker restarted healthy with the same container,
configuration and mount mapping. No nonterminal work was interrupted. An
initial post-restart check compared the order of Docker's mount list and
rolled back automatically; repeated read-only inspection reproduced different
list orders with identical destination-to-mount mappings. The corrected
operator compares the complete mapping, preserving every path and option.
The second deployment passed. Operator SHA256:
`dea8af11dae92539d3596e8f0d1a381f1c62a8012c8d51521e6c62fd53f51c7b`.

Installed worker normalized SHA256:
`5618f9386e3fb6f1f2576d964ffbbe6fbb88b1a2464776b75a843db4bdb4a42a`.
Installed Gateway client normalized SHA256:
`545bada28f041949b6b9f189f0b8ef775c582c63539d56776c870835d8155100`.

A stubbed HTTP 502 probe through the installed module produced the expected
safe diagnostic with zero provider requests. This is an installed-code check,
not an audio extraction replay. The queue remained 192 completed / 523 failed;
capture and parallel flags remained false. The private server receipt is
`/home/adrien/.norva/selection-audio-diagnostics-fe7f8c5e.deploy.safe.json`.
