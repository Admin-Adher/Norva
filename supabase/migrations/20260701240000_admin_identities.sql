-- CRM audit priority #3 — dedicated Identités page: the canonical provider-identity graph.
-- One entity per REAL upstream panel (stream-ID fingerprint dedup), with its keys, its brand names
-- (a mirror like Opplex ≡ Ferran shows 2 brands on ONE identity) and the cloud_sources that carry it.
-- Sources are mapped via display_name ∈ identity's brand names — the same mapping the dashboard uses
-- elsewhere (cloud_sources has no provider_key column). Index added so that lookup stays cheap when
-- sources number in the thousands. Everything is bounded: identities are few by design (~1 per real
-- upstream panel), and each identity lists at most 50 sources.
create index if not exists idx_cloud_sources_display_name on public.cloud_sources (display_name);

create or replace function public.admin_identities()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(row_to_json(t) order by t.display_name), '[]'::jsonb) into v from (
    select pi.id, pi.display_name::text as display_name, pi.status, pi.first_seen, pi.last_seen, pi.notes,
      (select count(*) from catalog_provider_identities cpi where cpi.identity_id = pi.id) as key_count,
      (select coalesce(jsonb_agg(distinct cpi.display_name::text), '[]'::jsonb)
         from catalog_provider_identities cpi where cpi.identity_id = pi.id) as brands,
      (select coalesce(jsonb_agg(row_to_json(s2)), '[]'::jsonb) from (
         select s.id as source_id, coalesce(s.display_name, left(s.id::text, 8)) as display_name,
                s.user_id, u.email::text as owner_email, s.sync_status, s.last_synced_at,
                (s.user_id in (select user_id from public.admin_enrichment_accounts)) as is_driver
         from cloud_sources s
         left join auth.users u on u.id = s.user_id
         where s.display_name in (select cpi2.display_name from catalog_provider_identities cpi2 where cpi2.identity_id = pi.id)
         order by s.created_at
         limit 50
      ) s2) as sources
    from provider_identities pi
  ) t;
  return v;
end; $$;

revoke all on function public.admin_identities() from public, anon;
grant execute on function public.admin_identities() to authenticated;
