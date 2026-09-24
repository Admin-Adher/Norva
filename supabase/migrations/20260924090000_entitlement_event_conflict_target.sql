-- PostgREST upserts use ON CONFLICT (provider, provider_event_id). PostgreSQL
-- cannot infer the historical partial unique index from that conflict target.
-- A regular unique index has the same deduplication behavior here: PostgreSQL
-- allows multiple NULL provider_event_id values, while non-NULL keys remain
-- unique. Keep the old index during rollout so this change is additive.
create unique index if not exists cloud_entitlement_events_provider_event_full_uidx
  on public.cloud_entitlement_events (provider, provider_event_id);
