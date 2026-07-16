-- =============================================================================
-- 07-selfhost-data-healthcheck.sql — audit COMPLET des datas du dashboard admin
-- =============================================================================
-- Post-migration Supabase→Hetzner : vérifie CHAQUE source de données que le CRM
-- lit (Cockpit, Finance, Clients, Support, Providers, Identités, Moteur, Système,
-- Télémétrie), dérivé de l'inventaire exhaustif routes norva-admin × panels
-- AdminPage (audit 2026-07-16). 100 % READ-ONLY — exécutable à tout moment.
--
--   docker exec -i norva-db psql -U postgres -d postgres -P pager=off \
--     < ops/hetzner/scripts/07-selfhost-data-healthcheck.sql
--
-- IMPORTANT : lancer SANS -v ON_ERROR_STOP=1 — une table/colonne manquante doit
-- s'afficher comme une ligne ERROR (c'est un finding !) sans stopper le reste.
-- Chaque section imprime des colonnes `pass`/valeurs à interpréter ; coller la
-- sortie complète pour analyse.
-- =============================================================================
\pset pager off
\echo ''
\echo '================ [A] SNAPSHOT ADMIN (cockpit entier dépend de ça) ================'

select 'A1 admin_dashboard_cache' as check, count(*) as rows, max(refreshed_at) as refreshed_at,
       (count(*) = 1 and max(refreshed_at) > now() - interval '12 min') as pass
from admin_dashboard_cache where id = 1;

select 'A2 cache blobs' as check,
       (overview is not null) as overview_ok, (sources is not null) as sources_ok,
       (coverage is not null) as coverage_ok, (cron is not null) as cron_ok,
       (overview ? 'billing_mrr_cents') as has_mrr_key,
       (overview ? 'tmdb_year_backlog') as has_backlog_key,
       (overview ->> 'billing_mrr_cents') as mrr_cents_value
from admin_dashboard_cache where id = 1;

select 'A3 admin_metrics_daily (sparklines)' as check,
       count(distinct day) as days, max(day) as last_day, count(distinct metric) as metrics,
       (count(distinct day) >= 14 and max(day) >= current_date - 1) as pass
from admin_metrics_daily;

select 'A4 mrr_cents 3 derniers jours' as check, day, value
from admin_metrics_daily where metric = 'mrr_cents' order by day desc limit 3;

select 'A5 tables admin annexes' as check,
  (select count(*) from admin_events)              as events,
  (select max(created_at) from admin_events)       as events_last,
  (select count(*) from admin_alert_state)         as alert_state_open,
  (select count(*) from admin_feature_flags)       as flags,
  (select count(*) from admin_notes)               as notes,
  (select count(*) from admin_tags)                as tags,
  (select count(*) from admin_client_tags)         as client_tags,
  (select count(*) from admin_internal_accounts)   as internal_accounts,
  (select count(*) from admin_enrichment_accounts) as enrichment_accounts;
-- internal_accounts=0 → le trafic interne pollue funnel/finance.
-- enrichment_accounts=0 → Moteur « 100 % couverture » = FAUX positif.

select 'A6 feature flags' as check, string_agg(key, ', ' order by key) as keys
from admin_feature_flags;
-- attendus : au moins enrichment_paused, maintenance_banner

\echo ''
\echo '================ [B] BILLING / FINANCE ================'

select 'B1 projection par statut' as check, status, count(*) as n
from cloud_entitlement_projection group by status order by n desc;

select 'B2 ledger stancer (cross-rail)' as check,
  (select count(*) from cloud_stancer_customers) as customers,
  (select count(*) from cloud_stancer_payments)  as payments,
  (select max(created_at) from cloud_stancer_payments) as last_payment,
  (select count(*) from cloud_stancer_payments where payment_id like 'rc_%') as rc_mobile_rows;

select 'B3 rail revolut' as check,
  (select count(*) from cloud_revolut_customers) as customers,
  (select count(*) from cloud_revolut_orders)    as orders,
  (select count(*) from cloud_revolut_orders where state = 'completed') as completed,
  (select max(updated_at) from cloud_revolut_orders) as last_order;

select 'B4 cancel feedback' as check, count(*) as n from cloud_cancel_feedback;

\echo ''
\echo '================ [C] ★ DRIFT DE DÉFINITIONS (le check critique post-migration) ================'
\echo 'Les fns finance ont été redéfinies en LIVE (jamais en migration) pour Revolut.'
\echo 'revolut_aware=f sur une ligne = ce chiffre du CRM ignore le rail web Revolut (G2).'

select p.proname as fn,
       (p.prosrc like '%cloud_revolut_%') as revolut_aware,
       (p.prosrc like '%norva-stancer-billing%') as counts_dead_stancer_cron
from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
where p.proname in ('admin_finance','refresh_admin_dashboard','snapshot_admin_metrics',
                    'admin_user_billing','admin_client_crm','admin_users_export')
order by p.proname;
-- attendu : revolut_aware=t partout ; counts_dead_stancer_cron=f partout
-- (counts_dead_stancer_cron=t sur refresh_admin_dashboard = compteur billing_cron_fails_24h
--  qui surveille un cron RETIRÉ → les échecs de norva-revolut-billing seraient invisibles. G3)

select 'C2 funnel view revolut-aware' as check,
       (pg_get_viewdef('norva_funnel_daily'::regclass) like '%revolut%') as pass;

\echo ''
\echo '================ [D] RPCs — les 36 fonctions que le CRM appelle ================'

select 'D1 RPC manquants (0 ligne = parfait)' as check, x.fn as missing
from unnest(array[
  'is_admin','admin_overview','admin_sources','admin_enrichment_coverage','admin_cron_health',
  'admin_metric_sparks','admin_activity_series','admin_finance','admin_users_page','admin_users_export',
  'admin_user_detail','admin_user_billing','admin_client_crm','admin_note_add','admin_note_delete',
  'admin_tag_create','admin_tag_toggle','admin_tag_bulk','admin_internal_toggle','admin_support_counts',
  'admin_support_list','admin_support_ticket','admin_support_set_status','admin_identities','admin_audit_feed',
  'admin_flags_list','admin_flag_set','admin_flag_create','admin_flag_delete','admin_playback_telemetry',
  'refresh_admin_dashboard','snapshot_admin_metrics','admin_alert_recipients','admin_count_active',
  'feature_flag','app_public_flags']) as x(fn)
where not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = x.fn);

\echo ''
\echo '================ [E] CRONS ================'

select 'E1 totaux' as check, count(*) as total, count(*) filter (where active) as active
from cron.job;
-- réf parité 2026-07-07 : 47 jobs / 46 actifs (peut avoir évolué depuis, comparer à l onglet Moteur)

select 'E2 crons requis manquants (0 ligne = parfait)' as check, x.jobname as missing
from unnest(array[
  'admin-dashboard-refresh','norva-snapshot-metrics','norva-ops-alert','norva-admin-events-prune',
  'norva-cron-history-prune','norva-revolut-billing','norva-lifecycle','norva-catalog-reconcile',
  'norva-enrich-titles-from-catalog']) as x(jobname)
where not exists (select 1 from cron.job j where j.jobname = x.jobname);

select 'E3 crons stancer résiduels (0 ligne = parfait)' as check, jobname
from cron.job where jobname like 'norva-stancer%';

select 'E4 crons pointant encore vers supabase.co (0 ligne = parfait)' as check,
       jobname, left(command, 80) as cmd
from cron.job where command like '%supabase.co%';

select 'E5 historique run_details' as check, count(*) as rows,
       min(start_time) as oldest, max(start_time) as newest
from cron.job_run_details;
-- vide = Système « Crons OK 100 % » serait un faux vert

select 'E6 crons ACTUELLEMENT en échec (dernier run failed)' as check,
       j.jobname, lr.status, lr.start_time
from cron.job j
join lateral (select d.status, d.start_time from cron.job_run_details d
              where d.jobid = j.jobid order by d.start_time desc limit 1) lr on true
where j.active and lr.status <> 'succeeded'
order by lr.start_time;

\echo ''
\echo '================ [F] GUC / RÔLES / VAULT ================'

select 'F1 dual_write flag' as check,
       current_setting('app.norva_catalog_dual_write', true) as value;  -- attendu '0'

select 'F2 GUC par rôle' as check, r.rolname, s.setconfig
from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
order by r.rolname;
-- attendu : anon statement_timeout=3s ; authenticated statement_timeout=8s

select 'F3 vault (3 secrets, tous déchiffrables)' as check,
       name, (decrypted_secret is not null and decrypted_secret <> '') as decryptable
from vault.decrypted_secrets order by name;
-- attendus : norva_backfill_token, norva_cron_shared_secret, resend_api_key

\echo ''
\echo '================ [G] TABLES PRODUIT lues par le CRM ================'

select 'G1 échelle catalogue' as check,
  (select count(*) from cloud_sources)                as sources,
  (select max(last_synced_at) from cloud_sources)     as last_sync,
  (select count(*) from cloud_media_items)            as media_items,
  (select count(*) from cloud_titles)                 as titles,
  (select count(*) from cloud_title_variants)         as variants;

select 'G2 activité users' as check,
  (select max(updated_at) from cloud_watch_history)   as last_watch,
  (select count(*) from cloud_playback_events
     where created_at > now() - interval '30 days')   as playback_events_30d,
  (select count(*) from auth.refresh_tokens)          as refresh_tokens,
  (select max(created_at) from auth.refresh_tokens)   as last_login_token;
-- refresh_tokens vide/figé = le chart « Connexions » du CRM substitue silencieusement
-- les données de visionnage (faux chiffres de login)

select 'G3 identités providers' as check,
  (select count(*) from provider_identities)          as provider_identities,
  (select count(*) from catalog_provider_identities)  as catalog_identities;

select 'G4 sous-titres générés' as check, status, count(*) as n
from catalog_generated_subtitles group by status order by n desc;

select 'G5 runtime config' as check, key from cloud_runtime_config order by key;
-- attendus (ou en env edge) : NORVA_MEDIA_GATEWAY_URL, NORVA_RELAY_BASE_URL

select 'G6 comptes admin' as check, count(*) as admins,
       (count(*) > 0) as pass
from auth.users
where raw_app_meta_data ->> 'role' = 'admin' and email is not null and banned_until is null;
-- 0 = lockout total du CRM + zéro destinataire d alertes

select 'G7 support' as check,
  (select count(*) from cloud_support_tickets)          as tickets,
  (select count(*) from cloud_support_messages)         as messages,
  (select max(last_message_at) from cloud_support_tickets) as last_message,
  (select count(*) from cloud_support_tickets where status = 'open') as open;

\echo ''
\echo '================ [H] SMOKE COMPLÉMENTAIRE (hors SQL — à lancer ensuite) ================'
\echo '-- 1. curl -s $FUNCTIONS_BASE_URL/norva-admin/health -X POST -H "Authorization: Bearer <JWT admin>"'
\echo '--    → edge/db/gateway/relay/billing.revolut/billing.resend tous ok:true, revolut_mode attendu'
\echo '-- 2. Ouvrir le CRM (nouvel onglet !) : Cockpit frais, Finance avec paiements provider=revolut,'
\echo '--    Moteur = liste des crons, Télémétrie non vide.'
\echo '================ FIN HEALTHCHECK ================'
