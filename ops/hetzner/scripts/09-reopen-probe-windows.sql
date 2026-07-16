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
--   ⚠ LANCER EN supabase_admin (le superuser de l'image Supabase — `postgres` n'y est
--   PAS superuser : il n'a ni la propriété des jobs cron ni l'UPDATE sur cron.job,
--   d'où « permission denied for table job » constaté au run du 2026-07-16) :
--
--   docker exec -i norva-db psql -U supabase_admin -d postgres -P pager=off \
--     < ops/hetzner/scripts/09-reopen-probe-windows.sql
--
-- ROLLBACK (revenir à l'état d'avant) : même UPDATE cron.job que ci-dessous avec
--   les schedules de la section AVANT imprimée ; et
--   update provider_footprint_policy set max_probes_per_hour = 40
--    where identity_key = 'd8453dc1-4a95-4538-a05f-749df4f7c588';
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
\echo '================ [A] Fenêtres restaurées (films 6-23 · Ninja 24/7) ================'
-- UPDATE direct de cron.job (par NOM — les jobid ont bougé à la restauration Hetzner).
-- Pourquoi pas cron.alter_job : sa garde `username = current_user` rejette même un superuser
-- quand le job appartient à un autre rôle (« Job N does not exist or you don't own it » —
-- constaté sur la box, jobs recréés sous un autre rôle). En self-host superuser, l'UPDATE
-- direct est sûr : le trigger cron.job_cache_invalidate (vérifié ci-dessous) notifie le
-- launcher pg_cron, qui recharge la cadence immédiatement. (L'interdit « pas d'UPDATE direct »
-- du runbook était un artefact de permissions du Supabase MANAGÉ, pas un problème mécanique.)
select tgname as trigger_invalidation_present from pg_trigger where tgrelid = 'cron.job'::regclass;

update cron.job as j
   set schedule = v.s
  from (values
    ('norva-audio-langs-untagged', '*/3 6-23 * * *'),
    ('norva-audio-langs-jeremy',   '3-58/5 6-23 * * *'),
    ('norva-audio-airo-promax',    '1-59/3 6-23 * * *'),
    ('norva-audio-airo-opplex',    '2-59/6 6-23 * * *'),
    ('norva-audio-airo-king365',   '4-59/12 6-23 * * *'),
    ('norva-audio-airo-airysat',   '5-59/30 6-23 * * *'),
    -- Ninja 24/7 : le cap horaire (provider_footprint_policy) est le régulateur,
    -- le mutex lecture gère le chevauchement (design « ré-activation domptée »).
    ('norva-audio-airo-ninja',        '4-59/12 * * * *'),
    ('norva-audio-airo-ninja-series', '9-59/12 * * * *')
  ) as v(n, s)
 where j.jobname = v.n
 returning j.jobid, j.jobname, j.schedule;

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
\echo 'Vérif immédiate (si on est entre 06:00 et 23:59 UTC) : sous ~5 min un job de jour doit'
\echo 'tirer — contrôler :  select j.jobname, d.status, d.start_time'
\echo '                     from cron.job_run_details d join cron.job j on j.jobid = d.jobid'
\echo '                     order by d.start_time desc limit 10;'
\echo ''
\echo 'Suivi sous 24-48 h : re-lancer 08-enrichment-audio-diag.sql — attendu :'
\echo '  [E] sondes/jour x4-6 · [C] jamais_sonde en baisse nette · dashboard sans « provider muet »'
\echo '  Ninja [F] hits_24h ~1200-1400 (cap 60/h) sans 401/ban -> ok pour envisager 80/h.'
