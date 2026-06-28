-- Single-query GO/NO-GO for the global-cache read cutover. Combines the two gates that
-- actually govern the flip and that were previously checked separately:
--   1. QUALITY — would the cache ever serve WORSE than the per-user row? (catalog_titles_quality_gate)
--      title/poster/enrich/identity worse MUST be 0; year/backdrop tolerated < 0.5% (cosmetic, self-healing).
--   2. OVERLAP — do enough users share titles for dedup to actually pay? overlap = matched/distinct >= p_min_overlap.
-- Both must hold. At 1-2 users on DIFFERENT providers overlap ~= 1 (no benefit) — so this returns NO-GO
-- by design, and the flip stays OFF. It auto-signals GO once real same-provider users push overlap up.
-- Read-only, service-role gated. Note: byte-equality catalog_mirror_diff() is OBSOLETE (divergence is
-- expected — different providers name the same tmdb id differently); quality, not equality, is the gate.
create or replace function public.catalog_flip_readiness(p_min_overlap numeric default 3.0)
returns table (
  overlap_ratio    numeric,
  matched_titles   bigint,
  distinct_titles  bigint,
  quality_compared bigint,
  strict_worse     bigint,   -- title+poster+enrich+identity (must be 0)
  cosmetic_worse   bigint,   -- year+backdrop (tolerated tiny)
  overlap_ok       boolean,
  quality_ok       boolean,
  flip_ready       boolean,
  verdict          text
)
language sql
stable
security definer
set search_path = public
as $$
  with q as (
    select * from public.catalog_titles_quality_gate(null)
  ),
  o as (
    select
      count(*)                                            as matched,
      count(distinct (item_type, provider_tmdb_id))       as distinct_t
    from public.cloud_titles
    where item_type in ('movie','series')
      and provider_tmdb_id is not null
      and provider_tmdb_id !~ '^(tt)?0+$'
  ),
  calc as (
    select
      round(o.matched::numeric / nullif(o.distinct_t, 0), 2)                              as overlap_ratio,
      o.matched, o.distinct_t,
      q.compared,
      (q.title_worse + q.poster_worse + q.enrich_worse + q.identity_missing)              as strict_worse,
      (q.year_worse + q.backdrop_worse)                                                   as cosmetic_worse
    from q, o
  )
  select
    c.overlap_ratio,
    c.matched, c.distinct_t,
    c.compared,
    c.strict_worse,
    c.cosmetic_worse,
    (c.overlap_ratio >= p_min_overlap)                                                    as overlap_ok,
    (c.strict_worse = 0 and c.cosmetic_worse <= greatest(1, (c.compared * 0.005)::bigint)) as quality_ok,
    ((c.overlap_ratio >= p_min_overlap)
      and c.strict_worse = 0
      and c.cosmetic_worse <= greatest(1, (c.compared * 0.005)::bigint))                  as flip_ready,
    case
      when c.strict_worse > 0
        then 'NO-GO: cache would serve worse than per-user (' || c.strict_worse || ' strict regressions) — heal before flip'
      when c.overlap_ratio < p_min_overlap
        then 'NO-GO: overlap ' || c.overlap_ratio || ' < ' || p_min_overlap ||
             ' — too few shared titles for dedup to pay; flip provides ~0 benefit. Mechanism is ready; wait for real same-provider users.'
      else 'GO: quality-clean AND overlap ' || c.overlap_ratio || ' >= ' || p_min_overlap ||
           ' — set NORVA_CATALOG_READ_SOURCE=catalog_titles, watch, then thin cloud_titles.'
    end                                                                                   as verdict
  from calc c;
$$;

revoke all on function public.catalog_flip_readiness(numeric) from public, anon, authenticated;
grant execute on function public.catalog_flip_readiness(numeric) to service_role;
