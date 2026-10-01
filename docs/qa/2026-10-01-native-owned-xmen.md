# Ordinary owned Selection VOD: native resume and seek

Phone emulator run `run-phone-20261001T025318Z` passed the required real-player
instrumentation test, with zero failures and zero skips. Ordinary QA ownership
was checked against the current visible catalogue; no internal admission or
entitlement changes were used. Direct playback URL matched the exact audited
X-Men 2 source digest. This is host-supplied ordinary-session instrumentation,
not the natural login/card-selection UI.

- Resume target 600000 ms; measured position 605082 ms, 118 new video buffers,
  218 new audio buffers, elapsed 13021 ms.
- Seek target 20000 ms; measured position 25207 ms, 117 new video buffers,
  223 new audio buffers, elapsed 12095 ms.

These elapsed values include at least five seconds of actual playback demanded
by the assertion. They are not direct first-frame measurements. No native HTTP
or player errors were detected. The session was expired and the isolated
emulator stopped; cleanup reports zero active QA sessions and no errors.

All four app/test APK hashes, platform signatures and package names were
revalidated by the existing operator. Source e3577fc658998364e587dee75dfdb67aedbde129
has no production native source difference against current 3a2bff97296d.
The existing test was used without weakening any audio/video/timeline assertion.
Its supplied VOD and requested positions differ from the earlier truncated-file
investigation, which remains an independent source failure.

Evidence and operator:
`/home/adrien/.norva/native-owned-xmen-20261001/`.
Android TV replay was started after successful phone cleanup; outcome pending.
This does not establish Play distribution or physical-phone validation.

## TV control-flow correction

TV run `run-tv-20261001T025529Z` failed at the immediate player-not-null assertion,
before any playback assertion, with no native HTTP error and clean session/
emulator cleanup. Inspection of PlayerActivity confirms resumeSeconds >=30
intentionally displays the focused resume/restart choice without creating a
player. The previous host-supplied test did not confirm this action.

The shared instrumentation now verifies the visible, enabled, focused TV resume
button and sends DPAD_CENTER through Instrumentation, then reads the player on
the UI thread. Phone behavior and all actual audio/video/timeline requirements
remain unchanged. No production player code is changed. This fix still needs
build and a fresh exact-artifact TV replay; the earlier failed run is retained.
