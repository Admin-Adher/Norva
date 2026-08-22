#!/usr/bin/env bash
# =============================================================================
# provision-abuse-signup-secrets.sh — pose les secrets anti-abus du signup
# =============================================================================
#   bash ops/hetzner/scripts/provision-abuse-signup-secrets.sh
#   bash ops/hetzner/scripts/provision-abuse-signup-secrets.sh --fingerprints
#   bash ops/hetzner/scripts/provision-abuse-signup-secrets.sh --reveal-ingress-secret
#
# Les deux premiers modes n'affichent AUCUNE valeur : le script génère ce qui
# manque directement dans ops/hetzner/.env et n'imprime qu'un état (posé / déjà
# là) et une empreinte.
#
# Le troisième mode est la seule exception, et elle est explicite dans son nom.
# EDGE_INGRESS_SECRET_CURRENT doit être posé à l'identique côté Cloudflare Pages,
# et il n'existe aucun moyen de le transporter sans l'afficher une fois. Mieux
# vaut un mode qui le dit que quelqu'un qui finit par faire `cat .env`.
#
# L'empreinte est les 12 premiers caractères de sha256(valeur). Elle sert à
# vérifier que Cloudflare Pages et la box portent bien le MÊME
# EDGE_INGRESS_SECRET_CURRENT, sans qu'aucun des deux côtés n'ait à afficher le
# secret. C'est la seule variable qui doit exister des deux côtés : Pages signe
# avec elle, l'edge vérifie avec elle. Une divergence donne un rejet ingress sur
# 100 % des signups, ce qui est très visible mais très mal expliqué par les logs.
#
# Rappel appris à la dure : ne JAMAIS cat/diff un fichier qui contient des
# secrets dans un terminal partagé. Ce script est écrit pour n'avoir jamais
# besoin de le faire.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$(cd "$SCRIPT_DIR/.." && pwd)/.env}"
MODE="${1:-provision}"

ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$1"; }

[[ -f "$ENV_FILE" ]] || { bad "introuvable : $ENV_FILE"; exit 1; }

# 48 octets d'urandom en base64url : pas de +, /, = à échapper dans un .env, et
# largement au-dessus du plancher de 32 caractères que vérifient les modules.
gen() { head -c 48 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }

# Lecture sans jamais faire écho : la valeur ne sort de cette fonction que vers
# sha256sum.
value_of() { sed -n "s/^${1}=//p" "$ENV_FILE" | tail -n 1; }
fingerprint_of() {
  local v; v="$(value_of "$1")"
  if [[ -z "$v" ]]; then printf 'ABSENT'; else printf '%s' "$v" | sha256sum | cut -c1-12; fi
}

SECRETS=(
  NORVA_ABUSE_HASH_KEY
  NORVA_SIGNUP_TOKEN_SECRET
  NORVA_SIGNUP_IDEMPOTENCY_SECRET
  EDGE_INGRESS_SECRET_CURRENT
)
CONFIG=(
  "EDGE_INGRESS_KEY_VERSION=1"
  "NORVA_ABUSE_POLICY_VERSION=observe-v1"
  "SIGNUP_ENDPOINT_VERSION=norva-signup-v1"
  "NORVA_ABUSE_ENFORCEMENT_ENABLED=false"
)

if [[ "$MODE" == "--reveal-ingress-secret" ]]; then
  # Le seul secret qui doit sortir de la box, parce que Cloudflare Pages doit
  # signer avec exactement celui-là. Il n'y a pas de façon de le transporter sans
  # l'afficher une fois.
  printf '\n\033[1;33m╔══════════════════════════════════════════════════════════════╗\n'
  printf     '║  À COLLER DANS CLOUDFLARE PAGES, ET NULLE PART AILLEURS.     ║\n'
  printf     '║  Ne le colle pas dans un chat, un ticket, ni un commit.      ║\n'
  printf     '╚══════════════════════════════════════════════════════════════╝\033[0m\n\n'
  printf 'EDGE_INGRESS_SECRET_CURRENT=%s\n\n' "$(value_of EDGE_INGRESS_SECRET_CURRENT)"
  printf '  Empreinte à comparer après l'"'"'avoir posé : \033[1m%s\033[0m\n' \
    "$(fingerprint_of EDGE_INGRESS_SECRET_CURRENT)"
  printf '  Pense à effacer l'"'"'historique du terminal si tu partages cet écran :\n'
  printf '      history -c\n\n'
  exit 0
fi

if [[ "$MODE" == "--fingerprints" ]]; then
  printf '\n\033[1mEmpreintes (12 premiers caractères de sha256)\033[0m\n'
  for name in "${SECRETS[@]}"; do
    printf '  %-34s %s\n' "$name" "$(fingerprint_of "$name")"
  done
  printf '\n  Compare EDGE_INGRESS_SECRET_CURRENT avec la même empreinte calculée\n'
  printf '  côté Cloudflare Pages. Si elles diffèrent, tout signup sera rejeté\n'
  printf '  à l'"'"'ingress sans que le message ne le dise.\n\n'
  exit 0
fi

printf '\n\033[1m[1] SAUVEGARDE\033[0m\n'
BACKUP="$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
cp -p "$ENV_FILE" "$BACKUP" && chmod 600 "$BACKUP"
ok "copie en $(basename "$BACKUP") (mode 600, ignorée par git)"

printf '\n\033[1m[2] SECRETS\033[0m\n'
for name in "${SECRETS[@]}"; do
  current="$(value_of "$name")"
  if [[ -n "$current" ]]; then
    # Jamais réécrit sans qu'on le demande : régénérer HASH_KEY remet tous les
    # compteurs de vélocité à zéro, et régénérer INGRESS_SECRET_CURRENT casse
    # les signups jusqu'à ce que Pages suive.
    ok "$name déjà présent — laissé tel quel"
  else
    if grep -q "^${name}=" "$ENV_FILE"; then
      # Présent mais vide : remplacer la ligne au lieu d'en ajouter une seconde.
      tmp="$(mktemp)"; chmod 600 "$tmp"
      { grep -v "^${name}=" "$ENV_FILE"; printf '%s=%s\n' "$name" "$(gen)"; } > "$tmp"
      mv "$tmp" "$ENV_FILE"
    else
      printf '%s=%s\n' "$name" "$(gen)" >> "$ENV_FILE"
    fi
    ok "$name généré (48 octets, base64url)"
  fi
done

printf '\n\033[1m[3] CONFIGURATION\033[0m\n'
for entry in "${CONFIG[@]}"; do
  name="${entry%%=*}"
  if grep -q "^${name}=" "$ENV_FILE"; then
    printf '  = %-34s %s\n' "$name" "$(value_of "$name")"
  else
    printf '%s\n' "$entry" >> "$ENV_FILE"
    ok "$name = ${entry#*=} (défaut)"
  fi
done

chmod 600 "$ENV_FILE"

printf '\n\033[1m[4] EMPREINTES\033[0m\n'
for name in "${SECRETS[@]}"; do
  printf '  %-34s %s\n' "$name" "$(fingerprint_of "$name")"
done

ENFORCE="$(value_of NORVA_ABUSE_ENFORCEMENT_ENABLED)"
printf '\n\033[1m[5] CE QUI RESTE\033[0m\n'
if [[ "$ENFORCE" == "false" ]]; then
  ok "enforcement = false — aucun signup ne peut être refusé"
else
  bad "enforcement = $ENFORCE — remets false avant tout trafic réel"
fi
warn "EDGE_INGRESS_SECRET_CURRENT doit être posé À L'IDENTIQUE dans les"
printf '    variables Cloudflare Pages, sinon 100 %% des signups seront rejetés.\n'
warn "puis redémarrer les deux runtimes edge pour qu'ils lisent le .env :"
printf '\n      docker restart norva-edge-functions norva-edge-functions-2\n'
printf '\n  Vérifier ensuite que les variables sont bien arrivées, sans les afficher :\n'
printf '      docker exec norva-edge-functions env | grep -c "^NORVA_ABUSE\\|^EDGE_INGRESS\\|^NORVA_SIGNUP"\n'
printf '      (doit répondre 9)\n\n'
