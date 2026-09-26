# Restoring a fiche with current catalogue evidence

## Production observation

A new, authorized MAX OTT MKV language-validation job completed six samples on
26 September, from 02:11:28 to 02:19:46 UTC (497.16 seconds, including admission
waits). The exact file was certified English. Its owner observation and the
authenticated catalogue response both expose English with `verified` status.
No retry history or quarantine was reset; acceleration flags remained off.

The grouped Jasper Mall card already included a different English MP4. Its badge
was not used as evidence. The MKV version initially showed “Audio en attente”.
After completion, reloading the saved fiche still showed that stale state;
issuing a fresh search showed “Anglais” on the MKV version itself.

## Change

Saved fiche restoration now resolves its source and item through the existing
catalogue resolver instead of replaying the saved metadata/version group.
Movie and series selection use source plus provider-local ID. Series resolution
also replaces the selected placeholder with the fresh record, as movies do.
New snapshots retain navigation identity rather than entire version groups.

Offline fallback retains only navigation identity and makes no stale audio
claim. Newer navigation/fiche intents retain precedence over delayed work.

## Verification

- 28 focused Node tests passed, including eight behavioural restoration cases.
- Browser fixture executed the real restoration, page resolvers and version
  renderers for movies and series: fresh English evidence and selected source
  verified. No account/provider traffic in this fixture.
- Android WebView replay added to the existing version-card instrumentation,
  at text zoom 100 and 130. Emulator execution and production replay pending.
- No production deployment or Android startup speed improvement claimed here.

The real-file ASR result is a baseline for the current pipeline. It does not
validate the separate accelerated-capture candidate or global activation.
