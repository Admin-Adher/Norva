# M3U series-info production reference — 24 September 2026

The production `norva-series-info` Edge function already loads imported M3U
series through the visible owner, source, and current catalogue generation. It
then rechecks the source snapshot before responding and excludes those private
episodes from Xtream's shared exact-episode inventory. The versioned function
was missing that route, so rebuilding it from Git could have removed episode
details for M3U customers.

The production function and its `_shared/m3u-series-info.mjs` dependency were
read again from the shared mount used by both Edge replicas. Their SHA-256
values are `332768840968ebd8ab675020d6ff433cebe73b1f7dd0de23d6320ad2de249452`
and `831bd11ada9f81f10480ed107c5aa6b71c04bbc5d44e759f8de4340d3a56b535`.
After this change, the LF-normalized versioned files match those production
files exactly. The dependency was already present in Git; only the function
route was added.

Forty-five focused owner/generation, M3U episode, series-info, visibility-epoch,
and audio-foundation checks passed locally. The new route contract requires
the owned generation and final snapshot recheck before responding. CI results
remain to be recorded with the merge.

This is source reconciliation, not a new production deployment or a successful
paid-account playback test. Other Edge modules still differ from Git. A full
rebuild and live app replay remain required for the commercial-readiness goal.
