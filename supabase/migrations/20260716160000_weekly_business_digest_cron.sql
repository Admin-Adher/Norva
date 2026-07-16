-- =============================================================================
-- Digest business hebdomadaire sur Telegram (lundi 07:00 UTC).
-- =============================================================================
-- Un résumé proactif pour le fondateur : croissance, revenu, support — envoyé par
-- `norva-admin/weekly-digest` (lit le cache admin, envoie via sendTelegram).
--
-- ⚠️ Self-hosting : les migrations d'origine hardcodaient l'URL managée
-- `*.supabase.co`, mais le script de bascule a réécrit TOUS les crons vers l'URL de
-- la box (`FUNCTIONS_BASE_URL`). Plutôt que de re-hardcoder une URL (qui serait
-- fausse sur la box), on CLONE la commande du cron `norva-ops-alert` déjà en place
-- (donc déjà pointée sur la bonne URL + le bon token) et on swap juste le chemin.
-- =============================================================================

do $$
declare v_cmd text;
begin
  if exists (select 1 from cron.job where jobname = 'norva-weekly-digest') then
    raise notice 'norva-weekly-digest déjà planifié — rien à faire';
    return;
  end if;
  select command into v_cmd from cron.job where jobname = 'norva-ops-alert' limit 1;
  if v_cmd is null then
    raise notice 'cron norva-ops-alert introuvable — digest NON planifié (créer manuellement une fois l URL box connue)';
    return;
  end if;
  -- Réutilise l'URL + l'auth (backfill token) du sweep ops, ne change que la route.
  v_cmd := replace(v_cmd, '/norva-admin/ops-alert', '/norva-admin/weekly-digest');
  perform cron.schedule('norva-weekly-digest', '0 7 * * 1', v_cmd);  -- lundi 07:00 UTC
  raise notice 'norva-weekly-digest planifié (lundi 07:00 UTC) sur % ', left(v_cmd, 80);
end $$;
