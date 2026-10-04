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

## Follow-up at 16:09 UTC

The resume defect was corrected separately; the residual MULTI-SUB stutter is not declared resolved. Maintenance resumed under normal provider guards. All six exact files still lack confirmed audio language. Prey's pass one is now expired after the playback interval, with no current window receipts; this is not a completed analysis. Lost's expired job retains one receipt. Bolt's old job ended with `PROFILE_CHANGED`; its current profile is complete. Mars still lacks a profile.

A demonstrated queue-admission defect prevented explicit resampling while the automatic queue held 32 jobs. The [manual admission correction](2026-10-04-manual-language-resampling-admission.md) was verified with 23 isolated SQL assertions and deployed at 16:07:55. Innocent Voices pass three was admitted at 16:08:09, preserving passes zero through two. Ochi entered via the ordinary authenticated manual API at 15:58:37. At 16:09 both still had zero new receipts, with provider occupancy respected. Neither admission is counted as a probe or identification.


### Natural capture follow-up at 16:15 UTC

Innocent Voices pass three reached three authenticated receipts, with the last new capture at 16:13:14. The first three dispositions are conflict/weak/weak, not accepted language evidence. The next capture was deferred with `LANGUAGE_VALIDATION_PLAYBACK_ACTIVE`; the existing receipts and three provider attempts are retained. Ochi remains deferred for provider occupancy, zero captures. This proves real capture resumption after the admission fix, not a language identification. Both Gateways returned HTTP 200 / ok at 16:12:46; automatic admission remains enabled with 32 automatic and two manual jobs. The proof container is stopped; the permanent dispatcher was not restarted.

Code commit `1599a43ad628e675bf4845be0db82ee7b9c9626f` passed the cloud contracts, Edge contracts/types, disposable database, customer journey, notice policy, GoTrue acceptance, Android phone/TV tests and both Android package builds. The Windows package was still running at 16:15. PR 632 records the change; Codex attachment hit the existing 100-item limit, with no other attachment removed.


## Human listening confirmation after the AAC decoder correction

On 4 October, the user explicitly confirmed that the sound was normal and that
the current Innocent Voices [SUB] copy was spoken in Spanish. See the
[AAC decoder acceptance](2026-10-04-aac-decoder-regression.md). This is a
human identification of the exact selected file and track. The prior
inconclusive automated runs, source audio tag `und`, and independently known
English subtitles retain their original provenance. This documentary update
does not publish a fabricated provider declaration or strict worker result.
The other five requested film identifications remain open.


### Second user listening confirmation: Prey

The user then explicitly confirmed: "Prey l'audio est anglais je confirme".
English (`en`) is recorded as human-confirmed for the Prey copy discussed in
this playback investigation. This does not apply to every Prey variant or
turn its expired/inconclusive automated jobs into completed validations.
Together with Innocent Voices (`es`), two requested films now have direct
user listening confirmations; the other four remain unconfirmed in this
six-film request. These documentary confirmations have not changed the
catalogue badges; a separate human-provenance publication path is absent
from the code audited at this point.

### Additional user listening confirmations: Sinners and California King

The user subsequently confirmed English for the copy shown in the screenshot
of Pécheurs / Sinners (2025), with category `[MULTI-LANG] TOP 2025 MOVIES`, and
explicitly for `California King [MULTI-SUB]`. These two titles are outside the
original six-film request. Four copies in total now have human language
confirmations in the accompanying listening register, while four of the
original six films still lack a human confirmation.

The screenshot and named title identify the user's intended copies for this
documentary record; this update does not resolve their exact database file
coordinates. It does not propagate a language to other versions, certify
audio quality for either film, modify catalogue badges, or count these
confirmations as automated recognition successes.

The next user message also confirms English for `Broke [MULTI-SUB]`. This
brings the listening register to five confirmed copies, with the same
provenance and publication limits. Broke is outside the original six-film
request; the four outstanding films in that request remain unchanged.

### Publication after explicit owner request

The user then requested badge updates. The five confirmed copies were resolved
against the server playback history and published through a separate,
owner-scoped human-confirmation register. Production browser verification now
shows Spanish for Innocent Voices and English for Prey, Sinners, California
King and Broke. See [the publication proof](2026-10-04-human-confirmed-audio-badges.md).
This supersedes the earlier documentary-only badge limitation. Automated LID
records and their outcomes were not rewritten.

### Guarded follow-up at 21:48–21:54 UTC

Innocent Voices and Prey remain human-confirmed and published; neither was
requested again. For the four remaining exact files, current profiles/cache
match for Lost, Ochi and Bolt; Mars still lacks a profile. The normal guarded
profile request for Mars at 21:53:33 deferred for provider occupancy with zero
attempts. Ordinary authenticated manual requests admitted Lost and Ochi at
21:53:43/52, preserving the prior terminal jobs and their observed evidence.
Both then deferred for provider occupancy without a new capture at 21:54:26.
Bolt's preflight respected the manual/provider queue limits and sent no POST.
No sampling-pass override, lease reset, lowered threshold, language publication
or media launch was performed by the operator. Final follow-up and aggregate
receipts are in [the heartbeat report](2026-10-04-language-campaign-heartbeat-2348.md).

At 21:58:18 the new Lost job has two completed windows and two receipts, with
last provider progress at 21:57:50. This demonstrates actual capture progress,
not complete language validation. Ochi remains deferred with zero attempts.
The earlier Lost job's single receipt is preserved separately; it is not added
to the new job's two receipts as a fabricated three-window completion.
