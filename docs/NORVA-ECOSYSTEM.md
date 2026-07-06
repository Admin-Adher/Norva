# Norva — Description complète de l'écosystème

> **Norva est un lecteur multimédia multi-écran.** Vous connectez une source
> de médias compatible que vous êtes autorisé à utiliser ; Norva organise votre
> catalogue, en soigne l'affichage, le rend lisible partout et synchronise votre
> lecture d'un écran à l'autre. **Norva ne fournit ni chaînes, ni films, ni
> séries : Norva est le logiciel, pas le contenu.**

Ce document décrit Norva de bout en bout : la vision, la percée technique qui le
distingue, l'ensemble des applications qui composent l'écosystème (Web,
téléphone/tablette, Android TV, Samsung, ordinateur), les fonctionnalités
exclusives au mobile (mode hors ligne), la synchronisation multi‑appareil,
l'intelligence de catalogue, l'infrastructure et le cadre de confiance.

---

## 1. En une phrase

**Votre catalogue. Sur chaque écran. Une seule expérience.**

Un compte, une interface cohérente, et la reprise exacte à la seconde près :
mettez un épisode en pause sur la TV, reprenez‑le sur le téléphone, la tablette
ou dans le navigateur, là où vous vous étiez arrêté.

---

## 2. Le principe fondateur : là où passent les données

Toute l'architecture de Norva repose sur une distinction simple et rigoureuse :

- **Le plan de contrôle (100 % cloud)** — comptes, profils, catalogue,
  reprise/historique/favoris, préférences, appairage des appareils. C'est ce qui
  fait **voyager l'état** d'un écran à l'autre.
- **Le plan de données (la vidéo elle‑même)** — le flux vidéo **ne transite
  jamais par un datacenter par défaut**. Il sort du **réseau domestique de
  l'utilisateur** (adresse IP résidentielle), via un lecteur natif, un
  transcodeur local ou une passerelle à IP résidentielle.

Cette séparation est la clé de la fiabilité de Norva : la partie « intelligente »
(état partagé, catalogue, recommandations) vit dans le cloud, tandis que la
lecture reste au plus près de l'utilisateur, dans les conditions où elle
fonctionne le mieux.

---

## 3. La percée : lire dans le navigateur ce qu'aucun navigateur ne sait lire

**C'est la première mondiale de Norva.** Les navigateurs web refusent nativement
la plupart des formats de médias les plus répandus. Norva est **le premier à les
rendre réellement lisibles dans un simple onglet de navigateur, pour tout le
monde, sans serveur de transcodage** :

| Format concerné | Pourquoi le navigateur le refuse d'habitude | Ce que fait Norva |
|---|---|---|
| **Conteneur MKV / Matroska** | Non pris en charge par l'élément `<video>` | Ré‑emballage (remux) à la volée en MP4 fragmenté |
| **Vidéo HEVC / H.265** | Étiquetage `hvc1`/`hev1` incompatible | Correction de l'étiquette de codec et de l'`hvcC` en sortie |
| **Audio Dolby (AC‑3 / E‑AC‑3), DTS, TrueHD…** | Non décodé par le navigateur | Transcodage audio ciblé vers **AAC** (la vidéo, elle, reste intacte) |
| **Flux MPEG‑TS (`.ts`)** | Conteneur non lisible tel quel | Reconstruction des en‑têtes (AVCC/`avcC`, `esds`) et remux |
| **Sous‑titres intégrés (SRT/ASS/WebVTT…)** | Enfermés dans le conteneur | Extraits pendant le démuxage, sans seconde connexion à la source |

### Comment ça marche

Le **moteur de lecture Norva** (`public/js/norvaEngine.js`) applique un principe
inédit : **« le navigateur devient le serveur média »**.

1. Il lit le fichier distant **par plages d'octets HTTP** (lecture anticipée par
   fenêtres de quelques Mo), pour ménager la source.
2. Il **démuxe chaque paquet** grâce à une build WebAssembly sur mesure de
   **libav.js / FFmpeg 8** (`public/webengine/vendor/libav/`,
   `scripts/build-libav-norva.sh`), exécutée dans un *Web Worker*.
3. Il **recopie la piste vidéo** telle quelle (les décodeurs natifs du navigateur
   gèrent H.264/HEVC/VP9/AV1) et **ne transcode que l'audio** que le navigateur
   ne sait pas décoder.
4. Il **assemble un MP4 fragmenté en streaming** qu'il alimente dans un
   `MediaSource` — le tout **côté client, sans aucun serveur de transcodage**.

La démonstration est fournie en clair dans le dépôt
(`public/webengine/index.html`) : un banc de test qui prouve, **dans le propre
navigateur de l'utilisateur**, que même le cas le plus difficile — MKV en
**HEVC + AC‑3 5.1** — se lit sans aucune infrastructure de transcodage.

> **Repli maîtrisé** : pour les rares cas qu'un navigateur ne peut vraiment pas
> décoder, une passerelle cloud (`services/media-gateway`) prend le relais avec un
> vrai transcodage vers HLS. Ce n'est **pas** le chemin par défaut, mais un filet
> de sécurité — la lecture ne tombe jamais dans une erreur opaque.

Chaque décision de codec, chaque octet servi au lecteur est journalisé pour un
diagnostic fin ; des tests d'intégrité (`scripts/check-webengine-mux-tags.mjs`,
`tests/vod-playback-matrix.test.js`) verrouillent le bon comportement à chaque
build.

---

## 4. L'écosystème multi‑écran

Toutes les applications rendent la même interface Norva (le catalogue, les fiches,
le lecteur, les réglages). Elles diffèrent par **la façon dont elles lisent la
vidéo** et **le backend auquel elles parlent** — mais **le compte, le catalogue et
la reprise sont partout les mêmes**.

| Application | Ce que c'est | Lecture | Rôle |
|---|---|---|---|
| **Web (navigateur)** | L'expérience Norva canonique, installable en PWA | Moteur WASM du navigateur (§3) ou chemin résidentiel/passerelle | Ouverte partout, sans rien installer |
| **Android téléphone / tablette** | Application **native** (lecteur ExoPlayer/media3) | **Décodeurs matériels** du téléphone (HEVC/MKV/AC‑3…), depuis le **réseau domestique** | Mobilité + **mode hors ligne exclusif** (§5) |
| **Android TV / Google TV** | Application salon, navigation à la télécommande | Lecteur **natif ExoPlayer**, ligne « Watch Next », depuis l'IP résidentielle | Le grand écran, appairage par QR code |
| **Samsung Smart TV (Tizen)** | Enveloppe web Tizen (`.wgt`) plein écran | Selon le serveur/cloud connecté | Ouvre Norva sur les TV Samsung |
| **Ordinateur (Electron)** | Application de bureau qui **embarque le serveur Norva** | **Transcodeur local** exécuté depuis l'IP résidentielle | Écran d'ordinateur + rôle de « hub » domestique |

**Points communs :**

- L'application Web est le **socle** : les applications natives ouvrent la même
  expérience et héritent automatiquement de ses évolutions (pagination du
  catalogue, fiches, réglages, sessions de lecture).
- Les clients TV et mobiles détectent un **pont natif** (`window.NorvaTVCloud`),
  résolvent l'URL directe de la source via le cloud, et **lisent depuis l'IP
  résidentielle** : la source ne voit jamais un datacenter, elle voit le foyer de
  l'utilisateur.
- À la sortie du lecteur, la position finale est **renvoyée au cloud** : un titre
  arrêté sur le téléphone reprend sur la TV, et inversement.

> **Disponibilité** : l'application Web fonctionne dès aujourd'hui dans tout
> navigateur moderne. Les applications natives Android (téléphone/tablette et TV)
> sont en cours de déploiement sur Google Play.

---

## 5. Fonctionnalités exclusives au mobile : le mode hors ligne

Le **téléchargement pour lecture hors ligne** est une fonctionnalité **exclusive
à l'application native Android (téléphone/tablette)**. Elle n'existe ni sur la TV,
ni sur Samsung, ni sur l'ordinateur, ni dans le navigateur web — et c'est
volontaire.

### Ce que fait le mode hors ligne

- **Téléchargement depuis le réseau domestique** : un service en arrière‑plan
  télécharge le film ou l'épisode **directement depuis la source**, exactement
  comme le lecteur natif — **jamais via le cloud**.
- **Chiffrement bout en bout sur l'appareil** : chaque téléchargement est chiffré
  en **AES/CTR** avec une **clé de données 256 bits** propre à ce fichier. Cette
  clé est elle‑même scellée (**AES/GCM**) sous une **clé maître stockée dans le
  coffre matériel de l'appareil (AndroidKeyStore)**, non extractible.
  → Un fichier téléchargé **copié hors de l'appareil est indéchiffrable**.
- **Lecture qui reste fluide** : le chiffrement par flux (CTR) préserve la
  possibilité d'avancer/reculer librement dans la vidéo, déchiffrée à la volée
  pendant la lecture.
- **File d'attente robuste** : mise en pause, reprise (reprise partielle via les
  requêtes `Range`), réordonnancement, survie au redémarrage de l'application.
- **Wi‑Fi par défaut** (avec reprise automatique dès le retour du Wi‑Fi) et
  option de dérogation en données mobiles, plus **« téléchargements malins »** qui
  mettent en file l'épisode suivant automatiquement.

### Pourquoi le hors ligne est réservé au mobile

1. **Nature de l'usage** : le hors ligne sert à emporter ses contenus en
   déplacement — c'est le cas d'usage du téléphone et de la tablette.
2. **Chaîne technique native** : téléchargement résidentiel direct, chiffrement
   lié au coffre matériel et lecteur qui déchiffre à la volée sont du code natif
   Android que les enveloppes TV/Samsung/ordinateur/web ne portent pas.
3. **Sécurité par conception** : les téléchargements sont **liés au matériel** de
   l'appareil ; ils ne peuvent pas, par construction, en sortir.

> Côté web, un *service worker* rend l'application **installable** et tolérante
> aux coupures réseau pour l'interface, mais **ne stocke aucun média** — le hors
> ligne média reste l'apanage du mobile natif.

---

## 6. La synchronisation multi‑appareil

Sans mode hors ligne, tout se joue dans le cloud, en temps quasi réel. Le compte
Norva porte l'**état partagé** entre tous vos écrans :

- **Reprise exacte inter‑appareils** : la position de lecture est renvoyée par
  chaque lecteur à la sortie, et sert de **point de reprise faisant autorité** ;
  vous reprenez à la seconde près sur n'importe quel écran connecté.
- **Historique et favoris** : ce que vous avez commencé, aimé ou enregistré vous
  suit partout.
- **Profils et préférences** : langue audio préférée, sous‑titres, genres favoris,
  qualité — jusqu'à plusieurs profils par compte.
- **Appareils de confiance** : enregistrement, heartbeat, révocation, dans la
  limite des places de votre offre ; gestion des sessions simultanées.
- **Notes** (pouce haut/bas) qui nourrissent les recommandations.

### Appairer un nouvel écran

- **Connexion par QR code sur la TV** : la TV affiche un code, vous vous connectez
  (ou créez le compte) sur votre téléphone/ordinateur, vous approuvez — la TV
  ouvre Norva. Aucune saisie d'e‑mail/mot de passe à la télécommande.
- **Liens profonds** `norva://pair` depuis un scan de QR, et **connexion à un
  « hub » domestique** pour les configurations avancées.

---

## 7. L'intelligence de catalogue

Les sources fournissent souvent des métadonnées pauvres. Norva les enrichit avec
un principe intangible : **enrichir, jamais écraser** une information réelle
fournie par la source ; une valeur détectée ne remplit qu'un champ vide, et
seulement lorsqu'elle est fiable.

- **Lecture instantanée des conventions de nommage** : Norva déduit, sans aucune
  requête réseau, la vraie langue audio et le statut des sous‑titres
  (**incrustés / logiciels / absents**) à partir des libellés de version et des
  catégories, puis classe un titre comme **confirmé / probable / absent** pour la
  langue que vous préférez. C'est ce qui alimente les badges du type
  « Audio confirmé ».
- **Détection de langue par IA (Whisper)** : pour une piste audio non étiquetée,
  Norva extrait un court échantillon, le transcrit avec un moteur **whisper.cpp**
  auto‑hébergé, puis un détecteur de langue maison lève les ambiguïtés délicates
  (persan/kurde/ourdou vs arabe, ukrainien/serbe vs russe…). Exécutable hors
  pointe pour ne jamais gêner une lecture en cours.
- **Sous‑titres générés par IA** : quand aucun sous‑titre texte n'existe, Norva
  peut transcrire le film entier en **WebVTT** ; un pipeline par tronçons fait
  apparaître les premiers sous‑titres en 1 à 3 minutes. Une **traduction** (moteur
  hors ligne, sans connexion à la source) propose « 🌐 Traduire vers… ».
- **Sous‑titres image (OCR)** : les sous‑titres Blu‑ray (PGS) et DVB/VOBSUB sont
  reconnus par OCR, avec un calage temporel précis par sous‑titre.
- **Déduplication** : à l'échelle du titre (les multiples versions d'un même film
  sont regroupées et classées par préférence) et à l'échelle de la **source**
  (une même source exposée via des dizaines d'URL miroirs est reconnue par une
  empreinte robuste — de sorte qu'un nouvel utilisateur d'une source déjà analysée
  **hérite instantanément** des langues et sous‑titres détectés, sans re‑analyse).
- **Recommandations depuis votre propre catalogue** : des rangées par genre à la
  Netflix, un classement pondéré par compatibilité linguistique, genres favoris et
  qualité, une file « Reprendre la lecture », le tout enrichi par les métadonnées
  (affiches, genres, langue d'origine, synopsis localisés) — **sans jamais vendre
  un catalogue parallèle**.

---

## 8. L'infrastructure

Norva combine un backend auto‑hébergeable et une plateforme cloud, plus deux
services spécialisés.

- **Serveur Node auto‑hébergeable** (`server/`) : sert l'interface, détecte
  `ffmpeg`/`ffprobe`, gère l'authentification, l'import et l'organisation du
  catalogue, le transcodage/remux local, l'EPG. Il peut tourner sur un PC, un NAS,
  un mini‑PC ou en Docker, et servir de **hub domestique** auquel les TV se
  connectent. C'est aussi le cœur embarqué dans l'application de bureau Electron.
- **Plateforme cloud (edge functions + base de données + tâches planifiées)** :
  comptes/profils, appairage, gestion des sources, favoris/historique/notes,
  sessions de lecture, moteur de synchronisation du catalogue (avec
  versionnement « upsert‑puis‑purge » pour ne **jamais** vider un catalogue par
  erreur), service de catalogue, orchestration de la lecture et des travaux
  d'enrichissement (langue, sous‑titres), e‑mails de cycle de vie, facturation.
- **Passerelle média** : le service de transcodage/sondage/IA de secours, qui
  route le trafic vers la source via un **pool de proxys résidentiels**, collant
  par compte, pour rester au plus près des conditions réelles de lecture.
- **Relais** : coordinateur de sessions à IP résidentielle.

### Formats de source pris en charge

Norva se connecte aux **formats de médias standard** que vous êtes autorisé à
utiliser, sans abonnement supplémentaire ni verrouillage :

- **Playlists M3U / M3U8**
- **API compatible Xtream**
- **Guide de programmes XMLTV (EPG)**

Norva est **le lecteur, pas le contenu** : vous fournissez une source dont vous
avez le droit légitime de vous servir.

---

## 9. Confiance, conformité et positionnement

Norva est conçu pour être **privé, résiliable et responsable**.

- **Lecteur, pas fournisseur de contenu** : Norva ne vend ni chaînes, ni films,
  ni séries, ni bouquets, ni identifiants tiers. Votre abonnement Norva couvre le
  **logiciel et ses fonctionnalités**, jamais du contenu.
- **Source sous votre responsabilité** : pour utiliser Norva, vous connectez une
  source compatible à laquelle vous avez un **accès légitime** ; vous restez
  responsable de cette source et de ses conditions.
- **Hébergement UE & RGPD** : vos données de compte sont hébergées dans l'Union
  européenne ; accès, export et suppression à tout moment.
- **Téléchargements chiffrés** : les médias hors ligne sont chiffrés sur
  l'appareil avec une clé adossée au matériel lorsque c'est possible.
- **Paiement sécurisé** : les paiements par carte sont confiés à un prestataire
  certifié ; Norva ne stocke jamais votre numéro de carte.
- **Opérateur enregistré** : Norva est exploité par une société française
  enregistrée, avec mentions légales complètes et médiateur de la consommation
  agréé.
- **Essai et résiliation** : **essai gratuit de 7 jours**, rappel par e‑mail avant
  renouvellement, **résiliation à tout moment**, sans engagement.

**Ce que Norva fournit** : interface média · organisation du catalogue · lecture
multi‑écran · synchronisation cloud · recommandations · profils et préférences.

**Ce que Norva ne fournit pas** : le contenu. C'est votre source compatible, et
vous seul, qui en décidez.

---

## 10. Les offres

Toutes les offres démarrent par un **essai gratuit de 7 jours** et incluent
**toutes les fonctionnalités** de Norva ; on paie l'expérience logicielle, jamais
du contenu.

| | **Norva** | **Norva Famille** |
|---|---|---|
| Flux simultanés | 2 | 5 |
| Profils | jusqu'à 5 | jusqu'à 5 |
| Sync Web · téléphone · tablette · TV | ✅ | ✅ |
| Mode hors ligne (appareils compatibles) | ✅ | ✅ |
| Toutes les fonctionnalités Norva | ✅ | ✅ |

Facturation mensuelle ou annuelle (économie sur l'annuel). Aucun contenu, bouquet
ou abonnement de chaînes n'est inclus dans ces offres.

---

## 11. En résumé

Norva, c'est **une seule expérience média sur tous vos écrans** :

- **Une première technique** — le premier à rendre lisibles, **dans un simple
  navigateur**, les formats de médias que les navigateurs refusent nativement
  (MKV, HEVC/H.265, audio Dolby, MPEG‑TS), **sans serveur de transcodage**.
- **Un écosystème complet** — Web/PWA, application native Android
  téléphone/tablette, Android TV / Google TV, Samsung Tizen et application de
  bureau, toutes autour du même compte.
- **Le mobile en plus** — un **mode hors ligne** exclusif, chiffré et lié au
  matériel de l'appareil.
- **La continuité** — une **synchronisation multi‑appareil** qui vous fait
  reprendre à la seconde près, partout.
- **De l'intelligence** — détection de langue, sous‑titres IA/OCR, déduplication
  et recommandations issues de **votre propre catalogue**.
- **Un cadre clair** — un **lecteur, pas un fournisseur de contenu** : hébergement
  UE/RGPD, paiement sécurisé, essai gratuit et résiliation à tout moment.

> **Votre catalogue. Chaque écran. Une seule expérience.**
