-- 13-provider-presence-gate-audit.sql — audit du garde « presence → compte provider occupé ».
-- But : vérifier sur la box self-hosted que l'ouverture de l'app / du compte utilisateur
-- marque bien les comptes provider comme occupés, et que les crons/sondes qui consomment un
-- slot provider doivent donc se mettre en pause (skipped=account-busy) avant la 1re lecture.
--
-- IMPORTANT : ne colle pas le contenu de ce fichier dans bash. Exécute-le via dpsql.
-- Usage recommandé (sur la box self-hosted, depuis le repo Norva à jour) :
--   ./ops/hetzner/scripts/13-provider-presence-gate-audit.sh <uuid utilisateur pilote>
-- Usage direct équivalent :
--   dpsql -v USER_ID="<uuid utilisateur pilote>" -f ops/hetzner/scripts/13-provider-presence-gate-audit.sql
--
-- Interprétation rapide :
--   1) Ouvrir l'app/le site avec le compte pilote.
--   2) Relancer ce script dans les 60 secondes.
--   3) Les lignes [C] doivent afficher busy=true et age_seconds faible (< 300).
--      Si [C] est vide, le compte n'a pas de source Xtream exploitable (serverHost+username)
--      ou le touch presence n'est pas arrivé.
--   4) [D] liste les crons qui touchent des slots provider : ils restent actifs dans pg_cron,
--      mais leurs runners doivent skipper au runtime quand provider_account_busy(...) = true.
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
       s.name,
       lower(s.config_hint->>'serverHost') || '/' || (s.config_hint->>'username') as account_key,
       s.enabled,
       s.deleted_at is not null as deleted
from public.cloud_sources s
where s.user_id = :'USER_ID'::uuid
  and s.deleted_at is null
  and coalesce(s.config_hint->>'serverHost', '') <> ''
  and coalesce(s.config_hint->>'username', '') <> ''
order by s.created_at desc;

\echo '================ [C] Etat presence/busy après ouverture app/site ================'
with keys as (
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
       round(extract(epoch from (now() - a.last_seen_at)))::int as age_seconds,
       public.provider_account_busy(k.account_key) as busy
from keys k
left join public.provider_account_activity a on a.account_key = k.account_key
order by a.last_seen_at desc nulls last, k.account_key;

\echo '================ [D] Crons/sondes provider-slot à surveiller ================'
select j.jobid,
       j.jobname,
       j.schedule,
       j.active,
       left(regexp_replace(j.command, '\\s+', ' ', 'g'), 180) as command_preview
from cron.job j
where j.jobname ilike any (array[
  '%audio%', '%probe%', '%subtitle%', '%whisper%', '%vod%', '%reprobe%'
])
   or j.command ilike any (array[
  '%audio-backfill%', '%audio-langs%', '%provider_account_busy%', '%pregen-gate%'
])
order by j.jobname;

\echo '================ [E] Derniers runs account-busy / skipped (24 h) ================'
select j.jobname,
       d.start_time,
       d.status,
       left(coalesce(d.return_message, ''), 260) as return_message
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where d.start_time > now() - interval '24 hours'
  and (coalesce(d.return_message, '') ilike '%account-busy%'
       or coalesce(d.return_message, '') ilike '%skipped%busy%'
       or coalesce(d.return_message, '') ilike '%live-session%')
order by d.start_time desc
limit 50;
