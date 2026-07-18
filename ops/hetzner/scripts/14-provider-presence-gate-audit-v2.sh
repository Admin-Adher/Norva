#!/usr/bin/env bash
set -euo pipefail

# Wrapper bash volontairement séparé du SQL : évite de coller le contenu .sql
# dans un shell interactif. À lancer sur la box self-hosted depuis la racine du repo.
# Il utilise dpsql si le helper existe, sinon le conteneur Postgres self-hosted norva-db.

usage() {
  cat >&2 <<'USAGE'
Usage depuis la racine du repo ~/norva:
  ./ops/hetzner/scripts/14-provider-presence-gate-audit-v2.sh <uuid utilisateur pilote>

Usage si tu es déjà dans ~/norva/ops/hetzner:
  ./scripts/14-provider-presence-gate-audit-v2.sh <uuid utilisateur pilote>

Exemple depuis la racine du repo:
  ./ops/hetzner/scripts/14-provider-presence-gate-audit-v2.sh 00000000-0000-0000-0000-000000000000

Avant de lancer:
  1) Mets le repo à jour sur la box (git pull).
  2) Ouvre l'app/le site avec ce compte pilote.
  3) Lance ce script dans les 60 secondes.

Si dpsql n'existe pas, le script fallback sur:
  docker exec -i norva-db psql -U postgres -d postgres -P pager=off
USAGE
}

if [[ $# -ne 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 2
fi

USER_ID="$1"
if [[ ! "$USER_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "Erreur: USER_ID doit être un UUID." >&2
  usage
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$SCRIPT_DIR/14-provider-presence-gate-audit-v2.sql"

if [[ ! -f "$SQL_FILE" ]]; then
  echo "Erreur: fichier SQL introuvable: $SQL_FILE" >&2
  echo "Vérifie que le repo est à jour sur la box (git pull) et que tu es dans le bon checkout." >&2
  exit 1
fi

echo "Audit presence/provider busy pour USER_ID=$USER_ID"
echo "SQL: $SQL_FILE"

if command -v dpsql >/dev/null 2>&1; then
  dpsql -v "USER_ID=$USER_ID" -f "$SQL_FILE"
elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx 'norva-db'; then
  docker exec -i norva-db psql -U postgres -d postgres -P pager=off -v "USER_ID=$USER_ID" -f - < "$SQL_FILE"
else
  echo "Erreur: ni dpsql ni conteneur Docker norva-db actif ne sont disponibles." >&2
  echo "Commande directe possible si le conteneur existe:" >&2
  echo "  docker exec -i norva-db psql -U postgres -d postgres -P pager=off -c \"select id,email from auth.users limit 5;\"" >&2
  exit 1
fi
