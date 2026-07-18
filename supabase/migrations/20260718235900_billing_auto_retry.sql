-- Relances automatiques de prélèvement — anti-churn involontaire (2026-07-18).
--
-- Constat industrie : ~2/3 des échecs de carte sont transitoires (plafond
-- atteint, solde insuffisant en fin de mois) et passent en re-tentant quelques
-- jours plus tard. Jusqu'ici, le rail web ne re-tentait JAMAIS la même carte :
-- la récupération reposait à 100 % sur l'action du client (mise à jour de
-- carte). Le cron norva-revolut-billing re-tente désormais automatiquement à
-- J+3 puis J+5 après l'échéance — avant l'expiration du dunning (~J+10) :
--   • succès → réactivation immédiate, période ancrée sur l'échéance d'origine
--     (le client ne paie jamais deux fois le même temps), Telegram « récupéré » ;
--   • échec → on reste en past_due SANS ré-étendre la fenêtre de grâce de 72 h
--     (l'accès ne doit pas se rouvrir à chaque tentative).
-- L'essai est consommé AVANT le débit (un crash du cron ne rejoue jamais une
-- tentative) et la référence d'ordre est suffixée (-t1/-t2) — jamais de
-- collision avec l'ordre de l'échec initial.
--
-- Idempotent. supabase_admin. ⚠ NOTIFY pgrst requis (nouvelle colonne lue via
-- PostgREST par le cron).

alter table public.cloud_entitlement_projection
  add column if not exists billing_retry_count int not null default 0;
comment on column public.cloud_entitlement_projection.billing_retry_count is
  'Relances automatiques de prélèvement déjà tentées sur l''échéance en cours (0..2 : J+3 et J+5 après current_period_end). Remis à 0 à chaque encaissement réussi.';
