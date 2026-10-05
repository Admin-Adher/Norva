# Maintenance des langues — 5 octobre 2026, 02:07 Paris

Contrôles à partir de 00:07 UTC. Reçus locaux sous
`.codex-artifacts/language-heartbeat-0207/`. La campagne reste permanente.

## Manifeste initial, à 00:08 UTC

Périmètre immuable : 56 751 variantes et 43 125 fiches de quatre catalogues
du compte initial. Toutes les variantes restent visibles.

| Catalogue | Contrôles techniques uniques | Identifiées, compteur historique | Inconnues |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 8 673 | 142 | 30 052 |
| Norva Selection | 85 | 9 | 174 |
| Dino | 7 452 | 4 011 | 4 858 |
| MAX OTT | 5 828 | 3 467 | 14 038 |
| **Total** | **22 038** | **7 629** | **49 122** |

38 688 fiches inconnues. Depuis 23:09 : **918 contrôles uniques et 126
identifications** supplémentaires. Ce compteur exclut les badges humains ;
ce n'est ni un débit global ni un débit de reconnaissance vocale. L'audit
strict reste à **38 validations complètes et 78 analyses complètes indéterminées**
compatibles avec le profil courant. Ces ensembles se recoupent.

## Global et santé

54 sources et 47 propriétaires découverts, inventaire inchangé. Hors manifeste,
50 sources de 46 propriétaires ont été appelées : **4 092 tentatives et
1 825 identifications en reçus cumulés**, pas des fichiers uniques. Depuis
23:24 : +274 tentatives et +127 identifications dans ces reçus.

670 indices prioritaires de trois propriétaires, 7 136 variantes visibles et
383 variantes de films connues. Ce périmètre élargi ne permet pas de transformer
la différence avec le précédent inventaire en progression comparable.

Fenêtre dispatcher 23:09–00:08:51 : 97 lots avec tentatives, 1 222 tentatives,
269 identifications et 23 échecs en reçus ; aucun nouvel échec HTTP. Neuf travaux
stricts ont progressé, mais la dernière validation complète globale reste celle
de 23:00:30. Aucun nouveau compte ou import n'est prouvé.

Deux Edge et deux Gateways sains à 00:08, dates de démarrage inchangées.
À 00:09 : aucun lecteur ponctuellement, deux places déclarées par Gateway,
un broker strict et une computation sur le principal, cinq storyboards différés.
Un bail strict actif, zéro expiré. Crons, admission et dispatcher actifs.
Aucun diagnostic de finalisation dans les seules fenêtres Edge depuis 21:38 ;
les incidents historiques et quarantaines restent conservés. Le finaliseur
Strng de 02:22 reste reporté à 02:22:08 UTC, sans forçage.

## Copies prioritaires et confirmations humaines

Les cinq confirmations humaines restent lisibles après le correctif SQL de
23:23 : une espagnole et quatre anglaises. Aucune nouvelle écoute ou republication.

Lost conserve cinq reçus et neuf tentatives à 00:08 ; deux reçus sont désormais
expirés. Une répétition déterministe de préparation sur sa sixième acquisition
est démontrée et traitée séparément dans le [diagnostic ciblé](2026-10-05-language-capture-unusable-window.md).
Ochi reste sélectionné avec zéro capture/tentative fournisseur. Bolt garde son
profil exact, mais les quotas de deux travaux manuels et quatre travaux fournisseur
sont pleins. Mars reste sans profil. Aucun POST opérateur ni appel média fournisseur
n'a été effectué pendant les audits.

### Contrôle après le déploiement ciblé, 00:30–00:31 UTC

La correction de classification décrite dans le diagnostic ciblé est déployée.
À 00:30:06, elle n'a pas encore été exercée naturellement sur Lost : toujours
cinq reçus, neuf tentatives fournisseur et dernier état `INFERENCE_DEFERRED`
daté de 00:22. Les reçus, curseurs, profils et générations correspondent au
snapshot pris avant déploiement ; aucune langue nouvelle n'est publiée.

À 00:30:49, Lost est dû et sélectionné, mais la capacité du Gateway principal
est zéro pour `foreground-work` : une opération active et quatre travaux
prioritaires. Le secondaire déclare deux places ; cela n'autorise aucun
changement de route. Aucun lecteur, broker strict ou calcul d'inférence à cet
instant. Les deux crons sont actifs et leurs derniers passages ont réussi.

La garde du compte MAX OTT est également occupée par un marqueur `gateway`
rafraîchi à 00:30:43, avec grâce ordinaire jusqu'à 00:35:43 au minimum ; aucun
lecteur ou bail de validation/sonde actif sur ce compte. Quatre storyboards
de ce même compte ont chacun un checkpoint depuis 00:29. À 00:31:35, le
principal indique `transcribeBusy=true` et quatre travaux en attente ; cette
mesure n'identifie pas à elle seule chaque travail actif. Aucun motif pour
forcer une garde ou augmenter la concurrence n'est établi.

Les nouvelles fenêtres de logs depuis 00:29 ne contiennent encore ni le
nouveau code de fenêtre inexploitable, ni `LID_CAPTURE_PREPARATION_FAILED`.
Cette absence ne constitue pas une validation de la transition réelle ; le
suivi attend la prochaine exécution ordinaire. Les anciens logs et incidents
restent conservés. Reçus `postdeploy-*.safe.json`, aucune mutation de ces audits.

## CI et publication Android

L'ancien paquet Phone de PR 649 a finalement échoué pendant son **envoi d'artefact
GitHub**, après réussite de Gradle, des tests et du lint. `CreateArtifact` a expiré
après cinq tentatives. Ce n'est pas un échec de compilation ni un refus Google Play.

Un seul rerun ciblé du job 111556676809 a été demandé à 00:11:08 UTC. À 00:13:33,
la tentative 2 affiche Phone, TV, Windows et contrats cloud réussis. Le nouveau
job Phone est 111565332621. L'échec historique reste consigné. Les quatre contrôles
de PR 650 sont également réussis, paquets compris.

Les pages Google Play ont été relues pendant ce contrôle : **Mobile 1.3.32 (46)**
et **TV 3.8.25-hybrid (38)** restent en cours d'examen, sans action demandée.
Aucun nouvel import, changement de configuration ou redémarrage d'examen.
Leur disponibilité sur le Store n'est pas encore établie.
