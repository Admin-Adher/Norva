#!/usr/bin/env bash
# =============================================================================
# diagnose-jwt-architecture.sh — quelle révocation du service_role est possible
# =============================================================================
#   bash ops/hetzner/scripts/diagnose-jwt-architecture.sh
#
# LECTURE SEULE, ET AUCUNE VALEUR N'EST IMPRIMÉE. Ce script ne rapporte que des
# FORMES : une longueur, un algorithme lu dans un en-tête JWT, un nom de rôle,
# un compteur. Jamais un secret, jamais un JWT, jamais un fragment de clé.
#
# Il lit l'environnement par `docker inspect`, PAS par `docker exec printenv`.
# La première version faisait l'inverse et rapportait « ABSENTE » pour
# PGRST_JWT_SECRET — non pas parce que la variable manquait, mais parce que
# l'image PostgREST est distroless et n'embarque aucun binaire. Un échec de
# mesure présenté comme un fait, exactement le défaut qu'on venait de corriger
# dans la fumigation des migrations. Une mesure impossible dit maintenant
# NON MESURABLE et ne répond pas à la question à la place de la mesure.
# =============================================================================
set -uo pipefail

DBC="${DB_CONTAINER:-norva-db}"
KONGC="${KONG_CONTAINER:-norva-kong}"
RESTC="${REST_CONTAINER:-norva-rest}"
AUTHC="${AUTH_CONTAINER:-norva-auth}"
KONG_YML="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../volumes/api/kong.yml"

section() { printf '\n\033[1m================ %s ================\033[0m\n' "$1"; }
line() { printf '  %-40s %s\n' "$1" "$2"; }
psql() { docker exec -i "$DBC" psql -U postgres -d postgres -P pager=off -tAc "$1" 2>/dev/null; }

# Vide l'environnement d'un conteneur. La valeur traverse les pipelines mais
# n'est jamais imprimée.
env_dump_of() {
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null
}

# Rapporte la FORME d'une variable, ou pourquoi la mesure a échoué.
shape_of() {
  local container="$1" var="$2" dump value n
  docker inspect "$container" >/dev/null 2>&1 || { printf 'CONTENEUR ABSENT'; return; }
  dump="$(env_dump_of "$container")" || { printf 'NON MESURABLE'; return; }
  [[ -n "$dump" ]] || { printf 'NON MESURABLE'; return; }
  grep -q "^${var}=" <<<"$dump" || { printf 'NON DEFINIE'; return; }
  value="$(sed -n "s/^${var}=//p" <<<"$dump" | head -n 1)"
  [[ -n "$value" ]] || { printf 'VIDE'; return; }
  n=${#value}
  if [[ "${value:0:1}" == "{" ]]; then
    if grep -q '"keys"' <<<"$value"; then
      printf 'JWKS — JSON avec "keys" (%s octets)' "$n"
    else
      printf 'JSON sans "keys" (%s octets)' "$n"
    fi
  elif [[ "$value" == eyJ* ]]; then
    # Seul l'en-tête est décodé, pour l'algorithme. Il ne contient aucun secret.
    # Le payload et la signature ne sont jamais touchés.
    local alg
    alg="$(tr '_-' '/+' <<<"${value%%.*}" | base64 -d 2>/dev/null \
            | grep -o '"alg":"[^"]*"' | cut -d'"' -f4)"
    printf 'JWT alg=%s (%s octets)' "${alg:-inconnu}" "$n"
  elif [[ "$value" == sb_secret_* ]]; then
    printf 'cle opaque sb_secret_ (%s octets)' "$n"
  elif [[ "$value" == sb_publishable_* ]]; then
    printf 'cle opaque sb_publishable_ (%s octets)' "$n"
  else
    printf 'chaine opaque (%s octets)' "$n"
  fi
}

# Valeur brute, réservée aux variables NON sensibles (durées, noms de rôle).
plain_of() {
  local dump; dump="$(env_dump_of "$1")" || { printf 'NON MESURABLE'; return; }
  grep -q "^${2}=" <<<"$dump" || { printf 'NON DEFINIE'; return; }
  sed -n "s/^${2}=//p" <<<"$dump" | head -n 1
}

section "[1] LA QUESTION QUI DECIDE — verification JWT de PostgREST"
line "PGRST_JWT_SECRET" "$(shape_of "$RESTC" PGRST_JWT_SECRET)"
line "PGRST_JWT_SECRET_IS_BASE64" "$(plain_of "$RESTC" PGRST_JWT_SECRET_IS_BASE64)"
line "PGRST_JWT_AUD" "$(plain_of "$RESTC" PGRST_JWT_AUD)"
printf '\n  « JWT alg=… » ou « chaine opaque » = symetrique. « JWKS » = asymetrique.\n'

section "[2] LES CLES EN PLACE, PAR FORME"
for v in SUPABASE_ANON_KEY SUPABASE_SERVICE_KEY SUPABASE_PUBLISHABLE_KEY \
         SUPABASE_SECRET_KEY ANON_KEY_ASYMMETRIC SERVICE_ROLE_KEY_ASYMMETRIC; do
  line "$v (kong)" "$(shape_of "$KONGC" "$v")"
done
printf '\n  Lecture de kong-entrypoint.sh : la branche de traduction complete exige\n'
printf '  SUPABASE_SECRET_KEY ET SUPABASE_PUBLISHABLE_KEY non vides. Si SECRET_KEY\n'
printf '  est VIDE, c'"'"'est la branche legacy qui tourne — aucune traduction, et\n'
printf '  l'"'"'expression se reduit a « Authorization tel quel, sinon apikey ».\n'

section "[3] CE QUE L'EDGE RECOIT VRAIMENT"
for c in norva-edge-functions norva-edge-functions-2; do
  line "SUPABASE_SERVICE_ROLE_KEY ($c)" "$(shape_of "$c" SUPABASE_SERVICE_ROLE_KEY)"
  line "SUPABASE_SECRET_KEY ($c)" "$(shape_of "$c" SUPABASE_SECRET_KEY)"
done

section "[4] LE COUT REEL D'UNE ROTATION"
line "duree de vie access token (s)" "$(plain_of "$AUTHC" GOTRUE_JWT_EXP)"
line "roles admin GoTrue" "$(plain_of "$AUTHC" GOTRUE_JWT_ADMIN_ROLES)"
line "refresh tokens vivants" "$(psql 'select count(*) from auth.refresh_tokens where revoked = false')"
line "sessions actives 24 h" "$(psql "select count(distinct user_id) from auth.refresh_tokens where created_at > now() - interval '24 hours'")"
line "utilisateurs au total" "$(psql 'select count(*) from auth.users')"
printf '\n  Les refresh tokens sont des lignes opaques de auth.refresh_tokens : ils ne\n'
printf '  sont pas signes avec JWT_SECRET et SURVIVENT a une rotation. Le client web\n'
printf '  rafraichit deja de facon transparente sur 401 (public/js/cloudApi.js:922).\n'
printf '  Le cout attendu est un 401 par session vivante, pas une deconnexion.\n'

section "[5] QUI DEPEND DE JWT_SECRET, ET DEVRA ETRE RECREE"
# Recree, pas redemarre : un changement d'environnement n'est pris en compte
# qu'a la recreation du conteneur. `docker restart` relance l'ancien env.
for c in $(docker ps -a --format '{{.Names}}' | sort); do
  n="$(env_dump_of "$c" | grep -cE '^([A-Z_]*JWT_SECRET|.*JWT_ADMIN.*|.*ANON_KEY.*|.*SERVICE_(ROLE_)?KEY.*)=' || true)"
  [[ "${n:-0}" -gt 0 ]] && line "$c" "$n variable(s) concernee(s)"
done

section "[6] CE QUI NE DEPEND PAS DE JWT_SECRET"
line "jobs pg_cron actifs" "$(psql 'select count(*) from cron.job where active')"
line "secrets Vault" "$(psql 'select count(*) from vault.secrets')"
printf '\n  Les crons s'"'"'authentifient aupres de l'"'"'edge avec norva_cron_shared_secret\n'
printf '  tire du Vault, pas avec un JWT service_role.\n'

section "[7] LA SURFACE DU JETON EXPOSE"
line "routes qui transmettent Authorization" "$(grep -c 'Authorization: \$LUA_AUTH_EXPR' "$KONG_YML" 2>/dev/null || echo '?')"
line "routes qui admettent anon" "$(grep -A 4 'allow:' "$KONG_YML" 2>/dev/null | grep -c '\- anon' || echo '?')"
line "route /auth/v1/admin dediee" "$(grep -qE 'auth/v1/admin' "$KONG_YML" 2>/dev/null && echo 'oui' || echo 'NON — admin derriere /auth/v1/ qui admet anon')"
printf '\n  Mecanique, pour que personne ne la redecouvre : kong-entrypoint.sh fait\n'
printf '  passer tout Authorization qui ne commence pas par « Bearer sb_ »\n'
printf '  DIRECTEMENT a l'"'"'amont. Un appelant qui presente la cle publique en apikey\n'
printf '  est authentifie comme consumer anon, puis son Bearer est transmis intact.\n'
printf '  PostgREST et GoTrue verifient alors le JWT avec JWT_SECRET et honorent\n'
printf '  role=service_role. Retirer le credential service_role du consumer Kong\n'
printf '  ne change RIEN a ce chemin.\n\n'
