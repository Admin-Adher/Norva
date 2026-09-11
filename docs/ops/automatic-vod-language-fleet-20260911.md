# Automatic movie-language intake

## Scope

The existing dynamic enrichment fleet now feeds the exact-file strict worker
from every enabled, visible, ready source of an entitled account. New sources
are discovered by the existing fleet reconciliation; a new active catalogue
generation resets its small-page intake cursor. There is no account allowlist.

Only lane 0 (movie profile probe) is replaced. Existing episode inventory,
episode audio, tagged-language, subtitle and overview lanes are unchanged.
This does not promise recognition of every file, support for every streaming
format, or an immediate complete scan of every catalogue.

## Evidence and reuse

- Read the current exact-file cache first; do not start a second analysis of a
  known inventory or certified file. Declared track languages and speech
  certificates remain distinct evidence classes.
- When needed, run one bounded existing codec probe, then enqueue the existing
  strict 4/6-window worker. No alternative model or threshold change.
- Reuse results across accounts only under a server-verified provider identity
  and the same exact file/profile binding.
- For an unrecognized M3U/provider, use the server-derived `source:<UUID>` key.
  Observation, certification and title facets remain local to that source.
  A subsequently resolved shared identity invalidates pending private jobs;
  private certificates are not automatically promoted into shared evidence.
- A newly observed replacement clears old certificates and reopens the bounded
  intake budget. The same exhausted bytes are not retried by each sweep.

## Scheduling and safety

- `automatic_vod_language_fleet_enabled` is default OFF in the migration.
- Reuses `norva-dynamic-enrichment-fleet` and the strict worker cron; no extra
  provider cron, model process or provider concurrency.
- Keyset pages: 256 variants maximum; one leased exact-file operation per source.
- Intake leases: 20 minutes. Failed transport attempts: at most three, with
  backoff. Deferred account-busy work waits; it is not a language failure.
- Existing two-active / twenty-starts-per-user-per-day admission limits remain.
  Therefore this is a progressive rollout, not an immediate mass enrichment.
- Existing playback priority, account access, generation/visibility fences,
  provider circuits, drainage attestation and quarantines remain enforced.
- Learned-rule promotion is still 99% on at least 200 held-out files. This
  rollout does not change that independent requirement or measure model accuracy.

## Verification and release

`deploy-automatic-vod-language-fleet-20260911.py` copies schema and function
definitions, not production rows, into an isolated networkless PostgreSQL 17.
The SQL fixtures exercise paging, access, leases, future imports, changed
profiles, cache isolation, actual fanout and derived title languages. Visibility
is a fixture wrapper and production row triggers are not copied: the fixture
is not a complete simulation of production concurrency or UI.

The release stages only the two changed Edge modules plus one new pure module,
preserving every other live file. It applies the guarded migration while OFF,
replaces each Edge replica in turn, verifies protocol 1, then enables the intake.
Original stopped containers and immutable function trees are retained.

Operational state is in `catalog_vod_language_sweeps` and
`catalog_vod_language_intake`. These tables and the claim/finish RPCs are private
to service-role operators. No URLs, credentials or transcripts belong there.

To pause only the new intake, a privileged operator may set
`automatic_vod_language_fleet_enabled=false`. This does not cancel already queued
strict jobs or disable the pre-existing enrichment lanes. The established
`enrichment_paused` and `audio_lid_enabled` gates remain separate global controls.

Production activation and observed counts must be recorded separately from
local tests and Git publication; passing these tests is not proof of a model's
success rate on all providers.
