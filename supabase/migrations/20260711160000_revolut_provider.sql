-- =============================================================================
-- Allow 'revolut' as an entitlement provider (Stancer → Revolut migration).
-- =============================================================================
-- cloud_entitlement_projection.provider has a CHECK whitelist (last set in
-- 20260703170000_stancer_billing.sql). The Revolut webhook upserts rows with
-- provider='revolut', so it must be whitelisted first or every upsert fails.
-- 'stancer' is kept for the rollback window; drop it once Stancer is retired.

alter table public.cloud_entitlement_projection
  drop constraint if exists cloud_entitlement_provider_check;

alter table public.cloud_entitlement_projection
  add constraint cloud_entitlement_provider_check
  check (provider = any (array[
    'system','manual','revenuecat','google_play','apple_app_store',
    'web','stripe','stancer','revolut'
  ]));
