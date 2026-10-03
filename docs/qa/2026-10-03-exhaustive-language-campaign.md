# Campagne exhaustive des langues audio — 3 octobre 2026

## État : EN COURS

La demande couvre tous les films encore classés sans langue sur les quatre catalogues du compte contrôlé, pas un nouvel échantillon de 81 ou 100 fichiers. Une campagne durable tourne sur Hetzner. Son lancement ne constitue pas une validation de 100 % des fichiers.

## Cohorte initiale, figée à 16:24 UTC

| Catalogue | Versions sans langue |
| --- | ---: |
| Strng IPTV 8K | 30 194 |
| Norva Selection | 183 |
| Dino | 8 869 |
| MAX OTT | 17 505 |
| **Total** | **56 751** |

Ces versions représentent **43 125 fiches distinctes**. Les compteurs de fiches par source se recoupent et ne doivent pas être additionnés. Le manifeste privé contient les identités exactes et les générations ; il ne contient ni identifiant fournisseur ni URL média. Son empreinte SHA-256 est `50ff7771995554415b032f06a48d9a39678386eeba6277da3a4447fe920a2a79`.

## Traitement durable

- Conteneur `norva-language-campaign`, réseau interne `norva_default`, redémarrage automatique, état persistant atomique.
- Une requête d’admission à la fois pour cette campagne. Les contrôles distribués de capacité, de propriétaire, de génération, d’abonnement fournisseur et de priorité aux lectures restent ceux de la production.
- Métadonnées techniques fournisseur, puis profil exact et analyse stricte lorsque nécessaire. Aucune langue n’est déduite arbitrairement d’un sous-titre, d’un pays ou du titre d’une œuvre.
- Les captures strictes utilisent la file normale, avec ses quarantaines, certificats, seuils de consensus et limites par fournisseur. Les anciens échecs ne sont pas effacés.
- Les sondes opaques ffprobe réservent le réseau exclusivement. La campagne ménage donc un intervalle autour d’un déclenchement cron sur deux ; elle diffère aussi les admissions quand la file d’analyse est pleine. Cela évite que les nouvelles sondes privent continuellement les analyses déjà en attente de connexion.
- Les compteurs `processed`, `attempted` et `scanned` du dispatcher sont des opérations, éventuellement répétées. **Ils ne mesurent pas le nombre de fichiers uniques examinés.** Le rapprochement indépendant avec le manifeste fait foi.
- Aucun plafond total de fichiers ; les petits lots limitent chaque requête HTTP, pas la campagne.
- Supervision horaire attachée au chat : `terminer-les-sondes-audio-norva`. Elle doit rester silencieuse sans changement utile, continuer le diagnostic des blocages et clôturer uniquement après rapprochement exhaustif.

## Défaut de publication découvert et corrigé

La récupération des déclarations audio était ouverte par le déploiement progressif à 100 %, mais le lecteur SQL optimisé des films vérifiait encore uniquement l’ancien drapeau global, désactivé. Ainsi, une déclaration pouvait être enregistrée et acceptée par l’admission sans apparaître dans les filtres de l’application.

La migration `20261003163500_movie_declared_language_rollout.sql` utilise désormais l’éligibilité réelle de chaque source. Elle conserve les contrôles de propriétaire, génération, configuration et visibilité, ainsi que l’ordre de confiance : observation exacte, déclaration technique, puis indice fournisseur. Elle contient la définition complète de la projection optimisée pour permettre sa reconstruction.

Déploiement dans la base partagée de production à **16:39:16 UTC**, donc effectif pour les deux routes Edge. Aucun redémarrage de Gateway requis. Empreinte de la fonction déployée : `2b5b9a4aa561511cbeba12477bccf57d85c5ea0cbbaa60d64d9049f10f6a8d8f`.

## Vérifications

- **6 tests du dispatcher** : conservation de l’avancement après interruption, attente du bail incertain, exclusion des sources occupées, temporisation, créneau pour l’analyse stricte et journaux sans données sensibles.
- **13 contrôles SQL** réussis sur une copie du schéma sans réseau ni données utilisateur : ancien drapeau éteint avec déploiement à 100 %, disparition du filtre inconnu, filtres de langue, isolation entre propriétaires, priorité à l’observation, retrait du déploiement et configuration périmée.
- Comparaison temporaire en transaction annulée sur les quatre catalogues réels : zéro écart à la projection attendue et zéro résultat pour le mauvais propriétaire.
- Relances contrôlées du conteneur : progression conservée ; état sain après reprise.
- Les deux tâches cron normales et le worker Norva Selection restent actifs. Aucune mise en pause globale de l’enrichissement.

## Mesure à 16:45 UTC

Voir le relevé JSON joint, sans secrets ni identifiants de compte.

| Catalogue | Versions encore sans langue | Versions de la cohorte désormais identifiées |
| --- | ---: | ---: |
| Strng IPTV 8K | 30 194 | 0 |
| Norva Selection | 183 | 0 |
| Dino | 8 861 | 8 |
| MAX OTT | 17 356 | 149 |
| **Total** | **56 594** | **157** |

Le nombre de fiches distinctes sans langue est **42 990**, contre 43 125 au départ. Cette baisse comprend la publication des déclarations auparavant masquées et le travail des traitements actifs ; elle ne doit pas être attribuée intégralement aux seules nouvelles sondes du dispatcher.

L’analyse stricte progresse réellement sur Dino (fenêtres enregistrées ; dernier progrès fournisseur à 16:44:41 UTC). Les compteurs de fenêtres du relevé incluent aussi l’historique antérieur : ils ne constituent pas un taux de succès de cette campagne.

## Poursuite et clôture

Commande d’observation sur le serveur : `python3 /home/adrien/.norva/language-campaign-20261003.py observe`. Elle est en lecture seule sur la base et écrit uniquement le relevé privé local. Consulter également les journaux agrégés du conteneur et la santé des Gateways.

Répertoire privé : `/home/adrien/.norva/all-unknown-language-20261003`. `manifest.json` est immuable ; `state/state.json` est le journal du dispatcher, `latest.safe.json` le relevé publiable. Créer `state/STOP` empêche de nouvelles admissions sans interrompre la requête active ; ce mécanisme est réservé à une clôture prouvée ou à un incident. Ne jamais supprimer les baux SQL pour accélérer la campagne.

Restent à traiter les fichiers de la cohorte, les erreurs de fournisseur ou de profil et les langues indéterminées. Un report de capacité n’est pas une sonde. Un échec de transport n’établit pas la langue. Une déclaration technique n’est pas une reconnaissance vocale certifiée. **100 % examinés ne promet pas 100 % identifiables.** Ne fermer la campagne qu’après classification de chaque entrée et maintien explicite de ses limites.

Les nouvelles importations conservent le planificateur global habituel. Ce manifeste initial concerne les quatre catalogues du compte contrôlé ; il ne prouve pas à lui seul une couverture exhaustive de tous les comptes Norva. Les résultats canoniques partageables continuent d’être réutilisés selon les règles d’isolation existantes.
