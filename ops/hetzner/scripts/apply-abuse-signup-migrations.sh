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
# LA FUMIGATION EST BLOQUANTE. La version précédente de ce script ne l'était pas,
# et c'était un vrai défaut : elle tournait avec ON_ERROR_STOP=0 et signalait un
# invariant cassé par `raise warning`, qui ne fait pas échouer psql. Un socle avec
# une contrainte de sécurité disparue affichait donc « Socle posé. » Maintenant
# chaque invariant lève une véritable exception, ON_ERROR_STOP=1 fait sortir psql
# en erreur, et `set -e` arrête le script :
#
#   opération valide refusée          → exit != 0
#   opération interdite acceptée      → exit != 0
#   risk_score non clampé accepté     → exit != 0
#   snapshot modifiable ou supprimable→ exit != 0
#
# La section tourne dans une transaction annulée : `signup_decisions` est
# append-only, une ligne de test y resterait quatre-vingt-dix jours.
# =============================================================================
set -euo pipefail

DBC="${DB_CONTAINER:-norva-db}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MIGRATIONS="$REPO_ROOT/supabase/migrations"

psql() { docker exec -i "$DBC" psql -U postgres -d postgres -P pager=off -tAc "$1"; }
psqlt() { docker exec -i "$DBC" psql -U postgres -d postgres -P pager=off -c "$1"; }
section() { printf '\n\033[1m================ %s ================\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

# Un check qui ne doit pas arrêter le script tout de suite : on veut la liste
# complète des problèmes, pas seulement le premier. `bad` retourne 0, donc `set
# -e` ne coupe pas ici — l'échec est porté par FAILED et lu à la fin.
expect_eq() {
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — attendu « $3 », obtenu « $2 »"; fi
}

FILES=(
  20260821200000_abuse_velocity_store.sql
  20260822090000_abuse_signup_idempotency.sql
  20260822100000_abuse_signup_decisions.sql
  20260822110000_abuse_ingress_request_ids.sql
)

section "[0] PRÉ-VOL"
docker inspect "$DBC" >/dev/null 2>&1 \
  || { bad "conteneur $DBC introuvable — export DB_CONTAINER=... si le nom diffère"; exit 1; }
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
# Les signatures sont affichées, pas seulement les noms. La première version ne
# montrait que les noms, et la fumigation appelait ensuite
# abuse_signup_attempt_claim avec un literal 1 là où la fonction déclare un
# smallint — integer vers smallint est une assignment cast, pas une implicite,
# donc la résolution échouait. PostgREST passe des paramètres NOMMÉS convertis
# depuis JSON, donc le chemin de production n'a jamais eu ce problème : c'était
# la mesure qui était fausse. Une dérive de type se verra ici désormais.
psqlt "select p.proname as fonction,
              pg_get_function_arguments(p.oid) as arguments,
              has_function_privilege('service_role', p.oid, 'execute') as service_role,
              has_function_privilege('anon',          p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'abuse\\_%'
        order by p.proname"

expect_eq "les 9 RPC attendues sont exposées" \
  "$(psql "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname='public' and p.proname in (
              'abuse_velocity_touch','abuse_velocity_prune',
              'abuse_signup_attempt_claim','abuse_signup_attempt_settle',
              'abuse_signup_attempt_prune','abuse_signup_decision_record',
              'abuse_signup_decision_prune','abuse_ingress_request_consume',
              'abuse_ingress_request_prune')")" "9"

expect_eq "aucune RPC accessible à anon ou authenticated" \
  "$(psql "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname='public' and p.proname like 'abuse\\_%'
              and (has_function_privilege('anon', p.oid, 'execute')
                or has_function_privilege('authenticated', p.oid, 'execute'))")" "0"

expect_eq "aucune table abuse_private lisible par anon/authenticated" \
  "$(psql "select count(*) from information_schema.role_table_grants
            where table_schema='abuse_private' and grantee in ('anon','authenticated')")" "0"

expect_eq "le trigger append-only est en place" \
  "$(psql "select count(*) from pg_trigger
            where tgname = 'signup_decisions_append_only' and not tgisinternal")" "1"

section "[4] FUMIGATION — vélocité et rejeu"
ZERO_HASH="$(printf '0%.0s' {1..64})"
HASH_A="$(printf 'a%.0s' {1..64})"
HASH_B="$(printf 'b%.0s' {1..64})"
NONCE='dead0000beef0000cafe0000f00d0001'
REQID='dead0000beef0000cafe0000f00d0002'

printf '  compteur de vélocité (deux fenêtres, même sujet) :\n'
psqlt "select * from public.abuse_velocity_touch(
         '[{\"dimension\":\"ip\",\"subject_hash\":\"$ZERO_HASH\",
            \"hash_version\":1,\"windows_seconds\":[3600,86400]}]'::jsonb)"

printf '  request_id à usage unique :\n'
expect_eq "première consommation = true" \
  "$(psql "select public.abuse_ingress_request_consume('$REQID', 'signup', 300)")" "t"
expect_eq "seconde consommation = false (rejeu refusé)" \
  "$(psql "select public.abuse_ingress_request_consume('$REQID', 'signup', 300)")" "f"

printf '  claim idempotent :\n'
expect_eq "premier claim = claimed" \
  "$(psql "select public.abuse_signup_attempt_claim('$NONCE', '$HASH_A', 1::smallint, 900) ->> 'outcome'")" "claimed"
expect_eq "second claim, même empreinte = replay" \
  "$(psql "select public.abuse_signup_attempt_claim('$NONCE', '$HASH_A', 1::smallint, 900) ->> 'outcome'")" "replay"
expect_eq "même nonce, autre empreinte = intent_mismatch" \
  "$(psql "select public.abuse_signup_attempt_claim('$NONCE', '$HASH_B', 1::smallint, 900) ->> 'outcome'")" "intent_mismatch"

# Ces lignes-là sont supprimables (pas de trigger append-only sur les tentatives).
psql "delete from abuse_private.signup_attempts where nonce = '$NONCE'" >/dev/null
psql "delete from abuse_private.ingress_request_ids where request_id = '$REQID'" >/dev/null
psql "delete from abuse_private.velocity_buckets where subject_hash = '$ZERO_HASH'" >/dev/null
ok "lignes de fumigation retirées"

section "[5] FUMIGATION BLOQUANTE — le contrat du mode observe"
# ON_ERROR_STOP=1 : toute exception fait sortir psql en erreur, et `set -e`
# arrête le script. Chaque scénario interdit lève une VRAIE exception si
# l'opération a été acceptée — un `raise warning` ne ferait rien échouer.
if docker exec -i "$DBC" psql -U postgres -d postgres -P pager=off \
     -v ON_ERROR_STOP=1 -q <<'SQL'
begin;

-- ── 1. Une décision valide DOIT être acceptée ────────────────────────────────
-- CRITICAL observé, ALLOW appliqué, enforcement à false : exactement ce que
-- l'edge écrira. Si la base la refuse, l'exception remonte et psql sort en
-- erreur, ce qui est le comportement voulu.
do $$
declare v_id uuid;
begin
  v_id := abuse_private.signup_decision_record(jsonb_build_object(
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
  ), 90);
  if v_id is null then
    raise exception 'SMOKE FAILED: une décision valide du mode observe n''a pas été enregistrée';
  end if;
  raise notice 'OK 1/5 : CRITICAL observé + ALLOW appliqué est accepté';
end $$;

-- ── 2. Un refus enregistré alors que l'enforcement est off DOIT être refusé ──
-- C'est l'invariant central : un bug ailleurs ne peut pas inscrire un refus
-- pendant qu'on est censé seulement observer.
do $$
declare blocked boolean := false;
begin
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
  exception when check_violation then blocked := true;
  end;
  if not blocked then
    raise exception 'SMOKE FAILED: un refus a été enregistré alors que enforcement_enabled = false';
  end if;
  raise notice 'OK 2/5 : la base refuse un refus quand enforcement est off';
end $$;

-- ── 3. Un risk_score qui n'est pas le clamp de raw_score DOIT être refusé ────
do $$
declare blocked boolean := false;
begin
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
  exception when check_violation then blocked := true;
  end;
  if not blocked then
    raise exception 'SMOKE FAILED: un risk_score qui ne clampe pas raw_score a été accepté';
  end if;
  raise notice 'OK 3/5 : la base refuse un score non clampé';
end $$;

-- ── 4. Un snapshot NE DOIT PAS être modifiable ───────────────────────────────
-- La ligne du scénario 1 est visible dans cette transaction. On vérifie d'abord
-- qu'elle existe : un UPDATE qui ne touche aucune ligne ne déclenche pas le
-- trigger et passerait pour un succès.
do $$
declare blocked boolean := false; v_count integer;
begin
  select count(*) into v_count
    from abuse_private.signup_decisions where policy_version = 'smoke';
  if v_count = 0 then
    raise exception 'SMOKE FAILED: aucun snapshot à tester, le scénario 1 n''a rien inséré';
  end if;
  begin
    update abuse_private.signup_decisions set observed_risk_level = 'SAFE'
     where policy_version = 'smoke';
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'SMOKE FAILED: un snapshot de décision a pu être modifié';
  end if;
  raise notice 'OK 4/5 : append-only, aucune modification possible';
end $$;

-- ── 5. Un snapshot non expiré NE DOIT PAS être supprimable ───────────────────
-- La rétention peut retirer une ligne expirée ; rien ne peut retirer une ligne
-- vivante, sinon la trace n'est pas une trace.
do $$
declare blocked boolean := false;
begin
  begin
    delete from abuse_private.signup_decisions where policy_version = 'smoke';
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'SMOKE FAILED: un snapshot non expiré a pu être supprimé';
  end if;
  raise notice 'OK 5/5 : une décision vivante ne se supprime pas';
end $$;

rollback;
SQL
then
  ok "les 5 invariants tiennent, et rien n'a été laissé en base"
else
  bad "un invariant de sécurité est cassé — ne pose pas les secrets, lis le message ci-dessus"
  exit 1
fi

section "[6] RÉSULTAT"
printf '  lignes restantes dans abuse_private :\n'
psqlt "select 'velocity_buckets' t, count(*) from abuse_private.velocity_buckets
       union all select 'signup_attempts',  count(*) from abuse_private.signup_attempts
       union all select 'signup_decisions', count(*) from abuse_private.signup_decisions
       union all select 'ingress_request_ids', count(*) from abuse_private.ingress_request_ids"

if [[ "$FAILED" == "0" ]]; then
  printf '\n\033[32mSocle posé.\033[0m Prochaine étape : les secrets, puis le déploiement\n'
  printf 'de l'"'"'edge — le signup public continue d'"'"'aller à GoTrue en direct.\n\n'
else
  printf '\n\033[31mAu moins une vérification a échoué.\033[0m Ne pose pas les secrets\n'
  printf 'avant de l'"'"'avoir traitée.\n\n'
  exit 1
fi
