#!/usr/bin/env bash
# =============================================================================
# apply-abuse-signup-migrations.sh — pose le socle anti-abus du signup
# =============================================================================
# Applique les QUATRE migrations dans l'ordre, puis vérifie ce qu'elles ont
# vraiment créé. Chacune est déjà réentrante (`if not exists`, `or replace`,
# `drop trigger if exists`), donc relancer ce script est sans effet de bord.
#
#   bash ops/hetzner/scripts/apply-abuse-signup-migrations.sh
#
# Aucune fenêtre de maintenance : rien n'est modifié dans les tables existantes,
# rien n'est déposé, et aucun chemin de production ne lit encore ces objets. Le
# signup public continue d'aller directement à GoTrue jusqu'à ce qu'on le
# rebranche, ce qui n'est pas dans ce script.
#
# La fumigation finale tourne dans une transaction ANNULÉE : elle prouve que les
# contraintes acceptent une décision valide et refusent une décision interdite,
# sans laisser une seule ligne derrière elle. Utile parce que
# `signup_decisions` est append-only — une ligne de test y serait durable.
# =============================================================================
set -uo pipefail

DBC="${DB_CONTAINER:-norva-db}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MIGRATIONS="$REPO_ROOT/supabase/migrations"

psql() { docker exec -i "$DBC" psql -U postgres -d postgres -P pager=off -tAc "$1" 2>/dev/null; }
psqlt() { docker exec -i "$DBC" psql -U postgres -d postgres -P pager=off -c "$1"; }
section() { printf '\n\033[1m================ %s ================\033[0m\n' "$1"; }
ok() { printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✘\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

FILES=(
  20260821200000_abuse_velocity_store.sql
  20260822090000_abuse_signup_idempotency.sql
  20260822100000_abuse_signup_decisions.sql
  20260822110000_abuse_ingress_request_ids.sql
)

section "[0] PRÉ-VOL"
if ! docker inspect "$DBC" >/dev/null 2>&1; then
  bad "conteneur $DBC introuvable — export DB_CONTAINER=... si le nom diffère"
  exit 1
fi
ok "conteneur $DBC présent"
printf '  version   : %s\n' "$(psql 'select version()' | cut -c1-40)"
printf '  pgcrypto  : %s\n' "$(psql "select coalesce((select extversion from pg_extension where extname='pgcrypto'), 'ABSENT')")"

for f in "${FILES[@]}"; do
  [[ -f "$MIGRATIONS/$f" ]] || { bad "migration manquante : $f"; exit 1; }
done
ok "les 4 fichiers de migration sont là"

printf '\n  état AVANT :\n'
psqlt "select
         to_regclass('abuse_private.velocity_buckets')     as velocity,
         to_regclass('abuse_private.signup_attempts')      as attempts,
         to_regclass('abuse_private.signup_decisions')     as decisions,
         to_regclass('abuse_private.ingress_request_ids')  as request_ids"

section "[1] APPLICATION"
for f in "${FILES[@]}"; do
  printf '  → %s\n' "$f"
  # --single-transaction : une migration passe entièrement ou pas du tout.
  if docker exec -i "$DBC" psql -U postgres -d postgres -P pager=off \
       -v ON_ERROR_STOP=1 --single-transaction -q -f - < "$MIGRATIONS/$f"; then
    ok "$f appliquée"
  else
    bad "$f a échoué — rien de cette migration n'a été appliqué"
    exit 1
  fi
done

section "[2] CE QUI EXISTE MAINTENANT"
psqlt "select c.relname as objet, c.relkind as genre,
              pg_size_pretty(pg_total_relation_size(c.oid)) as taille
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'abuse_private' and c.relkind in ('r','i')
        order by c.relkind, c.relname"

section "[3] LES RPC ET LEURS DROITS"
# Le service_role est le seul à pouvoir appeler : l'edge s'en sert, personne
# d'autre. anon et authenticated ne doivent apparaître nulle part.
psqlt "select p.proname as fonction,
              has_function_privilege('service_role', p.oid, 'execute') as service_role,
              has_function_privilege('anon',          p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'abuse\\_%'
        order by p.proname"

EXPECTED_RPC=9
GOT_RPC="$(psql "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='public' and p.proname in (
                    'abuse_velocity_touch','abuse_velocity_prune',
                    'abuse_signup_attempt_claim','abuse_signup_attempt_settle',
                    'abuse_signup_attempt_prune','abuse_signup_decision_record',
                    'abuse_signup_decision_prune','abuse_ingress_request_consume',
                    'abuse_ingress_request_prune')")"
[[ "$GOT_RPC" == "$EXPECTED_RPC" ]] \
  && ok "les $EXPECTED_RPC RPC attendues sont exposées" \
  || bad "attendu $EXPECTED_RPC RPC, trouvé $GOT_RPC"

LEAKED="$(psql "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname='public' and p.proname like 'abuse\\_%'
                   and (has_function_privilege('anon', p.oid, 'execute')
                     or has_function_privilege('authenticated', p.oid, 'execute'))")"
[[ "$LEAKED" == "0" ]] \
  && ok "aucune RPC accessible à anon ou authenticated" \
  || bad "$LEAKED RPC exposée(s) à anon/authenticated — à corriger avant tout trafic"

TABLE_LEAK="$(psql "select count(*) from information_schema.role_table_grants
                     where table_schema='abuse_private' and grantee in ('anon','authenticated')")"
[[ "$TABLE_LEAK" == "0" ]] \
  && ok "aucune table abuse_private lisible par anon/authenticated" \
  || bad "$TABLE_LEAK droit(s) de table à retirer"

section "[4] FUMIGATION — vélocité et rejeu"
printf '  compteur de vélocité (deux fenêtres, même sujet) :\n'
psqlt "select * from public.abuse_velocity_touch(
         '[{\"dimension\":\"ip\",\"subject_hash\":\"$(printf '0%.0s' {1..64})\",
            \"hash_version\":1,\"windows_seconds\":[3600,86400]}]'::jsonb)"

printf '  request_id à usage unique — la seconde fois doit dire false :\n'
psqlt "select public.abuse_ingress_request_consume('dead0000beef0000cafe0000f00d0002', 'signup', 300) as premiere,
              public.abuse_ingress_request_consume('dead0000beef0000cafe0000f00d0002', 'signup', 300) as seconde"

printf '  claim idempotent — la seconde fois doit être un replay :\n'
psqlt "select public.abuse_signup_attempt_claim('dead0000beef0000cafe0000f00d0001', '$(printf 'a%.0s' {1..64})', 1, 900) as premiere"
psqlt "select public.abuse_signup_attempt_claim('dead0000beef0000cafe0000f00d0001', '$(printf 'a%.0s' {1..64})', 1, 900) as seconde"
printf '  même nonce, autre empreinte — doit être intent_mismatch :\n'
psqlt "select public.abuse_signup_attempt_claim('dead0000beef0000cafe0000f00d0001', '$(printf 'b%.0s' {1..64})', 1, 900) as mismatch"

# Ces lignes-là sont supprimables (pas de trigger append-only sur les tentatives).
psql "delete from abuse_private.signup_attempts where nonce = 'dead0000beef0000cafe0000f00d0001'" >/dev/null
psql "delete from abuse_private.ingress_request_ids where request_id = 'dead0000beef0000cafe0000f00d0002'" >/dev/null
psql "delete from abuse_private.velocity_buckets where subject_hash = '$(printf '0%.0s' {1..64})'" >/dev/null
ok "lignes de fumigation retirées"

section "[5] FUMIGATION — le contrat du mode observe"
# Tout ceci est annulé : signup_decisions est append-only, une ligne de test y
# resterait 90 jours.
docker exec -i "$DBC" psql -U postgres -d postgres -P pager=off -v ON_ERROR_STOP=0 <<'SQL'
begin;

-- 1. Une décision CRITICAL avec enforcement à false et actual_decision = ALLOW.
--    C'est exactement ce que l'edge écrira, et ça doit passer.
select 'CRITICAL observé, ALLOW appliqué' as cas,
       abuse_private.signup_decision_record(jsonb_build_object(
         'risk_model_version', 'smoke', 'policy_version', 'smoke',
         'policy_config_hash', repeat('a', 64),
         'velocity_rules_version', 'smoke',
         'fingerprint_version', 1, 'hash_version', 1,
         'thresholds_used', '{"low":20,"medium":40,"high":65,"critical":85}'::jsonb,
         'family_caps_used', '{"velocity":60}'::jsonb,
         'observed_raw_score', 105, 'observed_risk_score', 100,
         'observed_risk_level', 'CRITICAL', 'risk_floor', 45,
         'signals', '[{"code":"HONEYPOT_FILLED","weight":45}]'::jsonb,
         'family_totals', '{"behaviour":{"raw":45,"capped":45}}'::jsonb,
         'families_involved', array['behaviour','velocity'],
         'repeated_strong_evidence', true,
         'would_have_decision', 'BLOCK',
         'enforcement_enabled', false,
         'actual_decision', 'ALLOW',
         'auth_method', 'password', 'platform', 'web',
         'signup_endpoint_version', 'smoke'
       ), 90) is not null as accepte;

-- 2. La même chose mais en refusant réellement, alors que l'enforcement est off.
--    La contrainte signup_decisions_observe_allows doit l'interdire : un bug
--    ailleurs ne pourra pas enregistrer un refus en mode observe.
savepoint interdit;
do $$
begin
  perform abuse_private.signup_decision_record(jsonb_build_object(
    'risk_model_version','smoke','policy_version','smoke',
    'policy_config_hash', repeat('a', 64),
    'velocity_rules_version','smoke','fingerprint_version',1,'hash_version',1,
    'thresholds_used','{}'::jsonb,'family_caps_used','{}'::jsonb,
    'observed_raw_score',105,'observed_risk_score',100,
    'observed_risk_level','CRITICAL','risk_floor',0,
    'signals','[]'::jsonb,'family_totals','{}'::jsonb,
    'families_involved', array['behaviour'],
    'would_have_decision','BLOCK',
    'enforcement_enabled', false,
    'actual_decision','BLOCK',
    'auth_method','password','platform','web','signup_endpoint_version','smoke'
  ), 90);
  raise warning 'ECHEC : un refus a été accepté alors que enforcement_enabled = false';
exception when check_violation then
  raise notice 'OK : la base refuse un refus quand enforcement est off';
end $$;
rollback to savepoint interdit;

-- 3. Le clamp : risk_score doit être exactement le clamp de raw_score.
savepoint clamp;
do $$
begin
  perform abuse_private.signup_decision_record(jsonb_build_object(
    'risk_model_version','smoke','policy_version','smoke',
    'policy_config_hash', repeat('a', 64),
    'velocity_rules_version','smoke','fingerprint_version',1,'hash_version',1,
    'thresholds_used','{}'::jsonb,'family_caps_used','{}'::jsonb,
    'observed_raw_score',105,'observed_risk_score',90,
    'observed_risk_level','CRITICAL','risk_floor',0,
    'signals','[]'::jsonb,'family_totals','{}'::jsonb,
    'families_involved', array['behaviour'],
    'would_have_decision','BLOCK','enforcement_enabled', true,
    'actual_decision','BLOCK',
    'auth_method','password','platform','web','signup_endpoint_version','smoke'
  ), 90);
  raise warning 'ECHEC : un score non clampé a été accepté';
exception when check_violation then
  raise notice 'OK : la base refuse un risk_score qui ne clampe pas raw_score';
end $$;
rollback to savepoint clamp;

-- 4. Une décision ne se modifie pas.
savepoint appendonly;
do $$
begin
  update abuse_private.signup_decisions set observed_risk_level = 'SAFE'
   where policy_version = 'smoke';
  raise warning 'ECHEC : une décision a pu être modifiée';
exception when others then
  raise notice 'OK : append-only (%)', sqlerrm;
end $$;
rollback to savepoint appendonly;

rollback;
SQL
ok "aucune ligne de décision laissée en base (transaction annulée)"

section "[6] RÉSULTAT"
printf '  lignes restantes dans abuse_private :\n'
psqlt "select 'velocity_buckets' t, count(*) from abuse_private.velocity_buckets
       union all select 'signup_attempts',  count(*) from abuse_private.signup_attempts
       union all select 'signup_decisions', count(*) from abuse_private.signup_decisions
       union all select 'ingress_request_ids', count(*) from abuse_private.ingress_request_ids"

if [[ "$FAILED" == "0" ]]; then
  printf '\n\033[32mSocle posé.\033[0m Prochaine étape : les secrets, puis le déploiement\n'
  printf 'de l'"'"'edge — le signup public continue d'"'"'aller à GoTrue en direct.\n'
else
  printf '\n\033[31mAu moins une vérification a échoué.\033[0m Ne pose pas les secrets\n'
  printf 'avant de l'"'"'avoir traitée.\n'
  exit 1
fi
