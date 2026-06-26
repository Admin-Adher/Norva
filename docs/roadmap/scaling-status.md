# Norva — Scalabilité & coûts fournisseurs : état & reprise

> **But de ce fichier** : mémoriser les optimisations de scalabilité déjà en place
> et **ce qu'il reste à faire quand Norva aura beaucoup d'users multi-pays** — pour
> reprendre sans rien re-découvrir.
>
> _Dernière mise à jour : 2026-06-26._

Branche dev : **`claude/eager-carson-2zlqwy`** · Projet Supabase : **`oupsceccxsonaalhueff`**.

---

## TL;DR

La lecture passe par le **relais Cloudflare** (edge mondial, **zéro frais
d'egress** — le bon choix pour proxifier de la vidéo à l'échelle). Certains
fournisseurs IPTV redirigent la VOD vers des **nœuds backend en IP-brute** que
`fetch()` ne peut pas joindre (erreur Cloudflare **1003**) → le relais streame ces
nœuds via **socket TCP**. Trois optimisations de charge sont en place. Le gros
levier restant — le **cache de titres global** — a sa **fondation posée** ; sa
**bascule de lecture est volontairement différée** (zéro bénéfice tant qu'il n'y a
pas de recoupement multi-users, et c'est le changement le plus risqué du système).

---

## ✅ Fait & déployé (live)

### Lecture (relais `services/norva-relay`)
- **Socket TCP pour nœuds IP-brute** — `proxyPlayback` → `trySocketPath` /
  `fetchNodeViaSocket`. `fetch()` se prend un 1003 sur ces nœuds ; `connect()` les
  atteint (token lié à la même IP de sortie Cloudflare). Gardé aux 401/403 — les
  titres qui marchent gardent le chemin `fetch()` rapide.
- **#1 — Cache de hint socket** (`SOCKET_HINTS`, LRU in-isolate) : un flux confirmé
  « socket-only » saute le `fetch` qui 403 **et** la sonde de range → ~½ des
  allers-retours fournisseur par range request. Auto-réparant (re-apprend si le
  load-balancer déplace le titre).
- **Diagnostics** `X-Norva-Upstream-Status / -Reason / -Final` : sur tout échec
  fournisseur, le vrai statut + raison est exposé (header CORS-readable + log
  Worker `tag:"norva-relay-upstream-error"`).

### Métadonnées
- **#2 — Cache `get_vod_info`** : relais `/vod-info/<token>` + **edge Cache API**,
  clé `(host fournisseur, vod id)`, TTL 24h → **1 fetch par titre/PoP** au lieu de
  par-lecture, partagé entre tous les users. Sert le libellé audio
  « Anglais · AAC · Stereo · 128 kbps » (même donnée que le lecteur mobile natif).
- Libellé **sous-titres incrustés** dérivé du titre (`SUBT AR` →
  « Burned-in subtitles (Arabic) ») — parsing local, pas de pipeline externe
  (décision : « gratuit + bonne couverture arabe + fiable » n'existe pas ensemble,
  et le contenu arabe est déjà hardsubbé).

### Cache de titres global — FONDATION + SCALE-READY (#3)
- Table **`public.catalog_titles`** `(item_type, provider_tmdb_id)` + RLS (service-role
  only) + sentinelle `'0'` exclue. Migration `…270000_catalog_titles_foundation.sql`.
  **Backfill** : **16 751** titres copiés. **Dual-write** best-effort dans
  `_shared/vod-title-projection.ts` (sur `norva-source-sync` **et** `norva-cloud`).
- **`audio_languages` global** (06-24) : colonne + GIN sur `catalog_titles` + RPC
  `merge_catalog_title_audio()` (union race-safe en SQL, sentinelle-gardée, service-role).
  Les 2 points d'écriture audio (`runAudioBackfill.processOne`, `recordObservedLanguages`)
  miroitent dans le cache global ⇒ **une langue sondée une fois est partagée à tous**.
  Migration `…010000`. _(Piège évité : le builder Supabase est un thenable sans `.catch()`
  → `try/catch` obligatoire.)_
- **Harnais de vérif** `catalog_mirror_diff()` + route service-gated
  `POST norva-playback/catalog-mirror-verify` : prouve que `catalog_titles` est un miroir
  fidèle (aujourd'hui **16 751 comparés, 0 mismatch, 0 cloud_only**) = **gate du flip** ET
  preuve anti-rot (catalog==cloud ⇒ sortie flag-ON == flag-OFF). Migration `…020000`.
  **⚠️ OBSOLÈTE depuis le 2026-06-26** — voir le durcissement plus bas : l'auto-thinning vide
  `cloud_titles.metadata`, donc l'égalité octet ne peut plus tenir. Gate de flip = `catalog_titles_quality_gate()`.
- **Chemin de lecture flag-gated** `NORVA_CATALOG_READ_SOURCE` (défaut `cloud_titles`) :
  quand `catalog_titles`, `applyCatalogOverlay()` sert les métadonnées d'affichage depuis
  le cache global à **tous** les sites de `norva-catalog` (grille langues, rails
  genre/titre/populaire/because-you-watched via `listVerifiedTitleCandidates`,
  `localizeMediaTitles`). **Filtrage langue reste per-user. Défaut OFF ⇒ lecture identique.**
- **Cache facettes** `listLanguageFacets` : memo LRU in-isolate (`${userId}:${itemType}`,
  TTL 60s) → les 25 count-queries/appel ne tournent qu'1×/min/user.
- **Crawl audio scale** : (a) **progression** `cloud_titles.audio_probed_at` → le crawl
  avance au lieu de re-sonder le même front ; (b) **catalog-first fill** `mode=catalog` +
  `fill_user_audio_from_catalog()` → remplit un user depuis le cache global **sans appel
  fournisseur** (dedup : sonder 1× pour tous). **Branché AUTO à l'onboarding** : la
  projection appelle `fill_user_audio_for_titles` par batch → un nouvel user d'un fournisseur
  déjà couvert **démarre rempli** (le « 2-3 j » de découverte n'est payé qu'1× par
  fournisseur). Migrations `…030000`, `…040000`.
- **Périmètre du crawl** : `requireTag` accepte une **liste** (OR via `overlaps`). 2 crons
  pg_cron : **films** (`norva-audio-langs`, `0,30`, limit 15) sur `multi,vostfr,vo,vff,vfq`
  (rendement vostfr/vo ~80 % — l'audio original/JP des animés-films) + **séries**
  (`norva-audio-langs-series`, `10,40`, limit 12) via `resolveSeriesEpisodeUrl` (get_series_info →
  1er épisode du 1er season, ~70 % rendement — un id de série seul renvoie 406). → l'audio
  japonais des animés (films **et** séries) remonte dans le filtre au fil du crawl.
  Cadences **throttlées** (étaient `*/5`, `2-59/5`) pour réduire egress/invocations ; source
  de vérité des schedules : `supabase/functions/ENRICHMENT_CRON_SETUP.md`.
- ⚠️ **Rien ne lit `catalog_titles` en prod** (flag OFF) → **zéro impact**, additif, réversible.

### Cache de titres global — DURCISSEMENT keep-best + gate qualité (2026-06-26)
- **`overlap_factor` = 2.05** (était 1.00 ; 2ᵉ user, catalogues ~identiques) → le recoupement est
  **réel** mais l'échelle non (2 comptes). Le flip reste gardé sur **l'échelle**, pas sur le ratio.
- **Le gate octet `catalog_mirror_diff()` est OBSOLÈTE** : l'auto-thinning vide `cloud_titles.metadata`
  **par design** (étape 5), donc catalog ≠ cloud pour toujours — et c'est **correct**, pas du rot.
- **Trigger `catalog_titles_keep_best` (BEFORE, exception-guardé)** : les 2 écrivains (dual-write TS
  `_shared/vod-title-projection.ts` + miroir `cloud_titles_mirror_to_catalog`) font des upserts **en
  bloc sans garde** ; le trigger rend `catalog_titles` **monotone** — métadonnée/affichage TMDB-enrichi
  **jamais** écrasé par du provider-raw/null, remplit-sans-écraser, `release_year` clampé `[1900, +1]`,
  `audio_languages` intact. **Testé empiriquement** (downgrade bloqué / upgrade appliqué / null-fill).
  _(Piège corrigé : `jsonb_typeof(metadata->'tmdb')` = NULL si absent ⇒ `if not NULL` sautait tout le
  bloc ; coalescé en `false`.)_ Migrations `…154714` + fix `…155105`.
- **Réconciliation one-shot** : rempli **481 `release_year` + 718 `backdrop_url`** vides du cache depuis
  la meilleure ligne cloud (enrichi-puis-frais). Migration `…155504`.
- **Nouveau gate de flip `catalog_titles_quality_gate()`** (service-role) : mesure « catalog **jamais
  pire** que cloud » — aucun champ blanc là où cloud a une valeur, aucune perte d'enrichissement,
  identité complète. **Aujourd'hui : tout à 0 sur 16 046** ⇒ flip *quality-ready*. Migration `…155618`.
  **C'est lui le gate désormais**, plus `catalog_mirror_diff`.

---

## ⏳ À FAIRE quand on aura beaucoup d'users (le « ne pas oublier »)

### A. Bascule de lecture du cache de titres global (#3 — la moitié risquée + le gain)
> Design complet & étapes : [`global-title-cache-design.md`](./global-title-cache-design.md).

- **Trigger** : quand le **recoupement multi-users** est matériel (plusieurs
  users / pays partagent les mêmes titres TMDB). Aujourd'hui ~0 % (1 catalogue) →
  le gain (÷10-100 sur l'enrichissement TMDB + stockage) reste modeste à 2 users. **Mesuré
  2026-06-26 : `overlap_factor = 2.05` (2 users, catalogues ~identiques) — recoupement réel
  mais échelle insuffisante ; flip gardé sur l'échelle, pas le ratio.**
- **Mesurer le trigger** (relancer périodiquement) :
  ```sql
  select count(*)                                              as user_title_rows,
         count(distinct (item_type, provider_tmdb_id))         as distinct_titles,
         round(count(*)::numeric
               / nullif(count(distinct (item_type, provider_tmdb_id)), 0), 2) as overlap_factor
  from public.cloud_titles
  where provider_tmdb_id is not null and provider_tmdb_id <> ''
    and provider_tmdb_id !~ '^(tt)?0+$';
  ```
  `overlap_factor` nettement **> 1** (titres per-user / titres distincts) → implémenter.
- **Étapes** (additives, réversibles) :
  1. ✅ Créer `catalog_titles`.
  2. ✅ Dual-write depuis la projection.
  3. ✅ Backfill depuis `cloud_titles`.
  4. ✅ **Read cutover CONSTRUIT (flag OFF)** : `applyCatalogOverlay()` sur **tous** les
     sites de lecture de `norva-catalog` derrière `NORVA_CATALOG_READ_SOURCE`, + harnais
     `/catalog-mirror-verify` (aujourd'hui 0 mismatch). Filtrage langue reste per-user.
     **Le « cutover » se résume désormais à : (a) `catalog_titles_quality_gate()` → tout à 0
     (l'ancien `/catalog-mirror-verify` octet est obsolète depuis le thinning),
     (b) poser le secret `NORVA_CATALOG_READ_SOURCE=catalog_titles` sur `norva-catalog`.**
     ⏳ reste seulement **le flip** (gardé jusqu'au vrai recoupement).
  5. ⏳ **Thin `cloud_titles`** : retirer les colonnes métadonnées migrées une fois les
     reads stables sur le cache global (garder identité + lien per-user + variant_count).
  6. ⏳ **Catalog-first fill au sync** : appeler `mode=catalog` /
     `fill_user_audio_from_catalog` à l'onboarding d'un nouvel user → il hérite des
     langues déjà connues sans re-sonder le fournisseur (≈1 ligne dans le finalize sync).
- **À ajouter au cutover** : TMDB **changes API** (refresh incrémental des titres
  au `tmdb_synced_at` vieux) + **daily id exports** TMDB (seed bulk) — opèrent sur
  la table globale, une fois pour tous.

### B. Monitoring par fournisseur — ✅ émission + webhook construits
- Le relais émet `tag:"norva-relay-upstream-error"` (status/host/reason/finalUrl) **et**,
  si le secret **`MONITOR_WEBHOOK`** est posé, POST une alerte compacte **échantillonnée**
  (≤1×/(host,status)/5 min, fire-and-forget via `ctx.waitUntil`). Off par défaut.
  _(`maybeAlertUpstreamError` dans le relais — déployé via CI `deploy-relay.yml` au merge `main`.)_
- ⏳ Optionnel à l'échelle : Logpush / Workers Analytics Engine sur le même log pour des
  dashboards/seuils plus riches par host.

### C. Harness de test multi-fournisseurs — ✅ construit
- Route service-gated **`POST norva-playback/provider-playback-check`** : pour **1 film par
  host fournisseur**, lance un Range 1 octet via le relais et vérifie **206** (+ `path`,
  `ms`). Détecte un fournisseur dont l'auth/redirect casse **avant** les users. Vérifié
  aujourd'hui : `{checked:1, allOk:true, path:"socket"}`.

---

## 🧱 Garde-fous (à respecter quoi qu'il arrive)
- `provider_tmdb_id = '0' / ''` = sentinelle no-match → **jamais** une clé ni une
  identité (ne pas joindre dessus).
- Années de sortie **plafonnées** à `[1900, année courante + 1]`.
- Les ids TMDB du fournisseur sont fiables pour l'**identité** ; la validation TMDB
  ne gate que la confiance dans les **métadonnées** TMDB (jamais l'identité).

## 🧭 Coordonnées clés
| Élément | Où |
|---|---|
| Relais (socket, caches, diagnostics) | `services/norva-relay/src/index.js` — CI `deploy-relay.yml` sur push `main` |
| Cache `get_vod_info` | relais `/vod-info/<token>` + edge Cache API |
| Table cache global | `public.catalog_titles` (clé `item_type, provider_tmdb_id`) |
| Dual-write | `supabase/functions/_shared/vod-title-projection.ts` |
| Reads à basculer (étape 4) | `supabase/functions/norva-catalog/index.ts` (`titleRailItem`, `listGenreItems`, `listMediaItems`) |
| Design détaillé | [`global-title-cache-design.md`](./global-title-cache-design.md) |
