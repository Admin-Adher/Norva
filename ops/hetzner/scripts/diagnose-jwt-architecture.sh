#!/usr/bin/env bash
# =============================================================================
# diagnose-jwt-architecture.sh — quelle révocation du service_role est possible
# =============================================================================
#   bash ops/hetzner/scripts/diagnose-jwt-architecture.sh
#
# LECTURE SEULE, ET AUCUNE VALEUR N'EST IMPRIMÉE. Ce script ne rapporte que des
# FORMES : une longueur, un booléen, un algorithme, un nom de rôle. Jamais un
# secret, jamais un JWT, jamais un fragment de clé.
#
# Il répond à une seule question, celle qui décide du plan de remédiation :
# PostgREST vérifie-t-il les JWT avec un secret symétrique ou avec un JWKS ?
#
#   symétrique  → le chemin « sb_secret_ + JWT asymétrique » n'est PAS utilisable
#                 en l'état : Kong enverrait à PostgREST un jeton qu'il ne peut
#                 pas vérifier. Seule la rotation de JWT_SECRET révoque.
#   JWKS        → le chemin asymétrique est utilisable, et une bascule
#                 progressive sans coupure devient possible.
#
# Il mesure aussi le coût réel d'une rotation, parce que « déconnexion
# générale » est une hypothèse et pas une mesure : combien de sessions vivantes,
# quelle durée de vie des access tokens, et si les refresh tokens survivent.
# =============================================================================
set -uo pipefail

DBC="${DB_CONTAINER:-norva-db}"
KONGC="${KONG_CONTAINER:-norva-kong}"
RESTC="${REST_CONTAINER:-norva-rest}"
AUTHC="${AUTH_CONTAINER:-norva-auth}"

section() { printf '\n\033[1m================ %s ================\033[0m\n' "$1"; }
line() { printf '  %-40s %s\n' "$1" "$2"; }
psql() { docker exec -i "$DBC" psql -U postgres -d postgres -P pager=off -tAc "$1" 2>/dev/null; }

# Ne rapporte QUE la forme d'une variable d'environnement d'un conteneur.
# Longueur, et si ça ressemble à du JSON avec un tableau `keys` (donc un JWKS).
shape_of() {
  local container="$1" var="$2" value
  value="$(docker exec "$container" printenv "$var" 2>/dev/null)" || { printf 'ABSENTE'; return; }
  [[ -z "$value" ]] && { printf 'VIDE'; return; }
  local n=${#value}
  if [[ "${value:0:1}" == "{" ]]; then
    if printf '%s' "$value" | grep -q '"keys"'; then
      printf 'JWKS (JSON avec "keys", %s octets)' "$n"
    else
      printf 'JSON sans "keys" (%s octets)' "$n"
    fi
  elif [[ "$value" == eyJ* ]]; then
    # Un JWT : on ne décode que l'en-tête, qui ne contient aucun secret, pour
    # lire l'algorithme. Le payload et la signature ne sont jamais touchés.
    local alg
    alg="$(printf '%s' "${value%%.*}" | base64 -d 2>/dev/null | grep -o '"alg":"[^"]*"' | cut -d'"' -f4)"
    printf 'JWT alg=%s (%s octets)' "${alg:-inconnu}" "$n"
  elif [[ "$value" == sb_secret_* ]]; then
    printf 'clé opaque sb_secret_ (%s octets)' "$n"
  elif [[ "$value" == sb_publishable_* ]]; then
    printf 'clé opaque sb_publishable_ (%s octets)' "$n"
  else
    printf 'chaîne opaque (%s octets)' "$n"
  fi
}

section "[1] LA QUESTION QUI DÉCIDE — vérification JWT de PostgREST"
line "PGRST_JWT_SECRET" "$(shape_of "$RESTC" PGRST_JWT_SECRET)"
line "PGRST_JWT_SECRET_IS_BASE64" "$(docker exec "$RESTC" printenv PGRST_JWT_SECRET_IS_BASE64 2>/dev/null || echo 'non définie')"
line "PGRST_JWT_AUD" "$(docker exec "$RESTC" printenv PGRST_JWT_AUD 2>/dev/null || echo 'non définie')"
printf '\n  Si la forme ci-dessus est « JWT alg=… » ou « chaîne opaque », PostgREST\n'
printf '  est en symétrique : le chemin asymétrique n'"'"'est pas utilisable en l'"'"'état.\n'

section "[2] LES CLÉS EN PLACE, PAR FORME"
for v in ANON_KEY SERVICE_ROLE_KEY SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY \
         SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY \
         ANON_KEY_ASYMMETRIC SERVICE_ROLE_KEY_ASYMMETRIC; do
  line "$v (kong)" "$(shape_of "$KONGC" "$v")"
done
printf '\n  ANON_KEY_ASYMMETRIC et SERVICE_ROLE_KEY_ASYMMETRIC VIDES expliqueraient\n'
printf '  que les clients marchent avec sb_publishable_ : l'"'"'expression Lua retombe\n'
printf '  alors sur headers.apikey. Non vides et alg=RS256/ES256 avec un PostgREST\n'
printf '  symétrique serait au contraire incohérent — à comprendre avant de toucher.\n'

section "[3] CE QUE L'EDGE REÇOIT VRAIMENT"
line "SUPABASE_SERVICE_ROLE_KEY (edge)" "$(shape_of norva-edge-functions SUPABASE_SERVICE_ROLE_KEY)"
line "SUPABASE_SECRET_KEY (edge)" "$(shape_of norva-edge-functions SUPABASE_SECRET_KEY)"
printf '\n  SUPABASE_SECRET_KEY ABSENTE côté edge confirme l'"'"'étape 2 du plan :\n'
printf '  le compose ne l'"'"'injecte pas, donc le fallback ne peut pas servir.\n'

section "[4] LE COÛT RÉEL D'UNE ROTATION"
line "durée de vie access token (s)" "$(docker exec "$AUTHC" printenv GOTRUE_JWT_EXP 2>/dev/null || echo '3600 (défaut)')"
line "rôles admin GoTrue" "$(docker exec "$AUTHC" printenv GOTRUE_JWT_ADMIN_ROLES 2>/dev/null || echo 'non définie')"
line "refresh tokens vivants" "$(psql 'select count(*) from auth.refresh_tokens where revoked = false')"
line "sessions actives 24 h" "$(psql "select count(distinct user_id) from auth.refresh_tokens where created_at > now() - interval '24 hours'")"
line "utilisateurs au total" "$(psql 'select count(*) from auth.users')"
printf '\n  Les refresh tokens sont des lignes opaques de auth.refresh_tokens : ils ne\n'
printf '  sont pas signés avec JWT_SECRET et SURVIVENT à une rotation. Le client web\n'
printf '  rafraîchit déjà de façon transparente sur 401 (public/js/cloudApi.js).\n'
printf '  Le coût attendu est donc un 401 par session vivante, pas une déconnexion.\n'

section "[5] QUI DÉPEND DE JWT_SECRET, ET DEVRA REDÉMARRER"
for c in norva-kong norva-auth norva-rest norva-realtime norva-storage \
         norva-edge-functions norva-edge-functions-2 norva-studio norva-meta; do
  if docker inspect "$c" >/dev/null 2>&1; then
    has="$(docker exec "$c" sh -c 'printenv | grep -c "JWT_SECRET\|JWT_ADMIN\|ANON_KEY\|SERVICE_ROLE_KEY" || true' 2>/dev/null)"
    line "$c" "${has:-0} variable(s) concernée(s)"
  else
    line "$c" "absent"
  fi
done

section "[6] CE QUI NE DÉPEND PAS DE JWT_SECRET"
line "jobs pg_cron actifs" "$(psql 'select count(*) from cron.job where active')"
line "secrets Vault" "$(psql 'select count(*) from vault.secrets')"
printf '\n  Les crons s'"'"'authentifient auprès de l'"'"'edge avec norva_cron_shared_secret\n'
printf '  tiré du Vault, pas avec un JWT service_role : une rotation ne les casse pas.\n'
printf '  À confirmer par le compteur ci-dessus et par un run après bascule.\n'

section "[7] LA SURFACE DU JETON EXPOSÉ"
printf '  Routes qui transmettent Authorization tel quel : %s\n' \
  "$(grep -c 'Authorization: \$LUA_AUTH_EXPR' "$(dirname "$0")/../volumes/api/kong.yml" 2>/dev/null || echo '?')"
printf '  Routes qui admettent le consumer anon           : %s\n' \
  "$(grep -A 4 'allow:' "$(dirname "$0")/../volumes/api/kong.yml" 2>/dev/null | grep -c '\- anon' || echo '?')"
printf '\n  Rappel de la mécanique, pour que personne ne la redécouvre :\n'
printf '  kong-entrypoint.sh fait passer tout Authorization qui ne commence pas par\n'
printf '  « Bearer sb_ » DIRECTEMENT à l'"'"'amont. Un appelant qui présente la clé\n'
printf '  publique en apikey est authentifié comme consumer anon, puis son Bearer\n'
printf '  est transmis intact. PostgREST et GoTrue vérifient alors le JWT avec\n'
printf '  JWT_SECRET et honorent role=service_role. Retirer le credential\n'
printf '  service_role du consumer Kong ne change RIEN à ce chemin.\n\n'
