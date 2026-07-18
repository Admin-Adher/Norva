-- Fix upload du visuel de campagne (recette 2026-07-18) : POST 400 sur
-- /storage/v1/object/promo-assets/…
--
-- Cause : le flux d'écriture de storage-api (x-upsert) LIT l'objet avec le rôle
-- du JWT (test d'existence + retour de la ligne créée), or 20260718190000
-- n'avait posé que des policies INSERT/UPDATE/DELETE — le SELECT manquant fait
-- échouer l'écriture. La lecture PUBLIQUE de la page de vente n'est pas
-- concernée : /object/public/… est servi hors RLS pour un bucket public.
--
-- Idempotent. supabase_admin. Pas de NOTIFY (aucune fonction PostgREST).

drop policy if exists "promo_assets_admin_select" on storage.objects;
create policy "promo_assets_admin_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'promo-assets' and public.is_admin());
