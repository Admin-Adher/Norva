-- =============================================================================
-- 09-reopen-probe-windows.sql — Leviers A + C : ré-élargir les fenêtres de
-- sondage films-audio + monter le cap anti-ban Ninja 40→60/h
-- =============================================================================
-- CONTEXTE (diag 08-enrichment-audio-diag.sql du 2026-07-16) : après l'incident
-- 458 du 10/07, les crons films-audio ont été resserrés en fenêtre nuit 1-4 UTC
-- (mesure d'URGENCE). Les protections DURABLES sont depuis déployées et actives :
--   • verrou « compte occupé » (provider_account_busy, tick-level + par-titre),
--   • crawl-yield mi-tick (NORVA_CRAWL_YIELD_TO_VIEWERS=ON),
--   • circuit breakers par identité provider,
--   • plafond horaire low_footprint (Ninja).
-- → une sonde diurne qui croise un viewer SKIPPE sans le gêner. La fenêtre 1-4
-- est devenue le goulot n°1 : ~3-5k sondes/jour au lieu de ~15-20k, pendant que
-- l'intake tourne à ~25k titres/j → la couverture RECULE.
--
-- CE SCRIPT (runtime, PAS une migration — comme toute la flotte pg_cron) :
--   [A] restaure la fenêtre jour 6-23 UTC des crons films-audio (design
--       d'origine, ENRICHMENT_CRON_SETUP.md) ; Ninja passe en 24/7 — son vrai
--       régulateur est le plafond horaire, pas la fenêtre (design « ré-activation
--       domptée » : le mutex lecture gère le chevauchement).
--   [C] monte le cap Ninja 40 → 60 probes/h. OBSERVER 48 h (cartes « provider
--       muet » / échecs / gateway 401 barfik) avant d'envisager 80/h.
--   Les dimensions de nuit (séries/sous-titres/whisper, 0-5) sont INCHANGÉES.
--
-- PRÉALABLE RECOMMANDÉ (couverture totale du verrou, non bloquant — fail-open) :
--   poser NORVA_EDGE_CALLBACK_BASE=https://api.norva.tv/functions/v1/norva-playback
--   dans .env.media de la machine gateway, puis :
--   docker compose --env-file .env.media -f docker-compose.media.yml up -d
--
--   docker exec -i norva-db psql -U postgres -d postgres -P pager=off \
--     < ops/hetzner/scripts/09-reopen-probe-windows.sql
--
-- ROLLBACK (revenir à l'état d'avant) :
--   select cron.alter_job(jobid, schedule => '1-4-window-d-origine') … (cf. AVANT
--   imprimé ci-dessous) ; update provider_footprint_policy set
--   max_probes_per_hour = 40 where identity_key = 'd8453dc1-…';
-- =============================================================================
\pset pager off

\echo ''
\echo '================ AVANT — fenêtres actuelles ================'
select jobid, jobname, schedule, active from cron.job
where jobname in ('norva-audio-langs-untagged','norva-audio-langs-jeremy',
                  'norva-audio-airo-promax','norva-audio-airo-opplex',
                  'norva-audio-airo-king365','norva-audio-airo-airysat',
                  'norva-audio-airo-ninja','norva-audio-airo-ninja-series')
order by jobname;
select identity_key, mode, max_probes_per_hour from provider_footprint_policy;

\echo ''
\echo '================ [A] Fenêtre jour 6-23 restaurée (films audio) ================'
-- alter par NOM (les jobid ont bougé à la restauration Hetzner) ; 0 ligne = job absent (sain).
select cron.alter_job(jobid, schedule => '*/3 6-23 * * *')    from cron.job where jobname = 'norva-audio-langs-untagged';
select cron.alter_job(jobid, schedule => '3-58/5 6-23 * * *') from cron.job where jobname = 'norva-audio-langs-jeremy';
select cron.alter_job(jobid, schedule => '1-59/3 6-23 * * *') from cron.job where jobname = 'norva-audio-airo-promax';
select cron.alter_job(jobid, schedule => '2-59/6 6-23 * * *') from cron.job where jobname = 'norva-audio-airo-opplex';
select cron.alter_job(jobid, schedule => '4-59/12 6-23 * * *') from cron.job where jobname = 'norva-audio-airo-king365';
select cron.alter_job(jobid, schedule => '5-59/30 6-23 * * *') from cron.job where jobname = 'norva-audio-airo-airysat';

\echo ''
\echo '================ [A] Ninja 24/7 (le cap horaire est le régulateur) ================'
select cron.alter_job(jobid, schedule => '4-59/12 * * * *') from cron.job where jobname = 'norva-audio-airo-ninja';
select cron.alter_job(jobid, schedule => '9-59/12 * * * *') from cron.job where jobname = 'norva-audio-airo-ninja-series';

\echo ''
\echo '================ [C] Cap Ninja 40 -> 60 probes/h ================'
update provider_footprint_policy
   set max_probes_per_hour = 60,
       notes = 'Ninja/barfik — ancien compte banni. Probes via gateway résidentielle. Cap 60/h depuis 2026-07-16 (40/h à l''origine) — observer 48 h avant d''envisager 80/h.',
       updated_at = now()
 where identity_key = 'd8453dc1-4a95-4538-a05f-749df4f7c588'
 returning identity_key, max_probes_per_hour;

\echo ''
\echo '================ APRÈS — vérification ================'
select jobid, jobname, schedule, active from cron.job
where jobname in ('norva-audio-langs-untagged','norva-audio-langs-jeremy',
                  'norva-audio-airo-promax','norva-audio-airo-opplex',
                  'norva-audio-airo-king365','norva-audio-airo-airysat',
                  'norva-audio-airo-ninja','norva-audio-airo-ninja-series')
order by jobname;
select identity_key, mode, max_probes_per_hour from provider_footprint_policy;

\echo ''
\echo 'Suivi sous 24-48 h : re-lancer 08-enrichment-audio-diag.sql — attendu :'
\echo '  [E] sondes/jour x4-6 · [C] jamais_sonde en baisse nette · dashboard sans « provider muet »'
\echo '  Ninja [F] hits_24h ~1200-1400 (cap 60/h) sans 401/ban -> ok pour envisager 80/h.'
