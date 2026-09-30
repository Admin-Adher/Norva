# Android first-frame fixture: online precondition

## Observed failure

Build `36741810087` for PR509 passed. In the separate emulator QA run
`36741809603`, phone three-button / font 1.0 produced two failed assertions
in `FirstFrameFixtureInstrumentedTest`. Artifact `11110937675` contains the
complete XML and device logcat. The class received `offline`, not a decoder or
HTTP error; both failures occurred in under two seconds.

The device log gives the following UTC sequence on 2026-09-30:

- 16:14:13.939: `wlan0` interface down.
- 16:14:13.974: supplicant disconnect, reason 4, locally generated.
- 16:14:13.997: Android network 100 transitions CONNECTED to DISCONNECTED.
- 16:14:14.020: available networks count is zero.
- 16:14:14.142: `playableVideoMislabeledAsHtmlStillRendersARealFirstFrame` starts;
  it receives `offline` at 16:14:16.051.
- 16:14:17.281: `ownedHtmlRefusalRecoversThroughOneRawRouteAtTheRequestedPosition`
  starts; it receives `offline` at 16:14:18.585.
- 16:14:19.395: network 101 becomes the default active network.
- 16:14:23.344: the following native resume first-frame case finishes successfully.

`PlayerActivity` checks `hasUsableNetwork()` before preparing online media. With
no active network, it correctly reports OFFLINE before contacting the loopback
HTTP fixture. There is no demonstrated failure of that fixture's server, MIME
handling, recovery or decoder in these two cases. The underlying cause of the
emulator's Wi-Fi interruption is not established by these logs.

## Targeted change

An instrumentation-only `@Before` requires the online fixture's real Android
precondition: the same active network must advertise INTERNET for 500 ms. It
waits up to 15 seconds and otherwise fails explicitly as a preparation error.
It sends no network request, does not alter Wi-Fi or spoof connectivity, and
does not retry a failed playback assertion. Playback first-frame deadlines and
all existing media/recovery assertions are unchanged. No production source is
changed; these tests do not assert offline playback behavior.

## Verification status

Diff whitespace validation passed. This Windows workspace has no local Android
SDK/JDK, so Java compilation and replay still require the existing emulator CI
gate after review. No CI run was triggered during this diagnosis, and no passing
runtime result is claimed for the changed fixture yet.
