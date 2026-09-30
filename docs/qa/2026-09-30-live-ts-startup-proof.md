# Live TS startup guard — 30 September 2026

## Observed production failure

The web replay of Strng BE: TF1 HD at 13:33:07 UTC obtained video after automatic conversion, approximately 52.5 seconds from the recorded click. Initial remux preparation took 39.040 seconds; the browser rejected that stream with `bufferAppendError`. The replacement transcode prepared in 8.590 seconds. Its 485 ms player metric measures attachment only, not the full user wait.

The initial producer logs contained missing H.264 SPS/PPS and unknown dimensions. Those segments were deleted after session closure, so the logs do **not** prove which bytes caused the browser rejection. Both sessions were closed and no active Strng playback remained.

## Bounded correction

For a simple Live TS output with copied video, inspect finalized local segments before advertising readiness. Only explicit H.264 bitstream corruption can justify removing a prefix. Timeouts, unavailable evidence and resource errors retain the existing path without claiming verification. Cancellation never authorizes readiness.

Readiness and served playlists use the same projection, with a consistent media sequence and duration reserve. Rejected prefix segments cannot be fetched directly. The check opens no additional provider connection and does not restart the producer. VOD and unsupported playlist topologies retain their existing behavior.

## Evidence before release

Real synthetic TS tests include a prefix whose H.264 parameter sets have been removed, followed by a valid segment; radio; inconclusive inspection; abort; concurrent callers; playlist projection and direct-segment access. A valid local 1080p fixture took 67–72 ms to inspect on the development machine. Three runs using the deployed Gateway FFmpeg took 153 ms each, without waiting for or discarding an additional segment. These measurements are synthetic and do not establish a real-provider startup gain.

Independent review required preserving unsupported valid manifests and distinguishing memory/resource failures from corrupt bitstreams. Both findings were corrected and covered by regression tests, including mixed resource/PPS output in either order and timeout during teardown. The final independent review found no remaining blocker. Its focused run passed 16 tests, with the real-FFmpeg scenario skipped on that review environment; the author's separate Gateway-FFmpeg run passed 14 tests with actual synthetic media. The existing finite VOD policy regression passed 10 tests. These counts cover overlapping suites and must not be summed as unique coverage.

Before release, all 74 source files on both production Gateways matched this branch's base revision. Both were healthy at version 169 and idle at that check. No production process was restarted for these measurements. Deployment and a real-provider replay are still pending.

The rollout preflight also exposed a stale SQL guard using the nonexistent current state `active`. It now conservatively refuses replacement while **any** unexpired cloud playback session is `pending` or `ready`, without depending on a legacy native hint. This can also defer deployment for a direct playback between media requests. Four focused rollout tests passed; existing runtime activity and configuration checks remain intact.
