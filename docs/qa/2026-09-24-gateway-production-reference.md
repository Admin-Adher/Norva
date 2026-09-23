# Gateway production reference — 24 September 2026

## Scope

Reconcile the deployed Gateway source and playback Edge entry point with main. Source snapshots came from the existing production deployment; this change does not activate features or deploy services.

- Gateway: 31 substantive source differences after CRLF normalization (23 missing modules, eight changed modules).
- Playback Edge: restored native MP4 grants, private resume identity, HLS cohort routing, M3U episode resolution and deployed receipt behavior with four missing shared helpers.
- Deployment health gate: exact playback version 82, matching the candidate.
- Existing tests now execute the corresponding current modules. Preserve provider ownership, serialized upstream access, terminal errors, abort/drain ordering and opaque grants.

## Verification

- Gateway/playback regression: 992 tests; 984 pass, zero fail, eight skipped. Runtime: 90.6 seconds. Native/platform-specific skips are not production evidence.
- Four additional M3U ownership tests pass: visible owned source, same-generation parent, URL hash and source-type binding, unavailable/wrong-owner rejection, database failure closed.
- No runtime deployment performed by this reconciliation.

## Remaining gates

Review the complete source diff and CI; inspect all imported-module dependencies against production; reconcile container build inputs and both server mounts/configurations; rebuild and compare before deploying. The tests do not certify commercial signup/payment, ordinary-account real playback, Android distribution, shared-cache activation or capacity beyond the existing 20-viewer evidence.
