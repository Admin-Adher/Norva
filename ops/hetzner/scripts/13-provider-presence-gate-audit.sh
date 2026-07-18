#!/usr/bin/env bash
set -euo pipefail

# Wrapper bash volontairement séparé du SQL : évite de coller le contenu .sql
# dans un shell interactif. À lancer sur la box self-hosted depuis la racine du repo.

usage() {
  cat >&2 <<'USAGE'
Usage:
  ./ops/hetzner/scripts/13-provider-presence-gate-audit.sh <uuid utilisateur pilote>

Exemple:
  ./ops/hetzner/scripts/13-provider-presence-gate-audit.sh 00000000-0000-0000-0000-000000000000

Avant de lancer:
  1) Mets le repo à jour sur la box (git pull).
  2) Ouvre l'app/le site avec ce compte pilote.
  3) Lance ce script dans les 60 secondes.
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
SQL_FILE="$SCRIPT_DIR/13-provider-presence-gate-audit.sql"

if [[ ! -f "$SQL_FILE" ]]; then
  echo "Erreur: fichier SQL introuvable: $SQL_FILE" >&2
  echo "Vérifie que le repo est à jour sur la box (git pull) et que tu es dans le bon checkout." >&2
  exit 1
fi

if ! command -v dpsql >/dev/null 2>&1; then
  echo "Erreur: dpsql introuvable dans PATH. Lance depuis l'environnement self-hosted Norva." >&2
  exit 1
fi

echo "Audit presence/provider busy pour USER_ID=$USER_ID"
echo "SQL: $SQL_FILE"
dpsql -v "USER_ID=$USER_ID" -f "$SQL_FILE"
