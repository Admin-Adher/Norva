-- Fix: the Home rails time out for mega-accounts (400k+ titles).
--
-- Every Home rail (popular / because-you-watched / genre) calls
-- listVerifiedTitleCandidates(), which runs:
--
--   select * from cloud_titles
--   where user_id = $1 and item_type = $2
--     and match_status = 'provider_verified' and variant_count > 0
--   order by synced_at desc, updated_at desc
--   limit 300;
--
-- The only usable index was idx_cloud_titles_user_type_updated (user_id, item_type,
-- synced_at desc), which carries the ORDER BY but NOT the match_status / variant_count
-- filter. For account 7bdab1df that means walking the synced_at-ordered index and
-- heap-filtering ~419k movie rows to surface the 466 that are actually verified &
-- playable — a >90s scan (measured), past the statement timeout, so every rail hung.
--
-- A partial composite index that already embeds the filter as its predicate turns this
-- into a bounded index scan over just the verified+playable rows, in the exact ORDER BY
-- order: 93s -> ~0.3s cold (measured on 7bdab1df), no regression for normal accounts
-- (jeremy, ~300ms) since they use the same index. It stays tiny (~0.4MB total) because
-- only provider_verified rows with variants qualify — a fraction of a percent of the table.
--
-- Live DB: already built with CREATE INDEX CONCURRENTLY (imports were writing). This
-- migration is the repo-of-record / fresh-deploy path; IF NOT EXISTS makes it a no-op
-- where the concurrent build already landed.

create index if not exists idx_cloud_titles_home_verified
on public.cloud_titles (user_id, item_type, synced_at desc, updated_at desc)
where match_status = 'provider_verified' and variant_count > 0;
