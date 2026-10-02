# Commercial readiness — consolidated closeout, 2 October 2026

This is an evidence ledger, not a declaration of 100% completion. Fresh checks
below were performed on 2 October. Earlier replay evidence is labelled as such.
No 100-reader campaign or Partners payout activation is included.

## Production reference and corrective work

- Both routed Gateways: healthy version 171, image
  `sha256:8c5ec2976d5de70d2060cf386d676e2105b844d2818c4915bb619e8bbdd361f3`.
- All 80 source/package files match between nodes and Git reference
  `4b31ae43af00835f30cb165fe432ecd542c3378e`. Text comparison normalizes CRLF only.
- A real deployment drift was found: the main Compose override still named an
  older image. Corrected at 05:17 UTC without restarting either Gateway.
  Rendered image, complete environment and mounts now match the running node.
  Backup: protected server receipt `compose-override-before-20261002T051705Z.yml`.
- `persist-reference-gateway-compose.py` now takes an explicit expected image
  and defaults to a plan; `--apply` retains its backup and rollback verification.
- Both Docker specifications were saved, mode 0600 inside the server's 0700
  `commercial-closeout-20261002` directory. They include secrets and must never
  be committed. Their receipt hashes are
  `6e6ad9c1ed94adc9828e3755a8d7d3e5577ebb4de7b2643c2b9842ffe0546e5d`
  and `47cb398d61d7e560abeffcfb583b8eab11e0ab5f86d9c33c102127dbc68101b3`.
- The immutable codec base used by `Dockerfile.production-reference` remains on
  the host. Rebuilding elsewhere requires transferring that base image with
  Docker save/load; its local image ID is not a registry download reference.
- Edge audit found seven formatting/import-order/comment differences and an
  old, unused Edge copy of the Selection audio helper. Aligned these eight files
  to `eb2f8f5b` after 39 focused tests. Seven obsolete QA/backup source files were
  moved reversibly outside the served functions tree. Both Edge replicas were
  restarted sequentially, each passing playback health version 84 before the
  next restart. No database protocol or Gateway restart was involved.
- All 179 served Edge JS/TS/MJS files now match that reference on both replicas.
  `_shared/selection-shared-publisher.mjs` is an offline publication helper in
  the repository, not an imported runtime dependency or a served function.

Machine-readable evidence: `2026-10-02-commercial-production-state.json` and
`2026-10-02-edge-reference-hashes.json`. These intentionally omit credentials.

## Feature state and remaining gates

| Area | Fresh state | Remaining acceptance gate |
| --- | --- | --- |
| Provider Access | 50%, revision 21; safety assertion true | Complete the real observation, then promote and restore channels using CAS |
| Provider observation | Two qualifying changes, no rollback or visibility violation | Not before **2 October 15:15:26 UTC / 17:15 Paris** |
| Private/shared cache and live joining | Enabled on both Gateways and both Edge replicas | Preserve distinction between actual use and merely enabled flags |
| Adaptive provider routing | Policy enabled but shadow mode; one configured HTTP candidate per Gateway | A second independently usable route and end-to-end selection/recovery proof |
| Accelerated language metadata, exact-file and capture | Each cohort 100%, revision 5 | No need to repeat obsolete pilot rollout steps |
| Storyboard durability | Both nodes enabled, all authenticated owners | Native timeline previews are not inferred from web storyboard persistence |
| Play retention campaigns | Campaign and communications flags false; sandbox acceptance false on both production Edge replicas | Physical 1.3.29 replay and controlled communication checks before activation |
| Partners payouts | Payouts and Revolut payout API false; shadow mode true | Deliberately excluded |

Provider observation ID `db38d795-ba5d-478d-81f6-7ddec85eca20` supersedes the
older observation. Do not shorten its time window or manufacture activity.
The two credential changes already qualify; the remaining gate is elapsed time
plus a final metrics/safety check. Promotion resets external channels, which
must be explicitly restored only after the new stage is healthy.

## Ordinary-account web replay

The existing October 1 commercial QA account was verified in Settings as the
ordinary test customer. Its cancelled Plus trial preserves access until October
8. No new card transaction or entitlement override was performed on October 2.

- Selection catalogue search returned language-labelled film variants.
- Creed III detail page showed a localized synopsis, poster, cast and categories.
- Natural Play action produced decoded 1280×544 video, readyState 4, with time
  progressing from 4.52 to 55.74 seconds. This was the Gateway route, not an R2 hit.
- A seek around 12:21 produced video at the new position. The test also toggled
  pause manually; it is not an automatic seek-continuation latency benchmark.
- After leaving the player, the detail page offered Resume. Resume displayed
  12:41 with 11.45 seconds of the resumed stream already decoded at the check
  made 19 seconds after clicking. This is a checked upper bound, not a measured
  first-frame latency. Continue Watching then contained Creed III.
- The player was closed by navigation after the replay.

This strengthens the ordinary-account playback evidence but does **not** satisfy
the separate request for importing a provider previously unknown to Norva.
The user has been asked for another authorized provider through the browser,
or an explicit scope decision if none is available.

## Distribution and mobile promotions

Fresh Google Play console check: **1.3.29 (43), submission 27, published
2 October at 06:51 Paris**, full rollout. Earlier cached “under review” status
is superseded. The connected phone still reports 1.3.28 (42); the user has been
asked to install the Play update and reopen Norva. Google Play TV production is
**3.8.22 (35), 100%**, published September 29.

Before campaigns open, the web billing capability gate is raised from 1.3.24
to **1.3.29**, which contains the FETCH_CURRENT subscription-state fix.
Older clients use the existing update invitation rather than the stale native
purchase path. Twenty-nine focused billing tests pass, including rejection of
1.3.23/24/28, acceptance of 1.3.29 and later, and exclusion of TV/legacy bridges.
Publication of this web guard and the physical replay must be recorded below.

The October 1 isolated purchase evidence remains valid: monthly reduction for
three renewals, regular fourth price, annual reduction, confirmation before old
expiry and preserved access boundary. Sandbox receipts never activated real
production entitlements. See `2026-10-01-google-play-retention-followup.md`.

## Earlier evidence retained, with its actual scope

- MAX OTT and Dino reached final ready/active/visible states; the September 26
  production report records 217,710/59,249 logical titles and coherent variant,
  category and language counts. No new full import is claimed today.
- Selection activation was observed at 9.44 seconds on October 1 after shared
  catalogue publication. See `2026-10-01-selection-shared-activation.md`.
- September 24 shared-cache tests included three owners, scoped ticket denial,
  isolated revocation, real ordinary-account web use and native cache/recovery.
  Live-joining tests used synthetic media and API playback; they do not certify
  every provider or constitute an Android UI joining replay.
- September 30 native cache replay: six real cache playbacks across phone
  gesture/three-button navigation and font 1.0/1.3, plus TV D-pad 1.0/1.3;
  30 tests including 24 contracts, not 30 distinct real streams. APK source and
  artifact provenance are in `2026-09-30-native-cache-release-proof.md`.
- October 1 six-configuration emulator run `36906943420` passed on the native
  source used for 1.3.29; signed build `36907223342` passed. A distributed-phone
  replay remains a distinct gate.
- September 22/23 endurance r3: **20 readers**, ten Windows and ten Linux,
  common steady interval **7,204.971 seconds**, archived receipt SHA-256
  `506fd35c7fccb4d5c7108b2253eabdfd85499ebc7c121f5b2e5e75513906e339`.
  Neither the configured 64-viewer joining limit nor this historical test is
  a 100-reader certification.

## Completion rule

Do not mark the broad goal complete while the Provider Access gate, independent
route decision/proof, unknown-provider ordinary-customer journey, distributed
phone promotion replay, or corresponding campaign activation evidence is open.
No assertion of instantaneous starts, universal supplier availability or exact
WebView FPS certification is made by this audit.

## Publication receipt, 05:43 UTC

- PR 563 merged as `41fcbd3175b547a440420bf65a17a35c3fb96435` after CI
  `36969455540` passed cloud contracts, Android phone/TV and Windows builds.
- Cloudflare deployment `36969950833` succeeded. The public billing asset was
  fetched and matched SHA-256
  `115ed5b5c4c7fc79d0d3ffb7ab27213b8e76db3d323329e09935deb325c2821a`.
  The 1.3.29 promotional-purchase guard is therefore globally published.
- The SQL internal-account predicate confirms `false` for the ordinary QA owner.
  Source/language filtering returned only the two Spanish Creed variants;
  filters were then reset and the new-provider form left ready for the user.
- NodeMaven's authenticated inventory shows exactly one active USA HTTP proxy.
  A quote for one France HTTP ISP proxy is USD 4.99 per 30 days before tax,
  recurring. No purchase or terms acceptance was performed. Its checkout's
  billing-country field must be verified by the user before any payment.
- The broad objective remains open for the timed rollout gate and the user
  dependencies recorded above. These receipts do not activate mobile campaigns.

## Mobile gate closed, 06:33 UTC

The phone now runs Google Play 1.3.29 (43). Isolated physical purchases confirmed
monthly reactivation after expiry and annual replacement before expiry, with
Google-verified preserved access and immediate in-app confirmation. Mobile
campaign and communication policy is now enabled in production; the dedicated
dispatch returned HTTP 200 with zero eligible production recipients. Sandbox
acceptance remains false. See `2026-10-02-mobile-retention-production.md` for
receipts, exact scope and the separately observed standard-checkout retry.
The broader Provider Access, route and unknown-provider gates remain open.

## Real application conversion-sharing replay, 11:20 UTC

See [the detailed replay](2026-10-02-shared-conversion-app-proof.md).
Two profiles of an ordinary QA owner played a real Norva Selection MKV through
the normal web UI and shared one in-progress conversion. The joined viewer's
post-fix first frame was measured at 1.820 seconds. Closing the original viewer
did not terminate the follower. A separate internal owner's physical Android
launch exposed a destructive auxiliary-drain call; PR572 corrected it and is
merged. Gateway172 and Edge85 are deployed on both production routes, with
78 Gateway source files matched and main Compose pinned to the immutable image.

This closes the **synthetic-only proof gap for that web joining scenario**.
It does not close every playback gate: the follower encountered buffering and
resumed automatically; the same MKV still failed before its first frame on
phone1.3.29. Nonzero concurrent resume used the existing single-slot replacement
path. Neither native in-progress joining nor arbitrary-offset concurrent resume
is certified. All test players were closed and server viewer/pump counts returned
to zero. The broader objective remains open with these limits recorded explicitly.
