# Norva — Architecture de fiabilité (lecture & écosystème)

> Décision d'architecture (ADR) qui guide toutes les évolutions de lecture.
> Objectif : un écosystème **fiable**, sans les erreurs `502 / provider 401`
> qui cassent la confiance.

## 1. Le constat (juin 2026)

Symptôme : « aucun film ne se lance » — `POST /norva-playback/playback/session → 502`.

Cause racine **confirmée par les données de prod** :

- Le **media-gateway** (Railway) est en ligne et sain (`/health` → `version 38`).
- L'**Edge Function** Supabase fonctionne et remonte correctement l'erreur.
- Le **fournisseur IPTV** renvoie `401 Unauthorized` quand ffmpeg tire le flux
  **depuis l'IP datacenter de Railway** :
  `FFmpeg exited with code 1 ... Server returned 401 Unauthorized`.
- Le **même compte fonctionne** dans TiviMate / autre app (IP **résidentielle**).
- Timeline : la lecture marchait jusqu'à ~14h21, puis l'IP datacenter a été
  flaggée/bloquée par le fournisseur (panel renvoie aussi `429` aux inconnus).

**Conclusion : ce n'est pas un bug applicatif.** C'est le modèle « tirer la
vidéo via un datacenter » qui est intrinsèquement fragile : les fournisseurs
IPTV bloquent les plages d'IP datacenter (anti-revente / anti-abus).

## 2. Le principe directeur : séparer les deux plans

Norva ne télécharge pas les films. Le « cloud » sert à faire **voyager de
l'état** entre appareils (reprendre un film à 38:01 sur un autre écran).

| Plan | Rôle | Où il DOIT tourner | Statut |
|------|------|--------------------|--------|
| **Contrôle (le cerveau)** | comptes, appairage, catalogue, **reprise / historique / favoris / télémétrie** | **Cloud** (Supabase) | ✅ fonctionne, fiable |
| **Données (les octets vidéo)** | tirer + (éventuellement) transcoder le flux | **Réseau résidentiel** de l'utilisateur (comme TiviMate) | ⛔ à sortir du datacenter |

Règle d'or : **le flux vidéo se tire depuis l'IP de l'utilisateur, jamais
depuis un datacenter par défaut.** La synchro reste, elle, 100 % cloud.

## 3. Stratégie de lecture par surface

L'objectif « reprendre sur un autre appareil » est porté par le **plan de
contrôle** (déjà en place). Le **plan de données** s'adapte à chaque surface :

| Surface | Chemin vidéo recommandé | Transcodage requis ? |
|---------|-------------------------|----------------------|
| **Android TV / mobile (natif)** | **Lecture directe** depuis le fournisseur (IP résidentielle, ExoPlayer joue HEVC/MKV/AC3 nativement) | Non |
| **Navigateur — codec web-safe** (H.264/AAC) | Lecture directe / relais résidentiel | Non |
| **Navigateur — codec exotique** (MKV/HEVC/AC3) | **Hub local** (serveur `server/` sur une machine maison) qui transcode depuis l'IP résidentielle | Oui, mais en résidentiel |
| **Repli ultime** | Gateway cloud (Railway) — **opt-in seulement**, jamais le défaut | Oui, mais fragile (IP block) |

Le gateway cloud n'est PAS supprimé : il devient un **repli explicite**, pas la
voie par défaut.

## 4. Plan de fiabilité (incréments)

Classés par impact / facilité. ⚙️ = déployable par l'agent (web/edge) ;
🧰 = nécessite une action infra de l'owner (Railway/merge main/hub).

1. **Messages d'erreur exploitables** ⚙️
   Quand le fournisseur refuse depuis le cloud (`provider 401` / datacenter
   bloqué), afficher un message clair + proposer le hub local / l'app native,
   au lieu d'un échec cryptique. Ne plus « tourner » 10 s sur un 401 d'auth.

2. **Web : préférer le résidentiel, démoter le gateway cloud** ⚙️
   Réordonner la sélection de mode : direct/hub local d'abord, gateway cloud en
   dernier recours opt-in.

3. **Hub local de première classe pour le web** ⚙️/🧰
   Détection + bascule automatique vers un hub local appairé ; doc de mise en
   route (`server/` + Cloudflare Tunnel) pour un accès distant via IP maison.

4. **Apps natives = socle de lecture** 🧰
   Android TV / mobile en lecture directe + synchro cloud. Câbler la reprise
   multi-appareils sur le plan de contrôle existant.

5. **User-Agent configurable jusqu'au gateway** ⚙️/🧰
   Faire remonter le preset UA de la source (`tivimate` = `TiviMate/4.7.0`)
   du client → edge → gateway, au lieu d'un UA Chrome codé en dur (mitigation).

## 5. Invariants à NE PAS casser

- La **synchro cloud** (reprise/historique/favoris via Supabase) est le cœur de
  valeur : elle doit rester intacte et indépendante du chemin vidéo.
- La lecture doit **dégrader proprement** : si un chemin échoue, basculer vers
  le suivant et, en dernier recours, expliquer clairement à l'utilisateur.
- Aucune erreur silencieuse : tout échec de lecture produit un message
  actionnable + de la télémétrie (`cloud_playback_events`).

## 6. Journal d'implémentation & reste à faire

### Fait
- **Erreurs claires + stop au refresh en boucle** (`public/js/cloudApi.js`,
  `public/js/pages/WatchPage.js`). Un blocage fournisseur (401/403/429) affiche
  un message exact et n'enchaîne plus les rafraîchissements.
- **Lecture native TV en mode cloud** (`public/js/api.js`,
  `public/js/utils/standalone.js`). Quand un pont natif est présent
  (`window.NodeCastNative` standalone, ou `window.NorvaTVCloud` cloud), `api.js`
  résout l'**URL directe** du fournisseur (`mode: 'direct'`) et `standalone.js`
  la passe à l'ExoPlayer natif → lecture depuis l'IP résidentielle, codecs
  matériels, **pas de 401 datacenter**. Corrige aussi un bug : le pont ne gérait
  pas le *resolver* async de `play()` (il passait la fonction au lieu de l'URL),
  et ne s'activait qu'en standalone.
  - ⚠️ **À tester sur l'appareil** : impossible à exécuter ici (pas d'Android TV).
    Le mode cloud charge `norva.tv/app.html` en direct → déploiement web suffit
    (pas de rebuild APK). Le navigateur n'a aucun pont → comportement inchangé.

### Reste à faire (prioritaire pour la reprise multi-appareils)
1. **Remontée de position depuis le lecteur natif** (Java, rebuild APK).
   `clients/android-tv/.../PlayerActivity.java` ne reporte aujourd'hui qu'un
   statut ok/broken vers `127.0.0.1` (standalone only) — **aucune position**.
   Pour réaliser « reprendre à 38:01 sur un autre écran » :
   - POSTer périodiquement la progression vers l'API cloud `/history`
     (`POST norva-cloud/history` avec le token cloud + `sourceId/itemType/itemId`),
     p.ex. toutes les 10 s et à la pause/sortie.
   - Récupérer l'offset de reprise à l'ouverture et `player.seekTo(...)`.
   - Le pont devra fournir le token cloud + l'offset au `PlayerActivity`.
2. **Web → hub local (navigateur)**. Pour lire les codecs exotiques **dans un
   navigateur** sans datacenter :
   - UI d'appairage d'un hub (`server/`) dans Réglages + Cloudflare Tunnel.
   - Router la lecture web sur le hub (`_hubBase()` existe dans `api.js`, mais
     `_shouldUseCloud()` force le cloud sur un hôte distant — à assouplir pour la
     lecture quand un hub est appairé).
3. **UA configurable jusqu'au gateway cloud** (mitigation du repli cloud) :
   remonter le preset UA de la source (`tivimate`) client → edge → gateway.
