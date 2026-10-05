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
L’intégration et le déploiement restent à vérifier à cette étape.

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
