-- =============================================================================
-- Promos événementielles : visuel de campagne (2026-07-18, suite du Lot 8).
-- =============================================================================
-- Demande produit : pendant un événement (Black Friday, Noël…), la carte du plan
-- en promo doit être visuellement IMPACTANTE — thème aux couleurs de l'événement
-- par défaut (côté front), remplaçable par une image de fond uploadée depuis la
-- carte « 💵 Tarifs web » de Finance.
--
--   • Bucket `promo-assets` : PUBLIC en lecture (la page de vente charge l'image
--     sans auth), écriture admin-only via RLS is_admin() — même pattern que
--     vat-certificates, en public. Images uniquement, 2 Mo max.
--   • billing_promo_campaign (ligne unique) : chemin de l'image active. NULL =
--     thèmes par défaut. Servie par GET norva-revolut/prices (clé `campaign`).
--   • RPCs admin_promo_campaign / admin_promo_campaign_set.
--
-- Idempotent. supabase_admin (policies storage). ⚠ NOTIFY pgrst requis
-- (2 fonctions neuves).

-- ── 1) Bucket public (lecture) / écriture admin ─────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('promo-assets', 'promo-assets', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Lecture publique via /storage/v1/object/public/… (bucket public) — pas de
-- policy SELECT nécessaire pour ce chemin ; l'écriture reste admin-only.
drop policy if exists "promo_assets_admin_insert" on storage.objects;
create policy "promo_assets_admin_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'promo-assets' and public.is_admin());

drop policy if exists "promo_assets_admin_update" on storage.objects;
create policy "promo_assets_admin_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'promo-assets' and public.is_admin())
  with check (bucket_id = 'promo-assets' and public.is_admin());

drop policy if exists "promo_assets_admin_delete" on storage.objects;
create policy "promo_assets_admin_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'promo-assets' and public.is_admin());

-- ── 2) Campagne (ligne unique) ──────────────────────────────────────────────────
create table if not exists public.billing_promo_campaign (
  id         int primary key default 1 check (id = 1),
  bg_path    text,
  updated_at timestamptz not null default now()
);
comment on table public.billing_promo_campaign is
  'Visuel de campagne promo (ligne unique) : chemin de l''image dans promo-assets. NULL = thème par défaut de l''événement côté front.';
insert into public.billing_promo_campaign (id, bg_path) values (1, null)
on conflict (id) do nothing;

alter table public.billing_promo_campaign enable row level security;
revoke all on table public.billing_promo_campaign from public, anon, authenticated;
grant select on table public.billing_promo_campaign to service_role;

-- ── 3) RPCs admin ───────────────────────────────────────────────────────────────
create or replace function public.admin_promo_campaign()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return (select jsonb_build_object('bg_path', bg_path, 'updated_at', updated_at)
          from public.billing_promo_campaign where id = 1);
end; $$;
revoke all on function public.admin_promo_campaign() from public, anon, authenticated;
grant execute on function public.admin_promo_campaign() to authenticated, service_role;

create or replace function public.admin_promo_campaign_set(p_bg_path text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  update public.billing_promo_campaign
     set bg_path = nullif(btrim(coalesce(p_bg_path, '')), ''), updated_at = now()
   where id = 1;
  return jsonb_build_object('ok', true, 'bg_path', nullif(btrim(coalesce(p_bg_path, '')), ''));
end; $$;
revoke all on function public.admin_promo_campaign_set(text) from public, anon, authenticated;
grant execute on function public.admin_promo_campaign_set(text) to authenticated, service_role;
