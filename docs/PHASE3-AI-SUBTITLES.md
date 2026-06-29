# Phase 3 — Sous-titres IA (whisper → VTT + Argos)

**Statut : 3a LIVRÉ (transcription async + cache + livraison + player, en prod). 3b/3c = cadrage.**
**Décisions produit (2026-06-29) : déclenchement HYBRIDE · v1 = transcription + traduction Argos d'un coup.**

> **Mise à jour 2026-06-29 — 3a en production.** La chaîne transcription → cache cross-user → livraison
> au player est déployée et vérifiée bout-en-bout (cf. §8 « 3a tel que livré »). 3b (Argos) et 3c
> (orchestration : cron whitelist + reaper) restent à faire ; le reste de ce document garde la spec d'origine.

## 1. But

Quand un titre n'a **aucun sous-titre texte dans la langue de l'user**, générer des sous-titres :
transcrire l'audio (whisper.cpp, **horodaté → WebVTT**) puis **traduire vers la langue de l'user**
(Argos Translate, self-hosted/gratuit). Résultat **caché cross-user** (une génération sert tout le
monde sur le même panel).

Réutilise l'infra **Phase 2 déjà en prod** : whisper.cpp sur la gateway, extraction audio, langue
source déjà détectée, cache cross-user keyé par `providerKey` (cf. `PROVIDER-IDENTITY-DEDUP.md`).

## 2. Décisions actées

- **Déclenchement = HYBRIDE** : (a) **à la demande + cache** par défaut (l'user demande des sous-titres
  IA sur un titre qui n'en a pas → on génère en tâche de fond avec progression → cache) ; (b) **petit
  backfill nocturne** d'une **whitelist** (nouveautés / plus regardés) pour que les titres « chauds »
  soient déjà prêts.
- **v1 = complet** : transcription **puis** traduction Argos vers la langue de l'user, livré ensemble
  (pas juste la langue parlée).

## 3. Architecture (nouvelles pièces)

### a. Gateway — transcription complète horodatée
- Nouvel endpoint (ex. `POST /transcribe`) : extrait **tout l'audio** d'une piste (ffmpeg → WAV mono
  16 kHz) puis **whisper.cpp avec timestamps → VTT** (`whisper-cli … -ovtt`). Renvoie le VTT (langue
  source). Phase 2 n'extrayait que 20 s ; ici c'est le film entier.
- Réglages : modèle (`base`/`small` = compromis vitesse/précision), threads, timeout long, job async.

### b. Argos — traduction
- Argos Translate (Python) + **modèles de paires** (`en↔fr`, `ru↔fr`, `fa↔fr`, …; Argos pivote souvent
  via l'anglais). Appelé depuis la gateway (sous-processus Python, ou sidecar). Traduit **chaque cue**
  du VTT source → langue cible, **timestamps préservés**.
- Source = langue détectée (Phase 2) ; cible = langue de profil de l'user.

### c. Cache & livraison
- Table `catalog_generated_subtitles` (cross-user) : `provider_key, item_type, external_id, kind
  ('transcript'|'translation'), lang, vtt, created_at`. On **stocke le transcript source** (réutilisable
  pour toute langue cible → ne re-transcrit jamais) **et** la traduction par langue cible.
- Endpoint qui sert le VTT ; le player sait déjà afficher un text-track (cf. sous-titres in-band).

### d. Orchestration hybride
- **À la demande** : l'edge enqueue un job → gateway transcrit+traduit en async → stocke → l'UI
  affiche la progression (« Transcription… / Traduction… ») → 1ʳᵉ fois = quelques min, ensuite instantané
  pour tous (cache). Auto-proposé quand aucun sous-titre dans la langue de l'user.
- **Backfill nocturne** : cron (fenêtre nuit, comme l'enrichissement) qui pré-génère pour une
  **whitelist bornée** (nouveautés / top-vues / flag). Même endpoint gateway. Petit N/nuit (coût CPU).

## 4. Les contraintes DURES (à trancher à l'implémentation)

1. **Temps CPU de transcription** = le risque n°1. whisper.cpp sur ~2 h d'audio en **CPU** (Railway)
   peut prendre **plusieurs minutes à beaucoup plus** selon le modèle. Leviers : modèle plus petit
   (`base`), threads, jobs async avec progression ; envisager un **worker dédié** ou un **fallback API
   payant** pour l'à-la-demande si la latence CPU est trop forte. À benchmarker tôt.
2. **Extraction audio complète = longue connexion sur le slot unique.** Extraire tout l'audio d'un film
   monopolise l'unique connexion provider pendant toute la durée du read. Sur mono-slot, ça **entre en
   conflit avec la lecture** (un user qui regarde tient déjà le slot → l'extraction se 429/458).
   → **Le backfill nocturne (slot libre) est le bon moment** ; l'à-la-demande doit être **mis en file**
   (généré quand le slot se libère) plutôt que pendant la lecture. À cadrer dans l'orchestration.
3. **Argos = Python dans une gateway Node** → image Docker plus lourde / sidecar. Build + taille.
4. **Stockage** : les VTT sont du texte → négligeable.

## 5. Phasage interne (livré ensemble en v1, mais construit dans cet ordre)

- **3a — ✅ LIVRÉ** : gateway transcription async (audio complet → whisper VTT source) + table cache
  cross-user + endpoints de livraison + le player charge le VTT. (Toute la chaîne
  transcription→livraison→cache est validée. Détail en §8.)
- **3b** : Argos (VTT source → langue user) + modèles. (Le « dans MA langue ».)
- **3c** : orchestration hybride (UI à-la-demande ✅ ; reste : cron whitelist nocturne + reaper jobs bloqués).

## 6. À décider à l'implémentation
- Modèle whisper transcription (`base` vs `small`/`medium`) — benchmark vitesse/précision sur la gateway.
- Argos : sous-processus vs sidecar ; quelles paires installer (cible = langue(s) des users).
- Définition de la **whitelist** backfill (nouveautés ? top-vues ? flag manuel ?).
- Budget compute/nuit ; éventuel chemin rapide (GPU/API) pour l'à-la-demande.
- Langue cible = préférence de profil de l'user (où la lit-on).

## 7. Réutilisé vs neuf (résumé)
| Brique | État |
|---|---|
| whisper.cpp sur gateway | ✅ Phase 2 (live) |
| extraction audio | ✅ Phase 2 (clip) → ✅ **film entier** (3a, live) |
| langue source | ✅ Phase 2 |
| cache cross-user `providerKey` | ✅ (live) → ✅ **table `catalog_generated_subtitles`** (3a, live) |
| whisper **VTT horodaté** | ✅ **3a (live)** |
| **Argos** traduction | ❌ neuf (3b) |
| orchestration hybride + UI | 🟡 UI à-la-demande ✅ (3a) ; cron whitelist + reaper ❌ (3c) |

## 8. 3a tel que livré (2026-06-29)

Chaîne **async** de bout en bout, vérifiée en prod (modèle whisper `small`, RTF ~0.3 → ~35-45 min/film
de 2 h en tâche de fond) :

**Gateway** (`services/media-gateway`, `GATEWAY_VERSION` 56, modèle `small`) :
- File en mémoire (concurrence 1) : `POST /transcribe-async/:token` (token byte-pipe HMAC) → enqueue →
  extraction audio **complète** de la piste → `whisper-cli -ovtt -mc 0` → nettoyage anti-répétition
  (`cleanVtt` : dédup des cues consécutifs, collapse intra-cue, drop des hallucinations) → **callback**
  edge avec le VTT. `POST /transcribe/:token` (sync) reste dispo pour le benchmark.

**Edge** (`supabase/functions/norva-playback`, v16) :
- `transcribeEnqueue()` (helper partagé) : résout titre → variante → URL provider, calcule le
  `providerKey`, **claim atomique** du job (`claim_generated_subtitle_job` RPC), construit le token
  byte-pipe (exp +2 h), POST au gateway, renvoie tout de suite. Un transcript `ready` court-circuite
  depuis le cache.
- Routes **user-authées** (`requireIdentity`) : `GET /generated-subtitle?titleId=` (état + VTT quand prêt)
  et `POST /generated-subtitle` (déclenche). `POST /transcribe-callback` (authée par le token gateway)
  écrit le VTT dans le cache par `job_id`.
- Mode service `audio-backfill { mode:'transcribe-enqueue' }` (token backfill) partage le même helper.

**Anti-doublon (slot unique).** `claim_generated_subtitle_job` rend la décision « prendre la ligne »
**atomique** (`INSERT … ON CONFLICT … DO UPDATE … WHERE`) : sur deux déclenchements simultanés du même
titre, un seul gagne et POST au gateway, les autres réutilisent le job en cours. Une ligne `processing`
encore fraîche (< TTL 90 min) bloque la reprise ; une ligne périmée est reprise ; `force` outrepasse.

**Cache** : `public.catalog_generated_subtitles` — PK `(provider_key, item_type, external_id, kind, lang)`,
`kind` = `transcript` (lang `src`) | `translation` (3b), `status` = `processing|ready|failed`, `vtt`,
`source_lang`, `segments`, `audio_sec`, `job_id`. Service-role only. Survit à la suppression de compte
(pas de FK user/source) → une transcription sert tous les users du même panel.

**Player** (`public/js/pages/WatchPage.js`) : entrée « ✨ AI subtitles » dans le menu CC, affichée
**seulement** quand aucune piste texte exploitable n'existe. Machine à états : *Generate → génération…
→ ready / no speech detected / failed-retry*. Au `ready`, le VTT est parsé et injecté dans un `<track>`
sans `src` via `addCue()` (même chemin sans rechargement que les sous-titres probe/in-band). Sondage
20 s (plafond 1 h), cache VTT en session keyé par titre, polling coupé proprement au teardown.
`cloudApi.js` : `playback.generatedSubtitle()` / `playback.requestGeneratedSubtitle()`.

**Vérifié en live** : enqueue réel (FR) → `providerKey` dérivé du contenu → gateway `{queued, position:1}`
→ `ready` avec VTT FR propre (9 cues, `source_lang:fr`) ; 2ᵉ appel → `cached:true`, **même** `jobId`
(pas de doublon) ; callback `failed` réécrit bien la ligne par `job_id` (transitoire « Audio extraction
failed », réussite au retry).
