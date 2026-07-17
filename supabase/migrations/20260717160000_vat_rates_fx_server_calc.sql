-- =============================================================================
-- TVA niveau 3 (serveur) : taux TVA en table, taux BCE figé par trimestre,
-- calcul EUR + TVA due côté admin_vat_report.
-- =============================================================================
-- Jusqu'ici le calcul TVA (niveau 2) vivait côté front avec une table de taux en
-- constante JS et un fx USD→EUR indicatif. Ce lot déplace la rigueur côté serveur :
--
--   • eu_vat_standard_rates — les 27 taux standard UE (source : base TEDB de la
--     Commission ; aucun changement de taux standard en 2026). Un abonnement
--     streaming prend le taux standard partout (défaut sûr). Grèce = 'GR' (ISO,
--     comme les cartes/ledger) — le portail OSS l'affiche 'EL'.
--     ⚠ Table SANS historique : si un taux change un 1ᵉʳ janvier, la mettre à jour
--     APRÈS le dépôt du T4 précédent (les corrections d'anciennes périodes devront
--     utiliser l'ancien taux manuellement — limitation documentée, cas rarissime).
--
--   • oss_fx_rates — le taux BCE USD→EUR FIGÉ par trimestre (art. 369h dir.
--     2006/112 : taux publié le dernier jour de la période, à défaut le jour de
--     publication suivant). Pas de fetch automatique : l'admin FIGE le taux à la
--     clôture via admin_vat_fx_set (le front pré-suggère la valeur BCE, l'humain
--     valide — une déclaration engage sa responsabilité).
--
--   • admin_vat_report v3 (base : re-emission verbatim de 20260717150000) :
--     + clé 'fx' ({usd_eur_rate, fixed_at, source} ou null si non figé) ;
--     + par ligne : rate_pct (UE hors FR), base_eur_cents, vat_due_eur_cents
--       (null tant que le fx n'est pas figé → le front retombe sur l'indicatif) ;
--     + totals : oss_base_eur_cents, oss_vat_eur_cents (mêmes conditions).
--     Signature inchangée ⇒ pas de reload PostgREST. Exécuter en supabase_admin.

-- ── 1) Taux TVA standard UE (seed 2026, upsert idempotent) ──────────────────────
create table if not exists public.eu_vat_standard_rates (
  country_code text primary key check (country_code ~ '^[A-Z]{2}$'),
  rate_pct     numeric(5,2) not null check (rate_pct > 0 and rate_pct < 40),
  updated_at   timestamptz not null default now()
);
alter table public.eu_vat_standard_rates enable row level security;
-- Pas de policies : lu uniquement par les fonctions security definer (service role).

insert into public.eu_vat_standard_rates (country_code, rate_pct) values
  ('AT', 20), ('BE', 21), ('BG', 20), ('HR', 25), ('CY', 19), ('CZ', 21),
  ('DK', 25), ('EE', 24), ('FI', 25.5), ('FR', 20), ('DE', 19), ('GR', 24),
  ('HU', 27), ('IE', 23), ('IT', 22), ('LV', 21), ('LT', 21), ('LU', 17),
  ('MT', 18), ('NL', 21), ('PL', 23), ('PT', 23), ('RO', 21), ('SK', 23),
  ('SI', 22), ('ES', 21), ('SE', 25)
on conflict (country_code) do update set rate_pct = excluded.rate_pct, updated_at = now();

-- ── 2) Taux BCE figé par trimestre ──────────────────────────────────────────────
create table if not exists public.oss_fx_rates (
  year         int  not null check (year between 2020 and 2100),
  quarter      int  not null check (quarter between 1 and 4),
  usd_eur_rate numeric(10, 6) not null check (usd_eur_rate > 0.2 and usd_eur_rate < 5),
  source       text not null default 'ecb',
  fixed_at     timestamptz not null default now(),
  primary key (year, quarter)
);
alter table public.oss_fx_rates enable row level security;

-- ── 3) admin_vat_fx_set : figer (ou corriger avant dépôt) le taux d'un trimestre ─
create or replace function public.admin_vat_fx_set(p_year int, p_quarter int, p_rate numeric)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_year is null or p_year < 2020 or p_year > 2100 then raise exception 'invalid year' using errcode = '22023'; end if;
  if p_quarter is null or p_quarter < 1 or p_quarter > 4 then raise exception 'invalid quarter' using errcode = '22023'; end if;
  if p_rate is null or p_rate <= 0.2 or p_rate >= 5 then raise exception 'invalid rate' using errcode = '22023'; end if;
  -- On ne fige qu'un trimestre TERMINÉ (le taux légal est celui du dernier jour).
  if make_timestamptz(p_year, (p_quarter - 1) * 3 + 1, 1, 0, 0, 0, 'UTC') + interval '3 months' > now() then
    raise exception 'quarter not over yet' using errcode = '22023';
  end if;
  insert into public.oss_fx_rates (year, quarter, usd_eur_rate)
       values (p_year, p_quarter, p_rate)
  on conflict (year, quarter) do update set usd_eur_rate = excluded.usd_eur_rate, fixed_at = now();
  return jsonb_build_object('ok', true, 'year', p_year, 'quarter', p_quarter, 'usd_eur_rate', p_rate);
end; $$;
revoke all on function public.admin_vat_fx_set(int, int, numeric) from public, anon, authenticated;
grant execute on function public.admin_vat_fx_set(int, int, numeric) to authenticated, service_role;

-- ── 4) admin_vat_report v3 : calcul EUR + TVA côté serveur ──────────────────────
create or replace function public.admin_vat_report(p_year int default null, p_quarter int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_year    int := coalesce(p_year, extract(year from now())::int);
  v_quarter int := coalesce(p_quarter, extract(quarter from now())::int);
  v_start   timestamptz;
  v_end     timestamptz;
  v_eu constant text[] := array['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
  v_fx      numeric := null;
  v_fx_at   timestamptz := null;
  v_fx_src  text := null;
  v jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_quarter < 1 or v_quarter > 4 then raise exception 'invalid quarter' using errcode = '22023'; end if;
  if v_year < 2020 or v_year > 2100 then raise exception 'invalid year' using errcode = '22023'; end if;
  v_start := make_timestamptz(v_year, (v_quarter - 1) * 3 + 1, 1, 0, 0, 0, 'UTC');
  v_end   := v_start + interval '3 months';

  select usd_eur_rate, fixed_at, source into v_fx, v_fx_at, v_fx_src
    from public.oss_fx_rates where year = v_year and quarter = v_quarter;

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
    -- Taux BCE figé du trimestre (null tant que l'admin ne l'a pas figé à la
    -- clôture) — quand présent, les champs *_eur_cents ci-dessous sont DÉFINITIFS.
    'fx', case when v_fx is null then null else jsonb_build_object(
        'usd_eur_rate', v_fx, 'fixed_at', v_fx_at, 'source', v_fx_src) end,
    'rows', (select coalesce(jsonb_agg(row_to_json(t) order by t.gross_cents desc), '[]'::jsonb) from (
      select coalesce(coalesce(s.cc, rf.cc), '??') as country_code,
             coalesce(coalesce(s.cc, rf.cc) = any (v_eu), false) as is_eu,
             upper(coalesce(s.currency, rf.currency)) as currency,
             coalesce(s.n_tx, 0)::int as n_tx,
             coalesce(s.gross_cents, 0)::bigint as gross_cents,
             coalesce(rf.cents, 0)::bigint as refunded_cents,
             (coalesce(s.gross_cents, 0) - coalesce(rf.cents, 0))::bigint as net_cents,
             -- Taux du pays (UE hors France uniquement — FR = franchise, hors UE = hors OSS).
             (select r2.rate_pct from public.eu_vat_standard_rates r2
               where r2.country_code = coalesce(s.cc, rf.cc)
                 and coalesce(s.cc, rf.cc) <> 'FR'
                 and coalesce(s.cc, rf.cc) = any (v_eu)) as rate_pct,
             -- Champs EUR définitifs, seulement quand le fx du trimestre est figé.
             case when v_fx is not null
                  then round(((coalesce(s.gross_cents, 0) - coalesce(rf.cents, 0))::numeric) * v_fx)::bigint
                  end as base_eur_cents,
             case when v_fx is not null then
               (select round(((coalesce(s.gross_cents, 0) - coalesce(rf.cents, 0))::numeric) * v_fx * r3.rate_pct / 100)::bigint
                  from public.eu_vat_standard_rates r3
                 where r3.country_code = coalesce(s.cc, rf.cc)
                   and coalesce(s.cc, rf.cc) <> 'FR'
                   and coalesce(s.cc, rf.cc) = any (v_eu))
               end as vat_due_eur_cents
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
    'corrections', (select coalesce(jsonb_agg(row_to_json(t) order by t.orig_year, t.orig_quarter, t.country_code), '[]'::jsonb) from (
      -- fx du trimestre D'ORIGINE (une correction se déclare dans les termes de sa
      -- période) — null si pas figé. NB : taux TVA = table courante (pas d'historique
      -- de taux ; cas de changement rarissime, cf. bannière).
      select g.*,
             (select f.usd_eur_rate from public.oss_fx_rates f
               where f.year = g.orig_year and f.quarter = g.orig_quarter) as orig_usd_eur_rate
      from (
        select extract(year from orig_at)::int as orig_year,
               extract(quarter from orig_at)::int as orig_quarter,
               coalesce(country_code, '??') as country_code,
               upper(currency) as currency,
               sum(amount)::bigint as refund_cents
        from refunds
        where at >= v_start and at < v_end
          and orig_at is not null and orig_at < v_start
        group by 1, 2, 3, 4
      ) g
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
            where at >= v_start and at < v_end and country_code is null),
        -- Totaux OSS définitifs (UE hors FR), seulement quand le fx est figé.
        'oss_base_eur_cents', case when v_fx is not null then
            (select coalesce(round(sum((s.amount)::numeric * v_fx)), 0)::bigint from sales s
              where s.at >= v_start and s.at < v_end
                and s.country_code <> 'FR' and s.country_code = any (v_eu))
          - (select coalesce(round(sum((r.amount)::numeric * v_fx)), 0)::bigint from refunds r
              where r.at >= v_start and r.at < v_end
                and (r.orig_at is null or r.orig_at >= v_start)
                and r.country_code <> 'FR' and r.country_code = any (v_eu))
          end,
        'oss_vat_eur_cents', case when v_fx is not null then
            (select coalesce(sum(round((per.net)::numeric * v_fx * per.rate_pct / 100)), 0)::bigint
               from (
                 select (coalesce(sx.cents, 0) - coalesce(rx.cents, 0)) as net, vr.rate_pct
                 from (select country_code as cc, sum(amount)::bigint as cents from sales
                        where at >= v_start and at < v_end group by 1) sx
                 full outer join (select country_code as cc, sum(amount)::bigint as cents from refunds
                        where at >= v_start and at < v_end
                          and (orig_at is null or orig_at >= v_start) group by 1) rx
                   on rx.cc is not distinct from sx.cc
                 join public.eu_vat_standard_rates vr on vr.country_code = coalesce(sx.cc, rx.cc)
                 where coalesce(sx.cc, rx.cc) <> 'FR'
                   and coalesce(sx.cc, rx.cc) = any (v_eu)
               ) per)
          end),
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
