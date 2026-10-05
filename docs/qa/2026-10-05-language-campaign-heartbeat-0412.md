# Maintenance des langues — 5 octobre 2026, 04:12 Paris

Le relevé du manifeste vient des contrôles déjà effectués à 02:08 UTC sous
`.codex-artifacts/language-status-0408/`. Ces trois audits ne sont pas relancés.
Les trois audits complémentaires du périmètre global et de la finalisation
sont exécutés en lecture seule à 02:13:32 ; leurs reçus sont sous
`.codex-artifacts/language-heartbeat-0412/`.

## Manifeste initial : chiffres déjà communiqués

Périmètre immuable : 56 751 variantes et 43 125 fiches des quatre catalogues
du compte initial. Toutes les variantes restent visibles.

| Catalogue | Contrôles techniques uniques | Identifiées, compteur historique | Inconnues |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 9 370 | 145 | 30 049 |
| Norva Selection | 85 | 9 | 174 |
| Dino | 8 174 | 4 394 | 4 475 |
| MAX OTT | 5 858 | 3 485 | 14 020 |
| **Total** | **23 487** | **8 033** | **48 718** |

38 543 fiches restent inconnues. Gain comparable depuis le relevé de 01:08 :
**947 contrôles uniques et 252 identifications**. Ces chiffres ont déjà été
annoncés à Adrien avant ce heartbeat ; il ne s'agit pas d'un deuxième gain.
Le compteur historique exclut les badges humains et ne mesure pas l'ensemble
de Norva ni le débit de reconnaissance vocale.

L'audit strict du manifeste compte désormais **39 validations complètes et
78 analyses complètes indéterminées compatibles**, soit une validation de
plus. Ces ensembles se recoupent et ne s'additionnent pas aux compteurs
précédents.

## Bolt : langue vérifiée et projetée pour la copie exacte

Le travail manuel ordinaire admis lors du heartbeat précédent a validé
**l'anglais de Bolt from the Blue à 01:40:27.654 UTC**. Il a effectué sept
tentatives fournisseur. La preuve finale compte une piste attendue, une piste
terminée et une preuve complète ; profil, date de profil, taille du fichier,
indices audio et cache concordent.

La relecture authentifiée du catalogue à **02:11:03** répond HTTP 200 avec une
seule correspondance exacte. La fiche et la variante concernée portent `en` ;
la portée de la variante est `file`. Ce résultat ne propage pas l'anglais aux
autres copies du film. Il repose sur la validation automatique, distincte des
cinq confirmations humaines antérieures. Il ne certifie pas la fluidité du
fichier et ne répare pas les corruptions déjà signalées.

## Autres copies et délais conservés

À 02:13, **Lost** reste terminal `LANGUAGE_CAPTURE_AUDIO_WINDOW_UNAVAILABLE` :
cinq reçus conservés, dix tentatives fournisseur, curseur 5/6 et délai existant
jusqu'au 6 octobre à 01:14:10 UTC. Analyse incomplète, aucune langue publiée.

**Ochi** a atteint le même code terminal à 01:17:43 le 5 octobre, après sa
deuxième tentative fournisseur. Son premier reçu insuffisant est conservé,
curseur 1/6 ; le délai existant court jusqu'au 6 octobre à 01:17:43 UTC.
Il n'y a aucune langue qualifiée. Ces états ne sont pas des quarantaines
`NO_PROGRESS` et ne sont pas assimilés à des analyses complètes.

**Mars** reste sans profil. À 02:13:27, zéro lecteur et zéro bail de validation,
de profil ou d'identité sont observés sur le compte, mais le marqueur
`catalog-metadata` vient d'être rafraîchi à **02:13:26.632**. Sa grâce ordinaire
court jusqu'à **02:18:26.632**. Le précontrôle de structure et quotas n'est pas
une autorisation de contourner cette garde. Aucun POST de profil n'a été envoyé
à ce stade.

Les cinq confirmations humaines restent toutes projetables à 02:13:27 :
Innocent Voices en espagnol ; Prey, Sinners/Pécheurs, California King et
Broke/Amoché en anglais. Aucune nouvelle écoute, ligne ou republication.

## Deux nouvelles quarantaines MAX OTT

L'audit strict existant de 02:08 montre **deux autres travaux MAX OTT** avec
`LANGUAGE_VALIDATION_NO_PROGRESS_QUARANTINED`, chacun après cinq tentatives
fournisseur, zéro position de fenêtre conservée et aucun progrès fournisseur
enregistré. Leurs délais sont respectivement le **6 octobre à 01:43:48.234**
et le **6 octobre à 02:03:47.932 UTC**.

Ces deux quarantaines sont nouvelles par rapport au relevé de 01:08. La cause
précise de l'absence de progression n'est pas établie par cet audit agrégé.
Aucun délai, compteur ou quarantaine n'est forcé. Les quarantaines Dino
historiques restent séparées. Le finaliseur Strng déjà suivi reste reporté
au 5 octobre à 02:22:08 UTC, sans relance anticipée.

## Périmètre global et santé

À 02:13:32, l'inventaire global reste de **54 sources et 47 propriétaires**.
Hors manifeste initial : 50 sources de 46 propriétaires appelées, avec
**4 215 tentatives et 1 861 identifications en reçus cumulés**. Depuis 01:08 :
38 tentatives supplémentaires et aucune identification supplémentaire dans
ces reçus. Ce ne sont pas des fichiers uniques. Les 2 359 reports cumulés
ne sont pas des sondes. Aucun nouvel import ou propriétaire n'est démontré.

Les priorités restent à 670 indices de trois propriétaires et 7 136 variantes
visibles. Le nombre de variantes de films connues passe de 383 à **384**.
L'audit de cette file relève quatre travaux stricts ayant progressé depuis
leur priorité, contre un précédemment ; ces compteurs ne prouvent pas quatre
validations complètes.

Les deux Edge sont sains, les deux Gateways répondent HTTP 200 / ok et leurs
dates de démarrage sont inchangées depuis le déploiement précédent. Admission,
cron strict, découverte et dispatcher unique sont actifs ; un appel maximum
est en vol. Aucun bail strict, intake, metadata ou source-schedule n'est actif
dans ce snapshot.

Les quatre erreurs HTTP cumulées du dispatcher sont inchangées. Dans les
fenêtres Edge conservées depuis 00:28, aucun diagnostic de finalisation n'est
présent et le compteur de timeout reste à **une occurrence sur le second
Edge**, déjà documentée à 00:30:09. Aucun nouvel incident SQL n'est prouvé par
ce relevé. Les incidents historiques restent conservés.

## CI et Google Play

PR 653 est intégrée, fusion `c1d7042b1cad9a3bf15ca912e5bc957de7f6e230`,
tête documentaire `194df7533461c46e9e176b0448021432ef318e5e`. Ses cinq contrôles
sont réussis, paquets Phone, TV et Windows compris ; le dernier contrôle
Windows s'est terminé à 01:32:14 UTC. Aucun rerun n'est effectué.

Les pages Google Play sont relues entre 02:13 et 02:14 : **Mobile 1.3.32 (46)**
et **TV 3.8.25-hybrid (38)** restent en cours d'examen, sans action demandée.
Leur disponibilité n'est pas encore établie. Aucun bundle réimporté, examen
relancé ou réglage changé.

La maintenance des langues et le suivi Play restent actifs. Aucun déploiement,
changement de code, de modèle, de seuil, de route ou de concurrence n'est
effectué pendant ces audits. Les refus de HIT et les corruptions distantes
restent ouverts.
