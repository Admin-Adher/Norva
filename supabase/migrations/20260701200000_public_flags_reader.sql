-- Wire feature flags to real consumers.
-- (1) enrichment_paused → enforced in norva-playback/audio-backfill (edge; no DB change here).
-- (2) maintenance_banner → the app must read it while logged-out too, so expose ONLY a whitelisted
--     subset via a dedicated anon-callable reader. Lock down the generic public.feature_flag(key) so
--     clients can't probe arbitrary flag states (server code / SECURITY DEFINER callers are unaffected;
--     the service role bypasses grants).
revoke all on function public.feature_flag(text) from public, anon, authenticated;

create or replace function public.app_public_flags()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('maintenance_banner', public.feature_flag('maintenance_banner'));
$$;
revoke all on function public.app_public_flags() from public;
grant execute on function public.app_public_flags() to anon, authenticated;

comment on function public.app_public_flags is
  'Anon-safe reader exposing ONLY the client-facing feature flags (whitelist). Add a key here to let '
  'the app read a new public flag; the generic feature_flag(key) stays server-side only.';

-- Reflect that these two seed flags are now wired to real consumers (edge kill switch / app banner).
update public.admin_feature_flags set description = 'Coupe TOUT l''enrichissement au prochain tick (câblé — kill switch provider)' where key = 'enrichment_paused';
update public.admin_feature_flags set description = 'Affiche une bannière de maintenance en bas de l''app pour tous (câblé)' where key = 'maintenance_banner';
