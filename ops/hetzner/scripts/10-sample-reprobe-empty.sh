#!/usr/bin/env bash
# =============================================================================
# 10-sample-reprobe-empty.sh — Levier B : classifier les titres « sondés sans
# langue / aucune piste » (86k au diag du 2026-07-16) : morts vs récupérables.
# =============================================================================
# Ré-sonde un ÉCHANTILLON (défaut 12 titres) des 2 panels les plus touchés via
# le mode diagnostic `titleIds` de norva-playback/audio-backfill : pour chaque
# titre il renvoie les langues vues par get_vod_info ET par le header-probe.
#   • probe_languages / vod_default_norm NON vides → le titre est RÉCUPÉRABLE
#     (le marquage « vide » d'origine était transitoire ou dû au mauvais mode)
#   • tout vide → flux mort / conteneur réellement muet (perte structurelle)
#
# ⚠ Chaque titre = ~2 connexions provider, séquentielles, sans garde viewer
#   (mode ops) → lancer à une HEURE CREUSE (idéal 05-07 UTC), N ≤ 20.
#
# Usage :  ./10-sample-reprobe-empty.sh [N_PAR_PANEL]     # défaut 12
#   env :  FUNCTIONS_BASE=https://api.norva.tv/functions/v1 (défaut)
# =============================================================================
set -euo pipefail
N="${1:-12}"
[ "$N" -le 30 ] || { echo "N max 30 (limite diag 60 ids + timeout edge)"; exit 1; }
FUNCTIONS_BASE="${FUNCTIONS_BASE:-https://api.norva.tv/functions/v1}"
PSQL=(docker exec -i norva-db psql -U postgres -d postgres -Atq)

TOKEN=$("${PSQL[@]}" -c "select decrypted_secret from vault.decrypted_secrets where name='norva_backfill_token'")
[ -n "$TOKEN" ] || { echo "ERREUR: secret norva_backfill_token introuvable dans vault"; exit 1; }

# Les 2 panels (films) avec le plus de « sondé sans langue », avec leur compte pilote.
mapfile -t PANELS < <("${PSQL[@]}" <<'SQL'
select s.user_id || '|' || s.id || '|' || replace(coalesce(s.display_name, left(s.id::text,8)), '|', '/')
from cloud_sources s
join cloud_title_variants v on v.source_id = s.id
join cloud_titles ct on ct.id = v.title_id and ct.default_variant_id = v.id
where ct.variant_count > 0 and ct.item_type = 'movie'
  and ct.user_id in (select user_id from public.admin_enrichment_accounts)
  and ct.audio_probed_at is not null and ct.audio_languages = '{}'
group by s.user_id, s.id
order by count(*) desc limit 2;
SQL
)
[ "${#PANELS[@]}" -gt 0 ] || { echo "Aucun panel avec des titres sondés-sans-langue."; exit 0; }

for row in "${PANELS[@]}"; do
  USER_ID="${row%%|*}"; rest="${row#*|}"; SOURCE_ID="${rest%%|*}"; PANEL="${rest#*|}"
  echo ""
  echo "================ Panel : $PANEL (source $SOURCE_ID) — échantillon $N ================"
  IDS=$("${PSQL[@]}" -c "
    select coalesce(json_agg(id), '[]'::json) from (
      select ct.id
      from cloud_titles ct
      join cloud_title_variants v on v.id = ct.default_variant_id
      where v.source_id = '$SOURCE_ID' and ct.user_id = '$USER_ID'
        and ct.variant_count > 0 and ct.item_type = 'movie'
        and ct.audio_probed_at is not null and ct.audio_languages = '{}'
        and (ct.audio_tracks is null or jsonb_typeof(ct.audio_tracks) <> 'array'
             or jsonb_array_length(ct.audio_tracks) = 0)
      order by ct.release_year desc nulls last, random()
      limit $N) s;")
  [ "$IDS" != "[]" ] || { echo "  (aucun titre 'aucune piste' sur ce panel)"; continue; }

  RESP=$(curl -sS --max-time 170 -X POST "$FUNCTIONS_BASE/norva-playback/audio-backfill" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"userId\":\"$USER_ID\",\"titleIds\":$IDS}")

  if command -v python3 >/dev/null; then
    printf '%s' "$RESP" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("Réponse illisible:", e); sys.exit(0)
rows = d.get("diagnostic")
if not isinstance(rows, list):
    print("Réponse inattendue:", json.dumps(d)[:400]); sys.exit(0)
probe_ok = vod_ok = dead = err = 0
for r in rows:
    if r.get("error"): err += 1; verdict = "ERREUR " + str(r["error"])
    elif r.get("probe_languages"): probe_ok += 1; verdict = "RÉCUPÉRABLE (probe: " + ",".join(map(str, r["probe_languages"])) + ")"
    elif r.get("vod_default_norm"): vod_ok += 1; verdict = "RÉCUPÉRABLE (vod: " + ",".join(map(str, r["vod_default_norm"])) + ")"
    else: dead += 1; verdict = "vide (mort/muet)"
    t = str(r.get("title") or "?")[:48]
    print(f"  {t:<50} -> {verdict}")
n = len(rows)
print(f"\n  BILAN {n} titres : {probe_ok} récupérables par header-probe · {vod_ok} par vod"
      f" · {dead} vides · {err} sans cible")
if n and (probe_ok + vod_ok) * 3 >= n:
    print("  → GISEMENT RÉEL (≥ 1/3 récupérables) : demander le re-probe ciblé du panel")
elif n:
    print("  → majoritairement morts : perte structurelle, rien à re-sonder en masse")
'
  else
    printf '%s\n' "$RESP"
  fi
  sleep 30
done
echo ""
echo "Coller la sortie complète pour décider du re-probe ciblé (reset audio_probed_at du bucket)."
