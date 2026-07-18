-- =============================================================================
-- Pack premium TVA : provision, dépôts « payés », prévision T+1, ETA de seuil.
-- =============================================================================
-- Suite du brainstorm confronté (2026-07-17) — les 4 pièces serveur du pack :
--
--   1. vat_filings.paid_at + admin_vat_filing_mark_paid : boucle la vie d'une
--      déclaration (déclaré → payé → archivé) SANS intégration Revolut Business
--      (4 virements/an → un clic manuel suffit). admin_vat_filings renvoie paid_at.
--   2. vat_provision_eur_cents() (helper interne) : « TVA collectée non encore
--      reversée » = Σ (net par pays × taux × fx du trimestre, indicatif 0,92 à
--      défaut) − Σ vat_filings.vat_eur_cents, plancher 0. GATE LÉGAL : sous le
--      seuil 10 000 € (année N et N-1), lieu = France → franchise → provision 0.
--   3. admin_vat_forecast() : provision + prévision DÉTERMINISTE du trimestre
--      suivant (abonnés UE actifs × renouvellements × taux, fx indicatif — pas
--      d'extrapolation) + ETA de seuil en FOURCHETTE, montrée uniquement avec
--      ≥ 3 mois de ventes UE non nulles (sinon null — honnêteté avant tout).
--   4. refresh_admin_dashboard ré-émis (base 20260717190000, diff scripté =
--      1 addition) : clé overview.vat_provision_eur_cents pour la carte Cockpit.
--
-- Nouvelles fonctions ⇒ NOTIFY pgrst requis. Exécuter en supabase_admin.

-- ── 1) Dépôt « payé » ───────────────────────────────────────────────────────────
alter table public.vat_filings
  add column if not exists paid_at timestamptz;
comment on column public.vat_filings.paid_at is
  'Virement OSS effectué (marquage manuel — 4 virements/an, pas d''intégration bancaire).';

create or replace function public.admin_vat_filing_mark_paid(p_id uuid, p_paid boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_id is null then raise exception 'invalid id' using errcode = '22023'; end if;
  update public.vat_filings set paid_at = case when coalesce(p_paid, true) then now() else null end
   where id = p_id;
  if not found then raise exception 'filing not found' using errcode = '22023'; end if;
  return jsonb_build_object('ok', true, 'id', p_id, 'paid', coalesce(p_paid, true));
end; $$;
revoke all on function public.admin_vat_filing_mark_paid(uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_vat_filing_mark_paid(uuid, boolean) to authenticated, service_role;

-- Même signature ⇒ simple replace ; renvoie désormais paid_at.
create or replace function public.admin_vat_filings(p_year int default null, p_quarter int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(row_to_json(t) order by t.filed_at desc) from (
    select id, year, quarter, vat_eur_cents, reference, note, document_path, paid_at, filed_at
    from public.vat_filings
    where (p_year is null or year = p_year)
      and (p_quarter is null or quarter = p_quarter)
    order by filed_at desc
    limit 24
  ) t), '[]'::jsonb);
end; $$;
revoke all on function public.admin_vat_filings(int, int) from public, anon, authenticated;
grant execute on function public.admin_vat_filings(int, int) to authenticated, service_role;

-- ── 2) Provision (helper interne — appelé par refresh + admin_vat_forecast) ─────
create or replace function public.vat_provision_eur_cents()
returns bigint language plpgsql stable security definer set search_path = public as $$
declare
  v_eu constant text[] := array['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
  v_gate numeric;
  v_due numeric;
  v_filed numeric;
begin
  -- Gate légal : sous 10 000 € de ventes UE transfrontalières (année N ET N-1,
  -- fx indicatif 0,92), le lieu de taxation reste la France → franchise → 0.
  select greatest(
    coalesce(sum(w.net) filter (where w.y = extract(year from now())::int), 0),
    coalesce(sum(w.net) filter (where w.y = extract(year from now())::int - 1), 0)
  ) * 0.92 into v_gate
  from (
    select extract(year from coalesce(l.updated_at, l.created_at))::int as y,
           sum(case when l.kind = 'refund' then -l.amount else l.amount end)::numeric as net
    from cloud_billing_ledger l
    where l.provider = 'revolut'
      and ((l.kind in ('first_charge', 'renewal') and l.status = 'captured') or l.kind = 'refund')
      and l.user_id not in (select user_id from public.admin_internal_accounts)
      and l.country_code is not null
      and (case when l.country_code = 'MC' then 'FR' else l.country_code end) <> 'FR'
      and (case when l.country_code = 'MC' then 'FR' else l.country_code end) = any (v_eu)
    group by 1
  ) w;
  if coalesce(v_gate, 0) < 1000000 then return 0; end if;

  select coalesce(sum(round(q.net * coalesce(f.usd_eur_rate, 0.92) * r.rate_pct / 100)), 0) into v_due
  from (
    select extract(year from coalesce(l.updated_at, l.created_at))::int as y,
           extract(quarter from coalesce(l.updated_at, l.created_at))::int as qq,
           (case when l.country_code = 'MC' then 'FR' else l.country_code end) as cc,
           sum(case when l.kind = 'refund' then -l.amount else l.amount end)::numeric as net
    from cloud_billing_ledger l
    where l.provider = 'revolut'
      and ((l.kind in ('first_charge', 'renewal') and l.status = 'captured') or l.kind = 'refund')
      and l.user_id not in (select user_id from public.admin_internal_accounts)
      and l.country_code is not null
      and (case when l.country_code = 'MC' then 'FR' else l.country_code end) <> 'FR'
      and (case when l.country_code = 'MC' then 'FR' else l.country_code end) = any (v_eu)
    group by 1, 2, 3
  ) q
  join public.eu_vat_standard_rates r on r.country_code = q.cc
  left join public.oss_fx_rates f on f.year = q.y and f.quarter = q.qq;

  select coalesce(sum(vat_eur_cents), 0) into v_filed from public.vat_filings;
  return greatest(0, round(coalesce(v_due, 0) - v_filed))::bigint;
end; $$;
revoke all on function public.vat_provision_eur_cents() from public, anon, authenticated;
grant execute on function public.vat_provision_eur_cents() to service_role;

-- ── 3) Prévision T+1 (déterministe) + ETA de seuil (fourchette, gatée) ──────────
create or replace function public.admin_vat_forecast()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_eu constant text[] := array['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
  v_qs timestamptz := date_trunc('quarter', now()) + interval '3 months';
  v_qe timestamptz := date_trunc('quarter', now()) + interval '6 months';
  v_months_active int := 0;
  v_avg3 numeric := 0;
  v_rem_eur numeric;
  v_eta jsonb := null;
  v jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  -- ETA : mois d'activité UE non nulle + moyenne des 3 derniers mois RÉVOLUS.
  select count(*) into v_months_active from (
    select date_trunc('month', coalesce(l.updated_at, l.created_at)) as m,
           sum(case when l.kind = 'refund' then -l.amount else l.amount end) as net
    from cloud_billing_ledger l
    where l.provider = 'revolut'
      and ((l.kind in ('first_charge', 'renewal') and l.status = 'captured') or l.kind = 'refund')
      and l.user_id not in (select user_id from public.admin_internal_accounts)
      and l.country_code is not null
      and (case when l.country_code = 'MC' then 'FR' else l.country_code end) <> 'FR'
      and (case when l.country_code = 'MC' then 'FR' else l.country_code end) = any (v_eu)
    group by 1 having sum(case when l.kind = 'refund' then -l.amount else l.amount end) > 0
  ) t;
  select coalesce(sum(case when l.kind = 'refund' then -l.amount else l.amount end), 0) / 3.0 into v_avg3
  from cloud_billing_ledger l
  where l.provider = 'revolut'
    and ((l.kind in ('first_charge', 'renewal') and l.status = 'captured') or l.kind = 'refund')
    and l.user_id not in (select user_id from public.admin_internal_accounts)
    and l.country_code is not null
    and (case when l.country_code = 'MC' then 'FR' else l.country_code end) <> 'FR'
    and (case when l.country_code = 'MC' then 'FR' else l.country_code end) = any (v_eu)
    and coalesce(l.updated_at, l.created_at) >= date_trunc('month', now()) - interval '3 months'
    and coalesce(l.updated_at, l.created_at) < date_trunc('month', now());
  select 1000000 - round(greatest(
      coalesce(sum(case when l.kind = 'refund' then -l.amount else l.amount end)
        filter (where extract(year from coalesce(l.updated_at, l.created_at))::int = extract(year from now())::int), 0),
      coalesce(sum(case when l.kind = 'refund' then -l.amount else l.amount end)
        filter (where extract(year from coalesce(l.updated_at, l.created_at))::int = extract(year from now())::int - 1), 0)
    ) * 0.92) into v_rem_eur
  from cloud_billing_ledger l
  where l.provider = 'revolut'
    and ((l.kind in ('first_charge', 'renewal') and l.status = 'captured') or l.kind = 'refund')
    and l.user_id not in (select user_id from public.admin_internal_accounts)
    and l.country_code is not null
    and (case when l.country_code = 'MC' then 'FR' else l.country_code end) <> 'FR'
    and (case when l.country_code = 'MC' then 'FR' else l.country_code end) = any (v_eu);
  -- Fourchette ±30 % — montrée UNIQUEMENT avec ≥ 3 mois d'historique non nul et
  -- un seuil pas encore franchi (sinon null : pas de fausse précision).
  if v_months_active >= 3 and v_avg3 > 0 and coalesce(v_rem_eur, 1000000) > 0 then
    v_eta := jsonb_build_object(
      'months_min', greatest(1, ceil(v_rem_eur / (v_avg3 * 0.92 * 1.3)))::int,
      'months_max', ceil(v_rem_eur / (v_avg3 * 0.92 * 0.7))::int,
      'avg_3m_usd_cents', round(v_avg3)::bigint);
  end if;

  with subs as (
    select (case when p.country_code = 'MC' then 'FR' else p.country_code end) as cc,
           coalesce(rc.amount_cents, p.mrr_cents) as amt,
           coalesce(rc.period, p.bill_period, 'monthly') as period,
           p.current_period_end
    from cloud_entitlement_projection p
    left join cloud_revolut_customers rc on rc.user_id = p.user_id
    where p.provider = 'revolut' and p.status in ('trialing', 'active')
      and p.user_id not in (select user_id from public.admin_internal_accounts)
      and p.country_code is not null
      and (case when p.country_code = 'MC' then 'FR' else p.country_code end) <> 'FR'
      and (case when p.country_code = 'MC' then 'FR' else p.country_code end) = any (v_eu)
      and coalesce(rc.amount_cents, p.mrr_cents) is not null
  ), rn as (
    -- Déterministe : mensuel = 3 renouvellements dans le trimestre ; annuel = 1 si
    -- l'échéance tombe dans la fenêtre. cancelled_at_period_end exclu (ne renouvelle pas).
    select cc, sum(case when period = 'annual'
                        then case when current_period_end >= v_qs and current_period_end < v_qe then amt else 0 end
                        else amt * 3 end)::numeric as base_usd
    from subs group by cc
  )
  select jsonb_build_object(
    'provision_eur_cents', public.vat_provision_eur_cents(),
    'next_quarter', jsonb_build_object('year', extract(year from v_qs)::int, 'quarter', extract(quarter from v_qs)::int),
    'forecast_base_usd_cents', coalesce((select sum(base_usd) from rn), 0)::bigint,
    'forecast_vat_eur_cents', coalesce((select sum(round(rn.base_usd * 0.92 * r.rate_pct / 100))
        from rn join public.eu_vat_standard_rates r on r.country_code = rn.cc), 0)::bigint,
    'forecast_subscribers', (select count(*) from subs),
    'eta', v_eta
  ) into v;
  return v;
end; $$;
revoke all on function public.admin_vat_forecast() from public, anon, authenticated;
grant execute on function public.admin_vat_forecast() to authenticated, service_role;

-- ── 4) refresh_admin_dashboard : + overview.vat_provision_eur_cents (Cockpit) ───
-- Ré-émission VERBATIM (base : 20260717190000) avec cette SEULE addition.

create or replace function public.refresh_admin_dashboard()
 returns timestamp with time zone
 language plpgsql
 security definer
 set search_path to 'public', 'cron'
as $function$
declare ov jsonb; src jsonb; cov jsonb; crn jsonb;
begin
  set local statement_timeout to '180s';
  set local work_mem to '64MB';

  with tc as (
    select v.source_id, t2.item_type, count(*)::bigint as n
    from cloud_titles t2
    join cloud_title_variants v on v.id = t2.default_variant_id
    where t2.variant_count > 0 and t2.item_type in ('movie','series')
    group by 1, 2
  ), vc as (
    select source_id, count(*)::bigint as n from cloud_title_variants group by 1
  ), mc as (
    select source_id, count(*)::bigint as n,
           count(*) filter (where item_type in ('movie','series'))::bigint as n_ms
    from cloud_media_items group by 1
  ), tt as (
    select item_type, count(*)::bigint as n
    from cloud_titles where variant_count > 0 and item_type in ('movie','series')
    group by 1
  ), src_rows as (
    select s.id as source_id, s.user_id as user_id, u.email::text as owner_email,
           coalesce(s.display_name, left(s.id::text, 8)) as display_name,
           s.sync_status, s.sync_error, s.catalog_version, s.created_at, s.last_synced_at,
           coalesce(mc.n, 0)  as media_items,
           coalesce(vc.n, 0)  as variants,
           coalesce(tcm.n, 0) as movie_titles,
           coalesce(tcs.n, 0) as series_titles,
           (coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0) as incomplete,
           pi.id as identity_id, pi.display_name::text as identity_name,
           (s.user_id in (select user_id from public.admin_enrichment_accounts)) as is_driver
    from cloud_sources s
    left join auth.users u on u.id = s.user_id
    left join mc on mc.source_id = s.id
    left join vc on vc.source_id = s.id
    left join tc tcm on tcm.source_id = s.id and tcm.item_type = 'movie'
    left join tc tcs on tcs.source_id = s.id and tcs.item_type = 'series'
    left join catalog_provider_identities cpi on cpi.provider_key = (select cpi2.provider_key from catalog_provider_identities cpi2 where cpi2.display_name = s.display_name and cpi2.status = 'active' limit 1)
    left join provider_identities pi on pi.id = cpi.identity_id
    where s.user_id in (select user_id from public.admin_enrichment_accounts)
       or s.sync_status = 'sync_error' or s.sync_error is not null
       or (exists (select 1 from cloud_media_items m where m.source_id = s.id and m.item_type in ('movie','series'))
           and not exists (select 1 from cloud_title_variants v2 where v2.source_id = s.id))
    order by (s.user_id in (select user_id from public.admin_enrichment_accounts)) desc, s.created_at
    limit 300
  )
  select
    jsonb_build_object(
      'users_total',(select count(*) from auth.users),
      'users_active_7d',(select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
      'users_active_24h',(select count(*) from auth.users where last_sign_in_at > now() - interval '24 hours'),
      'users_active_30d',(select count(*) from auth.users where last_sign_in_at > now() - interval '30 days'),
      'users_new_7d',(select count(*) from auth.users where created_at > now() - interval '7 days'),
      'users_new_30d',(select count(*) from auth.users where created_at > now() - interval '30 days'),
      'users_watching_24h',(select count(distinct user_id) from cloud_watch_history where updated_at > now() - interval '24 hours'),
      'users_watching_7d',(select count(distinct user_id) from cloud_watch_history where updated_at > now() - interval '7 days'),
      'sources_total',(select count(*) from cloud_sources),
      'sources_error',(select count(*) from cloud_sources where sync_status = 'sync_error' or sync_error is not null),
      'sources_incomplete',(select count(*) from cloud_sources s
          left join mc on mc.source_id = s.id
          left join vc on vc.source_id = s.id
          where coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0),
      'titles_movie',(select coalesce((select n from tt where item_type = 'movie'), 0)),
      'titles_series',(select coalesce((select n from tt where item_type = 'series'), 0)),
      'identities_active',(select count(*) from provider_identities where status = 'active'),
      'gensubs_ready',(select count(*) from catalog_generated_subtitles where status = 'ready'),
      'gensubs_processing',(select count(*) from catalog_generated_subtitles where status = 'processing'),
      'gensubs_failed',(select count(*) from catalog_generated_subtitles where status = 'failed'),
      'tmdb_year_backlog',(select count(*) from cloud_titles where release_year is null and provider_tmdb_id is not null),
      'tmdb_unmatched',(select count(*) from cloud_titles where match_status = 'unmatched'),
      'tmdb_unverified',(select count(*) from cloud_titles where match_status in ('provider_unverified','weak') and provider_tmdb_id is not null and provider_tmdb_id <> '0'),
      'cron_active',(select count(*) from cron.job where active),
      'cron_paused',(select count(*) from cron.job where not active),
      'cron_fails_24h',(select count(*) from cron.job_run_details where status = 'failed' and start_time > now() - interval '24 hours'),
      'cron_ko',(select count(*) from cron.job j
          where j.active
            and (select d.status from cron.job_run_details d
                  where d.jobid = j.jobid order by d.start_time desc limit 1) = 'failed'),
      'billing_mrr_cents',(select coalesce(sum(case when coalesce(c.period, p.bill_period) = 'annual' then round(coalesce(c.amount_cents, p.mrr_cents) / 12.0) else coalesce(c.amount_cents, p.mrr_cents) end), 0)
          from cloud_entitlement_projection p left join cloud_stancer_customers c on c.user_id = p.user_id
          where p.status in ('active','past_due','grace','cancelled_at_period_end')
            and p.user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_trialing',(select count(*) from cloud_entitlement_projection
          where status = 'trialing' and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_active',(select count(*) from cloud_entitlement_projection
          where status = 'active' and provider <> 'system'
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_past_due',(select count(*) from cloud_entitlement_projection
          where status in ('past_due','grace') and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_cancel_pending',(select count(*) from cloud_entitlement_projection
          where status = 'cancelled_at_period_end' and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_collected_30d_cents',(select coalesce(sum(amount), 0) from cloud_stancer_payments
          where status = 'captured' and kind in ('first_charge','renewal') and updated_at > now() - interval '30 days'
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_conversions_7d',(select count(distinct user_id) from cloud_stancer_payments
          where kind = 'first_charge' and status = 'captured' and updated_at > now() - interval '7 days'
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_cron_fails_24h',(select count(*) from cron.job_run_details d join cron.job j on j.jobid = d.jobid
          where j.jobname in ('norva-revolut-billing','norva-lifecycle') and d.status = 'failed' and d.start_time > now() - interval '24 hours'),
      -- Pays : top 5 (payants + essais), nb de pays distincts, et le trou de
      -- couverture (clients facturés sans pays connu). Le MRR n'additionne que les
      -- lignes non-essai, avec la même formule amount/period que billing_mrr_cents.
      'billing_countries',(select coalesce(jsonb_agg(jsonb_build_object('country_code', t.cc, 'n', t.n, 'mrr_cents', t.mrr) order by t.n desc, t.cc), '[]'::jsonb) from (
          select p.country_code as cc, count(*)::int as n,
                 coalesce(sum(case when p.status = 'trialing' then 0
                                   when coalesce(c.period, p.bill_period) = 'annual' then round(coalesce(c.amount_cents, p.mrr_cents) / 12.0)
                                   else coalesce(c.amount_cents, p.mrr_cents) end), 0)::bigint as mrr
          from cloud_entitlement_projection p left join cloud_stancer_customers c on c.user_id = p.user_id
          where p.status in ('trialing','active','past_due','grace','cancelled_at_period_end')
            and p.country_code is not null
            and p.user_id not in (select user_id from public.admin_internal_accounts)
          group by 1 order by count(*) desc limit 5) t),
      'billing_countries_n',(select count(distinct country_code) from cloud_entitlement_projection
          where status in ('trialing','active','past_due','grace','cancelled_at_period_end')
            and country_code is not null
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_country_unknown_n',(select count(*) from cloud_entitlement_projection
          where status in ('trialing','active','past_due','grace','cancelled_at_period_end')
            and country_code is null
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'vat_provision_eur_cents',(select public.vat_provision_eur_cents()),
      'vat_ytd_eu_cross_cents',(select coalesce(sum(l.amount), 0) from cloud_billing_ledger l
          where l.provider = 'revolut' and l.kind in ('first_charge','renewal') and l.status = 'captured'
            and l.country_code is not null and l.country_code <> 'FR' and l.country_code = any (array['AT','BE','BG','HR','CY','CZ','DK','EE','FI','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'])
            and extract(year from coalesce(l.updated_at, l.created_at))::int = extract(year from now())::int
            and l.user_id not in (select user_id from public.admin_internal_accounts)),
      'vat_prevy_eu_cross_cents',(select coalesce(sum(l.amount), 0) from cloud_billing_ledger l
          where l.provider = 'revolut' and l.kind in ('first_charge','renewal') and l.status = 'captured'
            and l.country_code is not null and l.country_code <> 'FR' and l.country_code = any (array['AT','BE','BG','HR','CY','CZ','DK','EE','FI','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'])
            and extract(year from coalesce(l.updated_at, l.created_at))::int = extract(year from now())::int - 1
            and l.user_id not in (select user_id from public.admin_internal_accounts)),
      'vat_fx_pending',(select case when
          exists(select 1 from cloud_billing_ledger l
              where l.provider = 'revolut' and l.kind in ('first_charge','renewal') and l.status = 'captured'
                and l.country_code is not null and l.country_code <> 'FR' and l.country_code = any (array['AT','BE','BG','HR','CY','CZ','DK','EE','FI','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'])
                and extract(year from coalesce(l.updated_at, l.created_at))::int = extract(year from (date_trunc('quarter', now()) - interval '1 day'))::int
                and extract(quarter from coalesce(l.updated_at, l.created_at))::int = extract(quarter from (date_trunc('quarter', now()) - interval '1 day'))::int
                and l.user_id not in (select user_id from public.admin_internal_accounts))
          and not exists(select 1 from public.oss_fx_rates f where f.year = extract(year from (date_trunc('quarter', now()) - interval '1 day'))::int and f.quarter = extract(quarter from (date_trunc('quarter', now()) - interval '1 day'))::int)
          then 'T' || extract(quarter from (date_trunc('quarter', now()) - interval '1 day'))::int || ' ' || extract(year from (date_trunc('quarter', now()) - interval '1 day'))::int else null end),
      'support_open',(select count(*) from cloud_support_tickets where status <> 'closed'),
      'support_needs_reply',(select count(*) from cloud_support_tickets where status <> 'closed' and last_from = 'user'),
      'support_stale_24h',(select count(*) from cloud_support_tickets where status <> 'closed' and last_from = 'user' and last_message_at < now() - interval '24 hours')
    ),
    (select coalesce(jsonb_agg(row_to_json(sr) order by sr.is_driver desc, sr.created_at), '[]'::jsonb) from src_rows sr)
  into ov, src;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into cov from (
    select u.email::text as owner_email, coalesce(pi.display_name, s.display_name, left(s.id::text, 8)) as panel, ct.item_type,
           count(*) as total,
           count(*) filter (where ct.audio_languages <> '{}') as resolved,
           round(100.0 * count(*) filter (where ct.audio_languages <> '{}') / nullif(count(*), 0), 1) as resolved_pct,
           count(*) filter (where ct.audio_probed_at is null and ct.audio_languages = '{}') as never_probed,
           count(*) filter (where ct.audio_probed_at > now() - interval '24 hours') as probed_24h,
           count(*) filter (where ct.audio_probed_at > now() - interval '24 hours' and ct.audio_languages <> '{}') as resolved_24h,
           case when count(*) filter (where ct.audio_probed_at > now() - interval '24 hours') > 0
                then ceil(count(*) filter (where ct.audio_probed_at is null and ct.audio_languages = '{}')::numeric / count(*) filter (where ct.audio_probed_at > now() - interval '24 hours'))
                else null end as eta_days,
           count(*) filter (where ct.subtitle_probed_at is not null) as subtitle_probed,
           count(*) filter (where jsonb_typeof(ct.subtitle_tracks) = 'array' and jsonb_array_length(ct.subtitle_tracks) > 0) as subtitle_found
    from cloud_titles ct join cloud_title_variants v on v.id = ct.default_variant_id join cloud_sources s on s.id = v.source_id
    left join auth.users u on u.id = s.user_id
    left join catalog_provider_identities cpi on cpi.provider_key = s.config_hint->>'providerKey'
    left join provider_identities pi on pi.id = cpi.identity_id
    where ct.variant_count > 0
      and ct.user_id in (select user_id from public.admin_enrichment_accounts)
    group by u.email, coalesce(pi.id::text, s.id::text), coalesce(pi.display_name, s.display_name, left(s.id::text, 8)), ct.item_type
    order by u.email, ct.item_type, count(*) desc
  ) t;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into crn from (
    select j.jobid, j.jobname, j.schedule, j.active,
           case when j.schedule ~ '6-23' then 'jour'
                when j.schedule ~ '0-5' then 'nuit'
                when j.schedule ~ '^\S+ \* \* \* \*$' then 'continu'
                else '—' end as window,
           case when j.jobname ~ 'stancer|billing' then 'billing'
                when j.jobname ~ 'lifecycle' then 'lifecycle'
                when j.jobname ~ 'whisper' then 'whisper'
                when j.jobname ~ 'reaper|prewarm|prune|series-info|dashboard|vac|history|alert' then 'maintenance'
                when j.jobname ~ 'auto-refresh|resume-stuck' then 'sync'
                when j.jobname ~ 'series' then 'séries'
                when j.jobname ~ 'subtitle|pregen' then 'sous-titres'
                when j.jobname ~ 'audio|langs' then 'audio films'
                when j.jobname ~ 'enrich|origlang|revalidate|backfill-years|search-match|tmdb' then 'tmdb'
                when j.jobname ~ 'notify|digest' then 'notif'
                else 'autre' end as kind,
           lr.start_time as last_run, lr.status as last_status,
           coalesce((select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.status = 'failed' and d.start_time > now() - interval '24 hours'), 0) as fails_24h
    from cron.job j
    left join lateral (select d.start_time, d.status from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1) lr on true
    order by (case when j.jobname ~ 'stancer|billing|lifecycle' then 0 when j.schedule ~ '6-23' then 1 when j.schedule ~ '0-5' then 2 else 3 end), j.jobname
  ) t;

  insert into public.admin_dashboard_cache (id, overview, sources, coverage, cron, refreshed_at)
       values (1, ov, src, cov, crn, now())
  on conflict (id) do update set overview = excluded.overview, sources = excluded.sources, coverage = excluded.coverage, cron = excluded.cron, refreshed_at = excluded.refreshed_at;
  return now();
end; $function$;
