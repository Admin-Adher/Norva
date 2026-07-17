-- =============================================================================
-- TVA Lot B : profil d'entreprise durable + journal des dépôts (registre).
-- =============================================================================
-- Le mode guidé (Lot A) stockait le profil (forme juridique, raison sociale, SIREN,
-- n° intracom) et l'état des démarches en localStorage → perdu au changement
-- d'appareil/navigateur. Ce lot le rend DURABLE et multi-appareils côté serveur, et
-- ajoute le journal des dépôts OSS (le registre : qui, quand, combien, quelle
-- référence — conservation 10 ans, art. 63c).
--
-- 100 % de fonctions/tables NEUVES (aucune ré-émission des grosses fonctions déjà
-- retouchées cette session) → risque minimal. Nouvelles fonctions ⇒ recharger le
-- cache PostgREST (NOTIFY pgrst, 'reload schema'). Exécuter en supabase_admin.
-- Outil mono-entreprise : profil = une seule ligne (id = 1), comme
-- admin_dashboard_cache.

-- ── 1) Profil d'entreprise (ligne unique) ───────────────────────────────────────
create table if not exists public.admin_business_profile (
  id           int primary key default 1 check (id = 1),
  legal_form   text not null default 'micro'
                 check (legal_form in ('micro', 'ei_reel', 'eurl', 'sasu', 'sas_sarl')),
  company_name text,
  siren        text,
  vat_number   text,                          -- n° de TVA intracommunautaire (FR…)
  demarches    jsonb not null default '{}'::jsonb,   -- { intracom, des, uk, oss : bool }
  updated_at   timestamptz not null default now()
);
alter table public.admin_business_profile enable row level security;
-- Pas de policies : accès via les RPC security definer ci-dessous (is_admin()).
insert into public.admin_business_profile (id) values (1) on conflict (id) do nothing;

create or replace function public.admin_business_profile_get()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select to_jsonb(t) from (select * from public.admin_business_profile where id = 1) t), '{}'::jsonb);
end; $$;
revoke all on function public.admin_business_profile_get() from public, anon, authenticated;
grant execute on function public.admin_business_profile_get() to authenticated, service_role;

-- Patch partiel : seules les clés fournies sont modifiées (le reste inchangé).
create or replace function public.admin_business_profile_set(p_patch jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_form text := p_patch->>'legal_form';
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_form is not null and v_form not in ('micro', 'ei_reel', 'eurl', 'sasu', 'sas_sarl') then
    raise exception 'invalid legal_form' using errcode = '22023';
  end if;
  insert into public.admin_business_profile (id) values (1) on conflict (id) do nothing;
  update public.admin_business_profile set
    legal_form   = coalesce(v_form, legal_form),
    company_name = case when p_patch ? 'company_name' then nullif(btrim(p_patch->>'company_name'), '') else company_name end,
    siren        = case when p_patch ? 'siren' then nullif(regexp_replace(coalesce(p_patch->>'siren', ''), '\s', '', 'g'), '') else siren end,
    vat_number   = case when p_patch ? 'vat_number' then nullif(upper(regexp_replace(coalesce(p_patch->>'vat_number', ''), '\s', '', 'g')), '') else vat_number end,
    demarches    = case when p_patch ? 'demarches' and jsonb_typeof(p_patch->'demarches') = 'object' then p_patch->'demarches' else demarches end,
    updated_at   = now()
  where id = 1;
  return (select to_jsonb(t) from (select * from public.admin_business_profile where id = 1) t);
end; $$;
revoke all on function public.admin_business_profile_set(jsonb) from public, anon, authenticated;
grant execute on function public.admin_business_profile_set(jsonb) to authenticated, service_role;

-- ── 2) Journal des dépôts OSS (le registre) ─────────────────────────────────────
create table if not exists public.vat_filings (
  id             uuid primary key default gen_random_uuid(),
  year           int  not null check (year between 2020 and 2100),
  quarter        int  not null check (quarter between 1 and 4),
  vat_eur_cents  bigint,                       -- montant reversé (cents EUR)
  reference      text,                         -- référence unique OSS/FR/…/Qn.YYYY
  note           text,                         -- n° de certificat / emplacement du PDF
  filed_at       timestamptz not null default now()
);
alter table public.vat_filings enable row level security;
create index if not exists idx_vat_filings_period on public.vat_filings (year desc, quarter desc, filed_at desc);

create or replace function public.admin_vat_filing_record(
  p_year int, p_quarter int, p_vat_eur_cents bigint default null,
  p_reference text default null, p_note text default null
) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_year is null or p_year < 2020 or p_year > 2100 then raise exception 'invalid year' using errcode = '22023'; end if;
  if p_quarter is null or p_quarter < 1 or p_quarter > 4 then raise exception 'invalid quarter' using errcode = '22023'; end if;
  insert into public.vat_filings (year, quarter, vat_eur_cents, reference, note)
       values (p_year, p_quarter, p_vat_eur_cents, nullif(btrim(coalesce(p_reference, '')), ''), nullif(btrim(coalesce(p_note, '')), ''))
    returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end; $$;
revoke all on function public.admin_vat_filing_record(int, int, bigint, text, text) from public, anon, authenticated;
grant execute on function public.admin_vat_filing_record(int, int, bigint, text, text) to authenticated, service_role;

-- Journal : dépôts d'un trimestre donné, ou les 24 plus récents.
create or replace function public.admin_vat_filings(p_year int default null, p_quarter int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(row_to_json(t) order by t.filed_at desc) from (
    select id, year, quarter, vat_eur_cents, reference, note, filed_at
    from public.vat_filings
    where (p_year is null or year = p_year)
      and (p_quarter is null or quarter = p_quarter)
    order by filed_at desc
    limit 24
  ) t), '[]'::jsonb);
end; $$;
revoke all on function public.admin_vat_filings(int, int) from public, anon, authenticated;
grant execute on function public.admin_vat_filings(int, int) to authenticated, service_role;
