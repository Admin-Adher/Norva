# Maintenance des langues — 5 octobre 2026, 03:08 Paris

Contrôles à partir de 01:08 UTC. Reçus locaux sous
`.codex-artifacts/language-heartbeat-0308/`. Les six audits habituels sont
exécutés en lecture seule. La campagne reste permanente.

## Manifeste initial, à 01:08 UTC

Périmètre immuable : 56 751 variantes et 43 125 fiches de quatre catalogues
du compte initial. Toutes les variantes du manifeste restent visibles.

| Catalogue | Contrôles techniques uniques | Identifiées, compteur historique | Inconnues |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 8 897 | 142 | 30 052 |
| Norva Selection | 85 | 9 | 174 |
| Dino | 7 711 | 4 152 | 4 717 |
| MAX OTT | 5 847 | 3 478 | 14 027 |
| **Total** | **22 540** | **7 781** | **48 970** |

38 636 fiches restent inconnues. Depuis 00:08 : **502 contrôles uniques et
152 identifications** supplémentaires. Les quinze dernières minutes comptent
107 contrôles uniques. Ce compteur historique exclut les badges humains ;
il ne mesure ni l'ensemble de Norva ni le débit de reconnaissance vocale.

L'audit strict du même manifeste reste à **38 validations complètes et
78 analyses complètes indéterminées**, compatibles avec le profil courant.
Ces ensembles se recoupent et ne doivent pas être additionnés aux compteurs
précédents.

## Périmètre global et activité

L'inventaire reste de **54 sources et 47 propriétaires**. Hors manifeste,
50 sources de 46 propriétaires ont été appelées : **4 177 tentatives et
1 861 identifications en reçus cumulés**, soit +85 et +36 depuis 00:08.
Il s'agit de reçus, pas de fichiers uniques. Aucun nouvel import ou compte
n'est démontré par ce relevé.

Les priorités restent à 670 indices de trois propriétaires, 7 136 variantes
visibles et 383 variantes de films connues. Aucune progression comparable
de cet inventaire prioritaire n'est observée.

Fenêtre dispatcher 00:29:25–01:09:24 : 874 événements, 32 lots avec tentatives,
364 tentatives, 99 identifications et deux échecs en reçus ; **aucun nouvel
échec HTTP du dispatcher dans cette fenêtre**. Les reports comprennent
677 événements de capacité, 112 `pregen-active` et 21 d'occupation fournisseur.
Ces reports ne sont pas des sondes ni des lectures utilisateur prouvées.

La dernière validation stricte complète globale observée reste celle du
4 octobre à 23:00:30. Cinq travaux stricts ont progressé depuis 00:08,
dont quatre depuis 00:29 ; la dernière progression relevée à 01:09 est datée
de 01:09:14. Une progression de travail ne constitue pas une analyse terminée.

## Santé, capacité et garde MAX OTT

À 01:08, les deux Edge sont sains et les deux Gateways répondent HTTP 200 / ok.
Leurs dates de démarrage restent celles du déploiement précédent, entre
00:28:36 et 00:29:22. Admission, crons, découverte et dispatcher unique sont
actifs. Aucun redémarrage n'est effectué pendant ce contrôle.

À 01:09:24, chaque Gateway déclare deux places disponibles. Aucun lecteur,
broker strict ou calcul Whisper n'est actif à cet instant ; zéro bail strict
actif ou expiré est observé. Le principal conserve quatre travaux différés.
Les deux derniers passages de cron contrôlés ont réussi. Ces instantanés
ne justifient aucune modification de route, de concurrence ou de délai.

À 01:11:24, l'occupation du compte MAX OTT provient d'un marqueur `gateway`
daté de **01:07:38.717**, encore dans sa grâce ordinaire de cinq minutes,
jusqu'à **01:12:38.717**. Aucun lecteur ni bail de validation, de profil ou
d'identité n'est actif sur ce compte à cet instant. Il s'agit d'une garde
résiduelle observée, pas d'une lecture utilisateur démontrée.

Cinq storyboards du même compte montrent une progression de tuiles depuis
00:29 ; l'un devient prêt à 01:07:38.802. Un autre produit un checkpoint
fournisseur à 01:07:38.574, 228 ms avant ce passage prêt. Une émission d'activité
pendant l'assemblage local est une piste issue de la lecture du code, mais
ces deux événements voisins empêchent d'attribuer exclusivement le marqueur
à cet assemblage. Aucun blocage associé n'est démontré, aucun correctif n'est
appliqué et la grâce n'est pas forcée.

## Copies prioritaires : transition réelle après la grâce

À 01:08, Lost est encore reporté pour `PROVIDER_ACCOUNT_BUSY` : cinq reçus,
curseur 5/6 et neuf tentatives fournisseur. Les cinq reçus ont dépassé leur
durée de validité de deux heures. Le correctif de classification de PR 651
n'a alors pas encore été exercé naturellement sur ce travail.

Après expiration naturelle de la grâce, le worker reprend Lost à
**01:13:01.641** : dixième tentative fournisseur, sans nouveau POST opérateur.
À **01:14:10.455**, le travail atteint réellement l'état `failed` avec
`LANGUAGE_CAPTURE_AUDIO_WINDOW_UNAVAILABLE` et le délai existant de 24 heures,
jusqu'au **6 octobre à 01:14:10.451 UTC**. Les cinq reçus, leur empreinte,
le curseur 5/6, le passage 0, les indices audio attendus et le profil sont
conservés. Aucun horodatage de validation ni nouvelle quarantaine n'est créé.

Cette transition confirme le traitement du blocage déterministe décrit dans
le [diagnostic ciblé](2026-10-05-language-capture-unusable-window.md).
**Lost reste incomplet et sa langue n'est pas publiée.** Le délai ne constitue
pas une promesse de reprise automatique du même travail terminal.

La sortie terminale libère naturellement une place : un travail manuel et
trois travaux fournisseur actifs à 01:14. Le précontrôle ordinaire de Bolt à
01:14:45 confirme un profil/cache exact, la piste index 1, une identité liée,
aucun badge humain, aucun lecteur et aucun autre blocage. **Un seul POST
ordinaire est envoyé à 01:15:04**, accepté HTTP 202 avec état `queued`.
C'est une admission, pas une capture ou une identification. Aucun retry de
cet opérateur n'est effectué ; l'ancien état `PROFILE_CHANGED` est conservé.

À **01:16:18**, le travail existant d'Ochi obtient sa première capture et son
premier reçu, lors de sa première tentative fournisseur. Ce reçu est
`insufficient` : aucune langue qualifiée, aucune publication. À 01:16:39,
le travail est `queued`, passage 0 et curseur 1/6. À ce même instant, Bolt
reste `queued`, passage 0, zéro tentative et zéro reçu ; l'ancien travail
`PROFILE_CHANGED` demeure présent. Les quotas actifs sont revenus à deux
travaux manuels et quatre du compte fournisseur.

Mars reste sans profil. Sa garde est revue à 01:16:09 : bien que le marqueur
`language-validation` ne bloque pas la fonction globale de présence, un bail
de validation et un bail de profil exact sont actifs. **Aucun POST de profil
Mars n'est envoyé.** Aucune admission supplémentaire d'Ochi n'est créée.
Les cinq confirmations humaines restent projetables : une espagnole et
quatre anglaises, sans nouvelle écoute ni republication.

## Diagnostic SQL isolé

Un diagnostic `database-statement-timeout` / SQL **57014** apparaît sur le
second Edge à **00:30:09.875 UTC**, avec route `other` et opération `unclassified`.
Les accès Kong montrent un POST `norva-playback/audio-backfill` HTTP 500 à
**00:30:09.882**, environ sept millisecondes plus tard, précédé d'un POST interne
classé `other` également en 500. C'est une **corrélation temporelle** avec le
chemin audio-backfill ; les preuves conservées ne désignent ni la requête SQL,
ni le compte, ni la cause exacte. Elles ne démontrent pas un échec du finaliseur
strict.

La relecture des deux fenêtres Edge depuis 00:29 jusqu'à 01:11:21–22 ne trouve
**qu'une occurrence**, et aucune après celle de 00:30. Aucun diagnostic de
finalisation n'est trouvé dans ces nouvelles fenêtres. Cela ne supprime pas
les incidents historiques. L'audit n'applique aucun correctif spéculatif.

## CI et publication Android

À 01:09, les cinq contrôles observés de PR 651 et les quatre de PR 652 sont
tous réussis, paquets Phone, TV et Windows compris. PR 651 est intégrée par
`f1f2699b01c9da6b327de6c8209c99a521b0b3ee` ; PR 652 par
`81948a703f186230345cce3ee8e66f0c54286543`. Aucun rerun ni nouveau déploiement
n'est effectué pendant ce contrôle.

La Console Google Play est relue à 01:09 : **Mobile 1.3.32 (46)** et
**TV 3.8.25-hybrid (38)** restent en cours d'examen, sans action demandée.
Aucun bundle réimporté, examen relancé ou réglage modifié. Leur disponibilité
sur Google Play reste à confirmer.

## Limites et suites

Les audits sont en lecture seule ; la seule admission opérateur est le POST
ordinaire ciblé de Bolt décrit ci-dessus. Le worker permanent poursuit ses
traitements sous les gardes existantes. Aucune langue supplémentaire, réparation
de HIT ou réparation des octets corrompus n'est revendiquée. Les anciens
reports Strng et quarantaines Dino restent conservés. La maintenance globale
et le suivi des publications Play restent actifs.


## Suivi de clôture du relevé, 01:25 UTC

Le relevé de 01:25:16 retrouve Ochi à `failed` depuis **01:17:43.008**, avec
le même code `LANGUAGE_CAPTURE_AUDIO_WINDOW_UNAVAILABLE`. Deux tentatives
fournisseur ont produit un seul reçu insuffisant, conservé avec le curseur
1/6, passage 0. Le délai normal va jusqu'au **6 octobre 01:17:43.005 UTC**.
Son analyse est donc incomplète ; aucune langue ni analyse complète
indéterminée n'est revendiquée. Aucun opérateur ne relance ce travail terminal.

Bolt a maintenant deux reçus, curseur 2/6, pour trois tentatives fournisseur.
Sa dernière progression de reçu est datée de 01:20:22.367 ; il est reporté
`PROVIDER_ACCOUNT_BUSY` à 01:25:00.683. Il reste non identifié. Ces nombres
ne constituent ni quatre preuves qualifiées ni une analyse terminée.
Lost est inchangé et Mars reste sans profil. Les quotas sont redescendus à
un travail manuel et trois fournisseur ; cela ne démontre pas à lui seul
la disponibilité du compte. Reçu : `targets-closeout.safe.json`.
