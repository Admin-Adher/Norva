# Phone emulator unlock patch

The phone QA workflow checks out `ReactiveCircus/android-emulator-runner` at
`a421e43855164a8197daf9d8d40fe71c6996bb0d`, the revision used in run 36721136600.
The complete upstream action and Apache-2.0 `LICENSE` remain in that CI checkout.
Modified source and runtime files carry a change notice.

The upstream runner sends `input keyevent 82` immediately after
`sys.boot_completed`. In the failed gesture run it sent the key at
13:24:46.769 UTC, before HOME had a focused window. Android raised a launcher
ANR at 13:24:51.788; HOME was first displayed at 13:24:54.715. This happened
before Norva's navigation/font setup and before any application test.

The patch replaces only that unlock command with `wm dismiss-keyguard`, an
Android window-manager command that does not enqueue a key event for HOME.
Both upstream source and executable JS are validated by SHA-256 before either
file is changed. Updating the pinned revision requires reviewing the new code
and updating those hashes explicitly.

The separate bounded HOME-focus check, ANR failure, captured diagnostics,
real-keyboard assertions and connected instrumentation remain active. No ANR
dialogue is closed or suppressed. TV uses the existing upstream runner.
