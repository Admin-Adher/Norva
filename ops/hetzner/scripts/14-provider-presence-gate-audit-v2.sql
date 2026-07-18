-- 14-provider-presence-gate-audit-v2.sql — audit du garde « presence → compte provider occupé ».
--
-- NE PAS coller ce fichier dans bash : exécute-le via le wrapper :
--   ./ops/hetzner/scripts/14-provider-presence-gate-audit-v2.sh <uuid utilisateur pilote>
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
       public.provider_account_busy(k.account_key) as busy
from provider_keys k
left join public.provider_account_activity a on a.account_key = k.account_key
order by k.account_key;

\echo '================ [D] Crons/sondes provider-slot à surveiller ================'
select j.jobid,
       j.jobname,
       j.schedule,
       j.active,
       regexp_replace(j.command, E'[\\n\\r\\t ]+', ' ', 'g') as command
from cron.job j
where coalesce(j.jobname, '') ilike any (array['%audio%', '%probe%', '%backfill%', '%enrich%'])
   or coalesce(j.command, '') ilike any (array['%audio%', '%probe%', '%backfill%', '%enrich%', '%provider_account_busy%'])
order by j.jobname nulls last, j.jobid;

\echo '================ [E] Derniers runs account-busy / skipped / live-session (24 h) ================'
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
