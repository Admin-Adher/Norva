#!/usr/bin/env bash
set -euo pipefail

# Compatibility entrypoint from the repository root. The canonical ops script lives
# under ops/hetzner/scripts, but operators commonly try ./scripts/... from ~/norva.
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$REPO_ROOT/ops/hetzner/scripts/15-provider-presence-gate-audit-v3.sh"

if [[ ! -x "$TARGET" ]]; then
  echo "Erreur: wrapper canonique introuvable ou non exécutable: $TARGET" >&2
  echo "Depuis ~/norva, mets d'abord main à jour:" >&2
  echo "  git fetch origin main && git pull --ff-only origin main" >&2
  echo "Puis lance:" >&2
  echo "  ./ops/hetzner/scripts/15-provider-presence-gate-audit-v3.sh <uuid utilisateur pilote>" >&2
  exit 1
fi

exec "$TARGET" "$@"
