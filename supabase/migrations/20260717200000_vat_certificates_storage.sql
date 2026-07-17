-- =============================================================================
-- TVA : certificats de dépôt OSS — bucket Storage privé + lien sur le journal.
-- =============================================================================
-- Dernier morceau du registre (art. 63c — conservation 10 ans) : le PDF du
-- certificat de dépôt, archivé dans Supabase Storage (conteneur norva-storage,
-- déjà dans la stack) et rattaché à sa ligne de journal (vat_filings).
--
--   • Bucket `vat-certificates` : PRIVÉ, PDF uniquement, 10 Mo max. Accès gouverné
--     par RLS sur storage.objects : is_admin() (JWT app_metadata.role='admin') sur
--     les 4 verbes — personne d'autre ne lit ni n'écrit ; service_role bypasse.
--   • vat_filings.document_path : chemin de l'objet ('<année>/Tn-<ts>.pdf').
--   • admin_vat_filing_record gagne p_document_path — SIGNATURE ÉTENDUE ⇒ DROP de
--     l'ancienne (sinon surcharge ambiguë PostgREST) ⇒ NOTIFY pgrst requis.
--     admin_vat_filings (signature inchangée) renvoie document_path.
--
-- Exécuter en supabase_admin (policies sur storage.objects = superuser requis).
-- Le front uploade via POST /storage/v1/object/vat-certificates/<path> (JWT admin)
-- et télécharge via GET authentifié + blob (bucket privé → pas d'URL publique).

-- ── 1) Bucket privé ─────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vat-certificates', 'vat-certificates', false, 10485760, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── 2) Policies RLS admin-only (idempotent : drop puis create) ──────────────────
drop policy if exists "vat_certs_admin_select" on storage.objects;
create policy "vat_certs_admin_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'vat-certificates' and public.is_admin());

drop policy if exists "vat_certs_admin_insert" on storage.objects;
create policy "vat_certs_admin_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'vat-certificates' and public.is_admin());

drop policy if exists "vat_certs_admin_update" on storage.objects;
create policy "vat_certs_admin_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'vat-certificates' and public.is_admin())
  with check (bucket_id = 'vat-certificates' and public.is_admin());

drop policy if exists "vat_certs_admin_delete" on storage.objects;
create policy "vat_certs_admin_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'vat-certificates' and public.is_admin());

-- ── 3) Lien du certificat sur le journal ────────────────────────────────────────
alter table public.vat_filings
  add column if not exists document_path text;
comment on column public.vat_filings.document_path is
  'Chemin de l''objet dans le bucket vat-certificates (PDF du certificat de dépôt OSS).';

-- Signature étendue ⇒ DROP obligatoire (cf. bannière).
drop function if exists public.admin_vat_filing_record(int, int, bigint, text, text);

create or replace function public.admin_vat_filing_record(
  p_year int, p_quarter int, p_vat_eur_cents bigint default null,
  p_reference text default null, p_note text default null,
  p_document_path text default null
) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_year is null or p_year < 2020 or p_year > 2100 then raise exception 'invalid year' using errcode = '22023'; end if;
  if p_quarter is null or p_quarter < 1 or p_quarter > 4 then raise exception 'invalid quarter' using errcode = '22023'; end if;
  insert into public.vat_filings (year, quarter, vat_eur_cents, reference, note, document_path)
       values (p_year, p_quarter, p_vat_eur_cents, nullif(btrim(coalesce(p_reference, '')), ''),
               nullif(btrim(coalesce(p_note, '')), ''), nullif(btrim(coalesce(p_document_path, '')), ''))
    returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end; $$;
revoke all on function public.admin_vat_filing_record(int, int, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_vat_filing_record(int, int, bigint, text, text, text) to authenticated, service_role;

-- Même signature ⇒ simple replace ; renvoie désormais document_path.
create or replace function public.admin_vat_filings(p_year int default null, p_quarter int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(row_to_json(t) order by t.filed_at desc) from (
    select id, year, quarter, vat_eur_cents, reference, note, document_path, filed_at
    from public.vat_filings
    where (p_year is null or year = p_year)
      and (p_quarter is null or quarter = p_quarter)
    order by filed_at desc
    limit 24
  ) t), '[]'::jsonb);
end; $$;
revoke all on function public.admin_vat_filings(int, int) from public, anon, authenticated;
grant execute on function public.admin_vat_filings(int, int) to authenticated, service_role;
