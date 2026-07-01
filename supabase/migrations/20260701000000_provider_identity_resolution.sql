-- Provider IDENTITY resolution — the long-term "who is this provider, really" layer.
--
-- WHY: the old providerKey is a hash of the CATEGORY TAXONOMY, which is the wrong signal — categories
-- are cosmetic (each reseller renames them; they drift over time), so the same panel gets different keys
-- and mirrors are missed. Proven live: Opplex and Ferran share 100% of their 40,555 movie stream IDs
-- (same panel, two resellers) yet got two different providerKeys because their category lists differ by one.
--
-- FIX (two layers):
--   1. Fingerprint on STABLE CONTENT — the provider-assigned stream IDs (external_id). Mirrors share them
--      exactly; category renames don't touch them. We keep a bottom-256 md5 sample per identity (a MinHash
--      bottom-k sketch: deterministic, spread across the ID range so distinct panels don't collide on low
--      integers) and match by Jaccard overlap.
--   2. A canonical PROVIDER IDENTITY (this table) that many fingerprints resolve to (many->one). This is the
--      admin-dashboard entity and the stable key that cross-user caches should eventually move onto (Phase B),
--      so caches survive taxonomy drift, mirrors, and future fingerprint-scheme changes.
--
-- Additive and non-destructive: the existing catalog_provider_identities (providerKey -> name registry) stays
-- and simply gains an identity_id link. Phase B (re-key catalog_generated_subtitles / catalog_file_tracks onto
-- identity_id) is a separate, deliberate migration.

-- 1) Canonical provider entity (the dashboard's row; the future cross-user cache key).
create table if not exists public.provider_identities (
  id           uuid primary key default gen_random_uuid(),
  display_name text,
  status       text not null default 'active' check (status in ('active','deleted','archived')),
  notes        text,
  stream_sample text[],                 -- bottom-256 md5 sample of movie+series stream IDs (the fingerprint)
  sample_kind  text,                    -- provenance of the sample (algorithm tag)
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.provider_identities is
  'Canonical provider (panel) identity. Many fingerprints (catalog_provider_identities) resolve to one row via '
  'stream-ID overlap. Admin-dashboard entity; the stable key cross-user caches move onto in Phase B.';

-- GIN index so the resolver can prefilter candidate identities by array overlap (&&) before scoring Jaccard.
create index if not exists provider_identities_sample_gin
  on public.provider_identities using gin (stream_sample);

alter table public.provider_identities enable row level security;
revoke all on table public.provider_identities from anon, authenticated;
grant all on table public.provider_identities to service_role;

-- 2) Link each fingerprint to its canonical identity. Widen status to record superseded fingerprints
--    (an old key left behind when a provider's taxonomy drifted, now mapped to the same identity).
alter table public.catalog_provider_identities
  add column if not exists identity_id uuid references public.provider_identities(id);

create index if not exists catalog_provider_identities_identity_idx
  on public.catalog_provider_identities (identity_id);

alter table public.catalog_provider_identities drop constraint if exists catalog_provider_identities_status_check;
alter table public.catalog_provider_identities
  add constraint catalog_provider_identities_status_check
  check (status in ('active','deleted','superseded'));

-- 3) Resolver: keep the fingerprint->name registry current AND resolve-or-create the canonical identity by
--    stream-ID overlap. Called best-effort by the sync engine (recordProviderIdentity). Server-side so the
--    set math runs next to the data and concurrent isolates can't mint duplicate identities for one panel.
create or replace function public.norva_resolve_provider_identity(
  p_source_id    uuid,
  p_provider_key text,
  p_display_name text,
  p_status       text default 'active'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sample     text[];
  v_size       int;
  v_identity   uuid;
  v_best_id    uuid;
  v_best_jac   numeric := 0;
  v_min_sample constant int     := 32;   -- too few items to fingerprint reliably (brand-new source mid-import)
  v_threshold  constant numeric := 0.5;  -- mirrors ~1.0, distinct panels ~0; 0.5 separates them cleanly
  rec          record;
  v_inter      int;
  v_union      int;
  v_jac        numeric;
begin
  -- Bottom-256 (by md5) sample of movie+series stream IDs: deterministic, mirror-identical,
  -- taxonomy-independent, spread across the ID range (no low-integer clustering bias).
  select array_agg(external_id order by external_id) into v_sample
  from (
    select external_id
    from (
      select distinct external_id
      from public.cloud_media_items
      where source_id = p_source_id
        and item_type in ('movie','series')
        and external_id is not null and external_id <> ''
    ) d
    order by md5(external_id)
    limit 256
  ) s;

  v_size := coalesce(array_length(v_sample, 1), 0);

  -- Always keep the fingerprint->name registry current (back-compat). DO UPDATE only name/status/last_seen so
  -- manual notes on a historical/deleted provider survive a re-add.
  insert into public.catalog_provider_identities (provider_key, display_name, status, last_seen, updated_at)
    values (p_provider_key, p_display_name, p_status, now(), now())
  on conflict (provider_key) do update
    set display_name = excluded.display_name, status = excluded.status, last_seen = now(), updated_at = now();

  if v_size < v_min_sample then
    return null;  -- defer identity resolution until the catalog is populated enough to fingerprint
  end if;

  -- Serialize resolution: identity creation is infrequent, so a single global lock is simplest and prevents
  -- two isolates racing to create duplicate identities for the same panel.
  perform pg_advisory_xact_lock(hashtext('norva_provider_identity_resolve'));

  -- Already linked? just refresh.
  select identity_id into v_identity
  from public.catalog_provider_identities where provider_key = p_provider_key;

  if v_identity is not null then
    update public.provider_identities set last_seen = now(), updated_at = now() where id = v_identity;
    return v_identity;
  end if;

  -- Find the best-overlapping known identity (Jaccard >= threshold), prefiltered by array overlap.
  for rec in
    select id, stream_sample from public.provider_identities
    where stream_sample && v_sample
  loop
    select
      cardinality(array(select unnest(rec.stream_sample) intersect select unnest(v_sample))),
      cardinality(array(select unnest(rec.stream_sample) union     select unnest(v_sample)))
      into v_inter, v_union;
    v_jac := case when v_union > 0 then v_inter::numeric / v_union else 0 end;
    if v_jac > v_best_jac then v_best_jac := v_jac; v_best_id := rec.id; end if;
  end loop;

  if v_best_id is not null and v_best_jac >= v_threshold then
    v_identity := v_best_id;                                   -- same panel (mirror or drifted key)
    update public.provider_identities
      set last_seen = now(), updated_at = now(), display_name = coalesce(display_name, p_display_name)
      where id = v_identity;
  else
    insert into public.provider_identities (display_name, status, stream_sample, sample_kind, first_seen, last_seen)
      values (p_display_name, p_status, v_sample, 'xtream-streamid-md5-bottom256', now(), now())
      returning id into v_identity;
  end if;

  update public.catalog_provider_identities set identity_id = v_identity, updated_at = now()
    where provider_key = p_provider_key;

  return v_identity;
end;
$$;

revoke all on function public.norva_resolve_provider_identity(uuid, text, text, text) from anon, authenticated;
grant execute on function public.norva_resolve_provider_identity(uuid, text, text, text) to service_role;

-- 4) Convenience view for the admin dashboard: one row per canonical identity with its fingerprint aliases
--    and how many live sources currently resolve to it (mirror count).
create or replace view public.admin_provider_overview as
select
  pi.id                                             as identity_id,
  pi.display_name,
  pi.status,
  pi.notes,
  pi.first_seen,
  pi.last_seen,
  coalesce(array_agg(distinct cpi.provider_key) filter (where cpi.provider_key is not null), '{}') as fingerprints,
  count(distinct cpi.provider_key)                  as fingerprint_count
from public.provider_identities pi
left join public.catalog_provider_identities cpi on cpi.identity_id = pi.id
group by pi.id, pi.display_name, pi.status, pi.notes, pi.first_seen, pi.last_seen;

revoke all on public.admin_provider_overview from anon, authenticated;
grant select on public.admin_provider_overview to service_role;
