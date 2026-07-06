-- Backing for the source "Disable / Enable service" toggle (and the frontend's existing
-- `sources.filter(s => s.enabled)` content filter, which currently sees `undefined`). A disabled
-- source is paused: excluded from auto-refresh / resume-stuck and hidden from the catalog UI, but
-- its data stays until the user removes it. Default true so every existing source stays active.
alter table public.cloud_sources add column if not exists enabled boolean not null default true;

-- Auto-refresh/resume scans filter on this; keep those lookups cheap for the rare disabled rows.
create index if not exists cloud_sources_disabled_idx
  on public.cloud_sources (user_id)
  where enabled = false;
