# Phase 3 — Sous-titres IA (whisper → VTT + Argos)

**Statut : CADRAGE (spec). Pas encore implémenté.**
**Décisions produit (2026-06-29) : déclenchement HYBRIDE · v1 = transcription + traduction Argos d'un coup.**

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

- **3a** : gateway `/transcribe` (audio complet → whisper VTT source) + table cache + endpoint + le
  player charge le VTT. (Valide toute la chaîne transcription→livraison→cache.)
- **3b** : Argos (VTT source → langue user) + modèles. (Le « dans MA langue ».)
- **3c** : orchestration hybride (UI à-la-demande + cron whitelist nocturne + mise en file slot-safe).

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
| extraction audio | ✅ Phase 2 (clip) → **étendre au film entier** (neuf) |
| langue source | ✅ Phase 2 |
| cache cross-user `providerKey` | ✅ (live) → **nouvelle table sous-titres** (neuf) |
| whisper **VTT horodaté** | ❌ neuf (3a) |
| **Argos** traduction | ❌ neuf (3b) |
| orchestration hybride + UI | ❌ neuf (3c) |
