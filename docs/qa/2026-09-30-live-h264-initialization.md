# Live H.264 initialization and Android replay

## Observed failure

Physical phone Norva 1.3.27/code 40, Strng TF1 HD, 30 September 2026.
The second UI Play was at 16:15:10.464 UTC. The single producer first produced
local TS about 30 seconds later. At 16:16:10.618 the Gateway announced ready
after 56.709 seconds, although its diagnostic said `candidate-limit`,
`liveTsStartupDecoded=false` and three rejected segments. Android Media3 1.5.1
then failed in H264Reader/SampleQueue at 16:16:12.035 and 16:16:13.953; no first
frame was observed. Back at 16:17:48.782 and Films at 16:18:00.207 closed the test.

Two initial TS files, 7.6 MB total, were preserved privately before cleanup.
Segment 0 has no SPS, PPS or IDR, despite some packets marked keyframe.
Segment 1 begins with eight frames before its SPS/PPS/IDR. Independent decoding
rejects both starts. The later segments actually delivered to Media3 were
already removed and were not recovered; this is not an exact offline replay of
the entire Android failure.

The preceding attempt also revealed a separate retry after native Back. Its
WebView correction is tracked separately. Neither defect is an expiration of
the provider subscription.

## Correction

- Three explicitly invalid H.264 candidates fail with `LIVE_TS_STARTUP_INVALID`.
  They no longer authorize the untested fourth segment. Unknown formats,
  diagnostic timeouts and host failures keep their existing behavior.
- That precise failure may trigger one copy-to-encode fallback, for Live only.
  Existing encoder admission and the overall maximum of three producer attempts
  remain. It cannot turn a provider refusal or network timeout into a codec retry.
- Before replacement, the old producer is stopped and its exit checked, the
  provider release grace is observed and old artifacts are removed. Cancellation
  prevents a replacement. Failure to establish process exit fails closed.
- Safe startup timings record the reason and rejected-prefix evidence.

## Verification before deployment

- 147 focused/adjacent Node checks initially passed; two real-codec groups were
  skipped locally because this Windows shell has no FFmpeg binary. One additional
  producer-stop-failure regression was then added and all five retry tests passed.
- A separate network-disabled container using the production codec image ran
  the real startup suite and retry tests: 20 passed, zero skipped before the
  additional exit-state assertion. It includes nine FFmpeg subtests: corrupt
  prefix, missing parameters, radio, silent video, cancellation, bounded failure
  and healthy 1080p. Healthy local decode proof measured 146–149 ms.
- Offline experiment on the captured bytes: normal copy and parameter injection
  with the actual 1.5-second/2-MB probe each produced zero independently decoded
  segments out of four. Bounded encoding produced four out of four. Injection
  required a 10-second/10-MB probe to produce four out of four; that slower probe
  has not been made a global default.

Private evidence is under
`/home/adrien/.norva/strng-passive-playback-20260930/`.
No fixture analysis opened an additional provider connection.

## Remaining runtime proof

This report does not yet establish a successful replay after deployment. The
new fallback may add preparation time; native recovery has a 60-second deadline.
The provider's initial delay, an actual first frame, Back cleanup, and global
deployment must be measured separately. Code 42 was under Play review at the
last check; these measurements use installed code 40.
