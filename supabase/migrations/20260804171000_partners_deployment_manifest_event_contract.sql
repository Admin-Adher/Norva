-- Norva Partners: deployment manifests are first-class audited aggregates.
--
-- This additive repair deliberately follows the approval-registry migration
-- so it also upgrades persistent environments where that migration may already
-- have been recorded. The existing constraint remains active while PostgreSQL
-- validates the compatible superset.

alter table affiliate_private.affiliate_events
  add constraint affiliate_events_aggregate_type_v3
  check (
    aggregate_type in (
      'release_gate',
      'feature_flag',
      'pilot_allowlist',
      'program_version',
      'country_policy',
      'account',
      'link',
      'kyc',
      'attribution',
      'financial_fact',
      'commission',
      'payout',
      'tv_relay',
      'admin_capability',
      'worker',
      'configuration',
      'access_request',
      'deployment_manifest'
    )
  ) not valid;

alter table affiliate_private.affiliate_events
  validate constraint affiliate_events_aggregate_type_v3;

alter table affiliate_private.affiliate_events
  drop constraint affiliate_events_aggregate_type;

alter table affiliate_private.affiliate_events
  rename constraint affiliate_events_aggregate_type_v3
  to affiliate_events_aggregate_type;
