# AccÃ©lÃ©ration de la dÃ©tection des langues â€” 5 octobre 2026

## Demande et mesure initiale

Adrien demande explicitement d'accÃ©lÃ©rer la dÃ©tection et de mettre les solutions en place.
La maintenance permanente concerne tous les comptes Ã©ligibles. Le tableau comparable
ci-dessous concerne seulement le manifeste initial immuable, 56 751 variantes de quatre
catalogues du compte contrÃ´lÃ© ; il exclut les cinq confirmations humaines.

| Mesure | 03:08 Paris | 04:09 Paris | Ã‰volution |
|---|---:|---:|---:|
| ContrÃ´les techniques uniques | 22 540 | 23 487 | +947 |
| Variantes identifiÃ©es, compteur historique mÃ©tadonnÃ©es/pistes | 7 781 | 8 033 | +252 |
| Variantes encore inconnues | 48 970 | 48 718 | âˆ’252 |
| Validations audio strictes complÃ¨tes | 38 | 39 | +1 |
| Analyses complÃ¨tes indÃ©terminÃ©es compatibles | 78 | 78 | 0 |

Les ensembles stricts se recoupent et ne s'ajoutent pas aux autres lignes. Le total des
fiches inconnues Ã  04:09 est de 38 543. Les reÃ§us hors manifeste ne sont pas des fichiers
uniques. Voir le relevÃ© `2026-10-05-language-campaign-heartbeat-0412.md`.

## Goulots mesurÃ©s

### Attente entre fenÃªtres audio

Entre 00:30 et 02:19 UTC, 72 captures rÃ©ussies prÃ©sentent une mÃ©diane de 11,578 s
(p90 25,192 s), et 70 infÃ©rences une mÃ©diane de 3,193 s (p90 5,420 s). Ces populations
sont distinctes : leur addition dÃ©crit un ordre de grandeur, pas une mÃ©diane combinÃ©e.
Le checkpoint durable remet le travail en file immÃ©diatement ; le cron ordinaire
ne repasse qu'une fois par minute. Une acquisition rapide peut donc attendre le
passage suivant alors qu'elle est dÃ©jÃ  admissible.

Bolt a Ã©tÃ© validÃ© en 25 min 23,660 s, avec sept tentatives fournisseur et 21 claims.
Des reports d'occupation du compte sont documentÃ©s : ce dÃ©lai entier ne peut pas
Ãªtre attribuÃ© au cron ni Ãªtre promis comme gain du correctif.

### Garde de sous-titres Ã©tendue Ã  tout un propriÃ©taire

L'audit 01:00â€“02:22 UTC compte 493 reports `pregen-active`. Pour 165 d'entre eux,
la source visÃ©e utilise un compte fournisseur distinct de toutes les lignes de
sous-titres actives du mÃªme propriÃ©taire, aprÃ¨s rÃ©solution interne des identitÃ©s
et affinitÃ©s. La garde historique bloquait pourtant tous les comptes de ce propriÃ©taire.
Les deux Gateways Ã©taient libres au relevÃ© de 02:18:50. Les lignes observÃ©es avaient
Ã©tÃ© mises Ã  jour Ã  00:25â€“00:29 ; leur expiration naturelle Ã  deux heures doit Ãªtre
sÃ©parÃ©e de tout effet du nouveau code.

## Corrections

- Au plus deux Ã©tapes audio successives dans le mÃªme budget global de 270 s.
  La seconde exige un checkpoint durable incomplet, au moins 240 s restantes,
  et la sÃ©lection ordinaire du mÃªme travail comme premier admissible. Chaque
  Ã©tape reprend les contrÃ´les de capacitÃ©, profil, visibilitÃ©, circuit, activitÃ©,
  claim et baux. Toute erreur, fin, report ou prioritÃ© concurrente arrÃªte la suite.
- Garde de sous-titres ciblÃ©e sur le compte fournisseur exact pour les traitements
  automatiques de langues. Une rÃ©ponse SQL explicitement fausse est nÃ©cessaire
  pour continuer ; erreurs, correspondances pertinentes inconnues ou ambiguÃ«s
  restent bloquantes. Les gardes et claims existants restent obligatoires.

ModÃ¨le, seuils, quatre fenÃªtres qualifiÃ©es, plan d'Ã©chantillonnage, rÃ©serves,
limites de concurrence, TTL, reports et quarantaines sont conservÃ©s. Le cron
reste Ã  une minute pour la rÃ©cupÃ©ration. Aucun second dispatcher.

## Mars : reprise du chemin exact

Ã€ 02:18:40 UTC, le lecteur de garde rÃ©ellement utilisÃ© par les profils indique le
compte disponible ; seul le lecteur destinÃ© Ã  la validation vocale demeure bloquÃ©
par une activitÃ© metadata rÃ©cente. Une demande exacte de profil est envoyÃ©e une fois :
HTTP 200 Ã  02:19:52, une tentative et un profil persistÃ©. Le profil et son cache
concordent, piste 1, aucune identification automatique.

AprÃ¨s prÃ©lecture favorable, un unique POST manuel ordinaire de validation est admis
Ã  02:24:47 UTC (HTTP 202, passage 0). Ã€ 02:29:21, deux reÃ§us sont prÃ©sents et une
troisiÃ¨me tentative fournisseur est en cours. Une admission ou un profil n'est pas
une langue identifiÃ©e. Les deux marqueurs opÃ©rateur sont consommÃ©s et ne sont pas rejouÃ©s.

Bolt reste anglais validÃ© automatiquement ; Innocent Voices espagnol et Prey anglais
sont Ã©tablis humainement. Lost et Ochi conservent leur Ã©chec incomplet et leur dÃ©lai
jusqu'au 6 octobre Ã  01:14/01:17 UTC ; aucune relance de ces copies.

## Incident distinct conservÃ©

Trois diagnostics SQL57014 sont observÃ©s sur l'Edge principal Ã  02:18:10.260,
02:18:10.280 et 02:18:12.866 UTC. Les deux premiers sont voisins de rÃ©ponses
audio-backfill HTTP500, le troisiÃ¨me d'un HTTP500 provider-metadata du dispatcher.
Cette corrÃ©lation ne dÃ©signe pas la requÃªte SQL ni sa cause. Les statistiques
cumulÃ©es SQL ne permettent pas cette attribution. Aucun correctif spÃ©culatif.

## Ã‰tat de livraison

Correctifs et preuves en cours de vÃ©rification. Cette section sera remplacÃ©e par
les rÃ©sultats de tests, d'intÃ©gration, de dÃ©ploiement et d'observation rÃ©els.

ReÃ§us privÃ©s et agrÃ©gats sÃ»rs : `.codex-artifacts/language-throughput-20261005/`
et `.codex-artifacts/language-speed-audit-20261005/`. Aucun identifiant, URL
fournisseur, transcript, secret ou octet audio n'est publiÃ© dans ce rapport.
