# Cache privé R2, file globale et durée de vie des reprises

## Résultat et périmètre

La branche `codex/global-startup-durable-20261011` / PR786 prépare le transport
R2 privé et la file globale des premières minutes, avec compression sans perte.
Elle raccorde aussi les captures **HLS et MP4 natif web de reprise** et la règle demandée A → B,
avec suppression à partir de 90 % de la durée connue.

**Tout reste désactivé, sans activation R2 payante.** Aucun vrai bucket, secret,
migration de production, upload R2 ou changement de trajet fournisseur. Les
tests de stockage utilisent Miniflare local ; la migration SQL tourne dans
PGlite isolé. Aucun compte fournisseur n'est ouvert pour ces contrôles.

Le MP4 natif web utilise une archive de plages originales, distincte du graphe
HLS. Les autres caches d'input seuls, les lectures natives Android/Windows et
les profils incomplets restent hors de ce raccord. Aucun gain public de
démarrage ou de fluidité n'est annoncé ici.

## Première minute et file globale

- Publication atomique du média puis du manifeste signé ; objets privés,
  checksums, tailles et décompression bornés, sans URL fournisseur ni accès dans
  les manifestes. Deux objets par capture, plutôt qu'un objet par segment.
- Quotas partagés via un Durable Object SQLite, distincts des limites locales
  de staging et de mémoire. Deux instances Gateway ne peuvent pas dépasser le
  plafond partagé dans le test concurrent.
- Une écriture d'état incertain garde son quota. Suppression confirmée seule
  autorise sa libération ; révocation et retirement durable interdisent une
  republication tardive. Les barrières de progression périmées après la durée
  maximale des archives sont nettoyées par pages bornées.
- Rétention facultative jusqu'à sept jours pour le stockage. Une identité forte
  actuelle concordante est indispensable avant toute lease d'une archive âgée.
  Quatre échantillons gardent leur validité de dix minutes : pas de promotion
  en preuve complète du fichier.
- Curseurs SQL durables, file limitée à 8 192 coordonnées, pages de 64,
  alternance entre comptes/sources. Priorité aux dates récentes avec une part
  pour les anciens et les dates inconnues. Les épisodes ne prennent pas l'année
  de leur série comme date de diffusion ; l'import ne sert pas de date de sortie.
- Les contrôles actuels de présence, activité, droits, profil et admission
  fournisseur restent utilisés. La lecture préempte la préparation ; acquittement
  de la file seulement après drainage positif. Une réponse ambiguë arrête la boucle.

## Durée de vie d'une reprise

Le parcours de fermeture de session capture les données après drainage du
transport fournisseur et de l'encodeur. La compression et l'upload R2 sont
asynchrones : ils ne prolongent pas la réservation fournisseur et ne sont pas
attendus dans le passage à la lecture suivante. Les snapshots en attente restent
comptabilisés dans le budget mémoire ; au plus quatre jobs de média par processus.

1. A reste en stockage tant que la position de reprise n'a pas avancé.
2. La position de lecture authentifiée retire A. Les téléchargements de segments
   ne valent pas position réellement affichée. Les tokens obsolètes, viewers
   secondaires, sessions expirées et horloges non interprétables ne peuvent pas
   provoquer cette suppression.
3. Le lecteur peut continuer à utiliser sa lease locale de A. Une future reprise
   ne peut plus l'acquérir, même depuis un autre Gateway portant une copie mémoire.
4. À l'arrêt explicite avant 90 %, les segments finalisés de B sont capturés avec
   la position absolue, les pistes exactes et les sous-titres couverts. Un changement
   de piste remplace le snapshot durable du même fichier au lieu d'accumuler des variantes.
5. À **90 % exactement, entre 90 et 100 %, ou à la fin**, l'ancienne reprise est
   retirée et aucun nouveau B n'est archivé. La première minute reste présente.
6. Durée inconnue : le seuil ne peut pas être calculé ; l'archivage long est refusé.
   Les mécanismes courts ordinaires restent inchangés quand l'option est désactivée.

Une suppression R2 incertaine ne libère pas artificiellement son quota. Sa
barrière empêche la lecture de A ; sa suppression physique est retentée par le
nettoyage. B n'est pas publié par un job dont la suppression précédente a échoué.

## Vérifications réalisées

**209 tests ciblés réussis, aucun ignoré**, avec les runtimes Worker/R2 et SQL
effectivement chargés (Node 24 local). **157 tests réussis, aucun ignoré**, dans
l'image Gateway déployée sous Node 20, sans réseau ni connexion fournisseur.
La concurrence du banc est limitée à deux workers de test : un premier passage
avait atteint sa limite de 64 processus/threads avec dix fichiers simultanés.
Seul le conteneur de test a été arrêté ; le passage borné a ensuite réussi.

`tests/startup-cache-r2.test.js` exécute le vrai Worker, son Durable Object SQLite
et son stockage R2 dans Miniflare local :

- activation et authentification refusées sans écriture ;
- publication après média, disparition du staging, redémarrage ;
- archive de deux jours avec vérification fraîche et rejet d'un fichier modifié ;
- preuve échantillonnée expirée et corruption de payload rejetées ;
- révocation pendant la lecture et absence de repli vers l'ancien staging ;
- quota concurrent entre deux Gateways et quota d'une écriture non drainée ;
- restauration d'une reprise vers 610 secondes, cues traversants et futurs préservés ;
- A physiquement supprimé après progression, B restauré après redémarrage,
  changement de piste, suppression finale, refus de la republication de A et
  conservation indépendante du préfixe de démarrage ;
- un deuxième Gateway ayant déjà hydraté A ne peut pas le réutiliser après son retrait.

`tests/startup-prefix-global-queue-sql.test.js` exécute réellement la migration :
service-role, équité, priorités, pagination de plus de 64 lignes, curseur conservé,
révisions/visibilité/générations, leases, refus des acquittements périmés et cascade
de suppression. PGlite n'est pas une preuve de débit ou de concurrence d'un
PostgreSQL de production ; le verrou SQL protège l'énumération et sa limite globale.

`tests/private-resume-persistence.test.js` rejoue le captureur et le retour de
position du Gateway, avec le vrai cache : seuil de 90 %, durée inconnue, refus
des positions non autorisées, mémoire réservée, upload lent, révocation pendant
hydratation et suppression incertaine. Les autres tests couvrent l'admission,
les sous-titres, les connexions et le transfert du décodeur existants.

La suite complète locale a initialement détecté deux harness de transfert à
actualiser pour le nouveau retour de position ; ils ont été corrigés. Quatre
autres échecs locaux proviennent des chemins Git/bash fixes absents de cette
machine Windows. La CI Linux sur le commit exact reste le contrôle complet à
consulter dans PR786 ; aucun succès global n'est déduit de ce run local.

## Compression réelle sans nouvelle lecture fournisseur

L'extrait TS déjà conservé, H.264/AAC, a été compressé et restauré dans une
instance isolée de l'image Gateway déployée, réseau coupé, un CPU et 384 Mio.

| Contrôle | Résultat |
| --- | ---: |
| Original | 599 908 octets |
| Gzip niveau 6 | 527 028 octets |
| Économie | **12,15 %** |
| Compression | 9,59 ms |
| Restauration | 1,79 ms |
| Octets restitués | identiques |
| Frames vidéo et audio décodé | empreintes identiques, aucun échec de décodage |

Les threads du décodeur ont été explicitement limités pour le banc CPU/pids.
Un premier contrôle avait échoué dans les deux décodages ; deux sorties échouées
n'ont pas été comptées comme validation. La preuve finale vérifie la réussite
des deux décodeurs et l'égalité de leurs sorties. Ce contrôle ne remplace pas
l'écoute du lecteur réel. Aucune économie générale de 12 % n'est extrapolée.

## Preuves et activation ultérieure

Preuves expurgées, hors Git, dans `.codex-artifacts/startup-cache-20261010/` :

- `durable-final-focused.local.log` ;
- `startup-durable-linux.safe.json` ;
- `resume-lossless-real.remote.py.safe.json` ;
- `durable-v2-status.remote.py.safe.json` ;
- `durable-startup-pr.safe.json` ;
- `durable-global-full.local.log` (run local initial, non entièrement réussi).

Le plan et les variables inactives sont dans
[`ops/hetzner/media/startup-cache-durable-plan.md`](../../ops/hetzner/media/startup-cache-durable-plan.md).
Le [chiffrage de stockage](2026-10-11-startup-cache-storage-estimate.md) ne vaut
pas autorisation d'achat. Restent avant activation : budget accepté, vrai canary
Cloudflare/claims/lecteur avec les routes MP4 natives, diversité des fichiers et des
invalidations, écoute, débit durable, coûts d'opérations et charge du catalogue.

## Suite : persistance MP4 natif web

Le raccord prépare maintenant la persistance des fenêtres d'entrée utilisées
par la route `native-browser-mp4`. Il réutilise les plafonds, la compression,
la signature, les quotas et la barrière de retrait du même transport privé.
Les options R2 et persistance restent toutes désactivées.

- Format explicite `native-mp4-input-v1` : aucune playlist HLS ni durée de vidéo
  disponible inventée à partir d'un nombre d'octets. En-tête complet et quatre
  échantillons requis ; plages déjà complètes et reçues, avec budget actuel
  jusqu'à 32 Mio. Aucun téléchargement complémentaire à la fermeture.
- Le heartbeat de WatchPage rapporte le temps de la balise média, uniquement
  pour son propre URL/session MP4, lorsque la vidéo est chargée et hors saut.
  Le serveur vérifie utilisateur, session active et droits avant transmission.
  Un heartbeat n'ouvre aucun média. La fermeture transmet aussi la position.
- La progression supprime A du stockage et des reprises futures. La copie
  locale déjà utilisée poursuit la lecture. B est capturé après drainage et
  son upload ne retarde pas la libération du slot fournisseur.
- À 90 %, fin, position absente/zéro ou durée inconnue : aucun nouvel archivage.
  Le préfixe initial reste indépendant. Une révocation du propriétaire interdit
  B ; une révocation d'un autre compte ne le supprime pas. La table de stamps
  est bornée ; sa saturation provoque des refus, jamais une réutilisation indue.
- Après redémarrage, une archive faible garde la limite de dix minutes. Une
  archive native avec ETag fort peut être révalidée plus tard : identité forte
  **et quatre échantillons frais** doivent tous concorder avant le lease. La
  durée doit correspondre à celle du profil serveur signé actuel.

Le test Miniflare rejoue A → suppression physique → B → redémarrage → 90 %
avec le vrai Worker, SQLite et R2 locaux ; il vérifie les octets restitués,
le quota partagé, le refus d'une ancienne A déjà hydratée sur un autre Gateway
et la conservation distincte de la première minute. Le test du parcours de
fermeture utilise le vrai code Gateway avec transport isolé : drainage,
upload lent, position finale et révocations du même/autre compte.

**270 tests ciblés réussis, aucun ignoré**, avec Miniflare et la migration SQL
réellement chargés. **191 tests réussis, aucun ignoré**, dans l'image Gateway
Node 20 déployée, réseau coupé, un CPU, 384 Mio et deux workers de test.
Ces contrôles couvrent aussi les règles HLS et les chemins historiques.
Le contrôle CI complet du commit exact reste distinct de ces suites ciblées.

Un extrait réel déjà conservé a été remuxé en MP4 **sans réencodage**, hors réseau :
H.264 High / AAC-LC, 12,075 secondes. La vraie classe de cache le conserve,
le recharge après redémarrage, puis vérifie ses octets et sa sortie décodée.

| Contrôle MP4 | Résultat |
| --- | ---: |
| Original | 541 677 octets |
| Stockage gzip | 516 902 octets |
| Économie sur cet extrait | **4,57 %** |
| Octets après restauration | identiques |
| Sorties vidéo et audio décodées | identiques, aucun échec ni erreur de décodage |

Ce résultat ne prouve ni une reprise rapide dans le lecteur public, ni une
économie de 4,57 % sur le catalogue entier, ni la qualité à l'écoute. Le cache
ne garantit pas que les plages conservées couvrent une minute autour de tout
saut. Les premiers préchargements MP4 natifs restent distincts du préfixe HLS.

Preuves de cette suite sous `.codex-artifacts/startup-cache-20261010/` :
`native-durable-regression.local.log`, `native-durable-linux.safe.json`,
`native-resume-real.remote.py.safe.json`. PR786 reste en brouillon, sans
migration ni déploiement de production, ni connexion fournisseur supplémentaire.

## Suite : lecteurs natifs Android et Windows, route Gateway

Le raccord préparé s'étend à `native-vod-recovery`, uniquement lorsque cette
route est déjà utilisée par le lecteur natif et que la persistance est activée
en environnement isolé. Format `native-file-input-v1` distinct du MP4 web :
plages originales complètes, en-tête et quatre échantillons frais, durée signée,
quotas et compression sans perte identiques. Les lectures natives directes ne
sont pas couvertes : le serveur Norva ne reçoit pas leurs octets.

- Android téléphone/TV : après une première image réellement rendue, le
  heartbeat transmet la position Media3. La fermeture stocke sa position
  bornée avec l'UUID, le motif et l'âge absolu du close en attente ; les réessais
  après rechargement gardent la même position et la même expiration.
- Windows : le bridge utilise les statistiques de décodage et une position
  récente de la session exacte. Le processus principal conserve la position
  de fermeture jusqu'à l'ACK, y compris si le renderer est rechargé. Aucune
  position du DOM vidéo n'est utilisée pour un lecteur LibVLC.
- Compatibilité Windows : le canal protocole 1 `pending-closes` garde sa liste
  d'UUID pour les anciens renderers. Le détail de position utilise un canal
  distinct, protégé par le même contrôle de fenêtre/frame/origine. Le nouveau
  renderer revient à l'ancienne liste si le preload ne fournit pas le détail.
  **98 tests ciblés réussis**, sans ignoré, après cette correction, incluant
  accusés de fermeture, isolation de session et admission du cache natif.
- Le replay du vrai bloc Gateway teste les scopes MP4 web et récupération
  native, le drainage avant upload, les révocations et le seuil de 90 %.
  Lorsque l'option native est désactivée, aucun snapshot ni revalidation
  supplémentaire n'est ouvert. Les lectures de préchargement ne sont pas
  assimilées à la progression d'un spectateur.

**149 tests ciblés réussis, aucun ignoré**, dont le cycle A/B/redémarrage/retrait
à 90 % des deux formats avec le vrai Worker/SQLite/R2 local Miniflare.
Preuve : `native-recovery-focused.local.log`. Les assertions de runtime ajoutées
contrôlent une position non décodée refusée, la première image Media3 et une
horloge utilisable après saut puis pause.

La PR reste en brouillon. Aucun nouveau gain de lecture public, validation à
l'écoute ou déploiement de production n'est annoncé. R2 payant reste désactivé.

### Contrôle de WatchPage et du stockage persistant local

Le banc charge les vrais `WatchPage`, `cloudApi`, gestionnaire de sessions MP4,
bloc de création Gateway, broker d'entrée et classes de cache. Le Worker,
SQLite et R2 sont exécutés par Miniflare sur le disque local. L'entrée est le
même extrait H.264/AAC déjà conservé, remuxé sans réencodage (12,075 secondes,
541 677 octets). Les API d'authentification et d'admission restent des fixtures
locales : ce contrôle ne vaut pas parcours public Edge/Cloudflare déployé.

| Étape | Observation |
| --- | --- |
| Arrêt normal du lecteur | Position finale reçue, transport drainé, une fenêtre publiée |
| Redémarrage du banc et de Miniflare | RAM recréée, fichiers R2/SQLite conservés |
| Réouverture après redémarrage | Quatre échantillons frais concordants ; lease accepté |
| Données d'entrée réutilisées | **541 677 octets** ; aucun nouvel octet de média téléchargé par le broker de lecture |
| Deux reprises mesurées depuis le clic | **0,37 / 0,38 s** sur ce banc local |
| Progression | Retrait de l'ancienne archive sans interrompre le lease de lecture |
| Nouvel arrêt à 6,408 s | Nouvelle fenêtre publiée après drainage de 4 ms |
| Continuation jusqu'à 12,075 s | Aucune attente signalée ni image perdue sur ce replay court |
| Fin et clôture | Aucun nouvel archivage, cache vide, aucune connexion source active |

Les quatre requêtes de vérification sont nécessaires avant l'utilisation des
octets conservés : « zéro nouvel octet de média » ne signifie pas zéro requête
source. Maximum observé : une connexion à l'origine locale. Les replays courts
ne valident ni plusieurs minutes de continuité, ni le débit des fournisseurs,
ni les sauts hors cache, ni la qualité à l'écoute. Le premier replay du banc
a ouvert la lecture avant la fin du redémarrage asynchrone : erreur de séquencement
du banc, corrigée dans le protocole par l'attente de son ACK de fin. Les résultats
positifs ci-dessus proviennent des réouvertures après cet ACK.

Preuves locales sous `.codex-artifacts/startup-cache-20261010/` :
`native-player-restart-B.safe.json`, `native-player-stop-C.safe.json`,
`native-player-completed.safe.json` et `native-player-restart.png`. Banc arrêté
et onglet temporaire fermé après les contrôles.

### CI et émulateurs du raccord natif

Sur le commit de code `e54da030cc028687c3539c03d6b5667b43db3923`,
[Build Norva 38171302353](https://github.com/Admin-Adher/Norva/actions/runs/38171302353)
réussit : **6 539 tests réussis, 39 ignorés**, contrôles SQL imposés **50/50**,
Worker/SQLite/R2 local imposé **15/15**, locales/region/syntaxe et construction
des trois paquets Android téléphone, TV et Windows.

La [première matrice Android 38171302372](https://github.com/Admin-Adher/Norva/actions/runs/38171302372)
réussit sur TV aux deux tailles de police et téléphone gestes/police 1,3.
Les trois autres configurations échouent : deux rejouent une nouvelle assertion
de cache trop tôt, au callback de première image avant l'état READY ; les autres
échecs concernent les limites existantes de délai de refus HTML et le retour Back.
Le test attend désormais READY/ENDED après la première image, dans une fenêtre
bornée de cinq secondes, puis vérifie la position. Le code conserve son refus
d'une position encore non décodée ou en attente ; aucune protection de lecture
n'est assouplie. Correction de test : `1866ede730b448e63bd5c7cdfd80cf6acd2c67d8`.
La dernière matrice et son statut exact sont publiés dans la [PR786](https://github.com/Admin-Adher/Norva/pull/786).

La préparation reste désactivée en production. Le portable final, les comptes
réels, l'entrée authentifiée publique et la validation à l'écoute restent des
contrôles distincts avant activation ; les lectures natives directes restent
hors du périmètre de stockage serveur.
