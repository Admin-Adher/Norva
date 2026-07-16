-- =============================================================================
-- 08-enrichment-audio-diag.sql — diagnostic « couverture audio 38 % » du Moteur
-- =============================================================================
-- Répond à : POURQUOI la couverture audio plafonne — où vivent les titres non
-- résolus (jamais sondés vs sondés-sans-langue), quel cron est KO, à quel débit
-- réel chaque panel sonde, et si le plafond anti-ban (Ninja 40/h) est le goulot.
-- 100 % READ-ONLY — exécutable à tout moment.
--
--   docker exec -i norva-db psql -U postgres -d postgres -P pager=off \
--     < ops/hetzner/scripts/08-enrichment-audio-diag.sql
--
-- IMPORTANT : lancer SANS -v ON_ERROR_STOP=1 — une table/colonne manquante doit
-- s'afficher comme une ligne ERROR (c'est un finding !) sans stopper le reste.
-- =============================================================================
\pset pager off
set statement_timeout = '300s';

\echo ''
\echo '================ [A] CRON(S) KO sur 24 h (la carte "1 crons KO") ================'
select j.jobid, j.jobname, count(*) as echecs_24h,
       to_char(max(d.start_time), 'MM-DD HH24:MI') as dernier_echec,
       left((select d2.return_message from cron.job_run_details d2
              where d2.jobid = j.jobid and d2.status = 'failed'
              order by d2.start_time desc limit 1), 160) as derniere_erreur
from cron.job_run_details d join cron.job j on j.jobid = d.jobid
where d.status = 'failed' and d.start_time > now() - interval '24 hours'
group by j.jobid, j.jobname order by echecs_24h desc;

\echo ''
\echo '================ [B] ÂGE DU SNAPSHOT (le 38 % affiché date de là) ================'
select refreshed_at, now() - refreshed_at as age from admin_dashboard_cache where id = 1;

\echo ''
\echo '================ [C] COUVERTURE LIVE PAR PANEL — les 3 buckets ================'
\echo '-- resolus = audio_languages non vide · jamais_sonde = jamais tenté ·'
\echo '-- sonde_sans_langue = sonde aboutie mais 0 langue (flux mort / conteneur non tagué / série vide)'
select coalesce(pi.display_name, s.display_name, left(s.id::text, 8)) as panel,
       ct.item_type as type,
       count(*) as total,
       count(*) filter (where ct.audio_languages <> '{}') as resolus,
       round(100.0 * count(*) filter (where ct.audio_languages <> '{}') / nullif(count(*), 0), 1) as pct,
       count(*) filter (where ct.audio_probed_at is null and ct.audio_languages = '{}') as jamais_sonde,
       count(*) filter (where ct.audio_probed_at is not null and ct.audio_languages = '{}') as sonde_sans_langue,
       count(*) filter (where ct.audio_probed_at > now() - interval '24 hours') as sondes_24h
from cloud_titles ct
join cloud_title_variants v on v.id = ct.default_variant_id
join cloud_sources s on s.id = v.source_id
left join catalog_provider_identities cpi on cpi.provider_key = s.config_hint->>'providerKey'
left join provider_identities pi on pi.id = cpi.identity_id
where ct.variant_count > 0
  and ct.user_id in (select user_id from public.admin_enrichment_accounts)
group by 1, 2
order by total desc;

\echo ''
\echo '================ [D] SONDÉ-SANS-LANGUE : récupérable (whisper) vs vide ================'
\echo '-- pistes_presentes = le header a des pistes audio sans tag -> récupérable par whisper LID'
\echo '-- aucune_piste = rien d''exploitable (flux mort, série sans épisode) -> perte structurelle'
select ct.item_type as type,
       count(*) as sonde_sans_langue,
       count(*) filter (where jsonb_typeof(ct.audio_tracks) = 'array'
                          and jsonb_array_length(ct.audio_tracks) > 0) as pistes_presentes_whisperables,
       count(*) filter (where ct.audio_tracks is null
                          or jsonb_typeof(ct.audio_tracks) <> 'array'
                          or jsonb_array_length(ct.audio_tracks) = 0) as aucune_piste,
       count(*) filter (where ct.whisper_attempted_at is not null) as whisper_deja_tente
from cloud_titles ct
where ct.variant_count > 0
  and ct.user_id in (select user_id from public.admin_enrichment_accounts)
  and ct.audio_probed_at is not null and ct.audio_languages = '{}'
group by 1;

\echo ''
\echo '================ [E] DÉBIT RÉEL — sondes & résolutions par jour (7 j) ================'
select to_char(date_trunc('day', ct.audio_probed_at), 'MM-DD') as jour,
       count(*) as sondes,
       count(*) filter (where ct.audio_languages <> '{}') as resolues
from cloud_titles ct
where ct.audio_probed_at > now() - interval '7 days'
  and ct.user_id in (select user_id from public.admin_enrichment_accounts)
group by 1 order by 1;

\echo ''
\echo '================ [F] PLAFOND ANTI-BAN (Ninja 40/h) — consommation réelle ================'
select p.identity_key, p.mode, p.max_probes_per_hour as cap_h,
       (select count(*) from provider_probe_hits h
         where h.identity_key = p.identity_key and h.occurred_at > now() - interval '1 hour') as hits_1h,
       (select count(*) from provider_probe_hits h
         where h.identity_key = p.identity_key and h.occurred_at > now() - interval '24 hours') as hits_24h,
       p.notes
from provider_footprint_policy p;

\echo ''
\echo '================ [G] CIRCUIT BREAKERS (providers en refus -> sonde en pause) ================'
select identity_key, fail_ticks, open_count, open_until,
       (open_until is not null and open_until > now()) as ouvert_maintenant,
       last_failure_at, last_success_at
from provider_probe_circuit
order by coalesce(open_until, last_failure_at) desc nulls last;

\echo ''
\echo '================ [H] MARQUES "EXHAUSTED" ACTIVES (dimensions court-circuitées) ================'
select k, exhausted_until from enrichment_exhausted
where exhausted_until > now() order by 1;

\echo ''
\echo '================ [I] FLOTTE AUDIO/ST/WHISPER — les crons tournent-ils ? ================'
select j.jobid, j.jobname, j.schedule, j.active,
       to_char((select max(d.start_time) from cron.job_run_details d where d.jobid = j.jobid), 'MM-DD HH24:MI') as dernier_run,
       (select count(*) from cron.job_run_details d
         where d.jobid = j.jobid and d.start_time > now() - interval '24 hours') as runs_24h,
       (select count(*) from cron.job_run_details d
         where d.jobid = j.jobid and d.status = 'failed' and d.start_time > now() - interval '24 hours') as echecs_24h
from cron.job j
where j.jobname ~ 'audio|subtitle|whisper|langs|pregen'
order by j.jobname;

\echo ''
\echo '================ [J] COURSE INTAKE vs DRAIN (7 j) ================'
\echo '-- si nouveaux_7j > resolus_7j, la couverture RECULE mécaniquement même si tout marche'
select count(*) filter (where ct.created_at > now() - interval '7 days') as nouveaux_titres_7j,
       count(*) filter (where ct.audio_probed_at > now() - interval '7 days'
                          and ct.audio_languages <> '{}') as resolus_7j
from cloud_titles ct
where ct.variant_count > 0
  and ct.user_id in (select user_id from public.admin_enrichment_accounts);

\echo ''
\echo '================ FIN — coller la sortie complète pour analyse ================'
