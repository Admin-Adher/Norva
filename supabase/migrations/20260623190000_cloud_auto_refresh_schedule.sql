-- Per-source schedule + lock state for the premium background auto-refresh cron.
-- A pg_cron tick calls norva-source-sync POST /cron/refresh-due, which walks the
-- few sources whose window is due (auto_refresh_next_at is null or in the past),
-- enforces the auto_refresh_background entitlement, and drives each through the
-- normal (change-detection-cheap) sync.
--
--   auto_refresh_next_at  when this source is next eligible to refresh. NULL =
--                         "due now" (newly created sources fall in immediately).
--   auto_refresh_state    small jsonb the cron owns: { lockedAt, attempts,
--                         backoffUntil }. lockedAt is the compare-and-set lock
--                         (self-frees after a TTL); attempts/backoffUntil drive
--                         exponential backoff after a provider error.
--
-- Written only by the edge function (service role). Dormant until a user is
-- actually entitled — non-entitled sources just get their window pushed out.
alter table public.cloud_sources
  add column if not exists auto_refresh_next_at timestamptz,
  add column if not exists auto_refresh_state jsonb not null default '{}'::jsonb;

-- The cron's "due" query orders by next_at across only xtream/m3u sources; this
-- partial index keeps each tick's scan to the handful that are actually due.
create index if not exists idx_cloud_sources_auto_refresh_due
  on public.cloud_sources (auto_refresh_next_at nulls first)
  where source_type in ('xtream', 'm3u');
