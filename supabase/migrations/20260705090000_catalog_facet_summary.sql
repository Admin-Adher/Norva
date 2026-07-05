-- Catalog filters re-audit (2026-07-05) — Phase 2: precomputed per-user facet summary.
--
-- Phase 1 restored the Movies/Series filters but still computes them live per request (a ~4.6s
-- genre group-by + a per-language existence probe over the whole catalogue). This precomputes a
-- tiny per-(user,item_type) summary so both endpoints become an instant single-row read at any
-- catalogue size. The edge keeps a live fallback when the summary is missing (new users), so this
-- is a pure optimisation layer that can never leave a filter empty.

create table if not exists public.cloud_catalog_facet_summary (
  user_id             uuid    not null references auth.users(id) on delete cascade,
  item_type           text    not null check (item_type in ('movie', 'series')),
  genre_bucket_counts jsonb   not null default '{}'::jsonb,  -- {bucket: count} for browsable titles
  audio_langs         text[]  not null default '{}',         -- distinct audio_languages iso codes present
  version_tags        text[]  not null default '{}',         -- distinct version_languages tags present (vf/vostfr/multi…)
  refreshed_at        timestamptz not null default now(),
  primary key (user_id, item_type)
);
-- RLS on, no policy: only the norva-catalog edge (service_role) reads it; the cron (postgres) writes it.
alter table public.cloud_catalog_facet_summary enable row level security;
revoke all on table public.cloud_catalog_facet_summary from anon, authenticated;
grant select, insert, update, delete on table public.cloud_catalog_facet_summary to service_role;

-- Recompute one (user, item_type) summary. Two scans of the user's browsable titles:
-- one for the genre-bucket counts, one that unnests audio_languages + version_languages together.
create or replace function public.cloud_refresh_facet_summary(p_user_id uuid, p_item_type text)
returns void
language plpgsql
set search_path to 'public'
as $function$
declare v_counts jsonb; v_audio text[]; v_version text[];
begin
  select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb) into v_counts
  from (
    select b as bucket, count(*)::bigint as n
    from public.cloud_titles t
         cross join lateral unnest(coalesce(t.genre_buckets, array['autres'])) as b
    where t.user_id = p_user_id and t.item_type = p_item_type and t.variant_count > 0 and b <> 'autres'
    group by b
  ) g;

  select
    coalesce(array_agg(distinct u.val) filter (where u.kind = 'a'), '{}'),
    coalesce(array_agg(distinct u.val) filter (where u.kind = 'v'), '{}')
  into v_audio, v_version
  from public.cloud_titles t
  cross join lateral (
    select 'a'::text as kind, unnest(t.audio_languages)   as val
    union all
    select 'v'::text as kind, unnest(t.version_languages) as val
  ) u
  where t.user_id = p_user_id and t.item_type = p_item_type and t.variant_count > 0 and u.val is not null;

  insert into public.cloud_catalog_facet_summary (user_id, item_type, genre_bucket_counts, audio_langs, version_tags, refreshed_at)
  values (p_user_id, p_item_type, v_counts, coalesce(v_audio, '{}'), coalesce(v_version, '{}'), now())
  on conflict (user_id, item_type) do update set
    genre_bucket_counts = excluded.genre_bucket_counts,
    audio_langs         = excluded.audio_langs,
    version_tags        = excluded.version_tags,
    refreshed_at        = excluded.refreshed_at;
end
$function$;

-- Refresh every (user, item_type) that has browsable titles and whose summary is missing or older
-- than 30 min. Bounded by p_limit so a single cron tick can't run unbounded.
create or replace function public.cloud_refresh_all_facet_summaries(p_limit int default 100)
returns int
language plpgsql
set search_path to 'public'
as $function$
declare r record; c int := 0;
begin
  for r in
    select cmb.user_id, cmb.item_type
    from (select distinct user_id, item_type from public.cloud_titles where variant_count > 0) cmb
    left join public.cloud_catalog_facet_summary s
      on s.user_id = cmb.user_id and s.item_type = cmb.item_type
    where s.user_id is null or s.refreshed_at < now() - interval '30 minutes'
    order by s.refreshed_at nulls first
    limit greatest(1, coalesce(p_limit, 100))
  loop
    perform public.cloud_refresh_facet_summary(r.user_id, r.item_type);
    c := c + 1;
  end loop;
  return c;
end
$function$;

revoke all on function public.cloud_refresh_facet_summary(uuid, text) from public, anon, authenticated;
grant execute on function public.cloud_refresh_facet_summary(uuid, text) to service_role;
revoke all on function public.cloud_refresh_all_facet_summaries(int) from public, anon, authenticated;
grant execute on function public.cloud_refresh_all_facet_summaries(int) to service_role;

-- Keep the summaries fresh: every 15 min, refresh the stalest combos. Mirrors the
-- norva-catalog-reconcile pattern (local function call, statement_timeout raised for big accounts).
select cron.schedule(
  'norva-facet-summary-refresh',
  '7-59/15 * * * *',
  $cron$ set statement_timeout='300s'; select public.cloud_refresh_all_facet_summaries(200); $cron$
);
