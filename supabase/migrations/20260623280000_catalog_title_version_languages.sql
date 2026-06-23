-- Denormalize each title's available audio/subtitle version tags (already parsed
-- per-variant into cloud_title_variants.language at sync) onto the title row, so
-- the catalog can filter/sort the WHOLE catalogue by audio language / burned-in
-- subtitle availability server-side (GIN), fully paginated, with zero provider
-- hits. Additive + reversible. Stored lowercased (vf, multi, vostfr, subt_ar...);
-- the taxonomy (tag -> audio/subtitle facet) lives in code (norva-catalog), so
-- this column never needs a re-backfill when the mapping evolves.

alter table public.cloud_titles
  add column if not exists version_languages text[] not null default '{}'::text[];

create index if not exists cloud_titles_version_languages_gin
  on public.cloud_titles using gin (version_languages);

update public.cloud_titles t
set version_languages = sub.langs
from (
  select title_id,
         array_agg(distinct lower(btrim(language)) order by lower(btrim(language))) as langs
  from public.cloud_title_variants
  where language is not null and btrim(language) <> ''
  group by title_id
) sub
where sub.title_id = t.id
  and t.version_languages is distinct from sub.langs;
