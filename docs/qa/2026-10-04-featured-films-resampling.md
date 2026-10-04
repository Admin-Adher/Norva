# Featured films — explicit additional speech regions

Date: 4 October 2026. Scope: the six exact MAX OTT variants selected from the authenticated Movies category rails, at the user's explicit request. No language is inferred from a translated title, country, subtitle tag or TMDB.

## Change

The old strict sampler always used the same six anchors. An identical retry therefore could repeat the same inconclusive speech regions. Commit `22dee741bd192de7f4c103f8be357533e7daf450` adds a signed, bounded sampling pass to the existing capture/checkpoint pipeline. Pass zero stays compatible. Passes one through six use disjoint 60-second search regions for files at least 2,880 seconds long. Silero selects 20 seconds within each region. The four-window consensus, probability, lexical diversity, transcript agreement and playback preemption checks are unchanged.

The service-only SQL entry point permits a new pass only after a complete inconclusive prior pass on the same owned, active file profile. It creates a separate job and preserves prior receipts, attempt counts and retry dates. Quarantines, transport failures, incomplete runs, duplicate/skipped passes and queue/admission limits remain protected. It does not enable an automatic replay of the global inconclusive backlog.

## Verification before deployment

- 101 focused JS tests passed; one existing optional test skipped.
- 17 assertions passed in a networkless database with schema only and synthetic records. No customer rows or provider connections.
- Four resampling tests also passed inside the built Gateway image.
- All 12 GitHub checks passed on the code commit, including Edge types, disposable database and platform packages.
- Edge canary healthy. A Gateway canary was then started with the production numeric user and GPU device configuration, isolated storage and no network; health returned `ok`.

## Deployment and incident

The first deployment paused new admissions at 12:59:37 UTC. The first Gateway replacement failed to start because the thin image copied source files with mode 0600, unreadable by runtime user 1000. The rollback helper also incorrectly treated a restarting container as potentially serving viewers. The previous healthy Gateway was restored at 13:02:03 UTC; the failed container was retained. The exact interval without health service is not yet reconstructed. No claim of an interruption-free deployment is made. No viewer session was active at the pre-deployment idle check. Edges and SQL had not yet changed.

The image was rebuilt with source mode 0644 and the isolated runtime-user canary passed. The second controlled pause lasted 13:05:49–13:06:15 UTC. Both Gateways and both Edges were replaced successfully; the migration applied at 13:06:14.727 UTC. Admission, cron, Selection worker and permanent dispatcher were restored. No lease, circuit, quarantine or old job was forced or reset.

- Gateway image: `sha256:b65be379d436eb6d32287374704524424c5e55c89619b213272e3b6ef665fb6a`.
- Gateway entry point SHA-256: `ff8e93238a0ae475dd177515fe565f56ccb6731269429ff86b890930f622a791`.
- Playback Edge SHA-256: `ffe66d313222d7dea0d815d9dd13abcf2621e8ca0bf3e2acf33c2abb54129446`.
- Migration `20261004143000_explicit_language_resampling.sql`: SHA-256 `eb5a0e224ae3227ee2cf7191bc6a8db3f98aa7c5bda1a24e1e1d1e6c5572a8c5`.
- Other Edge files were preserved from the latest runtime, including the Last Bullet declaration fix.
- Proof containers and Edge/Gateway canaries are stopped; the permanent service remains running.

## Actual film results — work in progress

At 13:06:35 UTC the service admitted new pass-one jobs for Innocent Voices and Prey. At 13:12:43, Innocent Voices had five new authenticated window receipts; Prey was waiting in the same provider lane. These are not final language identifications.

Authenticated receipt diagnostics on the first four new Innocent Voices windows found Spanish candidates throughout: one accepted window (probability 0.966257), two weak windows with agreeing Spanish transcript classification, and one insufficient-speech window. The language is still unpublished until the existing proof requirements are met. English subtitles were independently observed earlier and do not certify English audio.

Lost on a Mountain in Maine has an exact AAC profile but no strict job yet. Ochi, Bolt from the Blue and I Want to Live on Mars still need their first complete track profile. Explicit guarded profile requests at 12:50 and 13:06 returned provider-account-busy without provider I/O. They are not counted as probes. All six variants share the MAX OTT provider account; requests stay sequential.

This report must be updated with final exact-file verification and the visible application cards. No completion is claimed at this stage.

## Follow-up at 14:00 UTC

The preceding 13:12 section is historical, not the current result. Innocent Voices completed passes one and two, both inconclusive; prior receipts and retry dates remain preserved. Pass one includes an accepted Spanish sample, but not four accepted independent windows. Pass two also produces mostly weak Spanish candidates. A separately pinned medium-model diagnostic on one existing, unexpired Spanish musical sample did not improve confidence (0.609 versus 0.693 from the production model). No model, probability threshold or language was changed. Diagnostic speech files expired and were removed.

Prey pass one has five receipts, including one accepted English sample, and is deferred for active playback. Lost's manual job captured one window, then expired in the queue during the subsequent playback investigation; this is not a completed analysis. Ochi and Bolt now have exact profiles from real playback. Bolt has a pending job, zero completed windows at the observation. Mars still lacks an exact profile. No additional language identification is claimed for these six files.

The user's live stutter report took immediate priority. See [the multi-file comparison](2026-10-04-featured-multisub-stutter.md): both Bolt and Lost MULTI-SUB samples reproduce input corruption before HLS conversion, while another Lost MKV copy on the same provider route played without those errors and was confirmed fluid by the user. The six-film language request remains incomplete. Reading the alternative version does not establish the language of the original exact file.
