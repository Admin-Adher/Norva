#!/usr/bin/env bash
# =============================================================================
# rotate-jwt-secret.sh — révocation réelle du service_role exposé
# =============================================================================
#   bash ops/hetzner/scripts/rotate-jwt-secret.sh --plan     # rien n'est touché
#   bash ops/hetzner/scripts/rotate-jwt-secret.sh --rotate
#   bash ops/hetzner/scripts/rotate-jwt-secret.sh --verify
#
# POURQUOI LA ROTATION ET RIEN D'AUTRE. Le JWT service_role exposé est accepté
# par tout amont qui vérifie avec JWT_SECRET, et kong-entrypoint.sh transmet
# n'importe quel `Authorization` ne commençant pas par « Bearer sb_ » tel quel.
# Vingt routes appliquent ce transform, neuf admettent le consumer anon, et la
# clé publiable dont l'appelant a besoin est publique par conception. Il n'existe
# pas de route /auth/v1/admin dédiée, donc l'API d'administration GoTrue est
# derrière la route générique qui admet anon, avec
# GOTRUE_JWT_ADMIN_ROLES=service_role.
#
# Retirer le credential du consumer Kong ne révoque rien : l'attaque ne présente
# jamais ce credential en apikey. Un garde PGRST_DB_PRE_REQUEST fermerait
# PostgREST de façon prouvable, mais laisserait GoTrue admin, Storage et
# Realtime ouverts. Le diagnostic a montré SERVICE_ROLE_KEY_ASYMMETRIC et
# SUPABASE_SECRET_KEY VIDES : il n'existe aucune clé asymétrique, donc la bascule
# vers sb_secret_ est un projet de migration de clés de signature, pas une
# réponse à incident. Reste la rotation, qui est la seule remédiation
# n'exigeant aucune preuve d'exhaustivité.
#
# CE QUE ÇA COÛTE, MESURÉ. Les clients envoient sb_publishable_ (clé opaque, pas
# un JWT) donc aucun redéploiement client. Les refresh tokens sont des lignes
# opaques de auth.refresh_tokens et survivent. cloudApi.js:922 réessaie déjà une
# fois à travers un refresh sur 401. Les crons s'authentifient par un secret
# Vault. Coût attendu : un 401 par session vivante, auto-réparé.
#
# LES NOUVEAUX JETONS GARDENT LES CLAIMS DES ANCIENS, seulement re-signés. Le
# payload d'un JWT anon/service_role n'est pas un secret — c'est la signature qui
# fait sa validité — donc on le recopie à l'identique pour éliminer tout risque
# d'incompatibilité sur iss, aud, role ou exp.
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
MODE="${1:-}"

# db est délibérément absent : son JWT_SECRET ne sert qu'aux scripts d'init du
# premier démarrage. Le GUC en base est mis à jour en SQL, pas en recréant la
# base de données.
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
fingerprint_of() {
  local v="$1"
  [[ -n "$v" ]] || { printf 'ABSENT'; return; }
  printf '%s' "$v" | sha256sum | cut -c1-12
}

# Le payload d'un JWT n'est pas un secret. On le lit pour décrire les claims et
# pour les recopier. Ni la signature ni la clé ne sont touchées.
claims_of() {
  local jwt="$1" payload
  payload="$(cut -d. -f2 <<<"$jwt")"
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
' "$payload"
}

# Re-signe un JWT existant avec un nouveau secret, en gardant son payload EXACT.
# Le secret arrive sur stdin ; il n'apparaît jamais dans argv.
resign_jwt() {
  local jwt="$1" secret="$2"
  printf '%s' "$secret" | python3 -c '
import sys, hmac, hashlib, base64
secret = sys.stdin.buffer.read()
old = sys.argv[1]
parts = old.split(".")
if len(parts) != 3:
    sys.exit("jwt malforme")
header, payload = parts[0], parts[1]
signing_input = (header + "." + payload).encode()
sig = hmac.new(secret, signing_input, hashlib.sha256).digest()
sys.stdout.write(header + "." + payload + "." + base64.urlsafe_b64encode(sig).decode().rstrip("="))
' "$jwt"
}

replace_var() {
  local name="$1" value="$2" tmp
  tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")" || die "mktemp a échoué"
  trap 'rm -f -- "${tmp:-}"' EXIT INT TERM
  chmod 600 -- "$tmp" || die "chmod 600 impossible"
  { grep -v "^${name}=" "$ENV_FILE" || true; } > "$tmp" || die "écriture impossible"
  printf '%s=%s\n' "$name" "$value" >> "$tmp" || die "écriture de $name impossible"
  grep -q "^${name}=." "$tmp" || die "$name absent du fichier écrit — $ENV_FILE intact"
  mv -- "$tmp" "$ENV_FILE" || die "remplacement impossible"
  trap - EXIT INT TERM
}

# ── plan ────────────────────────────────────────────────────────────────────

if [[ "$MODE" == "--plan" ]]; then
  section "ÉTAT ACTUEL — rien n'est modifié"
  OLD_JWT="$(value_of JWT_SECRET)"
  OLD_ANON="$(value_of ANON_KEY)"
  OLD_SR="$(value_of SERVICE_ROLE_KEY)"
  line "JWT_SECRET" "$([[ -n "$OLD_JWT" ]] && echo "${#OLD_JWT} octets, empreinte $(fingerprint_of "$OLD_JWT")" || echo ABSENT)"
  line "ANON_KEY" "$([[ -n "$OLD_ANON" ]] && claims_of "$OLD_ANON" || echo ABSENT)"
  line "SERVICE_ROLE_KEY" "$([[ -n "$OLD_SR" ]] && claims_of "$OLD_SR" || echo ABSENT)"

  section "CE QUI SERA FAIT"
  printf '  1. sauvegarde du .env dans %s (700/600)\n' "$SECRET_BACKUP_DIR"
  printf '  2. nouveau JWT_SECRET (64 octets urandom, base64url)\n'
  printf '  3. ANON_KEY et SERVICE_ROLE_KEY re-signés, claims INCHANGÉS\n'
  printf '  4. GUC app.settings.jwt_secret mis à jour en SQL si présent\n'
  printf '  5. recréation de : %s\n' "${SERVICES[*]}"
  printf '  6. vérification, dont la preuve que l'"'"'ancien Bearer est mort\n'

  section "CE QUI N'EST PAS TOUCHÉ"
  printf '  — le conteneur db (son JWT_SECRET ne sert qu%s l'"'"'init du 1er boot)\n' "'à"
  printf '  — sb_publishable_ côté clients : clé opaque, aucun redéploiement\n'
  printf '  — auth.refresh_tokens : lignes opaques, les sessions se rétablissent\n'
  printf '  — les crons : ils utilisent norva_cron_shared_secret du Vault\n'

  section "IMPACT MESURÉ"
  line "refresh tokens vivants" "$(docker exec -i "$DBC" psql -U postgres -d postgres -tAc 'select count(*) from auth.refresh_tokens where revoked = false' 2>/dev/null)"
  line "sessions actives 24 h" "$(docker exec -i "$DBC" psql -U postgres -d postgres -tAc "select count(distinct user_id) from auth.refresh_tokens where created_at > now() - interval '24 hours'" 2>/dev/null)"
  printf '\n  Chacune prendra un 401 puis se rétablira par refresh.\n\n'
  exit 0
fi

# ── verify ──────────────────────────────────────────────────────────────────

if [[ "$MODE" == "--verify" ]]; then
  section "PREUVE DE RÉVOCATION"
  CURRENT_SR="$(value_of SERVICE_ROLE_KEY)"
  BACKUP=""; OLD_SR=""
  for candidate in $(ls -1t "$SECRET_BACKUP_DIR"/env.* 2>/dev/null); do
    cand_sr="$(sed -n 's/^SERVICE_ROLE_KEY=//p' "$candidate" | tail -n 1)"
    if [[ -n "$cand_sr" && "$cand_sr" != "$CURRENT_SR" ]]; then
      BACKUP="$candidate"; OLD_SR="$cand_sr"; break
    fi
  done
  [[ -n "$OLD_SR" ]] || die "aucune sauvegarde ne contient un SERVICE_ROLE_KEY different de l'actuel dans $SECRET_BACKUP_DIR — rien a tester (rotation deja verifiee, ou pas encore faite)"
  PUB="$(value_of SUPABASE_PUBLISHABLE_KEY)"
  ok "ancien jeton lu dans $(basename "$BACKUP")"
  [[ -n "$PUB" ]] || die "SUPABASE_PUBLISHABLE_KEY absent — nécessaire pour reproduire l'attaque"
  printf '  L'"'"'ancien jeton est lu depuis la sauvegarde : personne n'"'"'a à le manipuler.\n'

  # Exactement l'attaque décrite : clé publique en apikey, ancien jeton en Bearer.
  #
  # Le choix des cibles n'est pas cosmétique. Une première version sondait
  # /rest/v1/ — or cette route exacte est matchée par rest-v1-openapi, dont
  # l'ACL n'autorise que le consumer `admin`. Le consumer anon y recevait donc
  # un 403 de l'ACL quelle que soit la validité du jeton, et la version
  # précédente acceptait 401 OU 403 : elle aurait annoncé une révocation sans
  # rien avoir prouvé. Une assertion qui passe pour la mauvaise raison ne
  # prouve rien.
  #
  # /rest/v1/<table inexistante> passe par rest-v1-all, qui autorise anon, donc
  # seul le JWT peut décider. Cela distingue l'authentification de
  # l'autorisation :
  #
  #   404  PostgREST a ACCEPTÉ le jeton, la table n'existe pas → jeton VIVANT
  #   401  signature refusée                                   → jeton MORT
  #
  # D'où l'exigence d'un 401 STRICT, jamais « 401 ou 403 ».
  probe='/rest/v1/norva_revocation_probe_absente?limit=1'
  dead=0; alive=0
  for target in "$probe" "/auth/v1/admin/users?page=1&per_page=1"; do
    code="$(curl -s -o /dev/null -w '%{http_code}' \
      -H "apikey: $PUB" -H "Authorization: Bearer $OLD_SR" \
      "${KONG_URL}${target}" || echo 000)"
    case "$code" in
      401) ok  "${target%%\?*} → 401 — signature refusée, l'ancien jeton est MORT"; dead=$((dead+1)) ;;
      403) bad "${target%%\?*} → 403 — refus d'ACL, pas de preuve sur le jeton" ;;
      000) bad "${target%%\?*} → aucune réponse — Kong joignable sur $KONG_URL ?" ;;
      *)   bad "${target%%\?*} → $code — L'ANCIEN JETON EST ENCORE ACCEPTÉ"; alive=$((alive+1)) ;;
    esac
  done

  if [[ "$alive" -gt 0 ]]; then
    printf '\n  \033[31mLancé AVANT la rotation, c'"'"'est le résultat attendu et cela\n'
    printf '  confirme la vulnérabilité. Lancé APRÈS, la rotation a échoué.\033[0m\n'
  elif [[ "$dead" -eq 2 ]]; then
    printf '\n  \033[32mLes deux surfaces refusent l'"'"'ancien jeton.\033[0m\n'
  fi

  section "LE NOUVEAU JETON FONCTIONNE"
  NEW_SR="$(value_of SERVICE_ROLE_KEY)"
  code="$(curl -s -o /dev/null -w '%{http_code}' \
    -H "apikey: $NEW_SR" -H "Authorization: Bearer $NEW_SR" \
    "${KONG_URL}/auth/v1/admin/users?page=1&per_page=1" || echo 000)"
  [[ "$code" == "200" ]] && ok "admin GoTrue avec le nouveau jeton → 200" \
                         || bad "admin GoTrue → HTTP $code (attendu 200)"

  code="$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $(value_of ANON_KEY)" "${KONG_URL}/auth/v1/settings" || echo 000)"
  [[ "$code" == "200" ]] && ok "nouvelle clé anon acceptée → 200" || bad "clé anon → HTTP $code"
  printf '\n'
  exit 0
fi

# ── rotate ──────────────────────────────────────────────────────────────────

[[ "$MODE" == "--rotate" ]] || { printf '\nUsage : --plan | --rotate | --verify\n\n'; exit 1; }

section "[0] CONFIRMATION"
printf '  Cette rotation invalide immédiatement TOUS les access tokens en cours.\n'
printf '  Les sessions se rétablissent par refresh, mais c'"'"'est une opération de\n'
printf '  production. Lance --plan d'"'"'abord si ce n'"'"'est pas déjà fait.\n\n'
read -r -p "  Taper ROTATE pour continuer : " answer
[[ "$answer" == "ROTATE" ]] || { printf '\n  Annulé, rien n'"'"'a été modifié.\n\n'; exit 0; }

section "[1] SAUVEGARDE"
install -d -m 700 "$SECRET_BACKUP_DIR" || die "impossible de préparer $SECRET_BACKUP_DIR"
BACKUP="$SECRET_BACKUP_DIR/env.$(date +%Y%m%d%H%M%S)"
cp -p -- "$ENV_FILE" "$BACKUP" || die "sauvegarde impossible — rien n'a été modifié"
chmod 600 -- "$BACKUP" || die "chmod 600 impossible sur la sauvegarde"
[[ -s "$BACKUP" ]] || die "sauvegarde vide — rien n'a été modifié"
ok "$(basename "$BACKUP") — l'ancien jeton y reste, pour prouver sa révocation"

section "[2] NOUVEAU SECRET ET JETONS RE-SIGNÉS"
OLD_ANON="$(value_of ANON_KEY)"
OLD_SR="$(value_of SERVICE_ROLE_KEY)"
[[ -n "$OLD_ANON" && -n "$OLD_SR" ]] || die "ANON_KEY ou SERVICE_ROLE_KEY absent de $ENV_FILE"

NEW_JWT="$(head -c 64 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
[[ ${#NEW_JWT} -ge 64 ]] || die "secret généré trop court (${#NEW_JWT})"
NEW_ANON="$(resign_jwt "$OLD_ANON" "$NEW_JWT")" || die "re-signature de ANON_KEY impossible"
NEW_SR="$(resign_jwt "$OLD_SR" "$NEW_JWT")" || die "re-signature de SERVICE_ROLE_KEY impossible"
[[ "$NEW_ANON" != "$OLD_ANON" && "$NEW_SR" != "$OLD_SR" ]] || die "les jetons re-signés sont identiques aux anciens — abandon"

line "JWT_SECRET" "${#NEW_JWT} octets, empreinte $(fingerprint_of "$NEW_JWT")"
line "ANON_KEY" "$(claims_of "$NEW_ANON")"
line "SERVICE_ROLE_KEY" "$(claims_of "$NEW_SR")"
ok "claims identiques aux anciens, signature nouvelle"

section "[3] ÉCRITURE"
replace_var JWT_SECRET "$NEW_JWT"
replace_var ANON_KEY "$NEW_ANON"
replace_var SERVICE_ROLE_KEY "$NEW_SR"
chmod 600 -- "$ENV_FILE" || die "chmod 600 impossible sur $ENV_FILE"
ok "$ENV_FILE mis à jour"

section "[4] GUC EN BASE"
GUC_COUNT="$(docker exec -i "$DBC" psql -U postgres -d postgres -tAc \
  "select count(*) from pg_db_role_setting s, unnest(s.setconfig) c where c like 'app.settings.jwt_secret=%'" 2>/dev/null || echo 0)"
if [[ "${GUC_COUNT:-0}" -gt 0 ]]; then
  # La valeur passe par stdin, jamais par argv ni par l'historique psql.
  printf "alter database postgres set \"app.settings.jwt_secret\" = %s;\n" "$(printf '%s' "$NEW_JWT" | sed "s/'/''/g; s/^/'/; s/$/'/")" \
    | docker exec -i "$DBC" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
    && ok "app.settings.jwt_secret mis à jour ($GUC_COUNT réglage(s) trouvé(s))" \
    || die "mise à jour du GUC impossible — .env déjà modifié, sauvegarde en $BACKUP"
else
  warn "aucun GUC app.settings.jwt_secret — rien à mettre à jour"
fi

section "[5] RECREATION"
# Recreer, pas redemarrer : `docker restart` relance le conteneur avec son
# ancien environnement.
#
# On ne recree QUE ce qui tourne deja. Un `compose up` sur un service arrete le
# DEMARRERAIT, et « realtime » comme « resend-contact-worker » peuvent etre
# volontairement a l'arret sur cette box — les allumer au passage serait un
# changement d'etat que personne n'a demande.
RUNNING=()
SKIPPED=()
for svc in "${SERVICES[@]}"; do
  grep -qE "^  ${svc}:" "$COMPOSE_FILE" || { SKIPPED+=("$svc (absent du compose)"); continue; }
  cname="$(docker compose -f "$COMPOSE_FILE" ps -q "$svc" 2>/dev/null | head -n 1)"
  if [[ -n "$cname" ]] && [[ "$(docker inspect -f '{{.State.Running}}' "$cname" 2>/dev/null)" == "true" ]]; then
    RUNNING+=("$svc")
  else
    SKIPPED+=("$svc (a l'arret — laisse tel quel)")
  fi
done

[[ ${#SKIPPED[@]} -gt 0 ]] && for sk in "${SKIPPED[@]}"; do warn "$sk"; done
[[ ${#RUNNING[@]} -gt 0 ]] || die "aucun service en marche a recreer — etat inattendu, .env deja modifie, sauvegarde en $BACKUP"

# Un seul appel : Compose parallelise, ce qui raccourcit la fenetre pendant
# laquelle certains conteneurs portent le nouveau secret et d'autres l'ancien.
# Dans cette fenetre, un appel edge -> PostgREST peut prendre un 401.
printf '  recreation en parallele de : %s
' "${RUNNING[*]}"
docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-deps "${RUNNING[@]}"   || die "la recreation a echoue — .env deja modifie, sauvegarde en $BACKUP"
ok "${#RUNNING[@]} service(s) recree(s)"

section "[6] LE NOUVEL ENVIRONNEMENT EST-IL ARRIVÉ"
NEW_FP="$(fingerprint_of "$NEW_JWT")"
for c in norva-kong norva-auth norva-rest norva-storage \
         norva-edge-functions norva-edge-functions-2 norva-studio; do
  docker inspect "$c" >/dev/null 2>&1 || { warn "$c absent"; continue; }
  got="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c" \
          | sed -n 's/^JWT_SECRET=//p;s/^GOTRUE_JWT_SECRET=//p;s/^PGRST_JWT_SECRET=//p;s/^AUTH_JWT_SECRET=//p' \
          | head -n 1)"
  if [[ -z "$got" ]]; then
    line "$c" "pas de JWT_SECRET direct (normal pour certains)"
  elif [[ "$(fingerprint_of "$got")" == "$NEW_FP" ]]; then
    ok "$c porte le nouveau secret"
  else
    bad "$c porte encore l'ancien secret — recréation à refaire"
  fi
done

printf '\n\033[1mRotation appliquée.\033[0m Lance maintenant la preuve :\n'
printf '\n    bash %s --verify\n\n' "$(basename "${BASH_SOURCE[0]}")"
printf '  Elle rejoue l'"'"'attaque exacte — clé publique en apikey, ancien jeton en\n'
printf '  Bearer — contre /rest/v1/ ET /auth/v1/admin/users, et exige un 401.\n\n'
