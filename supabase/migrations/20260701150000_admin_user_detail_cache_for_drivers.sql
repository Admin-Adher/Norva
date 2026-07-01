-- Fix: admin_user_detail 500 (57014 statement timeout) when clicking a DRIVING account's fiche.
--
-- Root cause: `set local statement_timeout='60s'` inside the function is useless via PostgREST — the
-- 8s timer is already armed on the outer `SELECT admin_user_detail(...)` before the function body runs
-- (it only helps for cron-called functions like refresh_admin_dashboard whose role has no 8s cap).
-- The 3 current users are all big drivers (super8k/jeremy/airo, up to 334k titles), so recomputing
-- their per-panel coverage + per-source counts live blows 8s.
--
-- Fix: for a DRIVER, read sources + coverage straight from the precomputed admin_dashboard_cache
-- (filtered by email) — instant, and identical shape to the live path. For a NORMAL user (small
-- inherited catalogue) keep the live computation, which is cheap. Profile is always live+trivial.
-- The response shape is unchanged, so the frontend needs no change.
create or replace function public.admin_user_detail(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user    jsonb;
  v_email   text;
  v_driver  boolean;
  v_sources jsonb;
  v_enrich  jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select to_jsonb(t), t.email, t.is_driver into v_user, v_email, v_driver from (
    select u.id                                              as user_id,
           u.email::text                                     as email,
           u.created_at,
           u.last_sign_in_at,
           (u.email_confirmed_at is not null)                as email_confirmed,
           coalesce(u.raw_app_meta_data ->> 'role', 'user')  as role,
           (u.id in (select user_id from public.admin_enrichment_accounts)) as is_driver,
           u.raw_app_meta_data ->> 'provider'                as auth_provider
    from auth.users u
    where u.id = p_user_id
  ) t;
  if v_user is null then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  if v_driver then
    -- Driver: pull from the 5-min cache (bounded, instant). Same element shape as the live path.
    select coalesce(jsonb_agg(e order by e ->> 'display_name'), '[]'::jsonb) into v_sources
      from public.admin_dashboard_cache c, jsonb_array_elements(c.sources) e
      where c.id = 1 and e ->> 'owner_email' = v_email;
    select coalesce(jsonb_agg(e), '[]'::jsonb) into v_enrich
      from public.admin_dashboard_cache c, jsonb_array_elements(c.coverage) e
      where c.id = 1 and e ->> 'owner_email' = v_email;
  else
    -- Normal user: small per-user catalogue → live is cheap and always < 8s.
    select coalesce(jsonb_agg(row_to_json(t) order by (t.sync_error is not null) desc, t.created_at), '[]'::jsonb)
      into v_sources from (
      select s.id                                              as source_id,
             coalesce(s.display_name, left(s.id::text, 8))     as display_name,
             s.sync_status, s.sync_error, s.catalog_version, s.created_at, s.last_synced_at,
             (select count(*) from cloud_media_items m where m.source_id = s.id) as media_items,
             (select count(*) from cloud_title_variants v where v.source_id = s.id) as variants,
             (select count(*) from cloud_titles t2 join cloud_title_variants v on v.id = t2.default_variant_id
                where v.source_id = s.id and t2.item_type = 'movie'  and t2.variant_count > 0) as movie_titles,
             (select count(*) from cloud_titles t2 join cloud_title_variants v on v.id = t2.default_variant_id
                where v.source_id = s.id and t2.item_type = 'series' and t2.variant_count > 0) as series_titles,
             (exists (select 1 from cloud_media_items m where m.source_id = s.id and m.item_type in ('movie','series'))
                and not exists (select 1 from cloud_title_variants v where v.source_id = s.id)) as incomplete,
             pi.display_name::text                             as identity_name
      from cloud_sources s
      left join catalog_provider_identities cpi
        on cpi.provider_key = (select cpi2.provider_key from catalog_provider_identities cpi2
                               where cpi2.display_name = s.display_name and cpi2.status = 'active' limit 1)
      left join provider_identities pi on pi.id = cpi.identity_id
      where s.user_id = p_user_id
    ) t;

    select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_enrich from (
      select coalesce(s.display_name, left(s.id::text, 8)) as panel, ct.item_type,
             count(*) as total,
             count(*) filter (where ct.audio_languages <> '{}') as resolved,
             round(100.0 * count(*) filter (where ct.audio_languages <> '{}') / nullif(count(*), 0), 1) as resolved_pct,
             count(*) filter (where ct.audio_probed_at is null and ct.audio_languages = '{}') as never_probed,
             count(*) filter (where ct.audio_probed_at > now() - interval '24 hours') as probed_24h,
             count(*) filter (where jsonb_typeof(ct.subtitle_tracks) = 'array' and jsonb_array_length(ct.subtitle_tracks) > 0) as subtitle_found
      from cloud_titles ct
      join cloud_title_variants v on v.id = ct.default_variant_id
      join cloud_sources s on s.id = v.source_id
      where ct.user_id = p_user_id and ct.variant_count > 0
      group by s.display_name, s.id, ct.item_type
      order by s.display_name, ct.item_type
    ) t;
  end if;

  return jsonb_build_object('user', v_user, 'sources', v_sources, 'enrichment', v_enrich);
end;
$$;

revoke all on function public.admin_user_detail(uuid) from public, anon;
grant execute on function public.admin_user_detail(uuid) to authenticated;
