# Maintenance des langues — 5 octobre 2026, 07:15 Paris

## Progression du manifeste initial

À **07:16 Paris**, les 56 751 variantes du manifeste initial restent visibles.
Ce périmètre immuable porte sur quatre catalogues du compte initial et 43 125
fiches ; il ne représente pas tous les comptes Norva.

| Mesure | 06:15 Paris | 07:16 Paris | Évolution |
|---|---:|---:|---:|
| Contrôles techniques uniques | 25 261 | 25 536 | +275 |
| Identifications historiques métadonnées/pistes | 8 484 | 8 555 | +71 |
| Variantes encore inconnues | 48 267 | 48 196 | −71 |
| Fiches encore inconnues | 38 344 | 38 289 | −55 |
| Validations audio strictes complètes | 41 | 43 | +2 |
| Analyses complètes indéterminées compatibles | 81 | 84 | +3 |

Les identifications historiques excluent les cinq confirmations humaines. Les
ensembles stricts se recoupent et ne s'ajoutent pas au compteur historique. Une
analyse complète indéterminée ne constitue pas une langue identifiée.
Les trois ajouts compatibles ont six reçus sur six positions : Selection à
04:18:22 et 05:09:24 UTC, puis MAX à 05:15:47 UTC, profils actuels concordants.

Le périmètre global reste de 54 sources / 47 propriétaires. Les 50 sources de
46 propriétaires hors des sources initiales totalisent 5 914 tentatives et
2 699 identifications en reçus cumulés (+670 / +304). Ces nombres ne décomptent
pas des fichiers uniques. Les priorités restent à 670 indices, 7 136 variantes
visibles et 385 variantes de films connues. Les audits sont des snapshots voisins.

## Trois nouvelles validations audio

Les preuves suivantes sont relues à 05:16:10 UTC :

| Validation UTC | Langue | Périmètre |
|---|---|---|
| 04:29:09.297 | Français | Hors sources et manifeste initiaux |
| 04:57:53.785 | Anglais | Strng, variante du manifeste initial |
| 05:05:53.178 | Chinois (`zh`) | Strng, variante du manifeste initial |

Chaque travail possède une piste attendue, terminée et documentée, et six
tentatives fournisseur. Profil courant, date, taille, indices audio, cache,
empreinte, identité, génération et visibilité concordent. Le prédicat
d'identification est vrai. La copie française hors manifeste n'est pas ajoutée
aux 43 validations du manifeste. Le code `zh` n'établit pas une variété parlée
plus précise. L'ancien finaliseur Strng reste résolu et n'est pas recompté.

## Continuations et limites du débit observé

Dans la fenêtre **04:15–05:15 UTC**, 29 secondes étapes ont enregistré un
checkpoint durable : dix sur le principal, dix-neuf sur le secondaire. Durées
propres de 10,695 à 72,132 secondes. Sur 44 démarrages, quinze sorties portent
`worker-stopped` ; onze autres possibilités sont écartées par le budget et trois
par la sélection. Les fenêtres de logs ne sont pas tronquées.

`worker-stopped` signifie que la seconde invocation n'a pas retourné un
checkpoint de fenêtre. Ce libellé regroupe plusieurs retours du worker et ne
prouve ni un redémarrage du service, ni une panne, ni une cause précise.
Les quinze invocations concernées durent entre 12 ms et 3,382 secondes. Neuf
voisinent un diagnostic de capacité, deux un `PROVIDER_FETCH_FAILED`, quatre
aucun diagnostic adjacent. Les journaux anonymes ne permettent pas d'attribuer
ces causes individuellement. Les quatre timeouts d'extraction de 166–168 secondes
sont hors de ces intervalles courts. Aucune régression n'est démontrée.
Le compteur de démarrages signifie une entrée dans le worker, pas nécessairement
une nouvelle capture fournisseur. Certaines continuations réussies dépassent
une minute : elles n'attendent pas le cycle suivant pour commencer, mais ne
terminent pas toutes avant ce cycle.

Le Gateway principal compte globalement 94 captures et 94 inférences réussies,
quatre `LID_CAPTURE_EXTRACTION_TIMEOUT`, deux `PROVIDER_FETCH_FAILED` et onze
reports de capacité. Vingt-six travaux ont progressé. Ces totaux ne sont pas
attribués individuellement aux continuations et ne représentent pas 94 langues
identifiées. Le nombre d'identifications historiques augmente moins vite que
lors de l'heure précédente ; les tâches, sources et temps d'extraction diffèrent.
Aucun multiplicateur de débit global ni cause unique de cette variation n'est
établi par ces snapshots.

## Incidents préservés

Un nouveau diagnostic SQL `57014` est observé à **05:15:14.132 UTC**, voisin de
`claim_catalog_provider_audio_metadata` HTTP 500 à 05:15:14.119 puis de l'erreur
dispatcher metadata à 05:15:14.136. Un autre
`fail_catalog_file_audio_validation_job` retourne HTTP 500 à **04:21:55.090 UTC** ;
son code SQL et sa cause restent inconnus et ne sont pas confondus avec le
diagnostic de 05:15. Les incidents des relevés précédents restent conservés.
Le compteur historique du dispatcher passe de six à sept erreurs HTTP, sans
couvrir les échecs de tous les autres RPC. Aucun nouveau diagnostic de
finalisation dans cette fenêtre, aucun RPC d'écriture rejoué pour le diagnostic.

Une nouvelle quarantaine MAX à **04:44:07 UTC** porte sur un autre travail
partiellement capturé ; ce n'est pas une analyse complète. Le nombre de travaux
MAX en quarantaine passe de trois à quatre. Aucune cause interne n'est attribuée
sur la seule base de cette transition, aucun délai ni bail n'est forcé.
Le travail conserve un reçu sur six positions, cinq tentatives fournisseur et
un profil concordant ; report normal jusqu'au 6 octobre à 04:44:07 UTC.

Deux autres reports Dino sont observés : `GATEWAY_ERROR` à 05:06:15 avec cinq
reçus / huit tentatives fournisseur, et `CHECKPOINT_RESET_REQUIRED` à 04:44:09
avec zéro reçu / sept tentatives. Leur cause précise reste non établie. Aucun
report ni reset de checkpoint n'est compté comme une identification ou une
analyse complète.

## Cibles et exploitation

À 05:16:06 UTC, Bolt reste anglais vérifié. Lost, Ochi et Mars conservent leurs
états incomplets, comptes de reçus, profils, tentatives et délais jusqu'au
6 octobre. Les cinq confirmations humaines restent projectables (quatre anglais,
une espagnol). La comparaison porte sur les faits persistés et comptes de reçus,
pas sur leurs octets. Aucune nouvelle admission ou relance de ces copies.

Google Play relu vers 05:17 UTC : Mobile 46 et TV 38 restent en examen, sans
action demandée ni disponibilité prouvée. Aucun bundle réimporté, examen relancé
ou réglage modifié. Les cinq checks de la PR documentaire 657 réussissent,
paquets Android et Windows compris.

Cette vérification ne change aucun code, déploiement, modèle, seuil, concurrence,
route, délai ou quarantaine. Aucun appel média fournisseur opérateur ni POST
d'admission. Deux Gateways et deux Edge sains ; cron, admission et dispatcher
actifs. Les baux ordinaires et l'appel dispatcher en vol au snapshot sont
préservés. La maintenance permanente et le suivi Play restent actifs. Reçus
agrégés sûrs sous `.codex-artifacts/language-heartbeat-0715/`.
