#!/usr/bin/env bash
# =============================================================================
# rotate-jwt-secret.sh — révocation réelle du service_role exposé
# =============================================================================
#   bash ops/hetzner/scripts/rotate-jwt-secret.sh --plan              # lecture seule
#   bash ops/hetzner/scripts/rotate-jwt-secret.sh --prove-vulnerable  # lecture seule
#   bash ops/hetzner/scripts/rotate-jwt-secret.sh --rotate
#   bash ops/hetzner/scripts/rotate-jwt-secret.sh --verify
#
# POURQUOI LA ROTATION ET RIEN D'AUTRE. kong-entrypoint.sh transmet tout
# `Authorization` ne commençant pas par « Bearer sb_ » tel quel à l'amont. Vingt
# routes appliquent ce transform, neuf admettent le consumer anon, et la clé
# publiable nécessaire est publique par conception. Il n'existe pas de route
# /auth/v1/admin dédiée, donc l'administration GoTrue est derrière la route
# générique qui admet anon, avec GOTRUE_JWT_ADMIN_ROLES=service_role. MESURÉ :
# témoin sans Bearer 401, avec le service_role exposé en Bearer 200.
#
# Retirer le credential du consumer Kong ne révoque rien : l'attaque ne présente
# jamais ce credential en apikey. Un garde PGRST_DB_PRE_REQUEST fermerait
# PostgREST de façon prouvable mais laisserait GoTrue admin, Storage et Realtime
# ouverts. SUPABASE_SECRET_KEY et les deux *_ASYMMETRIC sont vides, donc la
# bascule vers sb_secret_ est un projet de migration de clés de signature, pas
# une réponse à incident. Reste la rotation.
#
# ORDRE DES OPÉRATIONS. Tout ce qui peut échouer est fait AVANT la première
# écriture : validation du compose, découverte des services en marche,
# joignabilité de Docker, de la base et de Kong. Un préflight qui échoue ne
# laisse donc ni secret modifié, ni GUC modifié, ni impact production. Après les
# écritures et jusqu'à la première recréation, un trap restaure automatiquement
# le .env et le GUC : pendant un incident, mieux vaut ne pas dépendre d'une
# restauration manuelle sous pression. Une fois la recréation commencée, le
# rollback n'est plus le bon geste — il faut finir la rotation vers l'avant, et
# le script le dit.
#
# LES JETONS SONT RE-SIGNÉS, PAS RÉGÉNÉRÉS. Le payload d'un JWT anon ou
# service_role n'est pas le secret ; la signature l'est. On recopie le payload à
# l'octet pour éliminer toute dérive sur iss, aud, role ou exp.
#
# LE SECRET NE PASSE JAMAIS PAR argv. La signature HMAC lit la clé sur stdin,
# parce qu'un `openssl -hmac "$secret"` serait lisible dans `ps`.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HETZNER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$HETZNER_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$HETZNER_DIR/docker-compose.supabase.yml}"
SECRET_BACKUP_DIR="${SECRET_BACKUP_DIR:-$HOME/.norva-secret-backups}"
DBC="${DB_CONTAINER:-norva-db}"
KONG_URL="${KONG_URL:-http://127.0.0.1:8000}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-180}"
MODE="${1:-}"

# --env-file EXPLICITE. Sans lui, Compose cherche un .env selon le répertoire
# courant ou le répertoire du projet suivant sa version, et ce script se lance
# depuis ~/norva alors que les secrets sont dans ops/hetzner/.env. Le compose
# contient des interpolations obligatoires (`${VAR:?message}`) : un mauvais .env
# ne donne pas des valeurs vides, il fait échouer la commande — au pire moment,
# juste après avoir écrit le nouveau secret.
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

# db est délibérément absent : son JWT_SECRET ne sert qu'aux scripts d'init du
# premier démarrage. Le GUC en base est mis à jour en SQL.
SERVICES=(kong auth rest storage functions functions2 studio realtime resend-contact-worker)

section() { printf '\n\033[1m================ %s ================\033[0m\n' "$1"; }
line() { printf '  %-38s %s\n' "$1" "$2"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$1" >&2; }
die()  { bad "$1"; exit 1; }

command -v python3 >/dev/null 2>&1 || die "python3 requis pour signer sans exposer la clé dans argv"
[[ -f "$ENV_FILE" ]] || die "introuvable : $ENV_FILE"
[[ -f "$COMPOSE_FILE" ]] || die "introuvable : $COMPOSE_FILE"

value_of() { sed -n "s/^${1}=//p" "$ENV_FILE" | tail -n 1; }
value_in() { sed -n "s/^${2}=//p" "$1" | tail -n 1; }
fingerprint_of() {
  local v="$1"
  [[ -n "$v" ]] || { printf 'ABSENT'; return; }
  printf '%s' "$v" | sha256sum | cut -c1-12
}
# Définir un paramètre personnalisé (`app.settings.*`) exige le superuser :
# PostgreSQL les traite comme des placeholders. L'image de la base défaut
# POSTGRES_USER à supabase_admin, et `postgres` n'est PAS superuser sur cette
# stack — d'où le « permission denied to set parameter » rencontré en
# production. Le rôle capable est résolu au préflight, plus jamais supposé.
PSQL_ROLE="${PSQL_ROLE:-}"
psql_q() { docker exec -i "$DBC" psql -U postgres -d postgres -P pager=off -tAc "$1" 2>/dev/null || true; }
psql_as() { docker exec -i "$DBC" psql -U "$1" -d postgres -P pager=off -q -v ON_ERROR_STOP=1; }
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" || echo 000; }

# Le payload d'un JWT n'est pas un secret. On le lit pour décrire les claims et
# pour les recopier. Ni la signature ni la clé ne sont touchées.
claims_of() {
  python3 -c '
import sys, json, base64, datetime
raw = sys.argv[1]
raw += "=" * (-len(raw) % 4)
try:
    c = json.loads(base64.urlsafe_b64decode(raw))
except Exception:
    print("payload illisible"); raise SystemExit
exp = c.get("exp")
when = (datetime.datetime.fromtimestamp(exp, datetime.timezone.utc).strftime("%Y-%m-%d")
        if exp else "sans exp")
print("role=%s iss=%s aud=%s exp=%s" % (c.get("role","?"), c.get("iss","-"), c.get("aud","-"), when))
' "$(cut -d. -f2 <<<"$1")"
}

# Re-signe un JWT en gardant son payload EXACT. Le secret arrive sur stdin.
resign_jwt() {
  printf '%s' "$2" | python3 -c '
import sys, hmac, hashlib, base64
secret = sys.stdin.buffer.read()
parts = sys.argv[1].split(".")
if len(parts) != 3:
    sys.exit("jwt malforme")
signing_input = (parts[0] + "." + parts[1]).encode()
sig = hmac.new(secret, signing_input, hashlib.sha256).digest()
sys.stdout.write(parts[0] + "." + parts[1] + "." + base64.urlsafe_b64encode(sig).decode().rstrip("="))
' "$1"
}

replace_var() {
  local name="$1" value="$2" tmp
  tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")" || return 1
  chmod 600 -- "$tmp" || { rm -f -- "$tmp"; return 1; }
  { grep -v "^${name}=" "$ENV_FILE" || true; } > "$tmp" || { rm -f -- "$tmp"; return 1; }
  printf '%s=%s\n' "$name" "$value" >> "$tmp" || { rm -f -- "$tmp"; return 1; }
  grep -q "^${name}=." "$tmp" || { rm -f -- "$tmp"; return 1; }
  mv -- "$tmp" "$ENV_FILE" || { rm -f -- "$tmp"; return 1; }
}

set_guc() {
  local secret="$1" quoted
  quoted="$(printf '%s' "$secret" | sed "s/'/''/g")"
  printf "alter database postgres set \"app.settings.jwt_secret\" = '%s';\n" "$quoted" \
    | psql_as "${PSQL_ROLE:-supabase_admin}"
}

reset_guc() {
  printf 'alter database postgres reset "app.settings.jwt_secret";\n' \
    | psql_as "${PSQL_ROLE:-supabase_admin}"
}

# Lit la valeur actuelle du GUC pour pouvoir la restaurer. Elle ne sort de cette
# fonction que vers set_guc.
guc_value() {
  psql_q "select c from pg_db_role_setting s, unnest(s.setconfig) c where c like 'app.settings.jwt_secret=%' limit 1" \
    | sed 's/^app.settings.jwt_secret=//'
}

# Cherche un lecteur RÉEL dans la base, plutôt que de déduire du repo qu'il n'y
# en a pas. Une fonction créée à la main hors migration compte aussi.
guc_readers() {
  psql_q "select count(*) from pg_proc where prosrc like '%app.settings.jwt_secret%'"
}

# Teste la CAPACITÉ d'écrire un GUC personnalisé, sur un nom jetable, et rend le
# rôle qui y arrive. C'est ce test qui manquait au préflight : il validait le
# compose mais pas le droit d'écrire, donc l'échec tombait après la première
# écriture au lieu d'avant.
resolve_psql_role() {
  local role
  for role in supabase_admin postgres; do
    if printf 'alter database postgres set "app.settings.norva_rotation_probe" = %s;\n' "'ok'" \
         | psql_as "$role" >/dev/null 2>&1; then
      printf 'alter database postgres reset "app.settings.norva_rotation_probe";\n' \
        | psql_as "$role" >/dev/null 2>&1 || true
      printf '%s' "$role"; return 0
    fi
  done
  return 1
}

guc_present() {
  local n
  n="$(psql_q "select count(*) from pg_db_role_setting s, unnest(s.setconfig) c where c like 'app.settings.jwt_secret=%'")"
  [[ "${n:-0}" -gt 0 ]]
}

# Découvre les services à recréer. Uniquement ceux DÉJÀ EN MARCHE : un compose up
# sur un service arrêté le démarrerait, et realtime comme resend-contact-worker
# peuvent être volontairement à l'arrêt. Les allumer serait un changement d'état
# que personne n'a demandé.
RUNNING=(); SKIPPED=()
discover_services() {
  RUNNING=(); SKIPPED=()
  local svc cid
  for svc in "${SERVICES[@]}"; do
    grep -qE "^  ${svc}:" "$COMPOSE_FILE" || { SKIPPED+=("$svc — absent du compose"); continue; }
    cid="$({ "${COMPOSE[@]}" ps -q "$svc" 2>/dev/null || true; } | head -n 1)"
    if [[ -n "$cid" ]] && [[ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" == "true" ]]; then
      RUNNING+=("$svc")
    else
      SKIPPED+=("$svc — à l'arrêt, laissé tel quel")
    fi
  done
}

# ── plan ────────────────────────────────────────────────────────────────────

if [[ "$MODE" == "--plan" ]]; then
  section "ÉTAT ACTUEL — rien n'est modifié"
  OLD_JWT="$(value_of JWT_SECRET)"; OLD_ANON="$(value_of ANON_KEY)"; OLD_SR="$(value_of SERVICE_ROLE_KEY)"
  line "JWT_SECRET" "$([[ -n "$OLD_JWT" ]] && echo "${#OLD_JWT} octets, empreinte $(fingerprint_of "$OLD_JWT")" || echo ABSENT)"
  line "ANON_KEY" "$([[ -n "$OLD_ANON" ]] && claims_of "$OLD_ANON" || echo ABSENT)"
  line "SERVICE_ROLE_KEY" "$([[ -n "$OLD_SR" ]] && claims_of "$OLD_SR" || echo ABSENT)"

  section "PRÉFLIGHT — ce qui est vérifié avant toute écriture"
  if "${COMPOSE[@]}" config --quiet 2>/dev/null; then
    ok "compose valide avec --env-file $ENV_FILE"
  else
    bad "compose INVALIDE avec ce .env — --rotate refusera de démarrer"
  fi
  if guc_present; then
    line "GUC app.settings.jwt_secret" "présent, $(guc_readers) fonction(s) le lisant"
    printf '    Zéro lecteur signifie qu'"'"'il sera RETIRÉ plutôt que mis à jour :\n'
    printf '    l'"'"'écrire y placerait le nouveau secret de signature, lisible dans\n'
    printf '    pg_db_role_setting, pour personne. Forçable par GUC_ACTION.\n'
  else
    warn "aucun GUC app.settings.jwt_secret"
  fi
  # Le droit d'ÉCRIRE ce GUC n'est pas testé ici : ce mode reste strictement en
  # lecture. --rotate l'éprouve en toute première étape, avant la moindre
  # écriture — c'est précisément ce qui manquait quand la rotation a échoué
  # après avoir déjà modifié le .env.
  discover_services
  line "services à recréer" "${RUNNING[*]:-aucun}"
  if [[ ${#SKIPPED[@]} -gt 0 ]]; then for sk in "${SKIPPED[@]}"; do warn "$sk"; done; fi

  section "CE QUI SERA FAIT"
  printf '  0. préflight — un échec ici ne modifie RIEN\n'
  printf '  1. sauvegarde du .env dans %s (700/600)\n' "$SECRET_BACKUP_DIR"
  printf '  2. nouveau JWT_SECRET, jetons re-signés en mémoire\n'
  printf '  3. écriture .env + GUC, sous rollback automatique\n'
  printf '  4. recréation parallèle avec attente des healthchecks\n'
  printf '  5. vérification par empreinte que le secret est arrivé\n'

  section "CE QUI N'EST PAS TOUCHÉ"
  printf '  — le conteneur db : son JWT_SECRET ne sert qu%s l'"'"'init du 1er boot\n' "'à"
  printf '  — sb_publishable_ côté clients : clé opaque, aucun redéploiement\n'
  printf '  — auth.refresh_tokens : lignes opaques, les sessions se rétablissent\n'
  printf '  — les crons : norva_cron_shared_secret du Vault\n'

  section "IMPACT MESURÉ"
  line "refresh tokens vivants" "$(psql_q 'select count(*) from auth.refresh_tokens where revoked = false')"
  line "sessions actives 24 h" "$(psql_q "select count(distinct user_id) from auth.refresh_tokens where created_at > now() - interval '24 hours'")"
  printf '\n  Chacune prendra un 401 puis se rétablira par refresh.\n\n'
  exit 0
fi

# ── prove-vulnerable ────────────────────────────────────────────────────────

if [[ "$MODE" == "--prove-vulnerable" ]]; then
  section "MESURE DU CONTOURNEMENT — rien n'est modifié"
  SR="$(value_of SERVICE_ROLE_KEY)"; PUB="$(value_of SUPABASE_PUBLISHABLE_KEY)"
  [[ -n "$SR" ]] || die "SERVICE_ROLE_KEY absent de $ENV_FILE"
  [[ -n "$PUB" ]] || die "SUPABASE_PUBLISHABLE_KEY absent de $ENV_FILE"
  ADMIN='/auth/v1/admin/users?page=1&per_page=1'
  PROBE='/rest/v1/norva_revocation_probe_absente?limit=1'

  printf '\n  \033[1mGoTrue admin — le test qui décide\033[0m\n'
  a1="$(http_code -H "apikey: $PUB" "${KONG_URL}${ADMIN}")"
  a2="$(http_code -H "apikey: $PUB" -H "Authorization: Bearer $SR" "${KONG_URL}${ADMIN}")"
  line "témoin, apikey seul" "HTTP $a1"
  line "apikey + Bearer service_role" "HTTP $a2"

  printf '\n  \033[1mPostgREST — NON DISCRIMINANT avant rotation\033[0m\n'
  p1="$(http_code -H "apikey: $PUB" "${KONG_URL}${PROBE}")"
  p2="$(http_code -H "apikey: $PUB" -H "Authorization: Bearer $SR" "${KONG_URL}${PROBE}")"
  line "témoin, apikey seul" "HTTP $p1"
  line "apikey + Bearer service_role" "HTTP $p2"
  printf '  Le rôle anon est lui aussi valide, donc une table absente répond 404\n'
  printf '  dans les deux cas. Ce couple ne prouve AUCUNE élévation de privilège —\n'
  printf '  une version précédente le présentait à tort comme une preuve. Il\n'
  printf '  redevient utile APRÈS la rotation, où un 401 prouve que la signature\n'
  printf '  de l'"'"'ancien jeton est rejetée.\n'

  printf '\n'
  if [[ "$a1" == "401" && "$a2" == "200" ]]; then
    bad "CONTOURNEMENT CONFIRMÉ — refusé sans Bearer, accepté avec"
    bad "le jeton exposé atteint l'administration des utilisateurs GoTrue"
    printf '\n  Preuve nette : seule l'"'"'addition du Bearer change le résultat.\n'
    printf '  Enchaîne sur --rotate.\n\n'
  elif [[ "$a1" == "401" && "$a2" == "401" ]]; then
    ok "GoTrue admin refuse le Bearer"
    printf '\n  Contraire à la lecture du code. Ne rote pas sans comprendre :\n'
    printf '  rotation déjà faite, ou garde que je n'"'"'ai pas vu.\n\n'
  elif [[ "$a1" == "200" ]]; then
    bad "le témoin SEUL obtient 200 — problème distinct et plus grave"
    printf '\n  L'"'"'administration serait atteignable avec la seule clé publique.\n'
    printf '  À traiter avant toute rotation.\n\n'
  else
    warn "résultat ambigu (témoin $a1, avec Bearer $a2)"
    printf '\n  Un 000 signifie que Kong n'"'"'est pas joignable sur %s.\n\n' "$KONG_URL"
  fi
  exit 0
fi

# ── verify ──────────────────────────────────────────────────────────────────

if [[ "$MODE" == "--verify" ]]; then
  section "PREUVE DE RÉVOCATION"
  CURRENT_SR="$(value_of SERVICE_ROLE_KEY)"
  BACKUP=""; OLD_SR=""
  # La sauvegarde la plus récente n'est pas forcément celle qui contient
  # l'ANCIEN jeton : provision-abuse-signup-secrets.sh écrit dans le même
  # dossier avec le même motif de nom. On prend la plus récente dont le
  # SERVICE_ROLE_KEY diffère de l'actuel, ce qui est la définition de « ancien ».
  for candidate in $(ls -1t "$SECRET_BACKUP_DIR"/env.* 2>/dev/null); do
    cand="$(value_in "$candidate" SERVICE_ROLE_KEY)"
    if [[ -n "$cand" && "$cand" != "$CURRENT_SR" ]]; then BACKUP="$candidate"; OLD_SR="$cand"; break; fi
  done
  [[ -n "$OLD_SR" ]] || die "aucune sauvegarde ne contient un SERVICE_ROLE_KEY différent de l'actuel — rien à tester"
  PUB="$(value_of SUPABASE_PUBLISHABLE_KEY)"
  NEW_ANON="$(value_of ANON_KEY)"
  ok "ancien jeton lu dans $(basename "$BACKUP")"

  FAIL=0
  printf '\n  \033[1mL'"'"'ancien jeton doit être mort partout\033[0m\n'
  for target in "/auth/v1/admin/users?page=1&per_page=1" "/rest/v1/norva_revocation_probe_absente?limit=1"; do
    code="$(http_code -H "apikey: $PUB" -H "Authorization: Bearer $OLD_SR" "${KONG_URL}${target}")"
    case "$code" in
      401) ok "${target%%\?*} → 401, signature refusée" ;;
      403) bad "${target%%\?*} → 403, refus d'ACL : aucune preuve sur le jeton"; FAIL=1 ;;
      000) bad "${target%%\?*} → injoignable sur $KONG_URL"; FAIL=1 ;;
      *)   bad "${target%%\?*} → $code, L'ANCIEN JETON EST ENCORE ACCEPTÉ"; FAIL=1 ;;
    esac
  done

  printf '\n  \033[1mLe nouveau doit fonctionner\033[0m\n'
  code="$(http_code -H "apikey: $CURRENT_SR" -H "Authorization: Bearer $CURRENT_SR" \
           "${KONG_URL}/auth/v1/admin/users?page=1&per_page=1")"
  [[ "$code" == "200" ]] && ok "admin GoTrue, nouveau service_role → 200" \
                         || { bad "admin GoTrue → $code (attendu 200)"; FAIL=1; }
  code="$(http_code -H "apikey: $NEW_ANON" "${KONG_URL}/auth/v1/settings")"
  [[ "$code" == "200" ]] && ok "nouvelle clé anon → 200" || { bad "clé anon → $code"; FAIL=1; }
  code="$(http_code -H "apikey: $PUB" "${KONG_URL}/auth/v1/settings")"
  [[ "$code" == "200" ]] && ok "clé publiable des clients → 200" || { bad "clé publiable → $code"; FAIL=1; }

  printf '\n'
  if [[ "$FAIL" == "0" ]]; then
    printf '  \033[32mLe secret exposé est cryptographiquement mort.\033[0m Les migrations\n'
    printf '  anti-abus peuvent reprendre.\n\n'
  else
    printf '  \033[31mAu moins une preuve manque. L'"'"'incident n'"'"'est pas fermé.\033[0m\n\n'
    exit 1
  fi
  exit 0
fi

# ── rotate ──────────────────────────────────────────────────────────────────

[[ "$MODE" == "--rotate" ]] || {
  printf '\nUsage : --plan | --prove-vulnerable | --rotate | --verify\n'
  printf '        les deux premiers sont en lecture seule\n\n'
  exit 1
}

section "[0] PRÉFLIGHT — aucune écriture dans cette section"
docker info >/dev/null 2>&1 || die "démon Docker injoignable"
ok "Docker répond"
# psql_q se termine par `|| true` pour ne pas tuer le script sur une requête
# ratée, donc son code de retour ne dit rien : on vérifie la RÉPONSE.
[[ "$(psql_q 'select 1')" == "1" ]] || die "base $DBC injoignable"
ok "base $DBC joignable"

# LE TEST QUI MANQUAIT. La rotation précédente a échoué ici, après avoir écrit
# le nouveau secret : `alter database ... set app.settings.*` exige le superuser
# et `postgres` ne l'est pas sur cette stack. On l'éprouve maintenant, sur un
# nom de paramètre jetable, avant la moindre écriture.
GUC_ACTION="${GUC_ACTION:-}"
GUC_EXISTS=0
guc_present && GUC_EXISTS=1
if [[ "$GUC_EXISTS" == "1" ]]; then
  READERS="$(guc_readers)"
  line "GUC app.settings.jwt_secret" "présent, ${READERS:-?} fonction(s) le lisant"
  if PSQL_ROLE="$(resolve_psql_role)"; then
    ok "rôle capable d'écrire un GUC personnalisé : $PSQL_ROLE"
  else
    PSQL_ROLE=""
    warn "aucun rôle ne peut écrire un GUC personnalisé"
  fi
  if [[ -z "$GUC_ACTION" ]]; then
    # Rien ne le lit — et pgjwt n'est pas installé, donc la base ne peut ni
    # signer ni vérifier un JWT. Le mettre à jour écrirait le NOUVEAU secret de
    # signature dans pg_db_role_setting, lisible par qui peut lire le catalogue,
    # pour personne. Le retirer est mieux : ça enlève un secret vivant d'un
    # endroit inutile. Forçable par GUC_ACTION=update|reset|skip.
    if [[ "${READERS:-0}" -gt 0 ]]; then GUC_ACTION=update; else GUC_ACTION=reset; fi
  fi
  line "action retenue sur le GUC" "$GUC_ACTION"
  if [[ "$GUC_ACTION" != "skip" && -z "$PSQL_ROLE" ]]; then
    die "GUC_ACTION=$GUC_ACTION impossible sans rôle superuser — relance avec GUC_ACTION=skip pour roter sans y toucher (rien ne le lit), ou donne PSQL_ROLE=<rôle>"
  fi
  OLD_GUC="$(guc_value)"
  [[ -n "$OLD_GUC" ]] || warn "valeur du GUC illisible — la restauration ne pourra pas le remettre"
else
  GUC_ACTION=skip
  OLD_GUC=""
  warn "aucun GUC app.settings.jwt_secret — rien à faire de ce côté"
fi
[[ "$(http_code "${KONG_URL}/auth/v1/settings" -H "apikey: $(value_of SUPABASE_PUBLISHABLE_KEY)")" == "200" ]] \
  || warn "Kong ne répond pas 200 sur /auth/v1/settings — vérifie avant de continuer"

# Le point le plus important de cette section. Sans --env-file, Compose peut
# résoudre un autre .env selon sa version et le répertoire courant, et les
# interpolations obligatoires du compose feraient échouer la recréation APRÈS
# l'écriture du nouveau secret.
"${COMPOSE[@]}" config --quiet 2>/dev/null \
  || die "compose invalide avec --env-file $ENV_FILE — rien n'a été modifié"
ok "compose valide avec --env-file explicite"

OLD_ANON="$(value_of ANON_KEY)"; OLD_SR="$(value_of SERVICE_ROLE_KEY)"; OLD_JWT="$(value_of JWT_SECRET)"
[[ -n "$OLD_ANON" && -n "$OLD_SR" && -n "$OLD_JWT" ]] \
  || die "JWT_SECRET, ANON_KEY ou SERVICE_ROLE_KEY absent de $ENV_FILE"
ok "les trois variables à roter sont présentes"

discover_services
if [[ ${#SKIPPED[@]} -gt 0 ]]; then for sk in "${SKIPPED[@]}"; do warn "$sk"; done; fi
[[ ${#RUNNING[@]} -gt 0 ]] || die "aucun service en marche à recréer — état inattendu"
ok "à recréer : ${RUNNING[*]}"

WAIT_ARGS=()
if "${COMPOSE[@]}" up --help 2>/dev/null | grep -q -- '--wait'; then
  WAIT_ARGS=(--wait --wait-timeout "$WAIT_TIMEOUT")
  ok "attente des healthchecks disponible (--wait)"
else
  warn "compose sans --wait : attente par sondage après recréation"
fi

section "[1] CONFIRMATION"
printf '  Cette rotation invalide immédiatement tous les access tokens en cours.\n'
printf '  Les sessions se rétablissent par refresh. Services recréés : %s.\n\n' "${#RUNNING[@]}"
read -r -p "  Taper ROTATE pour continuer : " answer
[[ "$answer" == "ROTATE" ]] || { printf '\n  Annulé, rien n'"'"'a été modifié.\n\n'; exit 0; }

section "[2] SAUVEGARDE"
install -d -m 700 "$SECRET_BACKUP_DIR" || die "impossible de préparer $SECRET_BACKUP_DIR"
BACKUP="$SECRET_BACKUP_DIR/env.$(date +%Y%m%d%H%M%S)"
cp -p -- "$ENV_FILE" "$BACKUP" || die "sauvegarde impossible — rien n'a été modifié"
chmod 600 -- "$BACKUP" || die "chmod 600 impossible sur la sauvegarde"
[[ -s "$BACKUP" ]] || die "sauvegarde vide — rien n'a été modifié"
ok "$(basename "$BACKUP") — l'ancien jeton y reste, pour prouver sa révocation"

section "[3] NOUVEAU SECRET, JETONS RE-SIGNÉS EN MÉMOIRE"
NEW_JWT="$(head -c 64 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
[[ ${#NEW_JWT} -ge 64 ]] || die "secret généré trop court (${#NEW_JWT})"
NEW_ANON="$(resign_jwt "$OLD_ANON" "$NEW_JWT")" || die "re-signature de ANON_KEY impossible"
NEW_SR="$(resign_jwt "$OLD_SR" "$NEW_JWT")" || die "re-signature de SERVICE_ROLE_KEY impossible"
[[ "$NEW_ANON" != "$OLD_ANON" && "$NEW_SR" != "$OLD_SR" ]] || die "jetons re-signés identiques — abandon"
line "JWT_SECRET" "${#NEW_JWT} octets, empreinte $(fingerprint_of "$NEW_JWT")"
line "ANON_KEY" "$(claims_of "$NEW_ANON")"
line "SERVICE_ROLE_KEY" "$(claims_of "$NEW_SR")"
ok "claims identiques, signature nouvelle"

# ── barrière de rollback ────────────────────────────────────────────────────
# Armée juste avant la première écriture. Tant qu'aucun conteneur n'a été
# recréé, toute sortie anormale restaure le .env et le GUC automatiquement :
# pendant un incident on ne veut pas dépendre d'une restauration manuelle sous
# pression. Une fois la recréation commencée, revenir en arrière n'est plus le
# bon geste — il faut finir vers l'avant — donc le trap se contente d'expliquer.
ROTATION_COMMITTED=0
ROTATION_DONE=0
on_exit() {
  local rc=$?
  [[ "$ROTATION_DONE" == "1" ]] && return 0
  if [[ "$ROTATION_COMMITTED" == "1" ]]; then
    printf '\n\033[31mÉchec APRÈS le début de la recréation (code %s).\033[0m\n' "$rc" >&2
    printf 'Ne restaure pas en arrière : la stack est mixte. Termine vers l'"'"'avant —\n' >&2
    printf 'relance la recréation, puis --verify :\n\n' >&2
    printf '    %s up -d --force-recreate --no-deps %s\n\n' "${COMPOSE[*]}" "${RUNNING[*]}" >&2
    return 0
  fi
  printf '\n\033[33mÉchec avant toute recréation (code %s) — restauration automatique.\033[0m\n' "$rc" >&2
  if cp -p -- "$BACKUP" "$ENV_FILE" 2>/dev/null; then
    chmod 600 -- "$ENV_FILE" 2>/dev/null || true
    printf '  .env restauré depuis %s\n' "$(basename "$BACKUP")" >&2
  else
    printf '  ÉCHEC de la restauration du .env — restaure à la main depuis %s\n' "$BACKUP" >&2
  fi
  # Restaure la valeur d'ORIGINE lue au préflight, pas OLD_JWT : si le GUC
  # portait autre chose que le secret courant, le remettre à OLD_JWT aurait été
  # une deuxième modification déguisée en restauration.
  if [[ "${GUC_TOUCHED:-0}" == "1" ]]; then
    if [[ -n "${OLD_GUC:-}" ]] && set_guc "$OLD_GUC" >/dev/null 2>&1; then
      printf '  GUC app.settings.jwt_secret remis à sa valeur d'"'"'origine\n' >&2
    else
      printf '  ÉCHEC de la restauration du GUC — à traiter manuellement\n' >&2
    fi
  fi
  printf '  Aucun conteneur n'"'"'a été recréé : la production tourne sur l'"'"'ancien secret.\n\n' >&2
}
trap on_exit EXIT

section "[4] ÉCRITURE, SOUS ROLLBACK AUTOMATIQUE"
replace_var JWT_SECRET "$NEW_JWT" || die "écriture de JWT_SECRET impossible"
replace_var ANON_KEY "$NEW_ANON" || die "écriture de ANON_KEY impossible"
replace_var SERVICE_ROLE_KEY "$NEW_SR" || die "écriture de SERVICE_ROLE_KEY impossible"
chmod 600 -- "$ENV_FILE" || die "chmod 600 impossible sur $ENV_FILE"
ok "$ENV_FILE mis à jour"

case "$GUC_ACTION" in
  update)
    set_guc "$NEW_JWT" || die "mise à jour du GUC impossible"
    GUC_TOUCHED=1
    ok "app.settings.jwt_secret mis à jour"
    ;;
  reset)
    reset_guc || die "retrait du GUC impossible"
    GUC_TOUCHED=1
    ok "app.settings.jwt_secret retiré — personne ne le lisait, et il n'a plus à porter un secret vivant"
    ;;
  skip)
    warn "GUC laissé tel quel (GUC_ACTION=skip)"
    ;;
esac

# Dernier filet avant le point de non-retour : le compose doit toujours valider
# avec le NOUVEAU .env. S'il ne valide pas, le rollback est encore possible.
"${COMPOSE[@]}" config --quiet 2>/dev/null \
  || die "compose invalide avec le nouveau .env — rollback automatique"
ok "compose valide avec le nouveau .env"

section "[5] RECRÉATION"
printf '  Point de non-retour. Recréation parallèle de : %s\n' "${RUNNING[*]}"
ROTATION_COMMITTED=1
"${COMPOSE[@]}" up -d --force-recreate --no-deps "${WAIT_ARGS[@]}" "${RUNNING[@]}" \
  || die "la recréation a échoué"
ok "${#RUNNING[@]} service(s) recréé(s)"

if [[ ${#WAIT_ARGS[@]} -eq 0 ]]; then
  printf '  Attente des healthchecks par sondage (%s s max)…\n' "$WAIT_TIMEOUT"
  deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  while :; do
    unhealthy=0
    for svc in "${RUNNING[@]}"; do
      cid="$({ "${COMPOSE[@]}" ps -q "$svc" 2>/dev/null || true; } | head -n 1)"
      [[ -n "$cid" ]] || { unhealthy=1; continue; }
      st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null)"
      [[ "$st" == "healthy" || "$st" == "running" ]] || unhealthy=1
    done
    [[ "$unhealthy" == "0" ]] && { ok "tous les services répondent"; break; }
    [[ "$(date +%s)" -ge "$deadline" ]] && { warn "délai dépassé — certains services ne sont pas prêts"; break; }
    sleep 3
  done
fi

section "[6] LE NOUVEAU SECRET EST-IL ARRIVÉ"
NEW_FP="$(fingerprint_of "$NEW_JWT")"
MISMATCH=0
for svc in "${RUNNING[@]}"; do
  cid="$({ "${COMPOSE[@]}" ps -q "$svc" 2>/dev/null || true; } | head -n 1)"
  [[ -n "$cid" ]] || { warn "$svc sans conteneur"; continue; }
  got="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cid" \
          | sed -n 's/^JWT_SECRET=//p;s/^GOTRUE_JWT_SECRET=//p;s/^PGRST_JWT_SECRET=//p;s/^AUTH_JWT_SECRET=//p;s/^API_JWT_SECRET=//p' \
          | head -n 1)"
  if [[ -z "$got" ]]; then
    line "$svc" "pas de JWT_SECRET direct"
  elif [[ "$(fingerprint_of "$got")" == "$NEW_FP" ]]; then
    ok "$svc porte le nouveau secret"
  else
    bad "$svc porte encore l'ancien — recréation à refaire"; MISMATCH=1
  fi
done

ROTATION_DONE=1
trap - EXIT
if [[ "$MISMATCH" == "1" ]]; then
  printf '\n\033[31mAu moins un service porte encore l'"'"'ancien secret.\033[0m Termine vers\n'
  printf 'l'"'"'avant avant de conclure quoi que ce soit.\n\n'
  exit 1
fi

printf '\n\033[1mRotation appliquée.\033[0m La preuve, maintenant :\n'
printf '\n    bash %s --verify\n\n' "$(basename "${BASH_SOURCE[0]}")"
printf '  Elle exige un 401 sur l'"'"'ancien jeton — GoTrue admin ET PostgREST — et\n'
printf '  un 200 sur le nouveau. Sans ces quatre preuves, l'"'"'incident reste ouvert.\n\n'
