# Audit 2026-07-13 — Ce que les abonnements promettent **vs** ce que Norva fait vraiment

**Méthode.** Workflow multi-agents (8 finders en parallèle : 1 sur *tout le copy marketing/paywall*, 7 sur *le code réel* par domaine → confrontation → **vérification adverse** de chaque trouvaille, 26 claims vérifiés, 22 confirmés). Chiffres bruts : **52 promesses** relevées dans le copy, **172 fonctionnalités réelles** inventoriées dans le code.

**Le constat en une phrase :** Norva **fait beaucoup plus que ce qu'il vend** (tout un étage IA sous-titres + du polish streaming jamais mentionné), et **quelques promesses dépassent le code** (export RGPD, offline présenté comme universel, rappel J‑2 désactivé par défaut).

---

## 1. Le vrai différenciateur Plus ↔ Family (source de vérité : `_shared/entitlements.ts:26-96`)

Les limites sont **réellement appliquées** — `NORVA_ENTITLEMENTS_MODE` vaut `"enforce"` par défaut (`entitlements.ts:20`), et `norva-playback` compte les sessions ouvertes et bloque en HTTP 402 au-delà.

| Limite | **Plus** (4,99 €/mo · 41,99 €/an) | **Family** (8,99 €/mo · 75,99 €/an) |
|---|---|---|
| **Flux simultanés** | **2 écrans** | **5 écrans** ← *seule vraie différence* |
| Profils « Qui regarde ? » | 5 | 5 (identique) |
| Appareils de confiance | 10 | 10 (identique) |
| Sources connectées (Xtream/M3U/EPG) | 5 | 5 (identique) |
| Toutes les fonctionnalités (sync, IA, offline, gateway…) | activées | activées (identique) |

> ⚠️ **Family coûte ~80 % de plus pour uniquement +3 flux simultanés.** Tout le reste est identique. C'est honnête (le copy `subscribe.html` le dit), mais commercialement fragile : soit on **ajoute une vraie différence Family** (ex. plus de profils, ou le « téléphone → télécommande TV » vendu comme fonction foyer), soit on **assume franchement** le message « seul le nombre d'écrans change ».

---

## 2. ✅ Promesses tenues (le copy dit vrai)

Vérifié et réel — rien à changer :
- **2 vs 5 flux simultanés**, appliqués côté serveur (`entitlements.ts:42/51`, `norva-playback`).
- **Jusqu'à 5 profils**, favoris/historique/Continue Watching **par profil** (`norva-cloud/index.ts:2396-2542`, gate création `:761`).
- **Sync Web / téléphone / tablette / TV** + **reprise de lecture cross-appareils** (`cloudApi.js:633-675`, appairage QR `norva-cloud:2784-2891`).
- **Recommandations depuis ton propre catalogue** (« Because you watched », Top‑10, buckets de genres — `norva-catalog`).
- **Formats compatibles M3U/M3U8 · Xtream · XMLTV EPG** (`SourceManager.js`).
- **Essai 7 jours** carte pré-autorisée (empreinte minuscule, jamais débitée) (`norva-revolut/index.ts:36`).
- **~30 % d'économie en annuel**, **annulation à tout moment** jusqu'à la fin de période (`norva-revolut:432-478`).
- **Player uniquement, aucun contenu inclus** — cadrage juridique correct.

---

## 3. 💎 Fonctionnalités RÉELLES jamais vendues (les pépites à mettre en avant)

**Toutes vérifiées dans le code**, aucune n'apparaît dans le copy de prix (`subscribe.html`/`landing.html`). Classées par valeur marketing :

### Étage IA sous-titres (le plus fort — actuellement invisible)
1. **Génération de sous-titres par IA (Whisper)** à partir de l'audio — présent **seulement** dans le carrousel d'onboarding (`account.html:478`), **jamais** dans les pages de prix. `WatchPage.js:7630-7741`, cache partagé entre utilisateurs.
2. **Traduction IA des sous-titres (Argos)** — « Translate to <langue> » sur n'importe quel transcript. `WatchPage.js:7825-7860`.
3. **OCR des sous-titres image** (Blu-ray PGS / DVD VOBSUB / DVB → texte sélectionnable). `WatchPage.js:7147-7262`. Moat technique profond.
> 👉 **Angle produit :** « Ne reste jamais sans sous-titres — Norva les **génère et les traduit par IA**, même quand ta source n'en fournit aucun. » C'est ton différenciateur le plus puissant, et il est déjà livré.

### Parité streaming premium (le polish que les acheteurs attendent)
4. **Skip Intro** (marqueurs appris en crowd-sourcing, style SponsorBlock). `WatchPage.js:8718-8760`.
5. **Chromecast / Google TV** avec passe-plat sous-titres + progression + auto-épisode suivant. `WatchPage.js:1563-1863`.
6. **Vignettes de prévisualisation au scrub** (storyboards façon Netflix), générées serveur + cache. 
7. **Picture-in-Picture** (Live et VOD).
8. **Téléphone → télécommande TV** (piloter l'écran appairé). Argument foyer, pertinent pour **Family**.

### Fiabilité (répond à la douleur n°1 de l'IPTV : flux morts)
9. **Failover de lecture automatique / auto-réparation** : moteur → relay → gateway → transcode → autre version. Aujourd'hui à peine sous-entendu par « lecture fiable ».
10. **Groupement de versions + variantes qualité + failover de version** (une carte par titre, badges 4K/UHD, bascule vers une copie saine).
11. **Explicateurs d'erreur provider** (401/403/404/429 → langage clair, identifiants masqués) — distingue « ton compte IPTV est bloqué/expiré » d'un bug Norva.
12. **Assistant de dépannage transcodage** (pas de son / écran noir / buffering).

### « Vrai téléviseur » par-dessus un flux brut
13. **Moteur de lecture in-browser** : joue MKV/HEVC/AC‑3/DTS **côté client sans serveur de transcode** — la raison technique pour laquelle « ton IPTV marche dans le navigateur » fonctionne vraiment. `WatchPage.js:2962-3097`.
14. **Line-ups nationaux (36 pays)** + numérotation LCN + logos (~53 marchés) — transforme un dump brut en TV ordonnée.
15. **Fiche TMDB riche** : bandes-annonces, casting/réalisateur, « More like this », vignettes par épisode.
16. **Recherche floue tolérante aux fautes** (trigram) sur Films + Séries + recherche chaînes distante.
17. **Synopsis multi-langues** (résolution sous-titre→audio→région→locale→anglais).

---

## 4. ⚠️ Sur-promesses / risques (à corriger avant scale)

| Promesse (où) | Réalité (code) | Risque |
|---|---|---|
| **« Access, export or delete your data »** (RGPD) `index.html:327`, `landing.html:303` | Seul **DELETE** existe (`delete-account.html`). **Aucun endpoint/UI d'export** dans tout le repo. | **Juridique** : droit à la portabilité annoncé mais non fournissable. |
| **« Rappel 2 jours avant la fin d'essai »** `subscribe.html:192` | Email/push J‑2 **gated derrière `NORVA_LIFECYCLE_BILLING_LIVE`**, `false` par défaut (`norva-lifecycle:34`). | **Conso / chargebacks** : promesse de rappel avant débit non tenue si le flag n'est pas activé en prod. |
| **« Offline mode on compatible devices »** + **« Every Norva feature included »** (Plus **et** Family) | Téléchargements **uniquement dans l'app Android/Android TV** (bridge `window.NorvaTVCloud`) ; **web/PWA : aucun download** (bouton masqué `MoviesPage.js:1787`). | Un abonné **web** paie « offline / toutes les fonctions » qu'il ne peut pas utiliser. |
| **« Norva Family — pour tout le foyer »** | Family = **uniquement 5 flux** vs 2. **Aucune** invitation/membre/sous-compte ; cap 5 profils **identique** à Plus. | Le mot « Family / foyer » suggère un partage de compte qui n'existe pas. |
| **« Reco selon ton profil et ton historique »** (par profil) | « Because You Watched » interroge `cloud_watch_history` par **user_id**, pas **profile_id** ; `hidden_genres` pas appliqué au Home/billboard (`norva-catalog:1689`). | Perso **incohérente** avec la promesse par-profil (les genres cachés d'un profil enfant fuient sur le Home partagé). |
| **« Encrypted downloads, hardware-backed key »** `landing.html:307` | **Aucun** code d'encryption dans web/edge (vit peut-être dans l'APK natif — **non vérifiable** ici). | Affirmation sécurité sans preuve dans ce repo → **à confirmer dans l'APK** avant de continuer à l'annoncer. |

**Note interne (pas du copy) :** les flags premium `auto_refresh_background` / `auto_refresh_fast` / `content_notifications_frequent` sont un **échafaudage observe-mode** (`entitlements.ts:98-112`) — **ne pas** les mettre dans le copy tant qu'ils ne sont pas enforced. La page **grille EPG « Guide »** (`EpgGuide.js`) est construite mais **sans entrée de nav** (`data-page="guide"` absent) → code mort ou nav manquante.

---

## 5. 🚫 Absent aujourd'hui (à NE PAS annoncer — et à construire avant d'impliquer)

- **Catch-up / replay / timeshift** pour le Live : inexistant.
- **Contrôle parental / PIN profil / profils enfants** : inexistant — les profils se changent **sans aucune authentification** (`profiles.js`). Si un jour on évoque la sécurité enfant, **construire le PIN d'abord**.

---

## 6. Recommandations (par priorité)

**Bloquant / risque légal :**
1. **Export RGPD** : soit construire l'endpoint d'export (JSON des sources/profils/historique/favoris — les tables existent), soit **retirer le mot « export »** de `index.html:327` + `landing.html:303`.
2. **Rappel J‑2** : confirmer `NORVA_LIFECYCLE_BILLING_LIVE=true` en prod **ou** adoucir `subscribe.html:192`.
3. **Offline** : qualifier les puces « Offline mode » / « Every feature included » en **« app Android »** (le web ne peut pas télécharger).

**Croissance / conversion :**
4. **Promouvoir l'étage IA** (génération + traduction + OCR sous-titres) en **puce de prix** — c'est le plus gros argument non-dit.
5. **Mettre en avant** Skip Intro, Chromecast, vignettes de scrub, failover auto (« lecture auto-réparante ») sur la landing.
6. **Repenser l'écart Plus↔Family** (voir §1) : ajouter une vraie différence Family ou assumer « seuls les écrans changent ».

**Cohérence produit :**
7. Aligner la perso sur la promesse par-profil (`profile_id` pour « Because You Watched », `hidden_genres` sur le Home).
8. Ajouter une nav pour la grille Guide **ou** la retirer (code mort).
9. Vérifier la claim « encrypted downloads » dans l'APK natif.

---

*Preuves complètes (file:line) dans le résultat du workflow `wpw3tzpbi`. Toutes les pépites du §3 et les sur-promesses du §4 ont été vérifiées de façon adverse (22 confirmées / 3 partielles / 1 non concluante = « encrypted downloads », logée dans l'APK non audité ici).*
