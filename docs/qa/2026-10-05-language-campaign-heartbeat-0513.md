# Maintenance des langues — 5 octobre 2026, 05:13 Paris

## Progression comparable

Relevé en lecture seule à 05:14 Paris. Le périmètre reste le manifeste initial
immuable de 56 751 variantes, quatre catalogues du compte initial, entièrement
visible. Ce n'est pas un compteur unique de tous les comptes Norva.

| Mesure | 04:56 Paris | 05:14 Paris | Évolution |
|---|---:|---:|---:|
| Contrôles techniques uniques | 24 102 | 24 443 | +341 |
| Identifiées au compteur historique métadonnées/pistes | 8 163 | 8 240 | +77 |
| Variantes encore inconnues | 48 588 | 48 511 | −77 |
| Fiches encore inconnues | 38 484 | 38 440 | −44 |
| Validations audio strictes complètes | 39 | 39 | 0 |
| Analyses complètes indéterminées compatibles | 78 | 80 | +2 |

Les cinq confirmations humaines sont exclues du compteur historique. Les ensembles
stricts se recoupent et ne s'ajoutent pas aux identifications. Les deux analyses
indéterminées supplémentaires ont terminé naturellement : Dino à 02:58:48 UTC,
MAX OTT à 03:03:20 UTC, six positions supplémentaires chacune et profils actuels
compatibles. Ce sont des analyses complètes sans consensus suffisant.

Le périmètre global demeure de 54 sources et 47 propriétaires. Les 50 sources
de 46 propriétaires hors des sources initiales totalisent 4 555 tentatives et
2 029 identifications en reçus cumulés (+42 / +10 depuis 02:56 UTC), sans décompte
de fichiers uniques. Les priorités restent à 670 indices, 7 136 variantes visibles
et 384 variantes de films connues. Les compteurs sont lus à des instants voisins,
pas dans une transaction globale commune.

## Continuation après déploiement

Du 02:55:17 au 03:14:37 UTC, les deux Edge ont enregistré **14 secondes étapes
terminées avec un checkpoint** (contre quatre au relevé de 03:00:25). Durées
propres entre 12,303 et 26,692 secondes. Quinze secondes étapes ont démarré,
une est sortie sur `worker-stopped` ; deux autres possibilités d'enchaînement ont
été écartées faute de budget temporel. Les protections restent actives.

Le Gateway principal compte 32 captures et 32 inférences réussies sur cette
fenêtre globale, ainsi que six reports de capacité. Ce ne sont pas 32 fichiers
identifiés ni des étapes toutes attribuables aux 14 continuations. Neuf travaux
ont eu une progression fournisseur. Aucun multiplicateur de débit global ni durée
totale par film n'est déduit de ce relevé. Aucun changement de code, modèle,
seuil, quota, route ou concurrence n'est effectué pendant ce contrôle.

## Deux validations complètes vérifiées

- **03:09:37 UTC :** une copie de Norva Selection est validée en espagnol. Sa
  source appartient aux quatre catalogues initiaux, mais la variante est **hors
  manifeste**. Une piste attendue, terminée et documentée ; sept tentatives
  fournisseur. Ne pas l'ajouter aux 39 validations du manifeste à 03:14.
- **03:17:01 UTC :** l'ancien finaliseur Strng reprend naturellement et valide
  l'anglais pour une variante du manifeste. Les huit tentatives fournisseur et
  la dernière capture du 4 octobre à 01:31:35 sont inchangées. Il s'agit de la
  publication de la preuve complète conservée, sans nouvelle capture.

À 03:20 UTC, les deux preuves concordent avec le profil courant, sa date, la
taille, les indices de pistes, le cache, l'identité, la génération et la visibilité.
Le prédicat d'identification est vrai. Aucun rejeu opérateur du finaliseur ni
lecture média n'a été effectué. Les compteurs historiques de 03:14 ne sont pas
réécrits rétroactivement pour incorporer la réussite Strng de 03:17.

Le relevé strict séparé à **05:20:37 Paris** mesure désormais **40 validations
complètes et 80 analyses complètes indéterminées compatibles**. Il confirme le
gain d'une validation du manifeste, sans additionner la copie Selection hors
manifeste ni les cinq confirmations humaines.

## Incident SQL et récupération naturelle

À 03:11:28.509 UTC, l'Edge secondaire journalise `language-finalization`,
`rpc_error`, `57014`, durée 8 003 ms. Les journaux Kong confirment le RPC
`finalize_catalog_file_audio_validation_job` en HTTP 500 à 03:11:28.507, puis
`fail_catalog_file_audio_validation_job` en HTTP 500 à 03:11:28.557 et 03:11:36.511.
L'ancienne analyse Strng reste alors `finalizing` sous son bail normal.

Après expiration naturelle, la reprise de 03:17:01 réussit. À 03:18, aucun
finaliseur n'est actif ou expiré dans l'inventaire observé. Aucune libération
forcée, modification de délai, nouvelle admission ou mutation opérateur.

Le contexte PostgreSQL de l'erreur n'est pas disponible dans les 56 lignes
conservées pour cette fenêtre. La cause exacte (requête coûteuse ou attente de
verrou) reste inconnue. Le code montre que finalisation et enregistrement du
report passent par une publication commune, mais cela ne prouve pas son rôle
causal ici. En cas de récidive, observer le type d'attente et les bloqueurs pendant
une exécution naturelle ; ne pas rejouer une écriture ni relever les délais sur
supposition. L'incident et les précédents restent conservés malgré la récupération.

## Six copies prioritaires et confirmations humaines

Les états comparés à 03:14:59 sont inchangés depuis 02:57 : Bolt reste anglais
validé ; Lost et Ochi restent incomplets/indisponibles, Mars en quarantaine.
Leurs reçus et délais sont conservés. Les cinq confirmations humaines sont
toutes projetables : anglais pour quatre copies, espagnol pour une.

Le diagnostic historique Mars retrouve quatre absences consécutives de progression
et, dans les journaux Gateway de 02:24 à 02:55, quatre
`LID_CAPTURE_EXTRACTION_TIMEOUT` de 165 à 167,517 secondes, drainage attesté.
Le dernier précède de six millisecondes sa quarantaine. Les diagnostics sont
anonymes : l'attribution individuelle des quatre événements à Mars et la cause
interne de l'extraction ne sont pas établies. Aucun statut HTTP amont n'est fourni.
Les délais jusqu'au 6 octobre sont respectés, aucun marqueur consommé rejoué.

## Santé, publication Android et suivi

Les deux Gateways et les deux Edge sont sains, avec les mêmes dates de démarrage
et empreintes que le déploiement d'accélération. Cron strict, admission et
dispatcher permanent actifs. Les cinq HTTP cumulés du dispatcher n'augmentent
pas ; cet indicateur ne compte pas l'incident du finaliseur décrit ci-dessus.

Google Play relu dans le navigateur vers 03:15 UTC : Mobile 46 et TV 38 sont
toujours en examen, sans action demandée et sans disponibilité prouvée. Aucun
bundle réimporté ni examen relancé. Les cinq contrôles de la PR documentaire 655
réussissent maintenant, paquets Android et Windows inclus.

La campagne permanente et le suivi Play restent actifs. Aucun déploiement ni
appel média fournisseur opérateur pendant ce contrôle. Reçus agrégés sûrs sous
`.codex-artifacts/language-heartbeat-0513/` ; aucun secret, identifiant de compte,
URL fournisseur ou transcript publié.
