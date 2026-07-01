-- Admin dashboard — per-user detail (click a row in the Users section).
--
-- Returns one user's profile + their sources (sync state, counts, identity) + their per-panel audio
-- enrichment coverage. is_admin()-gated, SECURITY DEFINER (reads auth.users). Triggered on demand by a
-- single admin click, so a 60s definer budget is fine even for the biggest driver (airo, ~334k titles);
-- the aggregation is scoped to ONE user_id (indexed) — never multi-tenant.
create or replace function public.admin_user_detail(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user    jsonb;
  v_sources jsonb;
  v_enrich  jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  set local statement_timeout to '60s';

  select to_jsonb(t) into v_user from (
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
           case when count(*) filter (where ct.audio_probed_at > now() - interval '24 hours') > 0
                then ceil(count(*) filter (where ct.audio_probed_at is null and ct.audio_languages = '{}')::numeric
                          / count(*) filter (where ct.audio_probed_at > now() - interval '24 hours'))
                else null end as eta_days,
           count(*) filter (where jsonb_typeof(ct.subtitle_tracks) = 'array' and jsonb_array_length(ct.subtitle_tracks) > 0) as subtitle_found
    from cloud_titles ct
    join cloud_title_variants v on v.id = ct.default_variant_id
    join cloud_sources s on s.id = v.source_id
    where ct.user_id = p_user_id and ct.variant_count > 0
    group by s.display_name, s.id, ct.item_type
    order by s.display_name, ct.item_type
  ) t;

  return jsonb_build_object('user', v_user, 'sources', v_sources, 'enrichment', v_enrich);
end;
$$;

revoke all on function public.admin_user_detail(uuid) from public, anon;
grant execute on function public.admin_user_detail(uuid) to authenticated;

comment on function public.admin_user_detail is
  'Admin-only per-user detail: profile + sources (sync/counts/identity) + per-panel audio coverage. '
  'is_admin()-gated; scoped to one user_id so it stays cheap even for the largest driving account.';
