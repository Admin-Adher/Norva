> Subsequent expansion: see [Qualified VOD expansion](selection-qualified-vod-20260907.md). The counts below describe the original playback samples.

# Individually tested VOD addition — 7 September 2026

The audit pins 14 exact files from HERBERTM3 (5), KlysmGt (5) and Sandro (4).
Thirteen are enabled after authenticated catalogue acceptance; Nobody remains
held because an unbuffered seek does not resume in the gateway route.
The addition contains 10 movie versions and three physical episodes, grouped under Suits,
Peaky Blinders and Prison Break. No complete upstream playlist is imported.
Pixeldrain's five hotlink-denied files and the unavailable Ong-bak 3 file remain excluded.

Each file passed 120 seconds of continuous playback in the production Web player,
with forward/backward seeking and teardown. This was a direct-URL media audit;
normal catalog import and authenticated resolver acceptance are separate release checks.
Creed II took 18 seconds to start. Ads are accepted, including the advertisement
observed in the Black Panther file. No availability, native-player or capacity guarantee follows.

Authenticated catalogue acceptance additionally requires 30 seconds of decoded video
and audio, a seek outside the buffered passage, five seconds of playback after that
seek, and release of all owned player sessions. A resumed passage cannot validate
an unbuffered seek to the same position. Invalid automation attempts that never
launch the selected content are retained separately from media failures.

The acceptance tests exposed a Norva Relay transport defect: wrapping an upstream
body with the revocation ReadableStream caused Workers to omit Content-Length.
Some progressive files then exposed only a 0-0 seekable range. Commit e01f9b79
preserves known identity-encoded lengths using FixedLengthStream, retaining
revocation and cancellation. A real workerd HTTP regression reproduces the missing
header and verifies the corrected full and partial responses. Production playback
now exposes the full duration for Premiere annee, Black Panther, Cheaper by the
Dozen and Extraction 2; their seeks resume in approximately 1.3-2.4 seconds.
Extraction 2 took 30.4 seconds to start on this acceptance run; this remains a
measured startup limitation. Nobody is excluded from both imports and URL resolution
until a later complete catalogue playback test succeeds.

TMDB identities and release years were checked against its API. Series file labels
are normalized from their source numbering: Suits T4 chapter 12 becomes S04E12;
Peaky Blinders chapters 19–24 become S04E01–06; Prison Break chapters 58–78 become
S04E01–21. These are supplier-derived coordinates, not an audiovisual fingerprint
verification of episode identity. No untested episodes or complete seasons are implied.

The existing TMDB validation/enrichment workflow handles editorial metadata and genres.
Observed container audio tags are retained with codec metadata; an undefined language
does not inherit TMDB's original-language field or the playlist's country. A Matroska
file named `.mp4` keeps its measured `mkv` container. The HLS-specific relay is not
used for progressive MP4/Matroska files. Source ownership and generation fences remain.

The technical audit did not establish commercial distribution rights for these
repositories. User authorization to publish the technical selection is recorded
separately from the unchanged `integration-rights-unestablished` audit status.
