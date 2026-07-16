-- =============================================================================
-- Renomme le ledger cross-rail : cloud_stancer_payments → cloud_billing_ledger.
-- =============================================================================
-- Le rail Stancer est retiré ; le nom `cloud_stancer_payments` est trompeur (la table
-- est le journal de paiements CROSS-RAIL, colonne `provider`). On la renomme, avec une
-- **vue de compat** `cloud_stancer_payments` pour ne rien casser côté lecteurs.
--
-- ⚠️ Une vue auto-updatable (SELECT * d'une seule table) sert SELECT / UPDATE / DELETE,
-- mais PAS `INSERT ... ON CONFLICT` (upsert). Les deux écrivains upsert (norva-revolut-
-- billing, norva-billing-webhook) + l'insert du refund (norva-admin) sont donc repointés
-- vers `cloud_billing_ledger` dans le MÊME lot. Les lecteurs SQL (admin_finance,
-- refresh_admin_dashboard, snapshot_admin_metrics, norva_funnel_daily, admin_user_billing)
-- et norva-lifecycle (SELECT/UPDATE) continuent via la vue, sans ré-emission.
--
-- ORDRE DE DÉPLOIEMENT : appliquer cette migration PUIS déployer les edge functions
-- (git pull déjà fait). La fenêtre entre les deux est de quelques secondes ; à 0 abonné
-- payant actif, aucun upsert ne tombe dedans (et le journaling est best-effort de toute façon).
-- =============================================================================

alter table if exists public.cloud_stancer_payments rename to cloud_billing_ledger;

-- Renomme contraintes + index pour la cohérence (défensif : ne casse pas si un nom diffère).
do $$
begin
  begin alter table public.cloud_billing_ledger rename constraint cloud_stancer_payments_pkey to cloud_billing_ledger_pkey; exception when others then null; end;
  begin alter table public.cloud_billing_ledger rename constraint cloud_stancer_payments_provider_check to cloud_billing_ledger_provider_check; exception when others then null; end;
  begin alter table public.cloud_billing_ledger rename constraint cloud_stancer_payments_user_id_fkey to cloud_billing_ledger_user_id_fkey; exception when others then null; end;
end $$;
alter index if exists public.idx_stancer_payments_user     rename to idx_billing_ledger_user;
alter index if exists public.idx_stancer_payments_provider rename to idx_billing_ledger_provider;

-- Vue de compat : les lecteurs existants (`from cloud_stancer_payments`) marchent inchangés.
create or replace view public.cloud_stancer_payments as
  select * from public.cloud_billing_ledger;
comment on view public.cloud_stancer_payments is
  'COMPAT SHIM → cloud_billing_ledger. Le rail Stancer est retiré ; nouveau code : utiliser '
  'cloud_billing_ledger directement (les upserts DOIVENT viser la table, pas cette vue).';

-- Le ledger n'est touché que par le service_role (bypass RLS) ; la vue ne doit pas être
-- exposée aux rôles client.
revoke all on public.cloud_stancer_payments from anon, authenticated;
