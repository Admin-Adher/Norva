-- Per-profile hidden genres for the catalog-based "hide by genre" feature in
-- Manage Content. Stored as a JSONB array of curated bucket ids (e.g.
-- ["horreur","telerealite"]). A title whose curated genre buckets intersect this
-- list is excluded from that profile's catalog (rails, "See all", etc.).
-- Per-profile so a "Kids" profile can hide Horror / Adult Animation, etc.
alter table public.cloud_account_profiles
  add column if not exists hidden_genres jsonb not null default '[]'::jsonb;
