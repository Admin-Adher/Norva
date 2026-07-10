-- Verrou « compte provider occupé » (incident Live TV 458 du 2026-07-10, voir
-- docs/LIVE-TV-458-SLOT-CONTENTION.md §5.4). Les sondes autonomes (audio-backfill)
-- ne doivent JAMAIS toucher un compte provider pendant qu'un humain le regarde :
-- max_connections est par COMPTE (host+username — la clé que la gateway appelle
-- proxyKeyFromUrl), et le garde-fou existant userHasLiveSession est scoppé par
-- user_id + devient aveugle ~4 min après le début d'un visionnage réel.
--
-- Cette table est le signal partagé « ce compte est en cours d'utilisation » :
--   ÉCRIVAINS : la media-gateway (rapporteur ~60 s : sessions transcode, raw
--   pumps, extractions ffmpeg) via POST norva-playback/account-activity, et les
--   edge functions (création de session, événements de lecture, sauvegarde de
--   progression) via les RPCs ci-dessous.
--   LECTEUR : le chemin de sonde audio-backfill (norva-playback) — il saute tout
--   titre dont le compte a un signal frais, sans le stamper (retry au tick
--   suivant). Fail-open : aucun signal => sonde autorisée (comportement actuel).
--
-- Clé canonique : URL.host (port inclus s'il est non-défaut, déjà minuscule via
-- le parseur d'URL) + '/' + username (sensible à la casse). Identique des trois
-- côtés : proxyKeyFromUrl (gateway), providerAccountKeyFromUrl (edge, depuis
-- l'URL de flux /movie|series|live/USER/PASS/...), et config_hint (serverHost
-- écrit par safeHost = new URL(serverUrl).host + username) pour le chemin RPC
-- par source.

create table if not exists public.provider_account_activity (
  account_key  text primary key,
  last_seen_at timestamptz not null default now(),
  kind         text
);

alter table public.provider_account_activity enable row level security;
-- Pas de policy : seuls les helpers SECURITY DEFINER ci-dessous (et service_role,
-- qui bypasse la RLS) y touchent.

-- Marquer un lot de comptes comme actifs (rapporteur gateway + création de session).
create or replace function public.provider_account_touch_many(p_keys text[], p_kind text)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  insert into public.provider_account_activity(account_key, last_seen_at, kind)
  select distinct k, now(), left(coalesce(p_kind, ''), 32)
  from unnest(coalesce(p_keys, '{}')) as k
  where k is not null and k <> '' and length(k) <= 300
  on conflict (account_key) do update
    set last_seen_at = now(), kind = excluded.kind;
$function$;

-- Marquer le compte d'une source comme actif (événements de lecture, progression
-- de visionnage — les chemins qui portent un source_id mais pas d'URL provider).
-- Ne fait rien (fail-open) si la source n'a pas de hint xtream exploitable (M3U…).
create or replace function public.provider_account_touch_by_source(p_source_id uuid, p_kind text)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  insert into public.provider_account_activity(account_key, last_seen_at, kind)
  select lower(s.config_hint->>'serverHost') || '/' || (s.config_hint->>'username'),
         now(), left(coalesce(p_kind, ''), 32)
  from public.cloud_sources s
  where s.id = p_source_id
    and coalesce(s.config_hint->>'serverHost', '') <> ''
    and coalesce(s.config_hint->>'username', '') <> ''
  on conflict (account_key) do update
    set last_seen_at = now(), kind = excluded.kind;
$function$;

-- Le compte est-il occupé ? Fenêtre 5 min = garde 4 min existante (heartbeat de
-- progression toutes les 10 s côté web) + traîne de libération du slot (~8 s) +
-- marge rapporteur (60 s). Pas de ligne => libre.
create or replace function public.provider_account_busy(p_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    (select a.last_seen_at > now() - interval '5 minutes'
     from public.provider_account_activity a
     where a.account_key = p_key),
    false);
$function$;

revoke all on function public.provider_account_touch_many(text[], text) from public, anon, authenticated;
revoke all on function public.provider_account_touch_by_source(uuid, text) from public, anon, authenticated;
revoke all on function public.provider_account_busy(text) from public, anon, authenticated;
grant execute on function public.provider_account_touch_many(text[], text) to service_role;
grant execute on function public.provider_account_touch_by_source(uuid, text) to service_role;
grant execute on function public.provider_account_busy(text) to service_role;
