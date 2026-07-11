-- =============================================================================
-- Allow 'revolut' in the entitlement EVENTS idempotency journal.
-- =============================================================================
-- 20260711160000 added 'revolut' to cloud_entitlement_projection's provider
-- CHECK, but cloud_entitlement_events has its OWN provider CHECK (defined in
-- 20260616122103_cloud_entitlements.sql, never extended for stancer either).
-- The Revolut webhook records each processed event there for idempotency, so
-- the insert fails ("cloud_entitlement_events_provider_check") and the whole
-- handler 500s AFTER the projection upsert — making Revolut retry forever.
-- Whitelist 'revolut' (and 'stancer', to match the projection list).

alter table public.cloud_entitlement_events
  drop constraint if exists cloud_entitlement_events_provider_check;

alter table public.cloud_entitlement_events
  add constraint cloud_entitlement_events_provider_check
  check (provider in (
    'system','manual','revenuecat','google_play','apple_app_store',
    'web','stripe','stancer','revolut'
  ));
