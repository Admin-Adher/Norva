# Phase 3 — Sous-titres IA (whisper → VTT + Argos)

**Statut : PHASE 3 COMPLÈTE — 3a (transcription) + 3b (Argos) + 3c (orchestration nocturne) en prod.**
**Décisions produit (2026-06-29) : déclenchement HYBRIDE · v1 = transcription + traduction Argos d'un coup.**

> **Mise à jour 2026-06-30 — Phase 3 terminée.** 3a (transcription async → cache cross-user → player,
> §8), 3b (traduction Argos multi-cible, §10) et 3c (whitelist nocturne par provider + reaper, §11)
> sont déployés et vérifiés bout-en-bout. Le reste du document garde la spec d'origine.

> **Mise à jour 2026-07-04 — coordination viewer↔jobs + affichage player durci** (PR #107→#110) :
> gate pregen branchée sur le heartbeat watch-history + garde slot locale gateway + préemption
> viewer ; sonde du cache partagé à l'ouverture (plus de « Generate » sur un transcript prêt) ;
> survie des cues aux deux mécanismes d'effacement de hls.js (pistes labellisées + `_cleanTracks`
> sur recovery) ; libellés avec langue détectée (« show original (Français) ») ; la livraison
> progressive ne s'arrête plus au premier partiel. Détails :
> `SUBTITLE-PREGEN-RELIABILITY.md`, addendum 2026-07-04.

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
- **3c — ✅ LIVRÉ** : orchestration hybride complète (UI à-la-demande ✅ ; cron whitelist nocturne par
  provider ✅ ; reaper jobs bloqués ✅). Détail en §11.

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
| orchestration hybride + UI | ✅ UI à-la-demande (3a) + cron whitelist nocturne + reaper (3c, live) |

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

## 9. UX d'attente : compte à rebours + notif email (2026-06-29, v19)

Le `⏳ generating…` opaque (35-45 min) ne disait rien au viewer et l'obligeait à garder l'onglet ouvert.

**Player** : la ligne « génération » affiche maintenant un **compte à rebours** (ETA ≈ 0,4× la durée,
clampé 8-60 min, tické *en place* pour ne pas reconstruire le popover chaque seconde ; repli
« finishing up… » plutôt que de prétendre fini). Et un toggle **« 🔔 Notify me by email when ready »** :
on s'abonne, on peut fermer l'onglet — l'email arrive dès que le VTT atterrit (et il est caché, donc
chargement instantané ensuite). Chip optimiste, revert si le compte n'a pas d'email. Reset au
changement de titre.

**Edge** (`norva-playback` v19) : nouvelle route `POST /generated-subtitle-notify` (opt-in/out). Le
cache transcript étant **cross-user**, l'abonnement vit dans sa propre table par `(user, fichier)` :
`public.catalog_generated_subtitle_notifications` (`status = pending|sent|skipped|failed`, unique sur
`(user_id, provider_key, item_type, external_id, kind, lang)`, service-role only). La route est
**volontairement légère** : elle dérive le `providerKey` depuis la ligne source stockée (lookup DB
caché, **aucun** aller-retour provider), donc toggler en pleine lecture ne peut pas ouvrir une 2ᵉ
connexion provider (piège `user_multi_ip`). `runTranscribeCallback` fan-out les abonnés en attente :
`ready` avec speech → email Resend + `sent` ; `ready` mais vide → `skipped` (rien à montrer, pas
d'email) ; `failed` → `failed` (silencieux). Best-effort : un échec d'envoi ne fait jamais échouer le
callback. Email branché sur Resend (mêmes secrets que `norva-auth-email`, projet-wide), gabarit HTML
brandé sombre.

**Vérifié en prod** : v19 live (`/health`), route `401` sans auth ; callback réel (token gateway via
`net.http_post`) sur job synthétique `ready/segments:0` → cache `ready`, abonné `skipped`, **aucun
email** (chemin no-speech), rows nettoyées.

> Repère deep-link : l'email pointe vers `norva.tv` (pas de lien direct vers le film). La fiche est
> rétablie via `sessionStorage` (`norva-open-fiche`, meurt avec l'onglet) et keyée sur l'alias source
> **local** au navigateur — un deep-link serveur exact demanderait un routage fiche par URL + une
> résolution cloud→local de la source. À faire comme amélioration séparée si besoin.

## 10. 3b — traduction Argos (multi-cible) (2026-06-29, gateway v59 / edge v20)

Traduire le transcript whisper dans la langue choisie par le viewer. **Clé : la traduction tourne
sur le VTT déjà caché — AUCUNE connexion provider, pas d'audio** → zéro contention avec la lecture
(pas de `user_multi_ip`), et c'est rapide (~20-45 s/film). Caché cross-user comme le transcript.

**Moteur** (`services/media-gateway/src/translate.py`) : **CTranslate2 + SentencePiece directement**
(PAS le paquet `argostranslate` complet → pas de torch/stanza/spacy → image bien plus légère). On
traduit **cue par cue** (assez court pour ne pas avoir besoin de segmentation de phrases) : split par
ligne, garde verbatim les lignes sans lettre (`...`, `42`, `♪`), batch. Paires arbitraires **pivotent
par l'anglais** (`source→en→target`), comme Argos. Validé en local : FR/ES corrects, pivot fr→en→es
correct, ~34 cues/s (4 threads).

**Modèles** (`scripts/fetch_argos_models.py`, build-time) : télécharge + normalise les modèles
`en↔X` pour `ARGOS_LANGS` (défaut `fr,es,ar,de,it,pt` ≈ 1,3 Go ; en est toujours le pivot →
définit AUSSI les langues source traduisibles). Streaming + retry (les gros paquets, ex. `es_en`
~285 Mo, tronquaient sur un read bufferisé). Couche Docker placée tôt → cachée indépendamment du code.

**Gateway** (`GATEWAY_VERSION` 59) : `POST /translate-async` (gateway-auth, body
`{jobId,callback,source,target,vtt}`) → file séparée (lane à part de la transcription) → spawn
`translate.py` → POST callback edge (même forme que transcribe). `POST /translate` (sync, debug).
`/health` expose `translate` + `translateTargets`.

**Edge** (`norva-playback` v20) : `translateEnqueue()` — `providerKey` depuis la ligne source (caché,
**0 appel provider**), **réutilise** le claim RPC (`kind=translation`, `lang=target`) + le
`transcribe-callback`. Exige le transcript source `ready` (sinon `transcript-required`) ; sert le
transcript tel quel si `source==target` (`sameLang`). `POST /generated-subtitle` route
`kind=translation`/`targetLang` vers lui ; le `GET` sert déjà `kind=translation&lang`. Nouveau
`GET /generated-subtitle-langs` (cache 5 min) expose les cibles du gateway.

**Player** (`WatchPage.js`) : une fois le transcript prêt, une ligne **« 🌐 Translate to <langue> »**
par cible dispo (noms localisés). Machine à états par cible (`translating…` / actif / retry), sonde le
cache traduction, attache comme toute piste IA. Choisir une cible avant que le transcript existe →
différé puis auto-déclenché à l'arrivée. État remis à zéro au changement de titre.

**Vérifié en prod (2026-06-29)** : gateway `v59` `/health` → `translate:true`, `translateTargets:
['ar','de','en','es','fr','it','pt']` (les 6 langues + en pivot, ~1,3 Go de modèles téléchargés au
build). Appel réel `POST /translate` (token gateway via `net.http_post`) en→fr → `200` VTT FR correct,
dialogue multi-ligne préservé (« Nous devons partir tout de suite, ils arrivent. » / « - Où est
l'argent ? / - Je l'ai caché sous le pont. »), **615 ms** pour 2 cues. Edge `v20` live, route
`/generated-subtitle-langs` câblée (`401` sans auth).

**Reste** : ~~3c~~ → **LIVRÉ** (cf. §11).

## 11. 3c — orchestration nocturne : whitelist pré-génération + reaper (2026-06-30, edge v23)

Dernier morceau de Phase 3. Deux pièces : (1) un **reaper** qui débloque les jobs whisper
coincés en `processing`, (2) un **cron whitelist nocturne** qui pré-génère les sous-titres IA
des titres « chauds » de chaque provider, pour qu'ils soient déjà prêts avant qu'un user les
demande.

### a. Reaper (cron `norva-generated-subtitle-reaper`, jobid 55, `*/30 * * * *`)
SQL pur (pas d'edge) : passe en `failed` toute ligne `catalog_generated_subtitles` restée
`status='processing'` depuis **> 2 h** (jobs gateway morts / callback jamais reçu). Évite qu'un
job zombie bloque éternellement le cache cross-user d'un titre.

### b. Whitelist candidates — RPC `whitelist_subtitle_candidates(p_user uuid, p_limit int)`
Renvoie les titres « chauds » de l'user qui n'ont **pas** encore de sous-titre texte extractible
(`not (subtitle_tracks @> '[{"extractable":true}]')`), triés par priorité :
- **priorité 0** = récemment joués (≤ 21 j, via `cloud_playback_events → cloud_title_variants → title_id`) ;
- **priorité 1** = nouveautés films (`release_year ≥ année-1`, déjà sondés `subtitle_probed_at not null`).

Choix produit (2026-06-30) : **« les deux combinés »**, priorité au récemment-joué. Ordonné
`priority asc, updated_at desc`. Accordé à `service_role`.

### c. Mode edge `transcribe-whitelist` (route `audio-backfill`, `runOneDimension`)
`body = { userId, mode:'transcribe-whitelist', limit }`. Sur-échantillonne (`p_limit = max(limit*6, 20)`,
la plupart des candidats sont déjà cachés) puis appelle `transcribeEnqueue({titleId})` jusqu'à avoir
**`limit` NOUVEAUX** jobs enqueués — les titres déjà `ready` ou en vol pour un autre user sont sautés
et **ne comptent pas**, donc chaque run avance au-delà des déjà-faits. **Différé si l'user est live**
(`userHasLiveSession` → `skipped:'live-session'` ; la lecture audio serait une 2ᵉ connexion provider à
côté de son stream → `user_multi_ip`). Renvoie `{candidates, enqueued, cached, errored, started[]}`.

### d. Crons nocturnes par provider (staggered, fenêtre nuit)
| jobname | jobid | schedule (UTC) | user |
|---|---|---|---|
| `norva-subtitle-pregen-jeremy` | 56 | `20 0 * * *` | jeremy |
| `norva-subtitle-pregen-airo` | 57 | `25 0 * * *` | airo |
| `norva-subtitle-pregen-super8k` | 58 | `30 0 * * *` | super8k |

`limit:2` par run, échelonnés 00:20/00:25/00:30 pour ne pas se chevaucher (un seul slot provider
à la fois). Même secret `norva_backfill_token`, `timeout_milliseconds:=110000`.

### e. Vérifié en prod (2026-06-30)
- Edge `v23` `/health` déployé (Action `deploy-supabase-functions` ✅ sur `a460cf8`).
- Appel réel `mode:'transcribe-whitelist'` **jeremy** (live à ce moment) → `200` `{skipped:'live-session'}`
  → garde live OK.
- Appel réel **super8k** (non-live) → `200` `{candidates:20, enqueued:1, started:[{titleId, jobId,
  priority:0}]}` → **chaîne bout-en-bout prouvée** : RPC candidats → claim → ligne
  `catalog_generated_subtitles` créée → POST gateway.
- ⚠️ Le job de test a fini `failed` « Audio extraction failed » en < 1 s — **ce n'est PAS le titre
  ni le câblage 3c**. Diagnostic (2026-06-30) : **le provider super8k tout entier** (`x:0066…`,
  `super8k.top`) échoue l'extraction audio à ce moment. Reproduit sur 3 titres super8k (le placeholder
  2026 *1350344*, le vrai film *Kung Fu Panda 4* en piste entière **et** en clip 20 s) → toujours
  fast-fail. Un **autre provider** (`x:93d4…`) a transcrit un film entier de 89 min sans souci la veille
  (3a sain). Cause racine probable : la **source super8k est bloquée en `sync_status:error`**
  (« Unable to clear old catalog items », coincée en phase `connect` depuis 2026-06-29 20:03) → ce
  re-sync en boucle **monopolise le slot de connexion du provider** → toute extraction (2ᵉ connexion)
  est refusée → ffmpeg exit≠0 immédiat. **Leçon** : « Audio extraction failed » fast-fail = problème de
  **connexion provider** (creds expirées / max-connections / sync coincé), pas du titre. Vérifier
  `cloud_sources.sync_status` + tester un **autre** provider avant d'incriminer le pipeline.
- Comportement attendu : super8k reste candidat, re-tenté à la nuit (00:30 UTC, off-peak = pas de
  contention avec le cron probe de jour). *Affinage futur noté : (a) exclure du candidate-set les
  titres échoués récemment ; (b) court-circuit par provider si N extractions consécutives échouent
  (évite de brûler les 2 slots de nuit sur un provider down).*
