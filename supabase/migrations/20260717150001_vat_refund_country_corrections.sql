-- =============================================================================
-- admin_vat_report : remboursements pays-corrects + corrections OSS inter-trimestres.
-- =============================================================================
-- Audit 2026-07-17 (« toutes les logiques sont-elles prises en compte ? ») — deux
-- trous côté remboursements, corrigés ici + dans norva-admin (même commit) :
--
--   1. La ligne kind='refund' du ledger ne portait pas de pays (la route /refund ne
--      le copiait pas) → le remboursement tombait dans le bucket « Inconnu » au lieu
--      de réduire la base du bon pays. Écriture corrigée dans norva-admin ; en
--      lecture, le rapport HÉRITE désormais du pays de la vente d'origine (jointure
--      order_id) quand la ligne refund n'en porte pas — couvre aussi l'historique.
--
--   2. Règle OSS (TVA-OSS.md §3) : un remboursement d'une vente d'un trimestre
--      ANTÉRIEUR est une CORRECTION de ce trimestre-là (rubrique dédiée de la
--      déclaration, ±3 ans), pas un négatif du trimestre courant. Le rapport route
--      donc chaque remboursement : même trimestre (ou origine introuvable, défaut
--      conservateur) → netting de la base du trimestre ; trimestre antérieur →
--      nouvelle clé `corrections` [{orig_year, orig_quarter, country_code,
--      currency, refund_cents}].
--
-- Signature inchangée (int, int) ⇒ CREATE OR REPLACE simple, PAS de reload
-- PostgREST nécessaire. À exécuter en supabase_admin (leçon 20260717120000).
-- Hors périmètre, journalisé comme limite connue : les litiges/chargebacks ne sont
-- journalisés par aucun rail (pré-existant) — un remboursement fait directement
-- depuis le dashboard Revolut n'atterrit pas non plus dans le ledger : toujours
-- rembourser via la fiche admin.

create or replace function public.admin_vat_report(p_year int default null, p_quarter int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_year    int := coalesce(p_year, extract(year from now())::int);
  v_quarter int := coalesce(p_quarter, extract(quarter from now())::int);
  v_start   timestamptz;
  v_end     timestamptz;
  v_eu constant text[] := array['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
  v jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_quarter < 1 or v_quarter > 4 then raise exception 'invalid quarter' using errcode = '22023'; end if;
  if v_year < 2020 or v_year > 2100 then raise exception 'invalid year' using errcode = '22023'; end if;
  v_start := make_timestamptz(v_year, (v_quarter - 1) * 3 + 1, 1, 0, 0, 0, 'UTC');
  v_end   := v_start + interval '3 months';

  with internal as (
    select user_id from public.admin_internal_accounts
  ), web as (
    select l.order_id, l.kind, l.amount,
           case when l.country_code = 'MC' then 'FR' else l.country_code end as country_code,
           lower(coalesce(l.currency, 'usd')) as currency,
           coalesce(l.updated_at, l.created_at) as at
    from cloud_billing_ledger l
    where l.provider = 'revolut'
      and ((l.kind in ('first_charge', 'renewal') and l.status = 'captured') or l.kind = 'refund')
      and l.user_id not in (select user_id from internal)
  ), sales as (
    select * from web where kind <> 'refund'
  ), refunds as (
    -- Hérite du pays de la vente d'origine quand la ligne refund n'en porte pas, et
    -- transporte la date d'origine pour router même-trimestre vs correction.
    select coalesce(r.country_code, o.country_code) as country_code,
           r.currency, r.amount, r.at, o.at as orig_at
    from (select * from web where kind = 'refund') r
    left join lateral (
      select s2.country_code, s2.at
      from sales s2
      where r.order_id is not null and s2.order_id = r.order_id
      order by s2.at asc limit 1
    ) o on true
  )
  select jsonb_build_object(
    'year', v_year, 'quarter', v_quarter,
    'period_start', v_start, 'period_end', v_end,
    'rail', 'revolut',
    -- Base du trimestre par pays de consommation. refunded_cents = uniquement les
    -- remboursements dont la vente d'origine est du MÊME trimestre (ou introuvable,
    -- défaut conservateur) — les cross-trimestre vivent dans `corrections`.
    'rows', (select coalesce(jsonb_agg(row_to_json(t) order by t.gross_cents desc), '[]'::jsonb) from (
      select coalesce(coalesce(s.cc, rf.cc), '??') as country_code,
             coalesce(coalesce(s.cc, rf.cc) = any (v_eu), false) as is_eu,
             upper(coalesce(s.currency, rf.currency)) as currency,
             coalesce(s.n_tx, 0)::int as n_tx,
             coalesce(s.gross_cents, 0)::bigint as gross_cents,
             coalesce(rf.cents, 0)::bigint as refunded_cents,
             (coalesce(s.gross_cents, 0) - coalesce(rf.cents, 0))::bigint as net_cents
      from (select country_code as cc, currency, count(*)::int as n_tx, sum(amount)::bigint as gross_cents
              from sales where at >= v_start and at < v_end group by 1, 2) s
      full outer join (
            select country_code as cc, currency, sum(amount)::bigint as cents
              from refunds
             where at >= v_start and at < v_end
               and (orig_at is null or orig_at >= v_start)
             group by 1, 2) rf
        on rf.cc is not distinct from s.cc and rf.currency = s.currency
    ) t),
    -- Corrections OSS : remboursements DU trimestre affiché dont la vente d'origine
    -- appartient à un trimestre antérieur → à reporter dans la rubrique corrections
    -- de la déclaration, sur la période d'origine (délai 3 ans).
    'corrections', (select coalesce(jsonb_agg(row_to_json(t) order by t.orig_year, t.orig_quarter, t.country_code), '[]'::jsonb) from (
      select extract(year from orig_at)::int as orig_year,
             extract(quarter from orig_at)::int as orig_quarter,
             coalesce(country_code, '??') as country_code,
             upper(currency) as currency,
             sum(amount)::bigint as refund_cents
      from refunds
      where at >= v_start and at < v_end
        and orig_at is not null and orig_at < v_start
      group by 1, 2, 3, 4
    ) t),
    'totals', jsonb_build_object(
        'gross_cents', coalesce((select sum(amount) from sales where at >= v_start and at < v_end), 0),
        'refunded_cents', coalesce((select sum(amount) from refunds where at >= v_start and at < v_end), 0),
        'eu_cross_gross_cents', coalesce((select sum(amount) from sales
            where at >= v_start and at < v_end
              and country_code <> 'FR' and country_code = any (v_eu)), 0),
        'unknown_gross_cents', coalesce((select sum(amount) from sales
            where at >= v_start and at < v_end and country_code is null), 0),
        'unknown_n', (select count(*) from sales
            where at >= v_start and at < v_end and country_code is null)),
    -- Cumul ANNUEL (assiette du seuil 10 000 € — brut de remboursements, prudence).
    'year_summary', (select jsonb_build_object(
        'year', v_year,
        'eu_cross_cents', coalesce(sum(s.amount) filter (where s.country_code <> 'FR'
            and s.country_code = any (v_eu) and extract(year from s.at)::int = v_year), 0),
        'eu_cross_prev_cents', coalesce(sum(s.amount) filter (where s.country_code <> 'FR'
            and s.country_code = any (v_eu) and extract(year from s.at)::int = v_year - 1), 0),
        'fr_cents', coalesce(sum(s.amount) filter (where s.country_code = 'FR'
            and extract(year from s.at)::int = v_year), 0),
        'non_eu_cents', coalesce(sum(s.amount) filter (where s.country_code is not null
            and not (s.country_code = any (v_eu)) and extract(year from s.at)::int = v_year), 0),
        'unknown_cents', coalesce(sum(s.amount) filter (where s.country_code is null
            and extract(year from s.at)::int = v_year), 0))
      from sales s)
  ) into v;
  return v;
end; $$;
revoke all on function public.admin_vat_report(int, int) from public, anon, authenticated;
grant execute on function public.admin_vat_report(int, int) to authenticated, service_role;
