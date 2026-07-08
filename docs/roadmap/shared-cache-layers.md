# Les couches partagées (mutualisées) — ce qui profite à tous les users

> **Référence d'architecture** (pas un travail différé) : ce qui, dans Norva, est calculé **une
> fois** et réutilisé par **tous** les users du même provider. Vérifié dans le code (audit workflow
> 2026-07-08, 4 agents + vérif adverse) et chiffré sur la prod. Compagnon de
> [`phase2-dedup-activation-runbook.md`](./phase2-dedup-activation-runbook.md) (couche A/B) et de
> [`global-title-cache-design.md`](./global-title-cache-design.md) (design du cache titres).

---

## Le principe

Toute donnée **dérivée coûteuse** (enrichissement TMDB, sondage de pistes, transcription IA) est
écrite dans une table **`catalog_*` SANS `user_id`**, keyée sur l'**identité de contenu / de fichier
provider**. Les tables `cloud_*` (par-user) ne sont que des **projections**. Résultat : **1 calcul →
N users servis**, y compris les futurs users et ceux d'un provider jamais crawlé.

C'est la **couche A** du modèle dedup (enrichissement partagé, **ON**), à distinguer de la **couche B**
(catalogue brut, dormante — voir le runbook dedup).

---

## Les 3 couches partagées

### 1. Pistes audio + sous-titres — `catalog_file_tracks` ✅ **prouvé en prod**
- **Clé de partage** : `(server_host, item_type, external_id)` — identité du **fichier provider**,
  **sans `user_id`**, **pas** le tmdb (les index de flux ffmpeg sont une propriété du fichier exact).
- **Écriture** : `shareFileTracks` → RPC `upsert_catalog_file_tracks` (cache global) + RPC
  `fanout_file_tracks_to_users` (remplit les *autres* owners, sans écraser leur propre probe) —
  `supabase/functions/norva-playback/index.ts:2199-2221`.
- **Lecture (PULL, le mécanisme robuste)** : à chaque lecture engine, **avant** de probe, l'edge lit
  le cache par la même clé et l'overlay dans la ligne `cloud_titles` du user → l'utilisateur B récupère
  les pistes de A **sans toucher le provider** (`index.ts:390-419`).
- **Alimenté par** : (a) l'**extraction on-play** (header-parse relay, **immédiat, 0 seuil**, voir §
  on-play), **et** (b) le **crawl de fond** `norva-audio-*`. Les deux écrivent le même cache.
- **Cross-miroir** : plusieurs URLs revendeur d'un même panel Xtream retombent sur une identité via
  `providerKey` (`resolveSourceIdentity`, `index.ts:1120-1161`).
- **Prod (2026-07-08)** : **117 142 lignes**. Actif, **aucun flag**.

### 2. Métadonnées titres TMDB — `catalog_titles` (couche A) ✅ **prouvé en prod**
- **Clé** : identité de contenu (tmdb). Enrichissement partagé (titre, poster, i18n, année…).
- **Écriture ON** (writers best-effort inconditionnels + cron `cloud_enrich_titles_from_catalog` /5 min).
  La **lecture** globale a un gate séparé (`NORVA_CATALOG_READ_SOURCE`) — détail dans le runbook dedup.
- **Prod** : ~92k lignes. → un futur owner d'un provider réutilise cet enrichissement, sans refaire TMDB.

### 3. Sous-titres IA Whisper — `catalog_generated_subtitles` ⚠️ **construit + actif, mais latent**
- **Clé** : `(provider_key, item_type, external_id, kind, lang)` — **sans `user_id`**.
- **Écriture** : `transcribeEnqueue` (`index.ts:2474-2542`) ; **Lecture** : `getGeneratedSubtitle`
  (`index.ts:2709-2764`). Routes viewer **sans flag** (dispo pour tout user authentifié).
- **Mutualisation** : une transcription faite par un user sert **tous** les users du même panel pour ce
  fichier. **2ᵉ user = instantané** (VTT renvoyé en **une lecture DB**, `cached:true`, aucun Whisper
  refait) ; **seul le 1ᵉʳ** paie le coût Whisper multi-minutes. Un verrou `claim_generated_subtitle_job`
  empêche deux déclenchements concurrents de doubler le travail.
- **Requiert** un `provider_key` non-null (une source host-only est refusée en 422, `index.ts:2487-2490`).
- **Prod (2026-07-08)** : **49 lignes (41 `ready`)**. → le mécanisme est **réel et actif sans flag**,
  mais **quasi jamais exercé** à l'échelle actuelle : c'est **déclenché au clic** (pas automatique), le
  Whisper tourne sur une **gateway mono-slot**, et la pré-génération nocturne (whitelist) est throttlée.
  Le bénéfice cross-user deviendra visible dès qu'il y aura **recoupement réel** (plusieurs users sur les
  mêmes gros panels + au moins un qui a généré le transcript).

---

## ⚠️ Le caveat MODE-DÉPENDANT (à retenir absolument)

L'**extraction on-play gratuite** (le header-parse qui remplit `catalog_file_tracks` à la volée) ne
tourne **QUE sur le chemin moteur navigateur** : `mode:'relay'` + `body.enginePipe === true`
(`index.ts:336-340`). Elle est **immédiate** (probe synchrone, **awaited avant** que l'URL de lecture
soit renvoyée → **avant qu'une seule seconde soit visionnée**, plafonné 8s best-effort) et **totalement
indépendante des crons** (le code on-play ne lit jamais de table de cron / couverture provider).

**MAIS** en lecture **native/directe** (`mode:'direct'`) ou en **transcode gateway** (`mode:'transcode'`),
ce header-parse **ne tourne pas**. → « regarder scanne les pistes » n'est vrai que pour la **lecture
engine navigateur**. Le cache se remplit quand même via le **crawl de fond** + les **autres lectures
engine** — juste pas forcément à *cette* lecture-là.

---

## Deux « whisper » à ne PAS confondre

| | Ce que c'est | État |
|---|---|---|
| **Whisper transcription** | les **sous-titres IA** (couche 3 ci-dessus) | actif, **non flaggé**, mutualisé, 49 lignes |
| **Whisper détection de langue** | nomme les pistes **audio non-taguées** | `NORVA_WHISPER_DETECT`, **OFF par défaut**, tâche de fond |

Le même binaire `whisper.cpp` sur la gateway sert les deux, mais ce sont **deux fonctionnalités
différentes** — ne pas déduire de l'une l'état de l'autre.

---

## Verdict : prouvé vs latent

| Automatisme | Clé | Prod | Multi-user ? |
|---|---|---|---|
| Pistes audio/sous-titres (`catalog_file_tracks`) | `(server_host,item_type,external_id)` | **117 142** | ✅ **prouvé & actif** |
| Enrichissement titres TMDB (`catalog_titles`) | identité contenu (tmdb) | ~92k | ✅ **prouvé & actif** |
| Sous-titres IA (`catalog_generated_subtitles`) | `(provider_key,item_type,external_id,kind,lang)` | **49 (41 ready)** | ⚠️ **construit+actif, latent** |
| Catalogue brut (couche B) | `(server_host,item_type,external_id)` | **0** | ⏸️ **dormant** (runbook dedup) |

---

## Implication roadmap

La 1ʳᵉ génération Whisper est **lente (multi-minutes) et sérialisée** (gateway **mono-slot**). À
l'échelle, si beaucoup de users cliquent sur des fichiers non-transcrits, ça fait la **queue** → c'est
exactement la charge qui justifiera le **GEX44** (NVENC + slots parallèles) et, éventuellement, une
**pré-génération whitelist élargie** pour les gros catalogues. Tant que le volume est faible, mono-slot
suffit.

---

## Ancrages code (audit workflow 2026-07-08 — vérifié adversairement)

- **On-play extraction** : `supabase/functions/norva-playback/index.ts:336-340` (garde mode relay+enginePipe),
  `:424-458` (probe once → persist `cloud_titles` → shareFileTracks, awaited inline),
  `:2152-2189` (`probeEngineTracks` = fetch relay `/probe-audio`, 8s, best-effort).
- **Skip-probe si déjà connu** : `:370-378` (ligne titre) et `:390-420` (cache global).
- **Partage pistes** : `:2199-2221` (`shareFileTracks`) ; migration `20260625010000_catalog_file_tracks_global_cache.sql`
  (table clé `(server_host,item_type,external_id)`, sans `user_id`, service-role ; `fanout_file_tracks_to_users`
  ne remplit que les owners dont `..._probed_at IS NULL`) ; `20260629121000_fanout_file_tracks_provider_key.sql`
  (fan-out cross-miroir sur `coalesce(providerKey, serverHost)`).
- **Sous-titres IA** : `:2474-2542` (`transcribeEnqueue`, fast-path `{status:'ready',cached:true}`),
  `:2709-2764` (`getGeneratedSubtitle`), `:2511` (`claim_generated_subtitle_job` anti-double),
  migration `20260629143000_catalog_generated_subtitles.sql` (clé `(provider_key,item_type,external_id,kind,lang)`,
  sans `user_id`).
- **Crawl de fond (séparé du on-play)** : `:139-140,3332,3402,4072` (`/audio-backfill` → `runAudioBackfill`),
  crons `norva-audio-*` scopés userId/sourceId (`supabase/functions/ENRICHMENT_CRON_SETUP.md`).
- **whisperDetect flag** (à ne pas confondre) : `:463-466` (`rc.whisperDetect` / `NORVA_WHISPER_DETECT`, OFF défaut).
