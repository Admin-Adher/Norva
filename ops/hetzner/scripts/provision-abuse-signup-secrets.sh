#!/usr/bin/env bash
# =============================================================================
# provision-abuse-signup-secrets.sh — pose les secrets anti-abus du signup
# =============================================================================
#   bash ops/hetzner/scripts/provision-abuse-signup-secrets.sh
#   bash ops/hetzner/scripts/provision-abuse-signup-secrets.sh --fingerprints
#   bash ops/hetzner/scripts/provision-abuse-signup-secrets.sh --verify-edge
#   bash ops/hetzner/scripts/provision-abuse-signup-secrets.sh --cf-inspect
#   bash ops/hetzner/scripts/provision-abuse-signup-secrets.sh --cf-probe-merge
#   bash ops/hetzner/scripts/provision-abuse-signup-secrets.sh --cf-put-ingress
#   bash ops/hetzner/scripts/provision-abuse-signup-secrets.sh --push-to-cloudflare
#   bash ops/hetzner/scripts/provision-abuse-signup-secrets.sh --reveal-ingress-secret
#
# FAIL-FAST. `set -euo pipefail` plus une vérification explicite de chaque
# écriture : sauvegarde, chmod, mktemp, mv, et la longueur du secret généré. Un
# script qui manipule des clés de production ne doit jamais afficher un ✔ après
# une écriture qui a échoué, et la version précédente pouvait le faire — elle
# enchaînait `cp && chmod` puis un `ok` inconditionnel.
#
# LES SAUVEGARDES NE SONT PLUS DANS LE REPOSITORY. Elles vont dans
# $SECRET_BACKUP_DIR (défaut : ~/.norva-secret-backups), dossier en 700, fichiers
# en 600. Le script refuse de démarrer si ce dossier se trouve dans l'arbre git.
# Une règle .gitignore protège d'un commit accidentel, pas d'un `git add -f`, pas
# d'un tar du répertoire, pas d'un rsync, et pas de quelqu'un qui lit le
# working tree. Une copie complète des secrets de prod n'a rien à y faire.
#
# Les modes provision / --fingerprints / --push-to-cloudflare n'affichent AUCUNE
# valeur. --reveal-ingress-secret est la seule exception et le dit dans son nom.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$(cd "$SCRIPT_DIR/.." && pwd)/.env}"
SECRET_BACKUP_DIR="${SECRET_BACKUP_DIR:-$HOME/.norva-secret-backups}"
COMPOSE_FILE="${COMPOSE_FILE:-$(cd "$SCRIPT_DIR/.." && pwd)/docker-compose.supabase.yml}"
# norva-web, pas norva : c'est le nom que passe .github/workflows/deploy-cloudflare.yml
# (`pages deploy public --project-name=norva-web`). Le défaut précédent visait un
# projet inexistant.
CF_PROJECT="${CF_PAGES_PROJECT:-norva-web}"
CF_API="https://api.cloudflare.com/client/v4"
MODE="${1:-provision}"

ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$1" >&2; }
die()  { bad "$1"; exit 1; }

[[ -f "$ENV_FILE" ]] || die "introuvable : $ENV_FILE"

# 48 octets d'urandom en base64url : pas de +, /, = à échapper dans un .env, et
# largement au-dessus du plancher de 32 caractères que vérifient les modules. La
# longueur est vérifiée, parce qu'un /dev/urandom tronqué produirait une clé
# faible sans rien signaler.
gen() {
  local v
  v="$(head -c 48 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')" \
    || die "génération du secret impossible (urandom/base64)"
  [[ ${#v} -ge 60 ]] || die "secret généré trop court (${#v} caractères) — abandon"
  printf '%s' "$v"
}

# La valeur ne sort de cette fonction que vers sha256sum ou vers wrangler.
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

# ── modes de lecture seule ──────────────────────────────────────────────────

# Demande le jeton et l'account id, sans écho pour le jeton. Partagé par les
# modes qui parlent à l'API Cloudflare.
cf_credentials() {
  command -v curl >/dev/null 2>&1 || die "curl absent"
  command -v python3 >/dev/null 2>&1 || die "python3 absent"
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    [[ -t 0 ]] || die "CLOUDFLARE_API_TOKEN non défini et pas de terminal pour le demander"
    printf '  Jeton API Cloudflare (permission « Cloudflare Pages: Edit »).\n'
    printf '  La saisie ne s'"'"'affiche pas et ne va pas dans l'"'"'historique.\n'
    read -rsp '  Jeton : ' CLOUDFLARE_API_TOKEN; printf '\n'
    [[ -n "$CLOUDFLARE_API_TOKEN" ]] || die "jeton vide"
  fi
  if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    [[ -t 0 ]] || die "CLOUDFLARE_ACCOUNT_ID non défini et pas de terminal pour le demander"
    read -rp '  Account ID : ' CLOUDFLARE_ACCOUNT_ID
    [[ -n "$CLOUDFLARE_ACCOUNT_ID" ]] || die "account id vide"
  fi
  export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CF_PROJECT CF_API
}

if [[ "$MODE" == "--cf-probe-merge" ]]; then
  # MESURE la sémantique du PATCH sur env_vars au lieu de la supposer. C'est la
  # seule chose qui me retenait d'écrire par API : si un PATCH partiel REMPLACE
  # la map, poser une variable en production effacerait
  # NORVA_REFERRAL_EDGE_HMAC_SECRET, dont l'API ne renvoie pas la valeur et qui
  # serait donc irrécupérable.
  #
  # La sonde tourne sur PREVIEW, qui ne sert aucun trafic et ne contient qu'une
  # variable plain_text — donc lisible par l'API, donc restaurable. Le rayon
  # d'action est nul et la réponse est définitive.
  printf '\n\033[1mSÉMANTIQUE DU PATCH — sonde sur l'"'"'environnement PREVIEW\033[0m\n'
  cf_credentials
  rc=0
  python3 - <<'PY' || rc=$?
import json, os, sys, urllib.request, urllib.error

API = os.environ["CF_API"]; ACC = os.environ["CLOUDFLARE_ACCOUNT_ID"]
PROJ = os.environ["CF_PROJECT"]; TOK = os.environ["CLOUDFLARE_API_TOKEN"]
URL = "%s/accounts/%s/pages/projects/%s" % (API, ACC, PROJ)
PROBE = "NORVA_MERGE_PROBE"

def call(method, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(URL, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOK)
    if data: req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.load(e)

def preview_vars():
    d = call("GET")
    if not d.get("success"):
        print("  ECHEC lecture : %s" % (d.get("errors") or "inconnu")); sys.exit(1)
    cfg = ((d.get("result") or {}).get("deployment_configs") or {}).get("preview") or {}
    return cfg.get("env_vars") or {}

before = preview_vars()
print("  avant  : %s" % (", ".join(sorted(before)) or "(vide)"))
if PROBE in before:
    print("  la sonde precedente n'a pas ete nettoyee, on la retire d'abord")

# On envoie UNIQUEMENT la clef sonde. Si la semantique est la fusion, les autres
# survivent. Si c'est le remplacement, elles disparaissent — et on les remet.
r = call("PATCH", {"deployment_configs": {"preview": {"env_vars": {
    PROBE: {"value": "ok", "type": "plain_text"}}}}})
if not r.get("success"):
    print("  ECHEC du PATCH : %s" % (r.get("errors") or "inconnu")); sys.exit(1)

after = preview_vars()
print("  apres  : %s" % (", ".join(sorted(after)) or "(vide)"))

survivors = [k for k in before if k != PROBE and k in after]
lost = [k for k in before if k != PROBE and k not in after]
merged = bool(survivors) and not lost and PROBE in after

# Nettoyage : une valeur null supprime la clef.
call("PATCH", {"deployment_configs": {"preview": {"env_vars": {PROBE: None}}}})
restored = preview_vars()

if lost:
    # Remise en place de ce que le PATCH a effacé. Possible seulement parce que
    # preview ne contient que du plain_text.
    payload = {}
    for k in lost:
        meta = before[k] or {}
        if (meta.get("type") or "plain_text") != "plain_text" or meta.get("value") is None:
            print("  ATTENTION : %s ne peut pas etre restauree automatiquement" % k)
            continue
        payload[k] = {"value": meta["value"], "type": "plain_text"}
    if payload:
        call("PATCH", {"deployment_configs": {"preview": {"env_vars": payload}}})
        restored = preview_vars()

print("  final  : %s" % (", ".join(sorted(restored)) or "(vide)"))
print()
if merged:
    print("  VERDICT : FUSION — un PATCH partiel conserve les autres variables.")
    print("  La pose en production par API est donc sure. Enchaine sur :")
    print("      --cf-put-ingress")
    sys.exit(0)
print("  VERDICT : REMPLACEMENT ou resultat ambigu.")
print("  N'ecris PAS en production par API : NORVA_REFERRAL_EDGE_HMAC_SECRET")
print("  serait efface sans possibilite de restauration. Passe par le dashboard.")
sys.exit(2)
PY
  printf '\n'
  [[ "$rc" == "0" ]] && ok "la sémantique est mesurée, pas supposée" \
                     || warn "voir le verdict ci-dessus avant toute écriture"
  exit "$rc"
fi

if [[ "$MODE" == "--cf-put-ingress" ]]; then
  # Pose EDGE_INGRESS_SECRET_CURRENT en production par API. Le secret est lu
  # depuis le .env et passe par stdin : il n'apparaît ni dans argv, ni dans
  # l'historique, ni à l'écran, ni dans un fichier temporaire.
  #
  # À ne lancer qu'après --cf-probe-merge, dont le verdict FUSION est la seule
  # chose qui rend cette écriture sûre : sans elle, un remplacement de la map
  # effacerait NORVA_REFERRAL_EDGE_HMAC_SECRET, irrécupérable.
  printf '\n\033[1mPOSE DE EDGE_INGRESS_SECRET_CURRENT EN PRODUCTION\033[0m\n'
  secret="$(value_of EDGE_INGRESS_SECRET_CURRENT)"
  [[ -n "$secret" ]] || die "EDGE_INGRESS_SECRET_CURRENT absent du .env — lance d'abord le mode provision"
  printf '  empreinte à retrouver ensuite : \033[1m%s\033[0m\n' "$(fingerprint_of EDGE_INGRESS_SECRET_CURRENT)"
  printf '  version de clef posee en meme temps : %s
' "$(value_of EDGE_INGRESS_KEY_VERSION)"
  cf_credentials
  printf '\n  Confirme que --cf-probe-merge a rendu le verdict FUSION.\n'
  read -rp '  Taper POSER pour continuer : ' answer
  [[ "$answer" == "POSER" ]] || { printf '\n  Annulé, rien n'"'"'a été écrit.\n\n'; exit 0; }

  rc=0
  NORVA_INGRESS_SECRET="$secret"   NORVA_INGRESS_KEY_VERSION="$(value_of EDGE_INGRESS_KEY_VERSION)"   python3 - <<'PY' || rc=$?
import json, os, sys, urllib.request, urllib.error

secret = os.environ["NORVA_INGRESS_SECRET"]
API = os.environ["CF_API"]; ACC = os.environ["CLOUDFLARE_ACCOUNT_ID"]
PROJ = os.environ["CF_PROJECT"]; TOK = os.environ["CLOUDFLARE_API_TOKEN"]
URL = "%s/accounts/%s/pages/projects/%s" % (API, ACC, PROJ)
NAME = "EDGE_INGRESS_SECRET_CURRENT"
VERSION_NAME = "EDGE_INGRESS_KEY_VERSION"
version = os.environ.get("NORVA_INGRESS_KEY_VERSION") or "1"

def call(method, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(URL, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOK)
    if data: req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.load(e)

def prod_vars():
    d = call("GET")
    if not d.get("success"):
        print("  ECHEC lecture : %s" % (d.get("errors") or "inconnu")); sys.exit(1)
    cfg = ((d.get("result") or {}).get("deployment_configs") or {}).get("production") or {}
    return cfg.get("env_vars") or {}

before = set(prod_vars())
print("  avant  : %d variable(s)" % len(before))

# Les deux dans le MEME PATCH : une version sans sa clef, ou l'inverse, est
# precisement le mode de panne qu'on veut rendre impossible.
r = call("PATCH", {"deployment_configs": {"production": {"env_vars": {
    NAME: {"value": secret, "type": "secret_text"},
    VERSION_NAME: {"value": version, "type": "plain_text"}}}}})
del secret
if not r.get("success"):
    print("  ECHEC du PATCH : %s" % (r.get("errors") or "inconnu")); sys.exit(1)

after = prod_vars()
print("  apres  : %d variable(s)" % len(after))
lost = sorted(before - set(after))
if lost:
    print("  PERDUES : %s" % ", ".join(lost))
    print("  Restaure-les depuis le dashboard AVANT tout deploiement.")
    sys.exit(1)
if NAME not in after:
    print("  %s n'a pas ete cree" % NAME); sys.exit(1)
if (after[NAME] or {}).get("type") != "secret_text":
    print("  %s cree mais pas en secret_text" % NAME); sys.exit(1)
if VERSION_NAME not in after:
    print("  %s n'a pas ete cree" % VERSION_NAME); sys.exit(1)
if (after[VERSION_NAME] or {}).get("value") != version:
    print("  %s ne vaut pas %s" % (VERSION_NAME, version)); sys.exit(1)
for k in sorted(after):
    print("    %-38s %s" % (k, (after[k] or {}).get("type") or "plain_text"))
print()
print("  OK : %s en secret_text, %s = %s, aucune variable perdue."
      % (NAME, VERSION_NAME, version))
PY
  if [[ "$rc" == "0" ]]; then
    printf '\n'
    ok "posé sans que la valeur soit affichée"
    printf '\n  \033[1mIl reste à REDÉPLOYER.\033[0m Une variable Pages est liée au\n'
    printf '  déploiement : le déploiement courant a été créé avant cette pose et ne\n'
    printf '  la verra pas. « Retry deployment » dans le dashboard en crée un nouveau.\n\n'
  else
    printf '\n'; bad "voir ci-dessus"; exit "$rc"
  fi
  exit 0
fi

if [[ "$MODE" == "--cf-inspect" ]]; then
  # LECTURE SEULE. N'a besoin que de curl et python3 — cette box n'a ni node ni
  # npm (vérifié : `npm: command not found`), donc ni wrangler ni npx n'y sont
  # une option, et installer node en production pour poser un secret serait une
  # dette gratuite.
  #
  # Sert à trois choses avant toute écriture : valider le jeton, confirmer le nom
  # du projet, et lister les variables d'environnement DÉJÀ présentes. Ce
  # dernier point est le plus important — il donne le rayon d'action. Les
  # valeurs ne sont jamais affichées, seulement les noms et les types.
  # Demandé plutôt que passé sur la ligne de commande, pour deux raisons.
  # Un `CLOUDFLARE_API_TOKEN=xxx commande` atterrit dans ~/.bash_history en
  # clair. Et une consigne écrite avec des chevrons — CLOUDFLARE_API_TOKEN=<jeton>
  # — casse le shell, qui lit « < » comme une redirection : c'est arrivé.
  # `read -s` n'affiche rien et ne passe pas par l'historique.
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    [[ -t 0 ]] || die "CLOUDFLARE_API_TOKEN non défini et pas de terminal pour le demander"
    printf '  Jeton API Cloudflare (permission « Cloudflare Pages: Edit »).\n'
    printf '  La saisie ne s'"'"'affiche pas et ne va pas dans l'"'"'historique.\n'
    read -rsp '  Jeton : ' CLOUDFLARE_API_TOKEN; printf '\n'
    [[ -n "$CLOUDFLARE_API_TOKEN" ]] || die "jeton vide"
  fi
  if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    [[ -t 0 ]] || die "CLOUDFLARE_ACCOUNT_ID non défini et pas de terminal pour le demander"
    # L'identifiant de compte n'est pas un secret : il peut s'afficher. On le
    # trouve dans le dashboard Cloudflare, ou dans le secret GitHub Actions du
    # même nom qu'utilise deploy-cloudflare.yml.
    read -rp '  Account ID : ' CLOUDFLARE_ACCOUNT_ID
    [[ -n "$CLOUDFLARE_ACCOUNT_ID" ]] || die "account id vide"
  fi

  printf '\n\033[1mPROJET PAGES « %s »\033[0m\n' "$CF_PROJECT"
  body="$(curl -sS --max-time 20 \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$CF_PROJECT" 2>&1)" \
    || die "appel API impossible"

  printf '%s' "$body" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("  reponse illisible"); raise SystemExit(1)
if not d.get("success"):
    for e in d.get("errors") or [{"message": "erreur inconnue"}]:
        print("  ECHEC API : %s" % e.get("message"))
    raise SystemExit(1)
r = d.get("result") or {}
print("  nom               : %s" % r.get("name"))
print("  domaines          : %s" % ", ".join(r.get("domains") or []) or "-")
dep = (r.get("deployment_configs") or {})
for envname in ("production", "preview"):
    cfg = dep.get(envname) or {}
    ev = cfg.get("env_vars") or {}
    print("\n  %s — %d variable(s) :" % (envname, len(ev)))
    for k in sorted(ev):
        meta = ev[k] or {}
        # Les valeurs ne sont JAMAIS imprimees. Seulement le nom et le type.
        t = meta.get("type") or "plain_text"
        print("    %-38s %s" % (k, t))
    if "EDGE_INGRESS_SECRET_CURRENT" in ev:
        print("    -> EDGE_INGRESS_SECRET_CURRENT est DEJA present dans %s" % envname)
' || die "lecture du projet impossible"

  printf '\n  Rien n'"'"'a été modifié. Les valeurs de type secret_text ne sont pas\n'
  printf '  renvoyées par l'"'"'API, donc une écriture qui prétendrait « fusionner »\n'
  printf '  toute la map risquerait de les effacer. C'"'"'est pourquoi la pose se fait\n'
  printf '  par le dashboard, et pourquoi cette liste sert de témoin : relance ce\n'
  printf '  mode après la pose et vérifie que les mêmes noms sont toujours là.\n\n'
  exit 0
fi

if [[ "$MODE" == "--verify-edge" ]]; then
  # Compare les VALEURS par empreinte, jamais les noms. Un `env | grep -c` rend
  # 9 dès que le compose déclare les variables, même toutes vides : il
  # confirmerait un déploiement qui n'a pas eu lieu.
  #
  # Lecture par `docker inspect` et non `docker exec printenv` : ça donne
  # l'environnement tel que le conteneur a été CRÉÉ, ce qui est exactement la
  # question posée, et ça marche même sur une image sans binaires.
  printf '\n\033[1mVÉRIFICATION PAR EMPREINTE\033[0m\n'
  FAIL=0
  for c in norva-edge-functions norva-edge-functions-2; do
    printf '\n  %s\n' "$c"
    if ! docker inspect "$c" >/dev/null 2>&1; then
      bad "conteneur absent"; FAIL=1; continue
    fi
    dump="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null)"
    for name in "${SECRETS[@]}"; do
      want="$(fingerprint_of "$name")"
      got_raw="$(sed -n "s/^${name}=//p" <<<"$dump" | head -n 1)"
      if [[ -z "$got_raw" ]]; then
        bad "$name — VIDE dans le conteneur (recréation pas faite ?)"; FAIL=1
      elif [[ "$(printf '%s' "$got_raw" | sha256sum | cut -c1-12)" == "$want" ]]; then
        ok "$name — $want"
      else
        bad "$name — empreinte différente du .env"; FAIL=1
      fi
    done
    for entry in "${CONFIG[@]}"; do
      name="${entry%%=*}"
      got_raw="$(sed -n "s/^${name}=//p" <<<"$dump" | head -n 1)"
      # Configuration non sensible : la valeur peut s'afficher.
      if [[ "$got_raw" == "$(value_of "$name")" ]]; then
        ok "$name = ${got_raw:-<vide>}"
      else
        bad "$name = « ${got_raw:-<vide>} », attendu « $(value_of "$name") »"; FAIL=1
      fi
    done
  done
  printf '\n'
  if [[ "$FAIL" == "0" ]]; then
    printf '  \033[32mLes deux runtimes portent les mêmes valeurs que le .env.\033[0m\n\n'
  else
    printf '  \033[31mAu moins une valeur ne correspond pas.\033[0m Recrée les conteneurs :\n'
    printf '      docker compose --env-file %s -f %s \\\n' "$ENV_FILE" "$COMPOSE_FILE"
    printf '        up -d --force-recreate --no-deps functions functions2\n\n'
    exit 1
  fi
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

if [[ "$MODE" == "--push-to-cloudflare" ]]; then
  # Le chemin préféré : la valeur va du .env à Cloudflare par un pipe, sans
  # jamais passer par un terminal, un presse-papier ou un scrollback.
  # Repli sur npx : la box n'a pas forcément wrangler installé globalement, et
  # `npm i -g` sur un serveur de production pour une commande ponctuelle est une
  # dette gratuite.
  WRANGLER=()
  if command -v wrangler >/dev/null 2>&1; then
    WRANGLER=(wrangler)
  elif command -v npx >/dev/null 2>&1; then
    WRANGLER=(npx --yes wrangler)
    warn "wrangler absent, utilisation de npx (téléchargement à la volée)"
    # Cette box n'a ni node ni npm, donc ce repli n'y servira pas. Utilise
    # --cf-inspect puis le dashboard.
  else
    die "ni wrangler ni npx sur cette machine — passe par le dashboard Cloudflare et --reveal-ingress-secret"
  fi

  # Sur une box sans navigateur, `wrangler login` ne peut pas aboutir. Il faut un
  # jeton d'API, sinon la commande partira dans un flux OAuth qui n'ira nulle part.
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    warn "CLOUDFLARE_API_TOKEN non défini — sans lui wrangler tentera un login navigateur"
    printf '    Sur un serveur sans navigateur, exporte un jeton API avec la\n'
    printf '    permission « Cloudflare Pages: Edit » :\n'
    printf '        export CLOUDFLARE_API_TOKEN=...\n'
    printf '        export CLOUDFLARE_ACCOUNT_ID=...\n\n'
  fi

  v="$(value_of EDGE_INGRESS_SECRET_CURRENT)"
  [[ -n "$v" ]] || die "EDGE_INGRESS_SECRET_CURRENT est vide — lance d'abord le mode provision"
  printf '\n  Envoi vers le projet Pages « %s » sans afficher la valeur…\n' "$CF_PROJECT"
  printf '%s' "$v" | "${WRANGLER[@]}" pages secret put EDGE_INGRESS_SECRET_CURRENT \
    --project-name "$CF_PROJECT" \
    || die "wrangler a échoué — vérifie l'authentification et le nom du projet"
  unset v
  ok "posé côté Cloudflare"
  printf '  Empreinte à comparer : \033[1m%s\033[0m\n' \
    "$(fingerprint_of EDGE_INGRESS_SECRET_CURRENT)"
  # Détail qui fait perdre une heure sinon : sur Pages, une variable
  # d'environnement est liée au DÉPLOIEMENT. La poser ne change rien au
  # déploiement en cours, donc /api/signup* continuera de répondre 503 jusqu'à
  # ce qu'un nouveau déploiement soit publié.
  printf '\n  \033[1mIl faut maintenant REDÉPLOYER Pages.\033[0m Une variable posée ne\n'
  printf '  s'"'"'applique qu'"'"'aux déploiements suivants, donc /api/signup* répondra\n'
  printf '  encore 503 tant qu'"'"'un nouveau déploiement n'"'"'est pas publié — un push sur\n'
  printf '  main, ou « Retry deployment » dans le dashboard.\n\n'
  printf '  Preuve ensuite, sans créer de compte :\n'
  printf '      curl -sS -X POST https://norva.tv/api/signup-token \\\n'
  printf '        -H "content-type: application/json" -d "{}"\n'
  printf '      → 200 avec un token prouve toute la chaîne Cloudflare → edge → HMAC\n'
  printf '      → 401 signifie que les deux côtés n'"'"'ont pas le même secret\n'
  printf '      → 503 signifie que Pages n'"'"'a pas encore été redéployé\n\n'
  exit 0
fi

if [[ "$MODE" == "--reveal-ingress-secret" ]]; then
  # Dernier recours. Préfère --push-to-cloudflare, qui ne l'affiche jamais.
  printf '\n\033[1;33m╔══════════════════════════════════════════════════════════════╗\n'
  printf     '║  CE SECRET VA S'"'"'AFFICHER EN CLAIR.                           ║\n'
  printf     '║  Ne le colle ni dans un chat, ni dans un ticket, ni ailleurs. ║\n'
  printf     '╚══════════════════════════════════════════════════════════════╝\033[0m\n'
  printf '\n  Avant de continuer, vérifie que cette session n'"'"'est pas enregistrée :\n'
  printf '    — pas de partage d'"'"'écran, pas d'"'"'enregistrement de session ;\n'
  printf '    — pas de tmux/screen dont le scrollback survivra ;\n'
  printf '    — pas de journalisation du terminal côté client.\n'
  printf '\n  \033[1mhistory -c ne suffit pas\033[0m : le secret sort sur la sortie standard,\n'
  printf '  il n'"'"'est pas enregistré comme commande. Il reste dans le scrollback du\n'
  printf '  terminal, dans un éventuel log de session et dans le buffer tmux.\n'
  printf '  Après usage : efface le scrollback et ferme la fenêtre.\n\n'
  read -r -p "  Continuer quand même ? (tape OUI) " answer
  [[ "$answer" == "OUI" ]] || { printf '\n  Annulé.\n\n'; exit 0; }
  printf '\nEDGE_INGRESS_SECRET_CURRENT=%s\n\n' "$(value_of EDGE_INGRESS_SECRET_CURRENT)"
  printf '  Empreinte à comparer après l'"'"'avoir posé : \033[1m%s\033[0m\n\n' \
    "$(fingerprint_of EDGE_INGRESS_SECRET_CURRENT)"
  exit 0
fi

# ── provisionnement ─────────────────────────────────────────────────────────
#
# Un mode inconnu doit ÉCHOUER, pas retomber ici. La version précédente laissait
# tout argument non reconnu traverser jusqu'au provisionnement, qui écrit dans le
# .env : une faute de frappe dans un nom de mode — ou un script pas encore à jour
# sur la machine — déclenchait des écritures que personne n'avait demandées. Le
# même « fail-open » que les vérifications qui réussissaient sans mesurer.
if [[ -n "$MODE" && "$MODE" != "provision" ]]; then
  bad "mode inconnu : $MODE"
  printf '\n  Modes valides :\n' >&2
  printf '    (aucun) | provision      génère ce qui manque dans le .env\n' >&2
  printf '    --fingerprints           empreintes des secrets locaux\n' >&2
  printf '    --verify-edge            compare les valeurs dans les runtimes edge\n' >&2
  printf '    --cf-inspect             inventaire des variables Pages (lecture seule)\n' >&2
  printf '    --cf-probe-merge         mesure la sémantique du PATCH sur preview\n' >&2
  printf '    --cf-put-ingress         pose le secret en production par API\n' >&2
  printf '    --push-to-cloudflare     pose via wrangler, si disponible\n' >&2
  printf '    --reveal-ingress-secret  affiche le secret (dernier recours)\n' >&2
  printf '\n  Si le mode attendu figure dans cette liste sans être reconnu, la copie\n' >&2
  printf '  locale du script est en retard : lance `git pull` dans ~/norva.\n\n' >&2
  exit 2
fi

printf '\n\033[1m[1] SAUVEGARDE, HORS DU REPOSITORY\033[0m\n'
# Un garde-fou réel plutôt qu'un commentaire : si le dossier de sauvegarde tombe
# dans l'arbre git, on s'arrête. Une règle .gitignore ne protège pas d'un
# `git add -f`, d'un tar, d'un rsync ni d'une simple lecture.
if REPO_TOP="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
  BACKUP_REAL="$(mkdir -p "$SECRET_BACKUP_DIR" && cd "$SECRET_BACKUP_DIR" && pwd -P)" \
    || die "impossible de créer $SECRET_BACKUP_DIR"
  REPO_REAL="$(cd "$REPO_TOP" && pwd -P)"
  case "$BACKUP_REAL/" in
    "$REPO_REAL"/*) die "le dossier de sauvegarde est dans le repository ($BACKUP_REAL) — choisis SECRET_BACKUP_DIR ailleurs" ;;
  esac
  ok "hors de l'arbre git ($REPO_REAL)"
fi

install -d -m 700 "$SECRET_BACKUP_DIR" || die "chmod 700 impossible sur $SECRET_BACKUP_DIR"
BACKUP="$SECRET_BACKUP_DIR/env.$(date +%Y%m%d%H%M%S)"
cp -p -- "$ENV_FILE" "$BACKUP" || die "la sauvegarde a échoué — rien n'a été modifié"
chmod 600 -- "$BACKUP" || die "chmod 600 impossible sur la sauvegarde"
[[ -s "$BACKUP" ]] || die "la sauvegarde est vide — rien n'a été modifié"
ok "$(basename "$BACKUP") dans $SECRET_BACKUP_DIR (700/600)"

printf '\n\033[1m[2] SECRETS\033[0m\n'
for name in "${SECRETS[@]}"; do
  if [[ -n "$(value_of "$name")" ]]; then
    # Jamais réécrit sans qu'on le demande : régénérer NORVA_ABUSE_HASH_KEY
    # remet tous les compteurs de vélocité à zéro, et régénérer
    # EDGE_INGRESS_SECRET_CURRENT casse les signups jusqu'à ce que Pages suive.
    ok "$name déjà présent — laissé tel quel"
  elif grep -q "^${name}=" "$ENV_FILE"; then
    # Présent mais vide : remplacer la ligne au lieu d'en ajouter une seconde.
    # Le fichier temporaire doit rester dans le MEME repertoire, sinon le mv
    # final n'est pas atomique : rename ne traverse pas les systemes de
    # fichiers. Il porte donc un nom couvert par .gitignore, nait en 600 grace a
    # mktemp, et un trap le retire quoi qu'il arrive.
    tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")" || die "mktemp a echoue"
    trap 'rm -f -- "${tmp:-}"' EXIT INT TERM
    chmod 600 -- "$tmp" || die "chmod 600 impossible sur le fichier temporaire"
    # `|| true` : grep sort en 1 s'il ne reste aucune ligne, ce qui decrit un
    # fichier d'une seule ligne, pas une erreur. Sans ca le `&&` sautait le
    # printf et la nouvelle valeur n'etait jamais ecrite.
    { grep -v "^${name}=" "$ENV_FILE" || true; } > "$tmp"       || die "ecriture impossible - $ENV_FILE intact, sauvegarde en $BACKUP"
    printf '%s=%s
' "$name" "$(gen)" >> "$tmp"       || die "ecriture de $name impossible - $ENV_FILE intact, sauvegarde en $BACKUP"
    grep -q "^${name}=." "$tmp"       || die "la nouvelle valeur n'est pas dans le fichier - $ENV_FILE intact"
    mv -- "$tmp" "$ENV_FILE" || die "remplacement impossible - sauvegarde en $BACKUP"
    trap - EXIT INT TERM
    ok "$name genere (ligne vide remplacee)"
  else
    printf '%s=%s\n' "$name" "$(gen)" >> "$ENV_FILE" \
      || die "ajout de $name impossible — sauvegarde en $BACKUP"
    ok "$name généré (48 octets, base64url)"
  fi
done

printf '\n\033[1m[3] CONFIGURATION\033[0m\n'
for entry in "${CONFIG[@]}"; do
  name="${entry%%=*}"
  if grep -q "^${name}=" "$ENV_FILE"; then
    printf '  = %-34s %s\n' "$name" "$(value_of "$name")"
  else
    printf '%s\n' "$entry" >> "$ENV_FILE" || die "ajout de $name impossible"
    ok "$name = ${entry#*=} (défaut)"
  fi
done

chmod 600 -- "$ENV_FILE" || die "chmod 600 impossible sur $ENV_FILE"

printf '\n\033[1m[4] EMPREINTES\033[0m\n'
for name in "${SECRETS[@]}"; do
  printf '  %-34s %s\n' "$name" "$(fingerprint_of "$name")"
done

printf '\n\033[1m[5] CE QUI RESTE\033[0m\n'
ENFORCE="$(value_of NORVA_ABUSE_ENFORCEMENT_ENABLED)"
if [[ "$ENFORCE" == "false" ]]; then
  ok "enforcement = false — aucun signup ne peut être refusé"
else
  die "enforcement = $ENFORCE — remets false avant tout trafic réel"
fi

warn "EDGE_INGRESS_SECRET_CURRENT doit être posé À L'IDENTIQUE côté Cloudflare"
printf '    Pages, sinon 100 %% des signups seront rejetés à l'"'"'ingress.\n'
printf '\n  Sans jamais l'"'"'afficher :\n'
printf '      bash %s --push-to-cloudflare\n' "$(basename "${BASH_SOURCE[0]}")"
printf '\n  Puis RECRÉER les deux runtimes edge. Pas `docker restart` : celui-ci\n'
printf '  relance le conteneur avec son ancien environnement, donc les nouveaux\n'
printf '  secrets n'"'"'arriveraient jamais.\n\n'
printf '      docker compose --env-file %s \\\n' "$ENV_FILE"
printf '        -f %s \\\n' "$COMPOSE_FILE"
printf '        up -d --force-recreate --no-deps functions functions2\n'
printf '\n  Et vérifier par EMPREINTE, jamais en comptant des noms :\n'
printf '      bash %s --verify-edge\n' "$(basename "${BASH_SOURCE[0]}")"
printf '\n  Compter les noms de variables donnerait 9 dès maintenant — elles sont\n'
printf '  déjà déclarées par le compose, avec des valeurs VIDES. Un tel compte\n'
printf '  confirmerait un déploiement qui n'"'"'a pas eu lieu.\n\n'
