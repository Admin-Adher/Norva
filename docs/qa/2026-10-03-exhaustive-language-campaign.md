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

## Contrôle automatique à 18:11–18:13 UTC

Le rapprochement unique à 18:11:21 UTC compte **657 versions contrôlées** depuis le lancement : Strng 216, Selection 29, Dino 142, MAX OTT 270. Il s'agit d'au moins un contrôle de métadonnées, de profil ou d'une progression de capture ; ce n'est pas le nombre d'analyses vocales terminées ni celui de langues identifiées.

Les quatre mesures de projection, prises successivement pendant que les traitements avancent, donnent **302 versions de la cohorte désormais identifiées** (5, 1, 79, 217 respectivement). La requête globale, exécutée ensuite, trouve **56 446 variantes / 42 904 fiches inconnues**. Ce relevé n'est pas une transaction unique : la petite différence entre la somme des sources et le total global est conservée, sans prétendre à une photographie atomique.

Le passage de 493 à 657 versions contrôlées entre 18:02:04 et 18:11:21 représente 164 nouveaux contrôles uniques en 9 min 17 s, environ 1 060/h sur cette courte fenêtre. Ce n'est pas un débit soutenu certifié ni une prévision de fin complète. La cible d'une ou deux heures demeure non atteinte.

À 18:13:06 UTC, depuis le correctif SQL de 18:01:46 : **zéro erreur HTTP du dispatcher, zéro diagnostic d'expiration SQL dans les deux réplicas Edge**, et dix lots de métadonnées non vides terminés. Des erreurs de profil/transport et reports fournisseur restent présents ; ils ne sont pas assimilés à une langue identifiée. Le dernier progrès de capture stricte observé pour Selection date de 18:11:16 ; des travaux de Strng, Dino et MAX OTT restent en traitement ou en attente selon leurs baux et quarantaines.

Les deux Gateways répondent HTTP 200 avec `ok=true`, aucune lecture active au moment du relevé, capacité réseau toujours limitée à deux travaux. Le dispatcher est sain, sans redémarrage ni marqueur STOP ; l'enrichissement reste ouvert et le cron strict actif. Aucun bail ni échec n'a été effacé. Les correctifs sont intégrés jusqu'au commit `32940a3dae65583302fdbbcda0642a9a8ecb9fe4` (PR 607).

Preuve agrégée : `2026-10-03-language-campaign-heartbeat.json`. La campagne et son suivi horaire restent actifs. Pas de nouvelle modification de production lors de ce contrôle.

## Contrôle automatique à 19:11–19:13 UTC

Le relevé unique compte **2 213 versions contrôlées** : Strng 784, Selection 33, Dino 899, MAX OTT 497. L'écart avec 18:11:21 est **1 556 nouvelles versions en 60 min 26 s**, soit environ **1 545 contrôles uniques/h** sur l'heure écoulée. Ce débit comprend des métadonnées et des profils, pas uniquement des analyses vocales complètes. Il ne garantit pas la même vitesse lorsque les fichiers restants nécessiteront des captures longues.

Le rapprochement de la projection donne **813 variantes initialement inconnues désormais identifiées** : Strng 11, Selection 1, Dino 453, MAX OTT 348. Il reste **55 938 variantes / 42 685 fiches inconnues**. Les 56 751 variantes de départ sont toujours visibles. La baisse n'est pas produite par une suppression de fichiers ou de catalogue.

À 19:12:01, depuis le correctif SQL de 18:01:46 : **zéro erreur HTTP du dispatcher, zéro diagnostic d'expiration SQL dans les deux Edge**, et 91 lots de métadonnées non vides terminés. Les deux Gateways sont sains ; l'enrichissement et le cron strict restent actifs. La capture stricte Dino a encore progressé à 19:11:21. Les états terminaux agrégés restent distincts d'une preuve de nouvelle analyse vocale complète sur chaque version.

Une autre cause de perte de débit a été identifiée : un garde-fou local « fournisseur occupé / circuit de sondes ouvert » peut être enregistré comme un échec de fichier incertain, sans qu'aucune requête soit partie. Il dépense alors une tentative et prolonge inutilement l'exclusion réseau. MAX OTT possède huit lignes de ce type en nouvelle tentative et un circuit réellement ouvert jusqu'à 19:33 UTC ; cette pause fournisseur doit être respectée. La correction et son déploiement sont documentés dans `2026-10-03-language-metadata-provider-deferrals.md`.

La campagne reste **EN COURS**. La cible d'une à deux heures n'est pas atteinte. Les fichiers seulement contrôlés, les langues identifiées et les résultats d'analyse vocale ne sont pas additionnés comme s'il s'agissait de la même mesure. Preuve de cette heure : `2026-10-03-language-campaign-heartbeat-1911.json`.

## Contrôle automatique à 20:12 UTC

| Catalogue | Versions distinctes contrôlées depuis le lancement | Initialement inconnues, désormais identifiées | Encore sans langue |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 1 665 | 19 | 30 175 |
| Norva Selection | 36 | 4 | 179 |
| Dino | 1 403 | 728 | 8 141 |
| MAX OTT | 776 | 496 | 17 009 |
| **Total** | **3 880** | **1 247** | **55 504** |

Le total de fiches distinctes encore inconnues est **42 459**. Aucune variante de la cohorte n'a disparu. Entre 19:11:47 et 20:12:27, **1 667 versions supplémentaires** ont reçu un contrôle distinct : environ **1 649/h sur 60 min 40 s**. Sur les deux fenêtres horaires cumulées depuis 18:11:21, le gain est 3 223 en 121 min 6 s, soit environ 1 597/h. Ce débit observé de contrôles techniques ne représente ni la vitesse d'analyse vocale complète ni une garantie de délai pour les fichiers restants.

La projection comporte **434 identifications supplémentaires** par rapport à 19:11. MAX OTT a repris automatiquement après expiration de son circuit de protection ; les huit nouvelles tentatives historiques de métadonnées ne sont plus présentes. Aucun compteur ni bail n'a été supprimé manuellement. Le dernier lot observé à 20:11:38 a contrôlé 25 métadonnées, dont dix identifications et quinze résultats inconclusifs.

À 20:12:51, zéro erreur HTTP du dispatcher depuis 18:01:46 ; zéro diagnostic d'expiration SQL dans les Edge depuis leur recréation à 19:23. Les deux Gateways répondent HTTP 200 ; les admissions sont ouvertes, le cron strict actif et STOP absent. Le conteneur de campagne est sain, sans redémarrage.

L'audit strict complémentaire recense **sept versions dont le travail est passé à `verified` depuis le lancement**, avec progression fournisseur et preuve enregistrée pour toutes les pistes attendues (Strng 1, Selection 2, Dino 1, MAX OTT 3). Ce compteur de travaux terminés est distinct des 1 247 langues identifiées via les différents mécanismes. Il ne certifie pas à lui seul qu'un fichier fournisseur n'a pas changé depuis sa vérification.

L'audit a également identifié une attente anormale : un travail obsolète se présentait en tête du répartiteur mais échouait au garde-fou du profil observé. D'autres travaux dus depuis plus d'une heure attendaient derrière lui, dont un finaliseur Dino. La correction et la preuve de reprise sont consignées dans `2026-10-03-language-worker-stale-profile.md`. La campagne reste **EN COURS**.

Correctif SQL publié à **20:28:46 UTC**, après 23 contrôles dédiés : deux travaux obsolètes ont été retirés naturellement de la file globale, sans sonde ni attribution de langue. À 20:34, deux variantes de la cohorte ont une nouvelle progression de capture après publication. Le total des vérifications strictes terminées depuis le lancement est passé à **huit** ; la huitième (Dino à 20:22) précède ce correctif et n'en est pas une preuve de résultat. Aucun nouveau travail terminé n'est revendiqué dans les cinq premières minutes après déploiement.

Les douze contrôles CI du code ont réussi. La base de preuve isolée a été arrêtée ; le dispatcher de production et la supervision restent actifs. Aucun compteur, bail, échec inconclusif ni quarantaine n'a été réinitialisé.
