# Maintenance des langues — 5 octobre 2026, 06:14 Paris

## Progression comparable

Relevé en lecture seule à **06:15 Paris**. Le manifeste initial reste entièrement
visible : 56 751 variantes de quatre catalogues du compte initial, 43 125 fiches.
Ce périmètre ne représente pas tous les comptes Norva.

| Mesure | 05:14 Paris | 06:15 Paris | Évolution |
|---|---:|---:|---:|
| Contrôles techniques uniques | 24 443 | 25 261 | +818 |
| Identifiées au compteur historique métadonnées/pistes | 8 240 | 8 484 | +244 |
| Variantes encore inconnues | 48 511 | 48 267 | −244 |
| Fiches encore inconnues | 38 440 | 38 344 | −96 |

Le relevé strict passe de **40 validations complètes / 80 indéterminées
compatibles à 05:20:37 Paris** à **41 / 81 à 06:15:36 Paris**. La nouvelle analyse
complète indéterminée MAX OTT termine à 04:00:18.542 UTC. Une analyse sans
consensus suffisant n'est pas une langue identifiée. Les ensembles stricts se
recoupent et ne s'ajoutent pas au compteur historique. Les cinq confirmations
humaines restent comptées séparément.

Le périmètre global demeure à 54 sources / 47 propriétaires. Les 50 sources de
46 propriétaires hors des sources initiales totalisent **5 244 tentatives et
2 395 identifications en reçus cumulés**, soit +689 / +366 depuis le relevé
précédent. Ce ne sont pas des fichiers uniques. Les priorités restent à 670
indices et 7 136 variantes visibles ; les variantes de films connues passent de
384 à 385. Les différents audits sont des snapshots voisins, pas une transaction
globale commune.

## Trois nouvelles validations audio complètes

Preuves relues à 04:16:23 UTC :

| Validation UTC | Langue | Périmètre |
|---|---|---|
| 03:30:18.734 | Espagnol | Hors sources et manifeste initiaux |
| 03:38:47.456 | Espagnol | Hors sources et manifeste initiaux |
| 03:56:25.393 | Anglais | MAX OTT, variante du manifeste initial |

Chacune possède une piste attendue, terminée et documentée, et six tentatives
fournisseur. Profil courant, date, taille, indices audio, cache, empreinte,
identité, génération et visibilité concordent ; le prédicat d'identification
est vrai. Les deux copies hors manifeste ne sont pas ajoutées aux 41 validations
du manifeste. L'ancien finaliseur Strng demeure validé ; sa récupération du
relevé précédent n'est pas recomptée comme un nouveau résultat.

## Accélération réellement observée

Dans la fenêtre **03:20–04:15 UTC**, 36 secondes étapes séquentielles ont terminé
avec un checkpoint durable : 17 sur l'Edge principal, 19 sur le secondaire.
Durées propres de **10,098 à 26,634 secondes**, issues du `elapsedMs` attaché à
chaque résultat. Sur 37 démarrages, un s'est arrêté avec `worker-stopped`.
Huit autres possibilités ont été écartées par la sélection et quatre par le
budget temporel. Les gardes continuent donc à interrompre l'enchaînement.

Le Gateway principal enregistre 95 captures et 95 inférences réussies dans cette
fenêtre globale, 12 reports de capacité, un `LID_CAPTURE_DURATION_INVALID` et un
`STRICT_LID_AUDIO_INVALID_DATA`. Vingt-quatre travaux ont progressé. Ces étapes
ne représentent pas 95 fichiers identifiés et ne sont pas toutes attribuables
aux continuations. Aucun multiplicateur de débit global ni temps par film n'est
déduit. Le bénéfice de la garde entre comptes distincts reste à observer lors
d'une pré-génération concurrente effective.

## Incidents et limites du diagnostic

Deux nouveaux diagnostics SQL `57014` sont observés à **03:26:11.016 UTC** sur
l'Edge secondaire et **03:26:13.158 UTC** sur le principal. Le premier voisine un
HTTP 500 `audio-backfill` à 03:26:11.020 ; le second voisine
`claim_catalog_provider_audio_metadata` HTTP 500 à 03:26:13.148 puis l'erreur
dispatcher metadata à 03:26:13.163. Le compteur historique du dispatcher passe
de cinq à six HTTP en erreur ; il ne couvre pas tous les appels Edge/RPC.

Deux appels `fail_catalog_file_audio_validation_job` ont aussi retourné HTTP 500
à **03:22:08.524** et **04:11:28.673 UTC**. Leur code SQL et leur cause ne sont pas
établis ; ils ne sont pas confondus avec les deux diagnostics `57014`. Aucun
nouveau diagnostic `language-finalization` dans cette fenêtre. Aucun RPC
d'écriture n'est rejoué pour le diagnostic. Les incidents historiques restent
conservés malgré la santé des services et les validations réussies.

Une observation PostgreSQL bornée suit les appels naturels entre **04:20:31 et
04:21:35 UTC** : 60 relevés sur 63,068 secondes, aucun timeout du lecteur. Le
claim metadata est aperçu actif cinq fois, âge maximal 2,322 secondes, aucun
bloqueur et `wait_event_type` / `wait_event` nuls à ces instants. Aucun appel
finalize/fail n'est intercepté, et aucun finaliseur durable n'est présent au
contrôle final. Un travail strict reste en cours sous bail valide jusqu'à 04:24 ;
63 secondes sans changement ne suffisent pas à établir un blocage. Ces snapshots
ne reconstituent pas les attentes passées : la cause des erreurs de 03:26 et les
codes des deux échecs du RPC de report restent inconnus. Aucun délai, bail ou
timeout de production n'est modifié.

## Cibles et exploitation

À 04:15:37 UTC, Lost, Ochi et Mars gardent leurs états incomplets, comptes de
reçus, profils, tentatives et délais jusqu'au 6 octobre. Cet audit compare les
faits persistés et les comptes de reçus ; il ne prétend pas comparer leurs octets.
Bolt reste validé en anglais. Les cinq confirmations humaines restent
projectables (quatre anglais, une espagnol). Aucune nouvelle admission, relance
terminale ou propagation à d'autres variantes.

Les deux Gateways, les deux Edge, le cron strict, l'admission et le dispatcher
permanent sont sains/actifs. Un bail strict est présent au snapshot global ; ce
n'est pas un compte fournisseur déclaré libre. Aucun code, modèle, seuil,
concurrence, délai, quarantaine ou déploiement n'est changé pendant ce contrôle.

Google Play relu dans le navigateur vers 04:18 UTC : Mobile 46 et TV 38
restent en examen, sans action demandée ni disponibilité prouvée. Aucun upload,
réexamen ou réglage modifié. Les cinq checks de la PR documentaire 656 réussissent
désormais, paquets compris. La maintenance permanente et le suivi Play restent
actifs.

Reçus agrégés sûrs sous `.codex-artifacts/language-heartbeat-0614/`. Aucun appel
média fournisseur opérateur, POST ou mutation de production durant ces audits.
