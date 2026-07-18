-- Presence gate (incident VOD mobile 2026-07-18, docs/LIVE-TV-458-SLOT-CONTENTION.md §9).
-- Les écrivains du verrou « compte occupé » (session/événement/historique/rapporteur
-- gateway) ne s'activent qu'une fois un flux existant : la PREMIÈRE tentative de
-- lecture d'un spectateur n'est donc pas protégée — une sonde qui démarre pendant
-- qu'il navigue prend le slot unique du compte provider et le lancement entre en
-- collision (458 → 1-3 min de retries web, ou erreur terminale sur l'app mobile).
-- Ce RPC permet à l'edge de marquer TOUS les comptes provider d'un utilisateur
-- comme actifs dès l'ouverture de l'app/du site (« presence »), avant tout play.
-- Même dérivation de clé que provider_account_touch_by_source (lower(serverHost)
-- + '/' + username brut du config_hint) ; fail-open : une source sans hint xtream
-- exploitable (M3U…) est simplement ignorée.
create or replace function public.provider_account_touch_by_user(p_user uuid, p_kind text)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  insert into public.provider_account_activity(account_key, last_seen_at, kind)
  select distinct lower(s.config_hint->>'serverHost') || '/' || (s.config_hint->>'username'),
         now(), left(coalesce(p_kind, ''), 32)
  from public.cloud_sources s
  where s.user_id = p_user
    and s.deleted_at is null
    and coalesce(s.config_hint->>'serverHost', '') <> ''
    and coalesce(s.config_hint->>'username', '') <> ''
  on conflict (account_key) do update
    set last_seen_at = now(), kind = excluded.kind;
$function$;

revoke all on function public.provider_account_touch_by_user(uuid, text) from public, anon, authenticated;
grant execute on function public.provider_account_touch_by_user(uuid, text) to service_role;
