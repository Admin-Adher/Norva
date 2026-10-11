# Cache privé R2, file globale et durée de vie des reprises

## Résultat et périmètre

La branche `codex/global-startup-durable-20261011` / PR786 prépare le transport
R2 privé et la file globale des premières minutes, avec compression sans perte.
Elle raccorde aussi les captures **HLS de reprise** et la règle demandée A → B,
avec suppression à partir de 90 % de la durée connue.

**Tout reste désactivé, sans activation R2 payante.** Aucun vrai bucket, secret,
migration de production, upload R2 ou changement de trajet fournisseur. Les
tests de stockage utilisent Miniflare local ; la migration SQL tourne dans
PGlite isolé. Aucun compte fournisseur n'est ouvert pour ces contrôles.

Les routes MP4 natives par plages d'octets et les caches conservant seulement
l'input ne sont pas des archives HLS : ils ne sont pas raccordés à cette
persistance. Aucun gain public de démarrage ou de fluidité n'est annoncé ici.

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
Cloudflare/claims/lecteur, routes MP4 natives, diversité des fichiers et des
invalidations, écoute, débit durable, coûts d'opérations et charge du catalogue.
