# Cache privé natif : preuve réelle sur six configurations Android

## Résultat

Le 30 septembre 2026, le rejeu `run-20260930T180343Z` s'est terminé avec
`complete=true`, `cleanupError=null` et un code de sortie 0 : **30/30 tests,
aucun échec et aucun skip**. Cela représente **six lectures réelles du cache
privé R2 et 24 exécutions de contrats**, et non trente lectures différentes.

| Environnement | Navigation | Police | Tests | Lecture réelle |
| --- | --- | --- | --- | --- |
| Phone | Trois boutons | 1.0 | 5/5 | Réussie |
| Phone | Trois boutons | 1.3 | 5/5 | Réussie |
| Phone | Gestes | 1.0 | 5/5 | Réussie |
| Phone | Gestes | 1.3 | 5/5 | Réussie |
| Android TV | D-pad | 1.0 | 5/5 | Réussie |
| Android TV | D-pad | 1.3 | 5/5 | Réussie |

## Code et provenance des APK

- Source commune : main `510163f2fa8a33044607c11d59ce99c38b221fc0`.
- Build GitHub réussi : `36747953742`, événement `push`, branche `main`, dépôt
  et dépôt source `Admin-Adher/Norva`.
- Phone : **1.3.28, code 42** ; Android TV : **3.8.22-hybrid, code 35**.
- Phone app/test : artefacts `11113442166` et `11113546834`, même job
  `109999512052`.
- TV app/test : artefacts `11113143075` et `11113282936`, même job
  `109999512180`.
- Empreintes ZIP contrôlées contre GitHub ; empreintes de chaque APK inscrites
  dans le manifeste. Certificat identique dans chaque paire app/test et noms
  des quatre paquets vérifiés avant installation.
- SHA256 du manifeste :
  `f97d0940c93844ffdf889a0389ec897bb1e7a2f2e23c37bc1dec14e10f06045d`.
- SHA256 de l'opérateur exécuté :
  `ca5091730426710785620930567a718b68625eb8e458ab1b28f0d8b33d0c811b`.

Cette preuve concerne ces APK de CI. Elle ne prouve pas l'installation de cette
version sur un téléphone utilisateur, ni le résultat des changements Live
ultérieurs présents dans le checkout de ce rapport.

## Parcours réellement exercé

Les classes `NativeMediaCacheInstrumentedTest` et
`NativeMediaCachePlaybackInstrumentedTest` ont été lancées avec
`norvaRequireMediaCacheFixture=true`. La fixture réelle est donc obligatoire :
son absence fait échouer, elle ne peut plus transformer ce contrôle en skip.

Le scénario réel impose :

1. Ouverture du lecteur natif avec le ticket privé d'un objet R2 déjà disponible.
2. Plus de 24 images décodées et rendues.
3. Renouvellement du ticket par l'API de production.
4. Recherche à 45 secondes, vitesse 2× et progression jusqu'à au moins 55 secondes.
5. Pause explicite conservée pendant trois secondes, dérive inférieure à 500 ms.
6. Fermeture de l'activité et retrait de la fixture privée.

Les quatre autres contrats contrôlent le périmètre HTTPS/origine/préfixe du
ticket, la stabilité d'identité au renouvellement et les en-têtes, les formats
de dates, ainsi que l'obligation explicite de fixture.

## Autorité et environnement QA

Le compte QA ordinaire et sa liaison existante à un objet réel ont été utilisés.
Aucune source, permission, offre, souscription ou liaison cache n'a été créée
ou modifiée pour ces essais. Avant chaque cas, l'opérateur relit l'autorité de
la liaison et refuse si elle a changé ou si un lecteur du compte est déjà actif.

Un bearer `authenticated` QA, signé sur l'hôte et valable 300 secondes, est livré
en mémoire après préparation de l'émulateur. **Ce procédé n'est pas une preuve
de connexion naturelle d'un utilisateur.** Il confère l'autorité du compte QA
ordinaire ; seul le ticket cache est limité à l'objet/session. Aucune clé durable
JWT, service-role, R2 ou SSH n'entre dans Android, les logs ou les artefacts.

La création, le heartbeat et l'expiration passent par les API ordinaires. Le
résultat doit être `shared-cache`, sans Gateway de lecture, avec transport
`private-r2-hls` et objet attendu. Tout repli est refusé ; aucun flux fournisseur
n'est consommé par ce rejeu.

Les deux conteneurs QA isolés utilisent l'image attestée
`sha256:a189143679bdbd34d8b119dcae99f15730ee736f5e80c99b12edc3335ca47cf0`.
Un seul émulateur tourne à la fois, avec un plafond temporaire autorisé de 4 CPU
au lieu de 2 ; les 2 vCPU Android, la RAM, l'image et les graphismes restent
identiques. Les deux Gateways doivent être sains et sans lecture ni processus
CPU de fond avant chaque cas. Aucun quota de production n'est modifié.

## Échecs initiaux et corrections du harnais

- Les premières préparations à 2 CPU ont rencontré un ANR SystemUI avant toute
  session. Le rapport Android montrait une attente Binder vers SurfaceFlinger
  de 13 989 ms avec forte pression CPU. Un diagnostic autorisé à 4 CPU a obtenu
  HOME puis trente secondes stables sans ANR ; le budget QA a été adapté
  explicitement. Aucun garde ANR n'a été retiré et aucun log n'a été effacé.
- Une ancienne instrumentation avait conservé son certificat debug. Le refus
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE` a conduit à corriger l'inventaire puis la
  remise à zéro des seuls paquets QA exacts app/test. Leur disparition est
  confirmée avant installation ; les exigences de signature restent intactes.
- `run-20260930T175403Z` a expiré sa session mais son contrôle final décodait le
  booléen PostgreSQL `t` comme du JSON. Son verdict n'avait pas été conservé :
  **aucun succès de test n'est revendiqué pour ce run perdu**. Le contrôle utilise
  maintenant `to_json(boolean)` et sauvegarde le verdict d'instrumentation avant
  le nettoyage. L'expiration de cette ancienne session a été confirmée en lecture
  seule, puis le reçu actif retiré. La version finale passe 29 tests d'opérateur.

Les six succès du présent rapport proviennent uniquement du nouveau rejeu
complet, distinct de ces essais initiaux.

## Nettoyage et preuves

Six reçus d'instrumentation et six reçus de nettoyage sont conservés séparément.
Les six sessions ont été confirmées expirées par SQL après l'API d'expiration ;
les fixtures Android sont retirées et aucun reçu de session active ne reste.
Les deux conteneurs sont arrêtés et plafonnés à nouveau à **2 CPU**. La commande
`validate` finale, en lecture seule, a confirmé l'état attendu et l'absence de
lecteur actif du compte QA.

Reçu privé serveur :
`/home/adrien/.norva/native-cache-host-proof-20260930/run-20260930T180343Z/result.json`.
SHA256 : `06d8c9da1633b371545dc8a33d8ac13b9ad2e9d63204747a22289e709c535624`.
Copie locale expurgée :
`C:/Users/Adrien/.codex/tmp/native-cache-main-510163f2/result-20260930T180343Z.safe.json`.

## Limites

Cette preuve couvre le cache privé réel sur Phone et TV émulés, ses tickets,
la recherche et la pause. Elle ne mesure pas précisément le délai de première
image ou les FPS, ne prouve pas le parcours commercial/login, une lecture
fournisseur, une concurrence entre spectateurs ou la continuité d'une même
position de reprise transférée entre deux appareils. Elle ne certifie pas
rétroactivement toute la suite QA générale de PR509 : une configuration avait
échoué avant instrumentation sur une archive SDK Android corrompue.
