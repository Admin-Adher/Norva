-- 14-provider-presence-gate-audit-v2.sql — audit du garde « presence → compte provider occupé ».
--
-- NE PAS coller ce fichier dans bash : exécute-le via le wrapper après merge/checkout de la PR :
--   ./ops/hetzner/scripts/14-provider-presence-gate-audit-v2.sh <uuid utilisateur pilote>
--
-- Si la box répond "No such file or directory" après git pull, tu es encore sur main sans
-- cette PR : utilise temporairement la commande docker directe donnée dans la conversation.
--
-- Pour tester la version de PR sans merge via `git show origin/<branche>:...`, lance d'abord
-- `git fetch origin <branche>` afin de ne pas relire une ancienne copie de la branche distante.
--
-- Depuis ~/norva/ops/hetzner :
--   ./scripts/14-provider-presence-gate-audit-v2.sh <uuid utilisateur pilote>
--
-- But : vérifier sur la box self-hosted que l'ouverture de l'app / du compte utilisateur
-- marque bien les comptes provider comme occupés, et que les crons/sondes qui consomment un
-- slot provider doivent donc se mettre en pause (skipped=account-busy) avant la 1re lecture.
--
-- Interprétation rapide :
--   1) Ouvrir l'app/le site avec le compte pilote.
--   2) Relancer ce script dans les 60 secondes.
--   3) Les lignes [C] doivent afficher busy=true, age_seconds faible (< 300), verdict=OK_BUSY_FRESH.
--      Si [C] est vide, le compte n'a pas de source Xtream exploitable (serverHost+username)
--      ou le touch presence n'est pas arrivé.
--   4) [D] liste les crons du pilote qui touchent des slots provider : ils restent actifs
--      dans pg_cron, mais leurs runners doivent skipper au runtime quand
--      provider_account_busy(...) = true. [E] montre seulement l'enqueue pg_net ("1 row"),
--      [G] lit les réponses HTTP pg_net qui contiennent le vrai JSON du runner.
--      Si ta sortie s’arrête à [F], tu exécutes une ancienne version du fichier : refetch la branche.
--
-- Note : on ne désactive pas cron.job.active ici. Le design Norva est une pause runtime par
-- compte provider, pas un arrêt global des jobs : les autres providers/utilisateurs continuent.

\set ON_ERROR_STOP on

\echo '================ [A] RPCs du verrou provider présents ================'
select n.nspname as schema,
       p.proname as function,
       pg_get_function_arguments(p.oid) as args,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('provider_account_touch_by_user', 'provider_account_touch_by_source', 'provider_account_touch_many', 'provider_account_busy')
order by p.proname;

\echo '================ [B] Sources Xtream du pilote qui peuvent produire une clé provider ================'
select s.id as source_id,
       s.display_name,
       s.source_type,
       s.enabled,
       s.deleted_at,
       s.config_hint->>'serverHost' as server_host,
       s.config_hint->>'username' as provider_username,
       lower(s.config_hint->>'serverHost') || '/' || (s.config_hint->>'username') as account_key
from public.cloud_sources s
where s.user_id = :'USER_ID'::uuid
  and s.deleted_at is null
  and coalesce(s.config_hint->>'serverHost', '') <> ''
  and coalesce(s.config_hint->>'username', '') <> ''
order by s.created_at desc;

\echo '================ [C] Etat presence/busy après ouverture app/site ================'
with provider_keys as (
  select distinct lower(s.config_hint->>'serverHost') || '/' || (s.config_hint->>'username') as account_key
  from public.cloud_sources s
  where s.user_id = :'USER_ID'::uuid
    and s.deleted_at is null
    and coalesce(s.config_hint->>'serverHost', '') <> ''
    and coalesce(s.config_hint->>'username', '') <> ''
)
select k.account_key,
       a.kind,
       a.last_seen_at,
       case when a.last_seen_at is null then null else round(extract(epoch from now() - a.last_seen_at))::int end as age_seconds,
       public.provider_account_busy(k.account_key) as busy,
       case
         when a.last_seen_at is null then 'NO_ACTIVITY_ROW'
         when public.provider_account_busy(k.account_key) then 'OK_BUSY_FRESH'
         when a.last_seen_at <= now() - interval '5 minutes' then 'STALE_NOT_BUSY_REOPEN_APP'
         else 'NOT_BUSY_UNEXPECTED'
       end as verdict
from provider_keys k
left join public.provider_account_activity a on a.account_key = k.account_key
order by busy desc, a.last_seen_at desc nulls last, k.account_key;

\echo '================ [D] Crons/sondes provider-slot du pilote à surveiller ================'
with pilot_sources as (
  select s.id::text as source_id
  from public.cloud_sources s
  where s.user_id = :'USER_ID'::uuid
), provider_slot_jobs as (
  select j.jobid,
         j.jobname,
         j.schedule,
         j.active,
         coalesce(j.command, '') as command,
         coalesce(j.command, '') ilike '%' || :'USER_ID' || '%' as pilot_user_match,
         exists (select 1 from pilot_sources ps where coalesce(j.command, '') ilike '%' || ps.source_id || '%') as pilot_source_match
  from cron.job j
  where coalesce(j.jobname, '') ilike any (array['%audio%', '%probe%', '%backfill%', '%enrich%', '%subtitle%', '%whisper%'])
     or coalesce(j.command, '') ilike any (array['%audio%', '%probe%', '%backfill%', '%enrich%', '%subtitle%', '%whisper%', '%provider_account_busy%'])
)
select jobid,
       jobname,
       schedule,
       active,
       pilot_user_match,
       pilot_source_match,
       regexp_replace(command, E'[\\n\\r\\t ]+', ' ', 'g') as command
from provider_slot_jobs
where pilot_user_match or pilot_source_match
order by jobname nulls last, jobid;

\echo '================ [E] Derniers runs des crons du pilote (24 h) ================'
with pilot_sources as (
  select s.id::text as source_id
  from public.cloud_sources s
  where s.user_id = :'USER_ID'::uuid
), pilot_jobs as (
  select j.jobid, j.jobname
  from cron.job j
  where coalesce(j.command, '') ilike '%' || :'USER_ID' || '%'
     or exists (select 1 from pilot_sources ps where coalesce(j.command, '') ilike '%' || ps.source_id || '%')
)
select d.start_time,
       d.status,
       pj.jobname,
       left(coalesce(d.return_message, ''), 500) as return_message
from cron.job_run_details d
join pilot_jobs pj on pj.jobid = d.jobid
where d.start_time >= now() - interval '24 hours'
order by d.start_time desc
limit 50;

\echo '================ [F] Derniers skips account-busy / live-session tous crons (24 h) ================'
select d.start_time,
       d.status,
       j.jobname,
       left(coalesce(d.return_message, ''), 500) as return_message
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where d.start_time >= now() - interval '24 hours'
  and (
    coalesce(d.return_message, '') ilike '%account-busy%'
    or coalesce(d.return_message, '') ilike '%skipped%'
    or coalesce(d.return_message, '') ilike '%live-session%'
  )
order by d.start_time desc
limit 50;

\echo '================ [G] Réponses HTTP pg_net avec skip/busy/viewer (24 h) ================'
select r.created,
       r.status_code,
       r.timed_out,
       left(coalesce(r.error_msg, ''), 300) as error_msg,
       left(coalesce(r.content, ''), 1200) as content
from net._http_response r
where r.created >= now() - interval '24 hours'
  and (
    coalesce(r.content, '') ilike '%account-busy%'
    or coalesce(r.content, '') ilike '%viewer-midtick%'
    or coalesce(r.content, '') ilike '%live-session%'
    or coalesce(r.content, '') ilike '%"skipped"%'
  )
order by r.created desc
limit 50;

\echo '================ [H] Dernières réponses HTTP pg_net norva-playback/audio-backfill (2 h) ================'
select r.created,
       r.status_code,
       r.timed_out,
       left(coalesce(r.error_msg, ''), 200) as error_msg,
       left(coalesce(r.content, ''), 500) as content
from net._http_response r
where r.created >= now() - interval '2 hours'
  and coalesce(r.content, '') <> ''
  and (
    coalesce(r.content, '') ilike '%audio-backfill%'
    or coalesce(r.content, '') ilike '%account-busy%'
    or coalesce(r.content, '') ilike '%processed%'
    or coalesce(r.content, '') ilike '%updated%'
  )
order by r.created desc
limit 50;
