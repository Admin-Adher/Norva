# Accélération de la détection des langues — 5 octobre 2026

## Demande et mesure initiale

Adrien demande explicitement d'accélérer la détection et de mettre les solutions en place.
La maintenance permanente concerne tous les comptes éligibles. Le tableau comparable
ci-dessous concerne seulement le manifeste initial immuable, 56 751 variantes de quatre
catalogues du compte contrôlé ; il exclut les cinq confirmations humaines.

| Mesure | 03:08 Paris | 04:09 Paris | Évolution |
|---|---:|---:|---:|
| Contrôles techniques uniques | 22 540 | 23 487 | +947 |
| Variantes identifiées, compteur historique métadonnées/pistes | 7 781 | 8 033 | +252 |
| Variantes encore inconnues | 48 970 | 48 718 | −252 |
| Validations audio strictes complètes | 38 | 39 | +1 |
| Analyses complètes indéterminées compatibles | 78 | 78 | 0 |

Les ensembles stricts se recoupent et ne s'ajoutent pas aux autres lignes. Le total des
fiches inconnues à 04:09 est de 38 543. Les reçus hors manifeste ne sont pas des fichiers
uniques. Voir le relevé `2026-10-05-language-campaign-heartbeat-0412.md`.

## Goulots mesurés

### Attente entre fenêtres audio

Entre 00:30 et 02:19 UTC, 72 captures réussies présentent une médiane de 11,578 s
(p90 25,192 s), et 70 inférences une médiane de 3,193 s (p90 5,420 s). Ces populations
sont distinctes : leur addition décrit un ordre de grandeur, pas une médiane combinée.
Le checkpoint durable remet le travail en file immédiatement ; le cron ordinaire
ne repasse qu'une fois par minute. Une acquisition rapide peut donc attendre le
passage suivant alors qu'elle est déjà admissible.

Bolt a été validé en 25 min 23,660 s, avec sept tentatives fournisseur et 21 claims.
Des reports d'occupation du compte sont documentés : ce délai entier ne peut pas
être attribué au cron ni être promis comme gain du correctif.

### Garde de sous-titres étendue à tout un propriétaire

L'audit 01:00–02:22 UTC compte 493 reports `pregen-active`. Pour 165 d'entre eux,
la source visée utilise un compte fournisseur distinct de toutes les lignes de
sous-titres actives du même propriétaire, après résolution interne des identités
et affinités. La garde historique bloquait pourtant tous les comptes de ce propriétaire.
Les deux Gateways étaient libres au relevé de 02:18:50. Les lignes observées avaient
été mises à jour à 00:25–00:29 ; leur expiration naturelle à deux heures doit être
séparée de tout effet du nouveau code.

## Corrections

- Au plus deux étapes audio successives dans le même budget global de 270 s.
  La seconde exige un checkpoint durable incomplet, au moins 240 s restantes,
  et la sélection ordinaire du même travail comme premier admissible. Chaque
  étape reprend les contrôles de capacité, profil, visibilité, circuit, activité,
  claim et baux. Toute erreur, fin, report ou priorité concurrente arrête la suite.
- Garde de sous-titres ciblée sur le compte fournisseur exact pour les traitements
  automatiques de langues des sources Xtream. Les sources M3U conservent leur
  garde historique par propriétaire, sans déduction d’un compte unique. Une réponse SQL explicitement fausse est nécessaire
  pour continuer ; erreurs, correspondances pertinentes inconnues ou ambiguës
  restent bloquantes. Les gardes et claims existants restent obligatoires.

Modèle, seuils, quatre fenêtres qualifiées, plan d'échantillonnage, réserves,
limites de concurrence, TTL, reports et quarantaines sont conservés. Le cron
reste à une minute pour la récupération. Aucun second dispatcher.

## Mars : reprise du chemin exact

À 02:18:40 UTC, le lecteur de garde réellement utilisé par les profils indique le
compte disponible ; seul le lecteur destiné à la validation vocale demeure bloqué
par une activité metadata récente. Une demande exacte de profil est envoyée une fois :
HTTP 200 à 02:19:52, une tentative et un profil persisté. Le profil et son cache
concordent, piste 1, aucune identification automatique.

Après prélecture favorable, un unique POST manuel ordinaire de validation est admis
à 02:24:47 UTC (HTTP 202, passage 0). À 02:29:21, deux reçus sont présents et une
troisième tentative fournisseur est en cours. Une admission ou un profil n'est pas
une langue identifiée. Les deux marqueurs opérateur sont consommés et ne sont pas rejoués.

Bolt reste anglais validé automatiquement ; Innocent Voices espagnol et Prey anglais
sont établis humainement. Lost et Ochi conservent leur échec incomplet et leur délai
jusqu'au 6 octobre à 01:14/01:17 UTC ; aucune relance de ces copies.

## Incident distinct conservé

Trois diagnostics SQL57014 sont observés sur l'Edge principal à 02:18:10.260,
02:18:10.280 et 02:18:12.866 UTC. Les deux premiers sont voisins de réponses
audio-backfill HTTP500, le troisième d'un HTTP500 provider-metadata du dispatcher.
Cette corrélation ne désigne pas la requête SQL ni sa cause. Les statistiques
cumulées SQL ne permettent pas cette attribution. Aucun correctif spéculatif.

## État de livraison

83 tests de continuation/capture/contrats passent, ainsi que 37 tests ciblés du parcours
automatique (groupes recoupés). La nouvelle garde réussit 52 assertions SQL sur un
PostgreSQL isolé sans réseau ni données clients ; conteneur de preuve supprimé.
La revue indépendante du flux confirme les gardes et la borne temporelle.
PR 654 intégrée par `6d01dfb922be37cc7acfb4289e7f0682a9cd7853`.
Code `171eb5885f598edda0df1c219d1e6f637ffa2cbf`, migration finale et contrats
`ff80df66eb284bde398edfefa8d310af06e8db95`, tête `7486e3aa8`.
Les douze contrôles de cette tête sont réussis, paquets Android et Windows inclus.
La suite Linux complète compte 5 940 tests : 5 913 réussis, 27 ignorés, zéro échec.
Aucun nouveau bundle Google Play ni changement de version applicative.

Reçus privés et agrégats sûrs : `.codex-artifacts/language-throughput-20261005/`
et `.codex-artifacts/language-speed-audit-20261005/`. Aucun identifiant, URL
fournisseur, transcript, secret ou octet audio n'est publié dans ce rapport.

## Régression évitée avant déploiement

Le premier benchmark en transaction annulée retrouvait 44 sources bloquées sur 54,
sans aucune pré-génération fraîche. Il s’agissait des 44 sources M3U sans affinité
Xtream, dont 38 déjà présentes dans l’intake. Ce n’était pas une source inéligible.
La première version n’a jamais été appliquée : M3U conserve maintenant exactement
la garde propriétaire historique ; l’optimisation de compte est limitée à Xtream.
Les preuves SQL passent de 44 à 52 assertions. L’ancien benchmark reste conservé.

Le benchmark final à 02:48:31 UTC parcourt les 54 sources : aucune bloquée dans
ce snapshot sans pré-génération fraîche, total 79,096 ms, maximum 2,414 ms par
source. Rollback vérifié ; 1 305 anciennes fonctions/procédures et leurs ACL,
preuves humaines, travaux et affinités restent identiques dans le même snapshot.

Le premier contrôle cloud du code 171eb5885 échoue sur une assertion textuelle
MKV qui attendait trois arguments au lieu des quatre du contrôle désormais lié à
la source. Les deux assertions conservent le contrôle avant/après claim et sont
actualisées ; sept tests MKV passent. La suite Windows locale a aussi rencontré
quatre échecs d’environnement (Git attendu sous Program Files absent, Bash absent) ;
ces fichiers ne sont pas modifiés. La suite Linux cloud sert de contrôle complet.

## Déploiement vérifié à 04:55 Paris

La migration `20261005043000_source_account_pregen_guard` est appliquée à
02:53:59.843 UTC, SHA-256 `56fe12a45fd3cbeacb5ddeafb0c4dfcbeaaa21c7e93c2a6b149b42afb14dd56d`.
Les 1 305 anciennes fonctions/procédures, ACL et faits comparés dans la même
transaction sont inchangés ; aucune écriture de donnée client. La nouvelle RPC
est réservée au rôle service et répond HTTP 200 via PostgREST à 02:54:45.
Le premier contrôle HTTP avait utilisé un nom DNS Docker depuis l'hôte ; son
échec de résolution est corrigé uniquement dans l'opérateur de vérification.

Les deux Edge sont recréés à 02:55:09 et 02:55:13 UTC avec le runtime
`/home/adrien/.norva/language-throughput-20261005/edge/runtime-functions` :

- `norva-playback/index.ts` : SHA-256 `bb6c34ff53c1ba81da6bdf9a8c7133b1eb6e80accf22e05e883c8bc6b1d59717` ;
- nouveau helper `_shared/source-account-pregen-guard.mjs` : `1dea7f468e776f6d3312725e25790f20c78f7ead9c9d53c5c3dd5d8b3667dde8` ;
- les 192 autres fichiers et leurs permissions sont conservés, 194 empreintes vérifiées.

Le canary de santé Edge est réussi puis arrêté ; son réseau est le réseau Edge
normal, aucun média fournisseur n'est demandé. Les admissions sont suspendues
de 02:54:57.375 à 02:55:17.259 UTC, soit **19,883 s**, avec drainage naturel,
sans bail forcé. Crons, admission et worker sont restaurés ; le même dispatcher
reste actif. Deux Edge et deux Gateways sains à 02:55:45 ; les Gateways et leur
image `sha256:d378abf26bbbe0f2ec25af3eec7f75c24a9b4fc459109786d532892c9c5170dc`
sont inchangés. Ne pas restaurer un ancien runtime Edge.

## Accélération réellement observée

Lecture seule entre 02:55:17 et 03:00:25 UTC, sans admission opérateur : **quatre
deuxièmes étapes ont persisté une nouvelle fenêtre** dans la même exécution.
Leurs durées propres sont 26,568 / 23,741 / 23,018 / 12,303 secondes. Elles
n'attendent donc plus le prochain réveil du cron après leur premier checkpoint.
Ces durées viennent du résultat de chaque étape, sans rapprochement supposé
entre requêtes concurrentes. Un autre enchaînement est encore en cours au relevé.

Un report pour budget temporel et un arrêt du worker restent observés : le
correctif conserve ces sorties. Sur la même fenêtre, le Gateway compte douze
captures et onze inférences réussies, concernant l'ensemble des travaux actifs ;
ces totaux ne sont pas tous attribuables aux quatre continuations. Deux travaux
stricts ont progressé, aucune nouvelle validation finale dans cette fenêtre.
Un checkpoint supplémentaire ne signifie pas une langue publiée. Aucun
multiplicateur de débit global ni durée totale par film n'est encore établi.

L'effet de la nouvelle garde de compte est prouvé par les fixtures SQL et le
chemin API. Aucune nouvelle pré-génération concurrente de comptes distincts n'a
encore été observée après déploiement pour mesurer son gain réel. La disparition
des trois anciennes lignes avait déjà suivi leur expiration normale.

## Chiffres comparables à 04:56 Paris

Même manifeste initial de 56 751 variantes, toujours intégralement visible :

| Mesure | 04:09 Paris | 04:56 Paris | Évolution |
|---|---:|---:|---:|
| Contrôles techniques uniques | 23 487 | 24 102 | +615 |
| Identifiées au compteur historique métadonnées/pistes | 8 033 | 8 163 | +130 |
| Variantes encore inconnues | 48 718 | 48 588 | −130 |
| Validations audio strictes complètes | 39 | 39 | 0 |
| Analyses complètes indéterminées compatibles | 78 | 78 | 0 |

38 484 fiches restent inconnues. Les cinq confirmations humaines sont exclues de
ce compteur et restent toutes projetables (quatre en, une es). Le gain ci-dessus
couvre surtout la période avant déploiement et ne mesure pas l'effet du correctif.
Le périmètre global demeure 54 sources et 47 propriétaires. Hors manifeste :
50 sources, 46 propriétaires, 4 513 tentatives et 2 019 identifications en reçus
cumulés (+298 / +158 depuis 02:13), sans décompte de fichiers uniques.

## Limites et suite permanente

Mars a obtenu son profil et deux reçus authentifiés, dont une fenêtre anglaise
qualifiée ; il en faut quatre. Son travail a terminé `NO_PROGRESS_QUARANTINED`
à 02:54:47 UTC, **avant les nouveaux Edge**, avec six tentatives fournisseur,
dernière progression à 02:26:58. Le délai jusqu'au 6 octobre à 02:54:47 reste
intact. Aucune langue n'est publiée pour cette copie et aucun nouvel essai n'est
effectué. Les deux marqueurs de profil/admission restent consommés. L'origine
de l'absence de progression n'est pas attribuée à la nouvelle garde SQL.

Trois des six copies prioritaires ont une langue publiée : Innocent Voices es et
Prey en par confirmation humaine, Bolt en par validation automatique. Lost et
Ochi restent incomplets/indisponibles, Mars en quarantaine. Leurs preuves et
délais sont conservés. HIT et les corruptions distantes restent ouverts.

L'incident SQL57014 de 02:18 est antérieur au déploiement. Zéro nouvel incident
dans les courts journaux recréés à 02:55 n'efface pas l'historique. La maintenance
permanente, les protections de lecture et le suivi Play restent actifs.
