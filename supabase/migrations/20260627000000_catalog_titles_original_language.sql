-- TMDB original language (e.g. 'ja' for an anime, 'en' for a US show), used by the player to
-- resolve a VOSTFR/VO ("original" version) audio track to its REAL language instead of a bare
-- "Default"/"VO". Global TMDB fact, so it lives on the cross-user catalog cache. Backfilled by
-- the norva-tmdb-origlang edge function (hits TMDB only, never the IPTV provider). Reversible:
--   alter table public.catalog_titles drop column original_language;
alter table public.catalog_titles add column if not exists original_language text;
