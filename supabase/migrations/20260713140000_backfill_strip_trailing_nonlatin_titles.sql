-- Backfill (2026-07-13): strip a trailing SECOND-SCRIPT title that providers append after the
-- Latin name — e.g. "Checkered Ninja 3 (2026) نينجاى شطرنجى 3" -> "Checkered Ninja 3".
--
-- The import-time cleaners (server cleanDisplayTitle in vod-title-projection.ts and the frontend
-- MediaUtils.cleanReleaseName) were extended to cut at the first Arabic/Hebrew/Cyrillic/Greek/
-- CJK/Kana/Hangul/Thai character, but ONLY when a Latin title remains in front (so a natively
-- non-Latin title is left untouched). This one-shot brings titles ALREADY stored before that fix
-- into line. The frontend cleaner also runs at card-render time, so cards look right even without
-- this backfill; this fixes the stored value at the source (search, dedup display, new syncs).
--
-- Guard: touch only rows that have BOTH a non-Latin char AND a Latin letter. Resets
-- search_match_attempted_at so the cleaned name (e.g. "Checkered Ninja 3") re-matches TMDB — those
-- titles were often unmatched precisely because the search started from the polluted name.
--
-- The non-Latin character class mirrors the JS cleaners exactly (Hebrew, Arabic + supplements +
-- presentation forms, Cyrillic, Greek, Kana, CJK, Hangul, Thai). '-' is placed last in each
-- separator class so it is a literal, not a range.

with nl as (
  select id, title,
         -- 1) cut at the first non-Latin-script char (plus any separators right before it)
         trim(regexp_replace(
           title,
           '[\s:|.،؛–—-]*[֐-׿؀-ۿݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿Ѐ-ӿͰ-Ͽ぀-ヿ㐀-鿿가-힯฀-๿].*$',
           ''
         )) as head
  from public.cloud_titles
  where title ~ '[֐-׿؀-ۿݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿Ѐ-ӿͰ-Ͽ぀-ヿ㐀-鿿가-힯฀-๿]'
    and title ~ '[A-Za-z]'
), cleaned as (
  select id, title,
         -- 2) drop a now-trailing bracketed year "(2026)"/"[2026]", then trailing separators
         trim(regexp_replace(
           regexp_replace(head, '\s*[\[(](19|20)[0-9]{2}[)\]]\s*$', ''),
           '[\s:|.–—-]+$', ''
         )) as new_title
  from nl
  where head ~ '[A-Za-z]' and length(head) >= 2   -- a Latin title must remain
)
update public.cloud_titles c
set title = s.new_title,
    search_match_attempted_at = null,
    updated_at = now()
from cleaned s
where c.id = s.id
  and s.new_title <> ''
  and s.new_title is distinct from c.title;
