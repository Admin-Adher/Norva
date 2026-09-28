# Metadata lane progressive admission

## Scope

The accelerated metadata lane previously required a global switch. This change adds stable owner cohorts (0, 1, 5, 20, 50, 100 percent), without an internal-account exception. Source ownership, enabled/ready state, deleted/banned owners, fresh capacity and the existing global admission lock remain enforced. Installation starts at zero. This does not activate exact-file admission or alter capture rollout.

The Edge dispatcher uses the owner/source RPC. Missing SQL, RPC errors or an unselected owner retain the existing single-file path. Selected owners use the existing bounded four-item metadata batch and provider cleanup logic.

## Evidence, 28 September 2026

- 15 metadata Node tests pass, including RPC argument binding, fail-closed fallback, bounded batch, foreground priority and shared reservations.
- Disposable networkless PostgreSQL 15 fixture: 18 named assertions and three exception guards pass. Tests cover stable cohort admission, cross-owner refusal, capacity exhaustion/expiry, ban/disabled source, revision conflict, stage order, idempotence and rollback.
- The fixture stubs the existing intake function. It proves new SQL guards, not full provider execution.
- Production read-only inspection finds exactly one old metadata gate and one capacity gate in the installed intake, with the global admission lock present.
- The complete migration successfully applied to the real production schema inside a transaction ending in ROLLBACK. The temporary state reported revision 0, basis points 0 and null owner/source refused. No rollout was committed.
- Temporary QA PostgreSQL container removed after verification.

## Deployment and activation requirements

Integrate the reviewed commit, deploy SQL at zero and then the matching Edge function through the existing drain guard. Confirm artifact parity before activation. Advance each cohort only after observing actual completed metadata work, foreground playback priority, owner isolation and no retry/capacity regression. Record stage revisions and runtime evidence here. An empty cohort or passing unit tests are not activation evidence.

Emergency rollback uses the service-only `set_catalog_language_metadata_rollout` RPC with the current revision, zero basis points and an audit note. The legacy global metadata flag must remain false during this rollout; if independently enabled, it retains its previous global semantics.

At the time of this report, this change is not deployed or enabled in production.
