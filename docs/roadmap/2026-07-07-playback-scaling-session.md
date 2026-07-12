# Session 2026-07-06/07 — playback HEVC, timeouts SQL, outage & reprise

> Journal de session + **état opérationnel courant** (ce qu'un futur contexte DOIT savoir).
> Projet `oupsceccxsonaalhueff`. Branche : `main` (tout est mergé) + `claude/language-filter-media-grid-ymd19s` (synchro).

---

## ⚠️ ÉTAT OPÉRATIONNEL COURANT (à connaître avant tout)

> _MàJ 2026-07-07 (fin de session) : le tableau ci-dessous reflète l'état réel courant._

| Élément | État | Action attendue |
|---|---|---|
| **Import Ninja `346a7f5b`** | ✅ **FINI** (`ready`) | — |
| **super8k `1aaeb703`** (272 774 items, autre user) | 🕓 `syncing` `building_titles` (~8-10% du finalize) | **Dernier gros import.** Le watchdog débloque tout quand il passe `ready`. ⚠️ Réapparu après purge — surveiller le quota free tier. |
| **cron 92 `norva-facet-summary-refresh`** | ⏸️ **EN PAUSE** (`active=false`) | Réactivé **auto par le watchdog** quand `still_syncing=0` (super8k fini). Manuel : `select cron.alter_job(job_id:=92, active:=true);` |
| **Ancien Ninja `976e7bbd`** | 🕓 soft-deleted, **attend le reap** | Se draine quand super8k finit (le reaper se défère tant qu'un sync tourne) → ÷2 données. |
| **Re-enrichissement TMDB (préfixes barre)** | 🕓 **gaté sur le drain de l'ancien Ninja** | Watchdog lance le reset des markers (`search_match_attempted_at=null` + `norva_search_match_state`) quand `soft_deleted_pending=0`. |
| **Regroupement admin par identité** | ✅ modif **appliquée** à `refresh_admin_dashboard()` (`coverage_change_applied=true`) | S'affiche au 1er refresh réussi (quand DB calme). ⚠️ **Appliquée en SQL direct, PAS dans une migration** → repro gap (à formaliser). |
| **Crawl audio deux-phases** (matchés d'abord) | 📋 **planifié, pas fait** | À implémenter quand la DB est calme (edge `norva-source-sync` + champ `phase` dans l'état du crawl). Voir §Crawl ci-dessous. |
| **Watchdog consolidé** | 🐕 armé (send_later ~06:30Z, /30min) | Réactive facet + reset TMDB + refresh admin quand super8k fini + ancien Ninja drainé. |
| **rôle `postgres` `statement_timeout`** | ✅ Normal (défaut 120s) | — (avait été levé à 1800s pour l'index, remis). |
| **Index `idx_cmi_dedup_primary_title`** | ✅ **valid** | migration `20260707000000`. |
| **Crons probe Ninja 79/80** | ❌ pointent l'ancienne source `976e7bbd` | **À repointer** vers `346a7f5b`. |
| **Miroir catalogue couche B** | 💤 dormant (flags OFF) | Runbook `docs/roadmap/phase2-dedup-activation-runbook.md`. |

**Users concernés** : `7bdab1df` (adrienhernandez20, le Ninja/barfik). super8k = un **autre** user de test (`c5be5ac4`). **Fil rouge de la session** : presque tous les frictions (dashboards qui timeout, canal MCP qui flappe, listes vides, sous-agents qui rament) = **la DB free-tier saturée par des imports lourds successifs** (Ninja 285k puis super8k 272k), PAS une accumulation de bugs. Confirmé chiffré : échecs crons **~250/24h pendant l'import → 5 sur les dernières 30 min** une fois Ninja fini.

---

## Changements livrés (commits sur `main`)

| Commit | Quoi | Chemin de deploy |
|---|---|---|
| *(pré-compaction)* | Animations scroll landing + mockups devices (setupScrollReveal, setupDeviceTilt, keyframes) | CI Cloudflare |
| `bd74729` | Endpoints source-management manquants (boutons progress/test/refresh/hard-refresh/toggle/delete étaient 404) | CI Supabase (norva-cloud) |
| `1b9b2a9` | Route `POST /catalog-media-mirror-verify` (norva-playback) + runbook activation couche B | CI Supabase + doc |
| `3336a14` | **Fix HEVC chemin MOTEUR** : media-error moteur non-TS → `fallbackEngineToTranscode` (avant : boucle) | CI Cloudflare |
| `55b8608` | **Fix HEVC chemin NATIF** : media-error code 3/4 à message vide → tag pour que `isFormatPlaybackError` matche → chaîne transcode s'exécute (avant : boucle) | CI Cloudflare |
| `7638806` | **Fix HEVC ÉPISODES (cause racine)** : codec inconnu → moteur (pas natif) + `mode:'transcode'` forcé sur le fallback | CI Cloudflare |

### Cause racine HEVC épisodes (trace approfondie via `VOD-PLAYBACK-AUDIT.md` + git)
- Les **épisodes de série n'ont pas de `videoCodec`** : `norva-series-info` sert le payload provider brut **sans** attacher le `codec_profile` (que `norva-catalog` attache aux films). → `playbackHint.videoCodec=''`.
- `shouldVodUseGatewayTranscode` ne flagge que ce qu'il **prouve** unsafe (`unsafeVideo = videoCodec && !(h264…)`) → codec vide = falsy → `browserSafeVod=true` → mode `relay` (**natif**) → HEVC injouable en `<video>` → `MediaError 4`. **Le moteur (qui lit le HEVC) n'est jamais sélectionné.** Les films marchent car enrichis.
- **Bug secondaire** : `retryWithCloudGatewayTranscode` passait `gatewayMode:'transcode'` mais **pas `mode:'transcode'`** ; `getStreamUrl` ne force le mode que via query `mode` → le retry re-tombait en natif → **aucune session transcode créée** (confirmé en base : sessions récentes toutes en `remux`, aucune `transcode`).
- **Pas une régression de code** (historique git aplati au 2026-07-05 ; les 2 commits post-audit ne touchent que l'error-handler). C'est **data-side** (épisodes non enrichis) + le bug de fallback.
- **Fix `7638806` (client, 2 volets)** : (1) `browserSafeVod` exige une **preuve positive** de codec browser-safe → codec inconnu + conteneur démuxable moteur → **moteur** ; (2) `mode:'transcode'` forcé sur le fallback → vraie session transcode.
- **Suivi « propre » (edge, optionnel)** : enrichir `norva-series-info` avec le `codec_profile` du variant (miroir de `norva-catalog:2120-2123`) → les épisodes se comportent **exactement** comme les films, sans dépendre de l'heuristique client. C'est le fix de fond le plus robuste (à faire côté edge quand tu veux).
- ⚠️ Un 4K HEVC **Main10 (10-bit)** ne joue via le moteur que si le navigateur/OS a un décodeur HEVC 10-bit ; sinon même le moteur échoue → transcode gateway (lourd pour 18 Go). Le routage est corrigé ; la jouabilité finale d'un fichier monstre dépend du support HEVC de l'appareil.

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

---

# Suite de session (2026-07-07) — titres premium, dedup provider, crons, admin

## Commits additionnels (`main`)
| Commit | Quoi | Deploy |
|---|---|---|
| `189dc42` | **Préfixes titres barre** (`DK ▎ `, `ALB ▎ `) strippés à l'affichage (`cleanReleaseName` client + `cleanDisplayTitle` edge) — le regex ne gérait que le tiret `FR - ` ; ajout de la famille barre `▎▏▍▌│┃┆┊｜|`. **+ fix cache vide** (`loadCloudSeries/Movies` ne cache plus une page vide → plus de « No series here yet » figé au retour). | CI Cloudflare + Supabase |
| `f4b780a` | **Match TMDB** : `cleanSearchQuery` strippe le préfixe barre AVANT la recherche (avant, il cherchait « DK A Hijacking » → jamais matché). Recherche-only, pas de re-keying. | CI Supabase |

## HEVC playback — 3 fixes (rappel + suite)
- `3336a14` (moteur), `55b8608` (natif code 3/4 message vide → tag pour `isFormatPlaybackError`), `7638806` (**cause racine épisodes** : `norva-series-info` n'enrichit pas le `codec_profile` → `videoCodec` vide → `browserSafeVod=true` → natif → HEVC échoue ; fix = preuve positive de codec browser-safe → sinon moteur ; + `mode:'transcode'` forcé sur le fallback). **Confirmé par l'user : les épisodes HEVC jouent (badge « Navigateur »).**
- **Suivi de fond** : enrichir `norva-series-info` avec le `codec_profile` (miroir `norva-catalog`) pour que les épisodes se comportent comme les films sans dépendre de l'heuristique client.

## Dedup provider-identity — VÉRIFIÉ, ça marche (pas un bug)
Le user pensait que le nouveau compte Ninja re-scannait tout. **Faux** : les **4 comptes Ninja** (provider_keys `x:d5bae7ea`/`x:5d1db4c9`/`x:93955a3b`/`x:045daa57`) pointent **tous vers la même identité `d8453dc1`**. `resolveSourceIdentity` (norva-playback:1086) upgrade la clé vers l'identité → cache audio `catalog_file_tracks` **partagé** entre comptes. Le nouveau compte **hérite** des probes de l'ancien.
- **Pourquoi 2,7% audio alors ?** Pas le dedup : l'**anti-ban**. L'identité Ninja est `low_footprint` à **40 probes/h** (posé car Ninja bannissait). Seulement **1 341 fichiers sondés au total** sur ~174k → ~6 mois à ce rythme (ETA « ≫1an »). Circuit-breaker fermé/sain en ce moment.
- **« Ninja doublé » dans l'admin** : le user a 2 sources Ninja (ancien un-reaped + nouveau) ; l'admin **listait par source** → 2 lignes. Le scan est mutualisé (même cache). D'où le regroupement admin par identité (ci-dessous).

## Crons en échec — c'était la charge, pas des bugs
`admin-dashboard-refresh` + `norva-catalog-reconcile` = `statement timeout` sous saturation d'import. `norva-facet-summary-refresh` = ma pause (pas un vrai échec). Chiffres : **~250 échecs/24h pendant l'import → 5 sur 30 min** une fois Ninja fini (**~98% de baisse**). Les 2 stragglers restants (`enrich-titles-from-catalog`, `admin-dashboard-refresh`) timeout encore un peu tant que **super8k** finalise.

## Regroupement admin par identité — APPLIQUÉ (⚠️ hors migration)
`refresh_admin_dashboard()` : le bloc coverage groupait par `s.id` (source) → 2 lignes Ninja. Modif **appliquée en SQL direct** (via un sous-agent) : join `catalog_provider_identities cpi on cpi.provider_key = s.config_hint->>'providerKey'` + `provider_identities pi` + `group by u.email, coalesce(pi.id::text, s.id::text), ...` → fusionne les abonnements d'un même user+identité. `coverage_change_applied=true` vérifié.
- ⚠️ **Repro gap** : appliquée en direct, **pas dans un fichier de migration** → à formaliser (comme l'index l'a été).
- ⚠️ Le sous-agent avait créé un cron temporaire `tmp-verify-admin-dash` (`* * * * *`, 300s) → **désinscrit** (nettoyé). Leçon : le verify d'une fonction lourde sous charge d'import timeout → ne pas re-run `refresh_admin_dashboard()` tant qu'un gros import tourne.

## Re-enrichissement TMDB des préfixes — ✅ LANCÉ le 2026-07-08
> **Exécuté** : l'ancien Ninja `976e7bbd` totalement drainé (0 source soft-deleted) + box calme →
> lancé manuellement. **138 331** marqueurs reset **par batches de 30k** (éviter le timeout MCP 60s),
> puis `norva_search_match_state` → `done=false, last_id=null`. Le cron `norva-enrich-search-match`
> (*/3) draine : **~74% de match dès le 1er batch** (748/1000). Requête ci-dessous conservée pour ref.

Le fix `f4b780a` aide les titres **pas encore tentés**. Les **≥5000 déjà tentés-et-ratés** portent un marqueur `search_match_attempted_at` (retry 90j) → il faut le reset pour re-chercher avec la requête propre :
```sql
update cloud_titles set search_match_attempted_at = null
where match_status = 'unmatched'
  and title ~ '^([A-Z]{2}|4K|8K|3D|2160P|1440P|1080P|720P|480P|360P|007)(-[A-Z0-9+]{1,6})*( [-–—▎▏▍▌│┃┆┊｜|] | -[A-Z0-9+]{1,6}- )';
update norva_search_match_state set last_id = null, done = false where id = 1;
```
→ le cron `norva-enrich-search-match` (*/3, actif) draine sur quelques heures → titres préfixés deviennent verified + poster + canonique.

## Crawl audio par pertinence — l'idée « mp4-only » + le plan sûr (PAS ENCORE FAIT)
- **Verdict sur « probe seulement les mp4 »** : le probe fetch l'entête depuis le provider pour TOUS les conteneurs → mp4 n'évite pas la connexion. MAIS l'audio est déjà récupéré **gratuitement à la lecture** (le moteur fait 1 header-parse relay → `shareFileTracks`, zéro hit en plus). Le ban vient du **crawl de fond** (40/h).
- **⚠️ « juste trier le select » est DANGEREUX** : le crawl avance par **curseur `id`** (`order by id, id > afterId`) pour 2 raisons — progression garantie + **anti-blocage** (un titre qui échoue toujours ne pose jamais `audio_probed_at` ; le curseur passe au-delà). Trier par pertinence sans curseur → un titre populaire mais mort bloquerait le budget en tête à chaque tick.
- **Plan sûr (à faire quand DB calme)** : **curseur à deux phases** — Phase 1 = titres matchés TMDB/browsables (`provider_tmdb_id is not null`) parcourus par le même curseur id ; Phase 2 = la longue traîne. Champ `phase` dans l'état du crawl. Edge `norva-source-sync` (select du backfill ~ligne 3800 de norva-playback pour le probe on-play, et le per-source `audio_backfill_candidates`). **Ban-sensible → à faire délibérément hors charge.**

## Incidents d'infra de la session (pour mémoire)
- **Canal de permission MCP `execute_sql`** a flappé plusieurs fois (« Tool permission stream closed ») + le serveur Supabase s'est déconnecté/reconnecté → retries + reload via ToolSearch. Pattern : se rétablit après quelques minutes.
- **Outage `norva-playback`** (début de session) : deploy MCP inline d'un fichier 228KB délégué à un sous-agent → placeholder poussé (v112 PENDING) → récupéré via le CI (deploy depuis le disque). **Leçon clé : jamais de deploy MCP inline d'un gros fichier ; passer par le CI.**
