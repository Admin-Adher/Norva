# Session 2026-07-06/07 — playback HEVC, timeouts SQL, outage & reprise

> Journal de session + **état opérationnel courant** (ce qu'un futur contexte DOIT savoir).
> Projet `oupsceccxsonaalhueff`. Branche : `main` (tout est mergé) + `claude/language-filter-media-grid-ymd19s` (synchro).

---

## ⚠️ ÉTAT OPÉRATIONNEL COURANT (à connaître avant tout)

| Élément | État | Action attendue |
|---|---|---|
| **cron 92 `norva-facet-summary-refresh`** | ⏸️ **EN PAUSE** (`active=false`, schedule `7-59/15 * * * *`) | Réactiver quand le gros Ninja finit : `select cron.alter_job(job_id:=92, active:=true);` — un **watchdog** (send_later, ~02:51Z puis /40min) le fait automatiquement quand `346a7f5b` passe `ready`. |
| **rôle `postgres` `statement_timeout`** | ✅ Normal (défaut 120s) | Rien — avait été levé à 1800s pour le build d'index puis **remis**. |
| **Index `idx_cmi_dedup_primary_title`** | ✅ **valid** en prod | Désormais dans une migration (`20260707000000_…`). |
| **Ancienne source Ninja `976e7bbd`** (operator1.barfik.org) | 🕓 **soft-deleted, pas encore drainée** | Le reaper (`reap_deleted_sources`, cron `norva-reap-deleted-sources`) attend que les syncs finissent (il se défère tant qu'un `sync_status='syncing'`). Se draine seul ensuite → ÷2 des données de l'user. |
| **Nouveau Ninja `346a7f5b`** | 🕓 `syncing`, finalize titres lent (~35,7k/235k) | Laisser finir (choix user). C'est le goulot qui garde le reaper en attente + sature l'IO. |
| **Crons probe Ninja 79/80** | ❌ Pointent encore l'ancienne source `976e7bbd` | **À repointer** vers `346a7f5b` (noté « quand tu veux »). |
| **Miroir catalogue couche B** | 💤 Construit mais **dormant** (flags OFF) | Runbook : `docs/roadmap/phase2-dedup-activation-runbook.md`. Ne PAS activer sans recoupement multi-user. |

**User concerné (celui des logs)** : `7bdab1df-80e6-46f9-bcdf-84b6595819a8` (adrienhernandez20). Il stresse la DB en important un provider massif (barfik, 285k items) deux fois (ancien + nouveau) → timeouts sur requêtes lourdes le temps que ça se draine.

---

## Changements livrés (commits sur `main`)

| Commit | Quoi | Chemin de deploy |
|---|---|---|
| *(pré-compaction)* | Animations scroll landing + mockups devices (setupScrollReveal, setupDeviceTilt, keyframes) | CI Cloudflare |
| `bd74729` | Endpoints source-management manquants (boutons progress/test/refresh/hard-refresh/toggle/delete étaient 404) | CI Supabase (norva-cloud) |
| `1b9b2a9` | Route `POST /catalog-media-mirror-verify` (norva-playback) + runbook activation couche B | CI Supabase + doc |
| `3336a14` | **Fix HEVC chemin MOTEUR** : media-error moteur non-TS → `fallbackEngineToTranscode` (avant : boucle) | CI Cloudflare |
| `55b8608` | **Fix HEVC chemin NATIF** : media-error code 3/4 à message vide → tag pour que `isFormatPlaybackError` matche → chaîne transcode s'exécute (avant : boucle) | CI Cloudflare |

### Migrations ajoutées cette session
- `20260706180000_provider_probe_circuit.sql` — circuit-breaker probe (table + `provider_probe_circuit_state` + `_record_tick`). Ouvre après 2 ticks all-fail, back-off 30m→24h. Câblé dans `norva-playback` `runOneDimension`.
- `20260706190000_source_soft_delete.sql` — `cloud_sources.deleted_at` + `reap_deleted_sources()` (batched, COMMIT/lot, self-defer si un sync tourne) + cron `norva-reap-deleted-sources` (/min).
- `20260706210000_source_enabled.sql` — `cloud_sources.enabled` (toggle disable + filtre frontend `sources.filter(s=>s.enabled)`).
- `20260707000000_cmi_dedup_primary_title_index.sql` — **index partiel** documentant `idx_cmi_dedup_primary_title` (créé à chaud en prod, cf. Cause 3).

> ⚠️ Les migrations **ne sont PAS auto-appliquées** par le CI (le workflow ne déploie que les edge functions). Le circuit/soft-delete/enabled ont été appliqués à la main en prod cette session ; l'index aussi (à chaud). Le fichier de migration index sert de trace reproductible (no-op via `IF NOT EXISTS` si déjà présent).

---

## 🔥 Incident outage `norva-playback` (résolu)

**Cause** : pour déployer `norva-playback` (index.ts = 228 KB), j'ai délégué à un sous-agent un deploy MCP **inline** ; il n'a pas pu porter 228 KB → a poussé du **placeholder** → live en **v112 avec `index.ts = "PENDING"`** → toutes les routes 500. Code disque jamais touché.
**Reprise** : push du code correct sur `main` → le CI `deploy-supabase-functions.yml` (`supabase functions deploy` depuis le disque) a redéployé → **v113 ACTIVE**. Vérifié (401 sur route + boot OK).
**Leçon** : **ne jamais déléguer/faire un deploy MCP inline d'un gros fichier.** Le chemin correct = **CI** (push sur `main` touchant `supabase/functions/**` ou `workflow_dispatch`), qui déploie depuis le disque (zéro risque de transcription). `verify_jwt` par fonction vient de `supabase/config.toml` (norva-playback = false).

---

## Diagnostics playback (les logs récurrents de l'user)

Trois causes **distinctes**, pas un seul bug :

1. **HEVC Main10 / MKV mal étiqueté mp4** → le navigateur ne décode/parse pas → échec.
   - **Chemin moteur (MSE)** : `CHUNK_DEMUXER_ERROR_APPEND_FAILED`. Ne basculait au transcode que si `wasTs`. **Fix `3336a14`** : tout échec média moteur non-provider-error-page → `fallbackEngineToTranscode`.
   - **Chemin natif (relay/direct)** : `Video error: 4`, `error.message` VIDE. `handlePlaybackFailure` gate le transcode sur `isFormatPlaybackError(message)` (regex texte) → message vide = 'Media error' = pas de match → transcode sauté → boucle retry-en-place. **Fix `55b8608`** : tag code 3/4 (codec par définition) pour matcher.
   - ⚠️ Le transcode d'un 4K HEVC 18 Go côté gateway Railway reste lourd ; le fix garantit la *tentative*, pas la vitesse.
2. **Provider 502** (`operator1.barfik.org`) → **côté fournisseur** (upstream mort). Aucun fix client ; `tryNextVersion` / santé provider. Diagnostic relay le montre (`http=502 upstream=502`).
3. **Sonde « <!DOCTYPE »** (`Probe failed… Unexpected token '<'`) → `/api/probe` **n'est routé vers aucun backend** → fallback SPA (`index.html`, HTTP 200 HTML) → `.json()` s'étrangle. **Bénin** (attrapé, « continuing without duration fallback »). Pré-sonde optionnelle ; pas la cause des échecs. *(Amélioration possible un jour : router `/api/probe` vers la gateway, ou ne pas l'appeler si non déployé.)*

---

## Cause 3 — timeouts SQL sous charge d'import

**Symptôme** : rail « recommandés » (`list_media_items_deduped`) puis genre-rails (`listGenreRails` sur `cloud_titles`) `canceling statement due to statement timeout` ; même un `count` de diagnostic a timeout à 60s.

**Cause racine unique** : DB saturée par le finalize Ninja 235k **+ données doublées** (ancien Ninja pas encore drainé) sur instance contrainte (DB 4,7 Go, IO en `DataFileRead`). Le facet-refresh (240s/15min) aggravait.

**Fix structurel livré** : `idx_cmi_dedup_primary_title` = index **partiel** `on cloud_media_items (user_id, item_type, title, external_id) WHERE is_dedup_primary`. Le fast path de la grille filtrait `is_dedup_primary` **sans index** (post-filtre ligne par ligne sur `idx_cmi_sort_title` → sautait des masses de doublons Ninja). Avec l'index : index scan pur sur les lignes primary. `EXPLAIN` confirmé : `Index Scan using idx_cmi_dedup_primary_title`, ~700ms (était timeout).
- Genre-rails (`cloud_titles`) : PAS d'index manquant (GIN `genre_buckets` existe) ; c'est purement la charge → se résorbe quand l'import finit + ancien Ninja drainé.

**Détail build d'index** : `CREATE INDEX CONCURRENTLY` via pg_cron (immune au timeout 60s du MCP). 1er essai tué par le `statement_timeout` 120s de pg_cron → index invalide → droppé, `statement_timeout` du rôle `postgres` levé à 1800s, replanifié → construit OK → cron désinscrit + timeout **remis à la normale**.

**Soulagement IO en cours** : facet-refresh (cron 92) mis en pause (choix user) le temps de l'import ; watchdog le rallume à la fin.

---

## Miroir catalogue global (couche B) — cartographié, dormant

- Deux couches : **A** (titres `catalog_titles`/`catalog_file_tracks`, write ON via best-effort + cron, read OFF) ; **B** (catalogue brut `catalog_media_items`+jumelles, write GUC `app.norva_catalog_dual_write` OFF, read env `NORVA_CATALOG_MEDIA_READ_SOURCE` OFF, tables VIDES).
- Couche B **entièrement construite, dormante** : write/read/verify/thin tous présents. Activation = 5 leviers d'ops (backfill → GUC → verify → flip lecture → thin), gatée sur `catalog_flip_readiness` overlap ≥ 3.0. **Rien activé.**
- Runbook complet : `docs/roadmap/phase2-dedup-activation-runbook.md`. Route de vérif raw-media câblée : `POST /catalog-media-mirror-verify` (norva-playback, service-role token).

---

## À faire / suivis ouverts

- [ ] **Repointer les crons probe Ninja 79/80** de `976e7bbd` (supprimée) vers `346a7f5b`.
- [ ] **Réactiver facet-refresh (cron 92)** quand `346a7f5b` = ready (watchdog auto, sinon manuel).
- [ ] Laisser le **reaper** drainer l'ancien Ninja `976e7bbd` (auto quand plus rien ne sync).
- [ ] Tester une vraie lecture **HEVC** (film + épisode) post-déploiement Cloudflare pour valider le fallback transcode en réel.
- [ ] (Optionnel) Router `/api/probe` vers la gateway, ou supprimer l'appel si non déployé (retire le bruit « <!DOCTYPE »).
- [ ] (Optionnel) Formaliser les migrations circuit/soft-delete/enabled/index dans un apply prod reviewé si pas déjà fait.
