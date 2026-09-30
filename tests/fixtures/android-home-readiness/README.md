# Android HOME readiness evidence

These excerpts come from the complete `diagnostics/readiness-windows.txt`
artifacts of Android emulator QA run **36723027110**, head `2beab649`:

| Fixture | Artifact |
| --- | --- |
| gesture10.txt | 11102127007 |
| gesture13.txt | 11101737032 |
| three10.txt | 11102421890 |
| three13.txt | 11101851805 |

Section headings, ANR status and the exact `mCurrentFocus` / `mFocusedApp`
lines are retained. Transient object identity hashes are redacted to `0000000`.
These are fresh QA emulators without user accounts or provider connections.

The associated device logs show an initial HOME resolution transition:
`com.google.android.googlesdksetup/.DefaultActivity` to
`com.google.android.apps.nexuslauncher/.NexusLauncherActivity`.
For gesture 1.0 the setup HOME starts at 13:40:23.055 UTC (uid 2000),
followed by the launcher at 13:40:24.399 UTC. The other three configurations
show the same transition. The shell tests replay this changing resolution
against the captured window output. Setup/provisioning flags in tests are
controlled boundary values, not claimed as captured settings output.
