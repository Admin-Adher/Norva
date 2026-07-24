# Android TV player parity audit — 2026-07-24

## Outcome

Health: **green in code and on the Android TV emulator**.

The TV player now follows the mobile player's hierarchy while preserving the
behaviours that matter on a television: D-pad focus, overscan-safe margins,
large targets, Picture-in-Picture, accelerated seeking, Live reconnect,
episode chaining, and direct-provider playback before Gateway fallback.

## Visual evidence

- [Before: terminal playback message without an action](07-before-player-controls.png)
- [After: focused Retry and Back to Norva actions](08-after-player-controls.png)
- [Before/after error-state comparison](before-after-error-comparison.png)
- [Primary TV control row](09-after-player-controls-normal.png)
- [Audio action focused with the D-pad](10-after-audio-focus.png)
- [Exact-file audio label: Spanish · MP3 · stereo](11-after-audio-dialog.png)
- [Mobile and TV hierarchy comparison](mobile-tv-control-comparison.png)
- [System volume overlay proving the TV key is not swallowed](13-final-player-controls.png)

The comparison shows the intended consistency: transport remains central,
time and progress remain at the bottom, and frequent track/display actions
share the same row. TV uses focus states and larger 48–64 dp targets instead
of copying touch gestures.

## Journey verification

| Step | Expected result | Evidence | Health |
| --- | --- | --- | --- |
| Start playback | Native player opens direct-first and keeps Gateway as fallback | Contract tests and installed debug APK | Green |
| First OK while controls are hidden | Reveal controls without pausing | Media session stayed `PLAYING` before and after OK | Green |
| Navigate primary controls | Rewind, play/pause, forward, Audio, CC, aspect and More are reachable | D-pad focus capture and TV contract | Green |
| Inspect audio | Use exact-file evidence and never provider/category guesses | `Spanish · MP3 · stereo` capture | Green |
| Change audio/subtitles | Persist scoped choices and relay them to the cloud | Resolver/store contracts and activity result bridge | Green |
| Resume on another device | Cloud launch choice can replace a stale local TV choice | Cloud-authoritative launch contract | Green |
| Press volume | Let Android handle the hardware volume key | Native system volume overlay | Green |
| Press Home outside PiP | Stop playback in the background | Media session changed from `PLAYING` to `PAUSED` and stayed paused | Green |
| Recover an expired VOD URL | Close the old socket, resolve a fresh URL, keep timestamp and activity | Recovery contracts | Green |
| Leave during recovery | Retire the token so the next Play is never swallowed | Token cancellation/TTL contracts | Green |
| Show subtitles | Render complete Media3 text/bitmap cues above the visible OSD | TV contract and Media3 `SubtitleView` | Green |
| Terminal failure | Keep the viewer in context with Retry and Back actions | Before/after comparison | Green |

## Corrections delivered

### P0

- Replaced title/provider audio guesses with exact-file, fail-closed labels.
- Added scoped audio/subtitle preferences and TV ↔ cloud propagation.
- Replaced activity-closing VOD recovery with in-place fresh-session recovery
  at the retained timestamp.
- Added cancellation, acknowledgement and a bounded TTL for recovery tokens.
- Bound every asynchronous replacement URL to its exact recovery token and
  discard superseded same-title responses before they can consume a provider
  session, replace the current stream, or open another player.
- Prevented watchdog, reconnect and late recovery callbacks from restarting
  playback while the activity is off-screen and outside PiP.
- Paused playback whenever the app leaves the foreground without active PiP.
- Replaced manual subtitle text with Media3 cue rendering.

### P1

- Added a compact Audio / CC / Fit-Zoom / More row aligned with the mobile
  hierarchy.
- Made the first OK reveal controls without toggling playback.
- Stopped consuming Android volume and mute keys.
- Added overscan-safe top and bottom zones and stable control IDs.
- Added actionable, localized EN/FR Retry and Back errors.
- Restored focus to the controls after Retry.
- Made the cloud payload authoritative on a new launch while retaining the
  viewer's current-session choice during an in-place recovery.
- Syncs only track choices explicitly confirmed by the viewer; Media3
  automatic defaults never overwrite the cloud profile.
- Serializes WebView recovery delivery on the Android main thread.
- Routes MediaSession and dedicated remote Play/Pause actions back through the
  foreground/PiP playback gate.

### P2

- Removed image-stretching mode; TV now exposes Fit and Zoom only.
- Hides playback speed for Live TV.
- Keeps occasional quality, speed, sleep, variant and episode actions in a
  compact overflow row.

## Verification

- Final TV/mobile/recovery contracts: **42/42 passed**.
- Final full repository repeat: **735/736 passed**; the sole
  failure was the unrelated Bash syntax check because the local WSL virtual
  machine timed out while starting. The TV/mobile/recovery tests all passed.
- Android TV debug build: **BUILD SUCCESSFUL**.
- APK: `clients/android-tv/app/build/outputs/apk/debug/app-debug.apk`
- APK size: **18,394,031 bytes**
- SHA-256:
  `376D7C94A567D8D145C5567BC9BBC2484652D09D01F84EB45C40D5E7005D3A71`
- `git diff --check`: clean apart from Windows line-ending warnings.

## Evidence limits

The emulator is AOSP Android TV API 34 at 1920×1080. Its Goldfish H.264
decoder failed on a public AVC sample, so the normal-control interaction used
a public audio sample; the failed video sample was useful for validating the
terminal error journey. This audit therefore does not claim validation of a
specific television's hardware codecs, HDMI-CEC behaviour, vendor remote, or
physical overscan. Those do not change the verified lifecycle, focus, routing,
preference, and recovery contracts.
