# Norva — journal de travail & suivi (audio / sous-titres « intelligence »)

État de tout ce qui a été livré, où ça vit, si c'est **actif** ou **derrière un flag**, et comment
l'activer. Mis à jour au fil des sessions.

---

## ⚠️ Actions owner en attente (checklist vivante)

Ces étapes **ne peuvent pas être faites par l'agent** (secrets Play Console, compte Google,
build/publish signés). Elles bloquent la **release du natif**. Ordre logique :

1. **Compte Google Play Console** — ⏳ *bloquant racine*. Sans lui, aucun upload possible.
   Message envoyé au support Google, en attente d'ouverture. → débloque 2, 3, 4.
   Réf : `IMPORT-NOTIFICATIONS.md`, `FCM-PUSH-SETUP.md`.
2. **Build/publish des APK** — versions **déjà bumpées en source** (TV `3.8.0-hybrid` /
   versionCode 13, phone `1.2.0` / versionCode 3, cf. `clients/android-*/app/build.gradle`),
   **mais jamais buildées/publiées**. Dernière build documentée = **v1.1.0 / versionCode 2**
   (release FCM). Lancer `.github/workflows/android-release.yml` (manuel ou tag `v*`) puis
   uploader les AAB en Test interne. → **porte tout le natif** : cast natif, gestes player,
   Watch Next, « À suivre ».
3. **assetlinks SHA-256** — remplacer le placeholder
   `REPLACE_WITH_RELEASE_SIGNING_SHA256_FROM_PLAY_CONSOLE` dans
   `public/.well-known/assetlinks.json` par l'empreinte SHA-256 de la signature **release**
   (Play Console → Intégrité de l'app, ou keystore). Fichier déjà correct par ailleurs
   (seul `tv.norva.phone` déclare les App Links https `norva.tv`). Sans ça, un lien `norva.tv`
   s'ouvre quand même dans l'app **mais après confirmation Android** (pas de vérif auto).
   Réf : `UX-NETFLIX-PARITY.md` #15.
4. **FCM push** — `GOOGLE_SERVICES_JSON` (secret GitHub) et `FCM_SERVICE_ACCOUNT` (secret
   Supabase) déjà posés ; il ne reste que la publication de l'APK (étape 2). Réf : `FCM-PUSH-SETUP.md`.

**Lien avec le Cast (Lot A, 2026-07-03)** : le Lot A cast est **web uniquement** (sender Google
Cast, déployé via `main`). Le **cast natif** (les APK ont leur propre intégration Cast) n'arrive
qu'avec la build de l'étape 2. Détail : `CAST-CHROMECAST.md`.

---

## 🗓️ MISE À JOUR 2026-07-03 — Cast Chromecast (Lot A) ⏳ sur branche

**Sur `claude/webm-block-additions-error-pj16xm`, pas encore mergé `main`.** Quick-wins UX du
sender Google Cast web (Default Media Receiver), sans récepteur custom :
- **Annuler ≠ erreur** (`requestSession` `cancel` normalisé, silencieux, lecture locale reprise) ;
- **sous-titres au cast** (Track VTT : sidecar `sub_<index>.vtt` embarqué, ou IA en `data:` URI ;
  retry-sans-piste → ne casse jamais la lecture) ;
- **garde-fou formats** (mkv/ts/HEVC/legacy → transcode gateway au lieu d'échec opaque) ;
- **progression sauvée pendant le cast** (10 s + flush `pagehide` → Continue Watching à jour) ;
- **barre enrichie** (seek scrubbable + temps, ±10 s, play/pause, épisode suivant même session, stop) ;
- **bouton dans la barre de contrôle**, visible dès découverte d'un device (fin du trou de 4 s).

Reste **Lot B** (récepteur CAF custom : branding TV, rendu sous-titres/audio, file d'épisodes) +
cast depuis les fiches, AirPlay iOS, cast live. Détail complet : **`CAST-CHROMECAST.md`**.

---

## 🗓️ MISE À JOUR 2026-07-03 — Ninja banni (anti-ban provider) ⚠️

Le provider Ninja (`operator1.barfik.org`) avait **banni l'ancien compte** (comportement suspect :
multi-IP + ~7 410 probes/jour + concurrence). Diagnostic complet (root cause = login périmé →
401 ; films masquaient via stamp-sur-échec ; séries exposaient via ETA « 12 664 j »). Compte
remplacé (nouveau login testé OK : auth/séries/épisodes). **Mesure immédiate : Ninja passé en
lazy-only** — les 4 crons de fond désactivés live (`cron.unschedule` : jobid 61/66/67/73). Puis
**mode faible empreinte codé (Slice 0-4, branche)** : plafond 40/h (`provider_footprint_policy`),
probes via IP résidentielle gateway (`/probe-audio` v63), concurrence 1 + jitter + mutex lecture
(409 `account_busy`), alarme dashboard « provider muet » + garde-fou ETA. **Reste** : déployer
gateway v63 + merger edge, puis re-scheduler les crons domptés. Détail : `docs/PROVIDER-ANTIBAN-NINJA.md`.

---

## 🗓️ MISE À JOUR 2026-07-01 — session (identités, notifications, sécurité, release Android)

Tout ci-dessous est **livré et déployé sur `main`** sauf mention contraire. Détails dans les docs dédiées.

### 1. Identité fournisseur — refonte long terme (Phases A / B / B.2) ✅ LIVE
Le `providerKey` basé sur la **taxonomie de catégories** était le mauvais signal : volatile (la clé de Ferran a
muté toute seule en 8 h) et il a **raté un miroir à 100 %** (Opplex & Ferran partagent 40 555/40 555 stream IDs
mais avaient 2 clés différentes). Refonte en 2 couches :
- **Phase A** — empreinte sur les **stream IDs** (échantillon bottom-256 md5 = MinHash, mirror-robuste,
  taxonomie-indépendant) + **`provider_identities`** (entité canonique, résolution Jaccard côté serveur via RPC
  `norva_resolve_provider_identity`, advisory-lock anti-doublon) + vue `admin_provider_overview`. Backfill des 7
  sources → **6 identités** ; **Opplex + Ferran fusionnés** (1 identité, 4 empreintes dont 2 `superseded`).
- **Phase B** — les caches cross-user (`catalog_file_tracks`, `catalog_generated_subtitles`) re-keyés sur
  `identity_id` via l'unique point `resolveSourceIdentity` (fallback empreinte pendant transition + backfill de
  fusion). Gain mesuré : Opplex 38→387 fichiers lisibles, Ferran 123→387, 228 sondes orphelines récupérées, les 2
  crons deviennent 2 ouvriers sur 1 catalogue partagé.
- **Phase B.2** — sous-cache tmdb/imdb (`vod-title-projection`) keyé sur l'identité (cohérence). 0 backfill (vide).
- **Phase C** (retirer le providerKey-taxonomie) — **DIFFÉRÉE** volontairement (analyse 9-agents : bénéfice déjà
  acquis par A/B ; risque de re-fragmentation pour zéro gain). **Déclencheur pour la faire** : couverture
  enrichissement ~15-25 % OU ~10+ providers. Détail : `PROVIDER-IDENTITY-DEDUP.md` §8.

### 2. Notifications de cycle de vie d'import ✅ LIVE (email) · ⏳ push (attend Play Store)
- **Phase 1 (email)** : table `cloud_import_notifications` (idempotence `unique(source_id,kind)`), hooks
  lifecycle dans le moteur partagé (`import_started/completed/failed`), templates anglais brandés
  (`_shared/import-email.ts`), **cron digest `norva-import-notify-digest`** (`*/2`, groupe par user+kind, fenêtre
  60 s) — **vérifié : 235 firings, 0 échec, HTTP 200**.
- **Phase 2 (push FCM native, app fermée)** : table `cloud_push_tokens`, `_shared/fcm.ts` (FCM HTTP v1, OAuth
  service-account), envoi dans le digest (`sendPushForGroup`), route `POST /push-token`, web (`registerPushToken`
  via bridge `NorvaTVCloud`), Android (`NorvaMessagingService` + `setupPush` + `getPushToken`, plugin
  google-services **conditionnel**). **Backend armé** (secret Supabase `FCM_SERVICE_ACCOUNT` posé) ;
  `google-services.json` posé en **secret GitHub `GOOGLE_SERVICES_JSON`** (injecté au build, jamais commité — le
  secret scanning bloque la clé). **AAB signé v1.1.0 / versionCode 2 buildé avec succès** (keystore
  `norva-upload.jks` + 4 secrets GitHub `ANDROID_KEYSTORE_*`). **⏳ BLOCAGE** : l'owner **n'a pas encore de
  compte Google Play Console** (message envoyé au support Google, en attente) → prochaine étape = upload de l'AAB
  en Test interne dès l'ouverture du compte. Détail : `IMPORT-NOTIFICATIONS.md` + `FCM-PUSH-SETUP.md`.

### 3. Release Android (FCM) — en cours, bloquée sur le compte Play Console
- **AAB signé buildé avec succès** (workflow `android-release.yml`, run #2 vert, phone + TV, versionCode **2** /
  versionName **1.1.0**). Keystore d'upload créé (`norva-upload.jks`) + 4 secrets GitHub posés.
- `google-services.json` **injecté au build depuis le secret `GOOGLE_SERVICES_JSON`** (gitignored, jamais commité —
  le secret scanning GitHub bloque la clé). Projet Firebase = **norva-ecosystem**, app `tv.norva.phone`.
- **⏳ BLOCAGE ACTUEL** : l'owner **n'a pas encore de compte Google Play Console** (message envoyé au support
  Google, en attente). Dès que le compte est ouvert → upload l'AAB en **Test interne** → installer sur le tel →
  token FCM enregistré → tester la push end-to-end. Guide clic-par-clic : `FCM-PUSH-SETUP.md` + `clients/PLAY_STORE.md`.
- ⚠️ Rappel : la push ne peut être **testée end-to-end** qu'après avoir un appareil avec l'app releasée (aucun token
  n'existe avant). Le backend, lui, est prêt.

### 4. Sécurité — investigation « contributeur ci Catalin » ✅ RÉSOLU (aucune intrusion)
- Le contributeur **`ci` / « Catalin »** vu sur GitHub = **fausse attribution par email**, PAS un accès. Collaborateurs
  du repo = **Admin-Adher seul**. Le seul commit attribué = le build WASM du bot, dont l'email
  `ci@users.noreply.github.com` correspond par collision au user GitHub `@ci`. Contenu = uniquement les artefacts
  `vendor/libav` (aucun code source/config/secret touché).
- **Correctif** : le workflow `build-libav-wasm.yml` committe désormais en `github-actions[bot]` (plus de
  mis-attribution). Détail dans l'historique git + `REPO-PROTECTION.md`.

### 5. Protection de `main` + flux de déploiement ✅ EN PLACE (changement de process)
- **Ruleset `protect main`** (Active) : Restrict deletions + Block force pushes. Protège contre réécriture
  d'historique / suppression.
- **Conséquence** : le push direct de l'automatisation (assistant) est refusé (son acteur n'est pas dans la bypass).
  → **Nouveau flux de déploiement : PR-merge** (push branche → PR → merge via API en tant qu'admin). Bonus : les
  commits sortent **Verified**. Détail : `REPO-PROTECTION.md`.

### 6. Billing — réalité high-risk + pivot Gumroad hybride ⏸️ EN PAUSE
- Norva = **HIGH-RISK** pour les processeurs : **Stripe / Paddle / Lemon Squeezy REFUSENT l'IPTV** (Lemon Squeezy
  le bannit explicitement). **Seul Gumroad accepte.**
- **CRITIQUE** : **RevenueCat n'intègre PAS Gumroad** (ses moteurs web = Stripe + Paddle uniquement) → « RC +
  Gumroad » **impossible**.
- **Nouvelle archi recommandée = HYBRIDE** : **RevenueCat pour le MOBILE** (Play / Apple — pas de refus high-risk,
  c'est Google/Apple qui encaissent) + **Gumroad DIRECT pour le WEB** ; les deux écrivent dans la **même table
  `cloud_entitlement_projection`** (agnostique de la source, déjà conçue ainsi).
- **Frais Gumroad** = 10 % + 50¢ + 2,9 % + 30¢ ≈ **29 % sur un mensuel à 4,99**, **~15 % sur l'annuel** → **ANNUEL-FIRST
  indispensable** (les 80¢ fixes tuent les petits mensuels). Option : **rail CRYPTO secondaire** (BTCPay / NOWPayments,
  ~0,5-1 %, zéro chargeback) alimentant la même projection.
- **⏸️ STATUT** : billing **EN PAUSE** en attente de la décision processeur/frais de l'owner (Gumroad annuel-first
  ± crypto, ou alternative). L'infra RC existante reste **DORMANTE** (valable pour la moitié mobile) ; la projection
  d'entitlements est prête pour n'importe quelle source. Détail : `docs/roadmap/billing-status.md`.

### 7. Enrichissement AÎRO — parallélisation par-panel (source-scoped) ✅ LIVE (2026-07-01)
Constat data : le compte pilote **AÎRO** (`7bdab1df…`) porte **5 hôtes DISTINCTS** (Airysat / Ninja / KING365 /
Opplex / Promax, ~334k films), pas un seul. L'enrichissement drainait par `user_id` seul → les 5 partageaient **UN**
slot sérialisé → **~52 j** pour un 1er passage complet, vs **~5 j** pour un compte mono-hôte (super8k, 70k). (Mon
diagnostic initial « petits panels starvés » était **faux** : le balayage est équitable ; les petits (Airysat 61 %,
KING365 58 %) sont les **plus** avancés, les gros (Ninja/Promax) montent lentement car énormes.)
- **✅ LIVE (base)** — RPC **`audio_backfill_candidates`** (scope `sourceId`, **variant-driven** borné au panel, no
  ORDER BY car les marqueurs `audio_probed_at`/`subtitle_probed_at` pilotent la progression ; **plpgsql + `format(%L)`**
  pour éviter le plan générique qui mis-coûtait les petits panels 10-21 s → **~1 s** partout). `whisper_candidate_titles`
  gagne un **`p_source`** optionnel (variant-driven quand scopé ; `p_source` null = comportement account-wide **inchangé**,
  rétro-compatible). Migrations appliquées + testées live.
- **✅ MERGÉ sur `main`** — edge : chemin `sourceId` dans `runOneDimension` (additif, chemin account-wide inchangé) +
  propagation du `sourceId` dans la **chaîne fallthrough** (sinon un cron de panel ouvrirait une connexion sur l'hôte
  d'un AUTRE panel → `user_multi_ip`). Doc `ENRICHMENT_CRON_SETUP.md` **v3** (SQL exact des 9 crons + retrait des 4).
- **✅ DÉPLOYÉ (v92)** — après la résolution de l'incident Supabase « Project status change failures » (capacité
  intermittente → `Failed to set function store` 500, résolu par retry), `norva-playback` **v92** est en ligne (scoping
  `sourceId` **vérifié live** : probe Ninja scopé → `processed:3`, 200). Les **9 crons par-panel créés** : **5 jour**
  (`norva-audio-airo-{ninja `*/3`, promax `*/3`, opplex `*/6`, king365 `*/12`, airysat `*/30`}` 6-23, `fallthrough`) +
  **4 nuit géants** (`norva-audio-airo-{ninja,promax}-series` + `norva-subtitle-airo-{ninja,promax}` 0-5). Les **4 crons
  account-wide retirés** (`norva-audio-langs-airo` + `-series` + `norva-subtitle-backfill-airo` + `-whisper`) ; pregen IA
  gardé. **Charge par-hôte inchangée** (1 connexion/hôte, plus time-sharée ; hôtes distincts → pas de collision) → chaque
  panel AÎRO reçoit le **traitement super8k** ; les 3 géants (Ninja/Promax/Opplex, ETA ~44 j en partagé) avancent
  désormais en parallèle. **À faire ensuite** : étendre le même schéma au compte jeremy/apdxes (Ferran + AtlasPro une fois
  re-syncé). Détail crons : `ENRICHMENT_CRON_SETUP.md` §v3.
  Détail : `ENRICHMENT_CRON_SETUP.md` §v3.

> **Références de cette session** : `PROVIDER-IDENTITY-DEDUP.md` §8 · `ENRICHMENT_CRON_SETUP.md` (v3 par-panel) ·
> `IMPORT-NOTIFICATIONS.md` · `FCM-PUSH-SETUP.md` · `REPO-PROTECTION.md` · `clients/PLAY_STORE.md` ·
> `docs/roadmap/billing-status.md`.

---

## Surfaces de déploiement (toutes auto-déployées sur push `main`)

| Surface | Quoi | Déploiement |
|---------|------|-------------|
| Web / client (`public/js/**`) | Cloudflare Pages | `deploy-cloudflare.yml` (push main) |
| Edge functions (`supabase/functions/**`) | Supabase (bundle CLI) | `deploy-supabase-functions.yml` (push main) |
| Relais (`services/norva-relay`) | Cloudflare Worker | `deploy-relay.yml` (push main) |
| Media gateway (`services/media-gateway`) | Railway | auto-build depuis `main` (pas de GH Action, Railway est branché au repo) |

→ **Un push sur `main` déploie les 4.** ⚠️ Edge functions = **uniquement via la CLI Supabase** (le bundle
résout les imports `../_shared`). Ne jamais déployer une edge function via un outil qui n'agrège pas
(ça plante au boot — cf. incident résolu). Toujours `curl` l'endpoint après déploiement.

## Ce qui est LIVE (actif, sans rien à faire)

| Domaine | Correctif | Fichiers |
|--------|-----------|----------|
| Moteur web | Spam log `BlockAdditions` filtré + `av_log` au niveau ERROR | `public/webengine/vendor/libav/*`, `norvaEngine.js`, `scripts/patch-libav-logs.js` |
| Moteur web | HEVC tagué `hvc1`/`hev1` selon le mime (fixe `CHUNK_DEMUXER_ERROR_APPEND_FAILED`) | `norvaEngine.js`, `stream.html` |
| Moteur web | Drop des B-frames open-GOP au resume/seek (fixe l'erreur en boucle à la reprise) | `norvaEngine.js` |
| Moteur web | **Trailer MP4 (`mfra`/`mfro`) plus jamais ajouté au SourceBuffer** (fixe `CHUNK_DEMUXER_ERROR_APPEND_FAILED` quand la lecture s'arrête tôt — provider mono-slot qui coupe). Cause trouvée via le snapshot de diag. | `norvaEngine.js` (ENGINE_VERSION 17) |
| Moteur web | **Sortie muxer NON-seekable** (`mkstreamwriterdev` + `device:false`) → movenc écrit en streaming pur (tailles calculées à l'avance, pas de seek arrière qui corrompait le flux en ordre d'append) → **fixe le `CHUNK_DEMUXER` à l'ouverture/reprise du mkv** | `norvaEngine.js` (ENGINE_VERSION 22) |
| Moteur web | **Libération du slot à la fermeture** : `destroy()` abort tous les fetch en vol → l'ancienne connexion provider tombe tout de suite (plus de zombie tenant le slot → fixe le spinner infini) ; + retry 458 côté player avec backoff visible | `norvaEngine.js` (v20), `WatchPage.js` (`playWithEngine`) |
| Gateway | **Pool de proxies résidentiels** (`PROVIDER_PROXY_URLS`, liste ; `PROVIDER_PROXY_URL` = singulier rétro-compat) → tout le trafic provider sort par une IP résidentielle (Evomi Static Residential) → **contourne le blocage `458` des IP datacenter Railway** (mkv qui ne démarrait pas alors que les mp4 `direct` jouaient). Round-robin **sticky par clé** (uid / host+user, hash FNV-1a) → chaque user/provider sort toujours par la même IP (pas de bascule d'IP en plein stream). undici `ProxyAgent` (fetch `dispatcher`) + `http_proxy`/`https_proxy` par-clé pour les enfants ffmpeg. | `services/media-gateway` (GATEWAY_VERSION 52), env `PROVIDER_PROXY_URLS` (Railway) |
| Moteur web | **Diagnostics profonds** sur échec moteur : `engineSnapshot()` (mime/codecs, boîtes fMP4, 1er paquet keyframe, trace des écritures muxer + seeks, raison de sortie du pump, état SB/MS/video) → console + télémétrie `playback_error` (lisible direct en base `cloud_playback_events`) | `norvaEngine.js`, `WatchPage.js` (`reportEngineFailure`) |
| **Phase 1** | Langue audio **déduite** (label/catégorie/région/orig-lang) en fallback ; sous-titres **incrustés** → entrée « 🔒 verrouillée » au lieu de « Off » | `mediaUtils.js`, `WatchPage.js`, `tests/trackIntel.test.js` |
| Catalogue | Badge de langue qui clignotait « une fois sur deux » au rechargement → ligne la plus riche gardée ; auto-guérison des langues 3 lettres (fas/kur/sqi/ell) | `supabase/functions/norva-catalog/index.ts` |
| Gateway | **Cache du profil ffprobe** par URL (moins de sondes répétées → moins de 458) | `services/media-gateway/src/index.js` (v48) |
| Edge | **Crons d'enrichissement déférés pendant une lecture live** (`userHasLiveSession()` : event < 4 min OU session `ready` non expirée → sonde relais audio-langs **et** backfill whisper renvoient `skipped: live-session`). Fixe le `user_multi_ip` (stream IP gateway + sonde IP Cloudflare = 2 IPs → panel mono-IP 429). On-demand non gardé. `ignoreLiveSession:true` bypass. **Vérifié prod** (user live → `skipped`). | `norva-playback` (v18) |
| Edge + Player | **UX d'attente sous-titres IA** : compte à rebours ETA + toggle **« 🔔 Notify me by email »** (opt-in par titre, route `POST /generated-subtitle-notify` légère sans appel provider, fan-out email Resend au callback). **Vérifié prod** (callback réel → `skipped` no-speech, 0 email). Détail `PHASE3-AI-SUBTITLES.md` §9. | `norva-playback` (v19), `WatchPage.js`, `cloudApi.js`, migration `…_generated_subtitle_notifications` |
| Enrichment | **Bascule auto « fallthrough »** : quand l'audio films d'un provider est fini, sa **fenêtre de jour draine les dimensions de nuit** (séries → sous-titres → whisper) → jour+nuit ≈ 2× plus vite. Slot-safe (séquentiel, garde live, stop si user regarde). Flag `'fallthrough',true` sur les 3 crons de jour. Vérifié live (apdxes films `0` → séries `15`). Détail `ENRICHMENT_CRON_SETUP.md`. | `norva-playback` (v22), `cron.alter_job` jobs 10/36/41 |
| **Phase 3b** Gateway+Edge+Player | **Traduction sous-titres IA multi-cible** (Argos / CTranslate2+SentencePiece sur la gateway — pivot par l'anglais, **0 connexion provider**, ~20-45 s/film, cache cross-user `kind=translation`). Sélecteur « 🌐 Translate to … » au player une fois le transcript prêt. `ARGOS_LANGS` (défaut `fr,es,ar,de,it,pt`) configurable. Détail `PHASE3-AI-SUBTITLES.md` §10. | gateway v59 (`translate.py`, `fetch_argos_models.py`, Dockerfile), `norva-playback` (v20), `WatchPage.js`, `cloudApi.js` |
| **Orphelins — Couche 1** | **Continue Watching ne montre plus un média retiré du catalogue** (le « cas Airysat » : clic → 404). `listHistory` retire les lignes **films** dont le `external_id` a disparu de `cloud_media_items`, **uniquement** si la source est stablement `ready` (jamais en plein sync), **non destructif** + **fail-safe**. Toutes les autres surfaces titres filtraient déjà `variant_count>0`. Détail `docs/ORPHAN-HANDLING.md` §2. | `norva-cloud` (commit `7ce2451`) |
| **Orphelins — Couche 3 (racine)** | **Le sync ne peut plus jamais vider le catalogue.** Upsert-puis-prune : plus de delete en amont, marquage `catalog_version` par run (UPDATE ciblé → enrichissement préservé), prune **gated** (0 erreur fetch **ET** <50 % de suppression + re-check single-flight avant DELETE) ; un refresh qui re-voit 0 item **garde l'ancien catalogue** (pas de re-hammer). **Rétro-compatible** (curseurs legacy = ancien chemin → déployable en plein sync). Revue adversariale (2 trouvailles corrigées) + mécanique DB validée. Détail `docs/ORPHAN-HANDLING.md` §3. | `norva-source-sync` (commit `965c1c3`), migration `20260630160000_layer3_catalog_versioning.sql` |

## Ce qui est DÉPLOYÉ mais derrière un FLAG (à activer pour en profiter)

| Fonctionnalité | Flag / activation | Défaut | Reco |
|----------------|-------------------|--------|------|
| **Sous-titres texte in-band** (le moteur lit ses propres paquets, zéro 2ᵉ connexion → fixe « rien ne s'affiche » sur mono-slot) | **ON par défaut** (`WatchPage._inbandSubsEnabled()`) ; **opt-out par appareil** via `localStorage.setItem('norvaInbandSubs','0')` | **on** | ✅ Déployé, on par défaut. Chaque appareil peut se désinscrire avec `norvaInbandSubs='0'`. |
| **Phase 2 — détection langue audio, inline** (à la lecture, en arrière-plan) | `NORVA_WHISPER_DETECT=true` (voir ci-dessous) | **on** (ligne `cloud_runtime_config`, activé 2026-06) | ⚠️ Sur mono-slot, l'extraction = 2ᵉ connexion. Le **gros du résidu passe par le cron whisper off-peak** (ci-dessous) ; l'inline ne sert plus que de filet ponctuel. |
| **Phase 2 — détection langue audio, backfill hors-ligne** | cron `norva-audio-langs-whisper` (`8,28,48 0-5 * * *`) → `POST /audio-backfill {"mode":"whisper"}` + `NORVA_BACKFILL_TOKEN` | **actif** | ✅ **Recommandé mono-slot** : tourne off-peak quand personne ne regarde. |
| Gateway **in-band header parse** (récupère les langues audio depuis l'entête déjà streamée, optimisation mono-slot) | env gateway `INBAND_HEADER_PARSE=true` | off | Optionnel ; active si l'audio mono-slot reste capricieux. |

### Où mettre `NORVA_WHISPER_DETECT`
Lu par `getRuntimeConfig`, depuis l'une OU l'autre source (env l'emporte) :
- **Secret edge** : `supabase secrets set NORVA_WHISPER_DETECT=true` (puis redéploie l'edge).
- **Ligne en base** `cloud_runtime_config` (pris en compte en ~30 s, pas de redéploiement) :
  ```sql
  insert into cloud_runtime_config (key, value) values ('NORVA_WHISPER_DETECT','true')
  on conflict (key) do update set value = excluded.value;
  ```
Ce flag ne gère QUE l'inline. Le backfill l'ignore (il lui faut juste `NORVA_BACKFILL_TOKEN`).

### Lancer le backfill Phase 2 (recommandé)
```bash
curl -X POST "$EDGE/norva-playback/audio-backfill" \
  -H "Authorization: Bearer $NORVA_BACKFILL_TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"whisper","userId":"<ton-uuid>","type":"movie","limit":100,"concurrency":1}'
# → { processed, candidates, detected, lastId, hasMore } ; pagine avec afterId=lastId tant que hasMore
```

## Roadmap des 4 phases

| Phase | Cible | Description | État |
|------|-------|-------------|------|
| 1 | audio + sous-titres incrustés | langue audio déduite + UI sous-titres incrustés verrouillés | ✅ **fait, live** |
| 2 | audio | whisper.cpp détecte la vraie langue d'une piste non taguée (self-hosted, gratuit) | ✅ **fait & ACTIF** (flag inline `on` + cron whisper off-peak) |
| 3 | sous-titres | **sous-titres auto** : Whisper transcrit l'audio → VTT quand aucun sous-titre texte ; + **traduction Argos** vers ta langue | ✅ **PHASE 3 COMPLÈTE** : 3a (transcription async + cache cross-user + livraison + bouton player) + 3b (**traduction multi-cible Argos**) + 3c (**cron whitelist nocturne par provider + reaper**) — tout live |
| 4 | sous-titres | **OCR (Tesseract)** : sous-titres image (PGS/VOBSUB/DVB) → texte | 🟢 **PGS + VOBSUB + DVB livrés** : gateway (`ocr_pgs.py` direct pour PGS, `ocr_imgsub.py` via ffmpeg `sub2video` pour VOBSUB/DVB, backoff 429) + edge v25 (`ocrEnqueue`, routage `fmt`) + **UI player on-demand** (bouton « OCR → text » par piste image), tous déployés ; les 2 parsers + backend prouvés (selftests PASS). Reste : valider sur un vrai flux image (le test a buté sur la limite connexion provider 429/401, pas le code). Détail `docs/PHASE4-OCR-SUBTITLES.md` |

Hors-plan (correctifs livrés en cours de route) : extraction sous-titres texte in-band (ci-dessus),
fix flicker catalogue, cache de profil gateway, fixes moteur (BlockAdditions/HEVC/open-GOP).

**Note Phase 3 :** réutilise l'infra Phase 2 (whisper.cpp + extraction audio déjà sur la gateway) —
il « suffit » d'une transcription complète horodatée (au lieu d'un clip de 20 s) + Argos pour traduire.
**3a livré (2026-06-29)** : transcription async film-entier → cache cross-user `catalog_generated_subtitles`
(claim atomique anti-doublon sur le slot unique) → routes `GET/POST generated-subtitle` → bouton
« ✨ AI subtitles » au player. Détail complet dans `docs/PHASE3-AI-SUBTITLES.md` §8.
**3b livré (2026-06-29)** : **traduction multi-cible Argos** (CTranslate2+SentencePiece sur la gateway,
pivot par l'anglais, 0 connexion provider) → cache cross-user `kind=translation` → sélecteur de langue
« 🌐 Translate to … » au player. `gateway v59` / `edge v20`. Détail `docs/PHASE3-AI-SUBTITLES.md` §10.
**3c livré (2026-06-30, edge v23)** : orchestration nocturne. **Reaper** (cron `*/30`, passe en `failed`
les jobs `processing` > 2 h). **Whitelist nocturne par provider** : RPC `whitelist_subtitle_candidates`
(titres chauds sans sous-titre texte = récemment joués ≤21 j + nouveautés films, priorité au joué) →
mode edge `transcribe-whitelist` (enqueue N nouveaux jobs whisper, saute les déjà-faits, différé si
user live) → 3 crons staggerés 00:20/00:25/00:30 UTC (jeremy/airo/super8k, `limit:2`). Vérifié bout-en-bout
(super8k non-live → `{candidates:20, enqueued:1}`, job dispatché à la gateway). Détail `docs/PHASE3-AI-SUBTITLES.md` §11.
**Phase 3 terminée** — reste seulement Phase 4 (OCR PGS/VOBSUB).

## Enrichment / backfill — état & stratégie par provider

L'enrichissement (langue audio + sous-titres) tourne en **flotte pg_cron** qui POST vers les
routes edge. Détail complet + SQL réel : `supabase/functions/ENRICHMENT_CRON_SETUP.md`.

**TROIS providers mono-connexion DISTINCTS** → flottes en parallèle (slot **par compte**, aucune
collision entre providers). **Parité premium : 4 dimensions par provider** (audio films · audio
séries · sous-titres films · whisper résidu) = 12 jobs pg_cron, **0 échec**.

| Provider | Compte | `get_vod_info` | Méthode | État (29/06) |
|----------|--------|----------------|---------|------|
| `super8k.top` | owner `c5be5ac4…` | ❌ vide → 'vod' mort | **probe** (header) | **gros chantier** : ~92k titres, **~7 % audio fait**, ~500/h → **~1 sem** pour l'audio films (sous-titres/séries : plus lent) |
| `apdxes.xyz` | frère `0b971271…` | ✅ marche | **vod** films (rapide) + probe séries/subs | films ~**34 %**, drain rapide (~1 j) ; 429 sur **toute** concurrence (vod compris) |
| `mandara.cc` = **AÎRO** | dédié `7bdab1df…` | ❌ vide → 'vod' mort | **probe** | nouveau (9,5k films + 2,2k séries), sonde démarrée |

> ⚠️ **Correction** : une note précédente disait « super8k résidu ~à jour » — **faux** (lecture
> erronée de la petite taille du *cache de sonde*). Le vrai catalogue fait **92k titres, ~7 % résolus** ;
> c'est le **gros chantier ~1 semaine**, pas « à jour ». apdxes (vod) est le rapide.

**Slot unique = time-sharing dans le temps** (pas de concurrence). Par provider : **films audio le
jour `6-23 UTC`** (`*/3` probe ou `*/5` vod), **séries + sous-titres + whisper la nuit `0-5 UTC`**
décalés de 3 min (cycle 9) → jamais deux accès simultanés. `langs` (films tagués) **supprimé**
(redondant avec le bulk `untagged`). apdxes 429 même sur métadonnées → son vod aussi en `6-23`.

> **MISE À JOUR 30/06 (nouveaux providers + état courant)** — le tableau ci-dessus est historique.
> État actuel : **jeremy** = `hernandez.jeremy@outlook.fr` (`0b971271…`) → **IPTV Ferran** ;
> **airo** = `projethorizon2030@gmail.com` (`7bdab1df…`) → **Airysat + IPTV Ninja + KING365 + Opplex +
> Promax 4K OTT** (5 panels sur un compte). Les crons sont **par `userId`** → un nouveau provider sur un
> compte déjà câblé est sondé **automatiquement** (rien à créer). **Tous les jobs jeremy passés en
> `concurrency:1`** (Ferran = panel neuf de limite inconnue ; `audio-langs-jeremy` jobid 36 : 2→1 via
> `cron.alter_job`) → 1 connexion max + crons de nuit décalées = pas de 429/abuse. Mapping complet +
> détails : `docs/ORPHAN-HANDLING.md` §6. **Admission control** = 3 gros imports simultanés max
> (`NORVA_MAX_CONCURRENT_IMPORTS`, défaut 3) ; les plus récents sont mis en file et admis par le watchdog
> dès qu'un slot se libère (vérifié en prod le 30/06).
>
> ⚠️ **Incident 30/06 (résolu)** : le déploiement Couche 3 a introduit un **doublon de fonction top-level**
> (`countSourceItems`) → `norva-source-sync` **503 sur toutes ses routes** (boot Deno KO) → les 4 imports en
> cours figés ~45 min. Corrigé par renommage (`countSourceItemsTotal`, commit `6826ff8`) + sweep anti-doublon
> ajouté au process. **esbuild ne détecte PAS** ce cas — détail + prévention dans `docs/SYNC-ENGINE-DEDUP.md` §4.

**Cache cross-user keyé par `providerKey`** (cf. `PROVIDER-IDENTITY-DEDUP.md`, LIVE) : les écritures
vont dans les caches globaux (`catalog_file_tracks`, `catalog_titles`), **partagés par tout user du
même panel — tous les miroirs d'URL fusionnent sous un seul `providerKey`**. → un **nouvel inscrit
sur un panel déjà sondé hérite langues/sous-titres instantanément** (zéro sonde), **même après
suppression du compte pilote** (les caches globaux ne sont liés à aucun user/source).

**Correctif débloquant (synchro catalogue du frère)** : `cloud_media_items → cloud_live_variants`
est `ON DELETE CASCADE` mais `cloud_live_variants(media_item_id)` n'était **pas indexé** → vider
un gros catalogue live faisait un SEQ SCAN par ligne (O(n²)) → dépassait le budget ~8 s de l'edge
→ « Unable to clear old catalog items » → source coincée en boucle de re-sync. **Index ajouté**
(migration `20260629095744_index_cloud_live_variants_media_item_fk.sql`, vérifié *Index Only Scan*)
→ le clear batché finit dans le budget. C'est le **vrai correctif racine** (préféré à une RPC, qui
n'aurait fait que contourner le symptôme).

## Vérifié / non vérifiable dans l'environnement de dev

- ✅ `node --check` (gateway, relais, client), transpile esbuild (edge TS), détecteur de langue **10/10**,
  gateway prod `/health` répond `ok` (GATEWAY_VERSION 52, pool proxy résidentiel), moteur `ENGINE_VERSION 23`,
  flotte pg_cron backfill **0 échec / 24 h** (vérifié via `cron.job_run_details`).
- ⚠️ Non testable ici (pas de navigateur MSE, pas de provider, pas de ffmpeg/whisper runtime) :
  le rendu réel des sous-titres, l'extraction audio contre le provider, la transcription whisper.cpp.
  → à valider côté prod.

## Réf. docs détaillées
- `docs/WEBENGINE-PLAYBACK-DEBUGGING.md` — **débogage lecture mkv** (les 4 bugs, diagnostic `engineSnapshot`, proxy résidentiel, runbook) ⭐
- `docs/ARCHITECTURE-RELIABILITY.md` — ADR datacenter-IP / plans de lecture
- `docs/WEBENGINE-LIBAV-LOGGING.md` — fix du spam log libav
- `docs/WEBENGINE-HEVC-PLAYBACK.md` — tag hvc1/hev1
- `docs/WEBENGINE-GATEWAY-INBAND-PROBE.md` — cache + in-band header parse (audio)
- `docs/WEBENGINE-INBAND-SUBTITLES.md` — sous-titres texte in-band
- `docs/WHISPER-AUDIO-LANGUAGE-DETECTION.md` — Phase 2 (whisper.cpp self-hosted)
- `supabase/functions/ENRICHMENT_CRON_SETUP.md` — **flotte backfill pg_cron** (cadences par-provider, SQL réel, rationale fréquence-vs-concurrence) ⭐
- `docs/PROVIDER-IDENTITY-DEDUP.md` — **audit miroirs d'URL + design `provider_key`** (l'URL ≠ le fournisseur ; dédup cross-user) ⭐
- `docs/PHASE3-AI-SUBTITLES.md` — **Phase 3 COMPLÈTE** (sous-titres IA : whisper→VTT + Argos) ; **3a §8, 3b §10, 3c §11** tous livrés
- `docs/PHASE4-OCR-SUBTITLES.md` — **Phase 4** OCR sous-titres image (PGS direct + VOBSUB/DVB via `sub2video`)
- `docs/ORPHAN-HANDLING.md` — **gestion des orphelins de catalogue** (Couche 1 Continue Watching + Couche 3 upsert-puis-prune + mémoire opérationnelle comptes/providers/crons) ⭐
- `docs/SYNC-ENGINE-DEDUP.md` — dédup du moteur de sync (norva-cloud vs norva-source-sync) **✅ FAITE** (moteur
  extrait dans `_shared/xtream-sync.ts`, Couche 3 active) + post-mortem de l'incident 503 (doublon
  `countSourceItems` → boot Deno KO). ⭐
- `docs/IMPORT-NOTIFICATIONS.md` — notifications cycle de vie d'import **✅ Phase 1 (email) LIVE** (table +
  templates + cron digest + hooks) · **Phase 2 (push FCM) codée**, attend le setup Firebase/Play Store (cf. §6bis)
- `docs/PROVIDER-IDENTITY-DEDUP.md` §8 — **refonte identité stream-ID (Phases A/B/B.2) LIVE** ; Phase C différée ⭐
- `docs/FCM-PUSH-SETUP.md` — guide owner : Firebase + secrets + release Play Store (push native app-fermée)
- `docs/REPO-PROTECTION.md` — protection `main` (ruleset) + flux de déploiement PR-merge
