-- Cross-user series-info cache, keyed by the PROVIDER (server_host + series_id). Xtream
-- get_series_info returns the same season/episode payload for every user on the same
-- provider, but the provider rate-limits hard (user_multi_ip / 429) on concurrent or
-- datacenter access — so re-fetching it on every fiche open is both wasteful and flaky.
-- Once ANY user successfully loads a series detail, the full payload is stored here and
-- served to EVERYONE: the provider is never hit again while the entry is fresh, and a later
-- provider failure is transparently masked by serving this cached copy (stale-while-error).
-- Service-role only; written/read exclusively by the norva-series-info edge function.
create table if not exists public.cloud_series_info_cache (
  server_host text not null,
  series_id text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (server_host, series_id)
);
alter table public.cloud_series_info_cache enable row level security;
revoke all on public.cloud_series_info_cache from anon, authenticated;
