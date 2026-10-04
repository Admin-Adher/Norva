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

## Contrôle automatique à 21:12–21:15 UTC

| Catalogue | Versions distinctes contrôlées depuis le lancement | Initialement inconnues, désormais identifiées | Encore sans langue |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 2 042 | 22 | 30 172 |
| Norva Selection | 40 | 4 | 179 |
| Dino | 1 712 | 918 | 7 951 |
| MAX OTT | 1 345 | 813 | 16 692 |
| **Total** | **5 139** | **1 757** | **54 994** |

Il reste **42 111 fiches distinctes** inconnues. Toutes les variantes initiales sont encore visibles. La projection donne **510 identifications supplémentaires** depuis le relevé précédent. Les requêtes par source sont successives et les traitements continuent : le relevé n'est pas une photographie atomique.

Entre 20:12:27 et 21:12:15, **1 259 variantes supplémentaires** ont reçu un contrôle distinct, soit **1 263 contrôles techniques/h** sur 59 min 47 s. Le débit a donc baissé par rapport à l'heure précédente (1 649/h), sans nouvelle erreur HTTP ni expiration SQL détectée. Les reports de capacité et d'occupation fournisseur persistent ; leur absence d'appel média ne compte pas comme une sonde. Ce débit ne constitue pas une prévision du temps de reconnaissance vocale complète.

### Résultats stricts et reprise après correction

Le travail Dino terminé à **21:05:51 UTC** apporte la première validation `verified` de la cohorte observée après le correctif de 20:28. Le total est désormais **neuf validations strictes réussies depuis le début** (Strng 1, Selection 2, Dino 3, MAX OTT 3), avec progression fournisseur et preuve pour toutes les pistes attendues.

L'audit en lecture seule distingue maintenant les analyses strictes réellement achevées mais indéterminées : état terminal de consensus insuffisant, progression fournisseur après le début de campagne, quatre ou six fenêtres complètes et autant de reçus de fenêtre. À 21:15, **14 variantes** remplissent ces critères (Strng 2, Selection 9, Dino 3, MAX OTT 0). Le profil exact observé en cache correspond encore dans les 14 cas : signature, date, description et taille. Les anciens résultats inconclusifs antérieurs à la campagne ne gonflent pas ce compteur. Aucun de ces travaux n'est relancé manuellement.

Ces compteurs d'analyse sont distincts des langues identifiées par les métadonnées et ne doivent pas être additionnés à celles-ci. Un simple profil sans langue ou une réponse de métadonnées inconclusive ne constitue pas une analyse vocale terminée. Les erreurs de transport encore en nouvelle tentative restent **à traiter** ; elles ne deviennent pas automatiquement une indisponibilité définitive prouvée.

À 21:12:39, **dix variantes** ont enregistré une nouvelle progression fournisseur après le correctif de 20:28. Les deux travaux obsolètes retirés de la file globale ne sont pas comptés comme des sondes. MAX OTT a reçu un nouvel essai à 21:14, reporté pour occupation fournisseur : son ancien état `LANGUAGE_VALIDATION_GATEWAY_ERROR` n'est plus immobile. La file continue, avec des contraintes de capacité toujours actives.

### Santé et continuité

Deux Gateways HTTP 200 / `ok=true`, aucune lecture active lors du relevé, capacité limitée à deux travaux. Le dispatcher est sain, sans redémarrage et sans marqueur STOP ; enrichissement et cron strict actifs. **Zéro erreur HTTP du dispatcher depuis 18:01:46**, 258 lots de métadonnées non vides terminés ; zéro diagnostic d'expiration SQL depuis la recréation des Edge à 19:23. Les codes SQL historiques figurant encore dans l'état d'admission ne prouvent pas une nouvelle expiration.

Le correctif précédent est intégré dans `be86445f99e7ae16be9bb107622bbf478fe545a4` (PR 609). Ce contrôle n'a modifié ni le dispatcher, ni la base, ni les seuils ou limites de production. Seul l'audit en lecture seule a été précisé. La campagne et sa supervision restent **ACTIVES**, sans clôture. Preuve : `2026-10-03-language-campaign-heartbeat-2112.json`.

## Contrôle du 4 octobre à 00:12 Paris (3 octobre 22:12 UTC)

| Catalogue | Versions distinctes contrôlées depuis le lancement | Initialement inconnues, désormais identifiées | Encore sans langue |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 2 271 | 25 | 30 169 |
| Norva Selection | 44 | 5 | 178 |
| Dino | 2 209 | 1 176 | 7 693 |
| MAX OTT | 1 624 | 979 | 16 526 |
| **Total** | **6 148** | **2 185** | **54 566** |

Il reste **41 884 fiches distinctes** sans langue dans le périmètre contrôlé. Les 56 751 variantes initiales sont toujours visibles. La projection compte **428 identifications supplémentaires** depuis le relevé précédent ; aucune suppression ne produit cette baisse. Les requêtes restent successives, pendant que les traitements avancent.

Le gain de contrôles distincts est **1 009 en 60 min 16 s**, soit **1 004 contrôles techniques/h**. Ce rythme est inférieur aux 1 263/h de la fenêtre précédente et ne constitue pas un débit d'analyse vocale ni un délai de clôture.

### Analyses strictes réellement terminées

**11 validations réussies avec preuve pour toutes les pistes** depuis le lancement (Strng 2, Selection 3, Dino 3, MAX OTT 3), contre neuf précédemment. Les deux nouvelles validations sont Selection à 21:17:10 UTC et Strng à 21:59:33 UTC.

**22 analyses complètes mais indéterminées**, contre 14 précédemment : Strng 4, Selection 13, Dino 4, MAX OTT 1. Chacune possède ses quatre ou six fenêtres et leurs reçus, une progression fournisseur postérieure au lancement et le même profil observé courant. Les autres échecs, anciennes analyses ou travaux reportés ne gonflent pas ce compteur. Ces 22 résultats ne reçoivent pas de langue arbitraire et ne sont pas relancés manuellement. Les contrôles techniques, identifications et résultats stricts se recoupent : ils ne doivent pas être additionnés.

### Incident SQL récupéré automatiquement

Une requête de métadonnées MAX OTT a reçu **HTTP 500 à 21:20:10 UTC**. Les deux Edge enregistrent à cet instant le code SQL `57014` (délai de requête dépassé). Il s'agit d'un échec HTTP du dispatcher avec un diagnostic sur chaque réplique, et non de deux fichiers sondés. Le premier lot de métadonnées terminé ensuite sur cette source est daté de **21:42:01 UTC**, avec deux contrôles et deux identifications. La temporisation conservatrice de 21 minutes a donc été respectée avant la reprise automatique. Aucun autre échec HTTP du dispatcher n'apparaît dans le contrôle allant jusqu'à 22:18:57 UTC.

L'opération SQL exacte reste **non établie** : le diagnostic la classe comme indéterminée et les journaux PostgreSQL consultés ne fournissent pas le contexte de la requête fautive. Les statistiques cumulées des appels réussis à l'admission des métadonnées donnent 563 ms en moyenne et 7 968 ms au maximum sur 7 594 appels ; elles incluent les anciennes versions et ne permettent pas d'attribuer cet incident à une requête précise. Aucun changement de production spéculatif n'a été appliqué.

### Santé, continuité et limites

À 22:12:52 UTC, les deux Gateways répondent HTTP 200 / `ok=true`, sans lecture active au moment du relevé. La capacité observée passe d'un à deux travaux entre 22:12 et 22:19 selon l'admission adaptative, sans modification de sa limite. Le dispatcher est sain, sans redémarrage ni marqueur STOP ; enrichissement ouvert et cron strict actif. Les dernières exécutions de cron à 22:16–22:19 réussissent, et les candidats dus contrôlés ne présentent pas le profil obsolète responsable de l'ancien blocage.

Le correctif de la file est intégré par la PR 609 ; la précision de l'audit strict est intégrée par la PR 610 (`3e4bd37bcef74c2fe368ded05fe8ae886b9d5ead`). Ce suivi a uniquement lu les états et conservé des reçus agrégés. Aucun bail, compteur, seuil, quarantaine ni résultat indéterminé n'a été réinitialisé. La campagne et son suivi restent **ACTIFS**, sans clôture. Preuve : `2026-10-04-language-campaign-heartbeat-0012.json`.

## Contrôle du 4 octobre à 01:12 Paris (3 octobre 23:12 UTC)

| Catalogue | Versions distinctes contrôlées depuis le lancement | Initialement inconnues, désormais identifiées | Encore sans langue |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 2 653 | 38 | 30 156 |
| Norva Selection | 49 | 5 | 178 |
| Dino | 2 288 | 1 221 | 7 648 |
| MAX OTT | 2 286 | 1 371 | 16 134 |
| **Total** | **7 276** | **2 635** | **54 116** |

**1 128 contrôles distincts supplémentaires en 60 min 17 s**, soit environ **1 123 contrôles techniques/h**. La projection compte **450 identifications supplémentaires** et **41 490 fiches distinctes** encore inconnues. Toutes les variantes initiales restent visibles. Les mesures par source sont successives, sans photographie atomique. Le contrôle des métadonnées demeure beaucoup plus rapide que les captures vocales complètes ; ce rythme ne prédit pas la clôture de ces dernières.

### Analyses strictes et attentes

**15 validations strictes réussies avec preuve complète** depuis le lancement : Strng 3, Selection 3, Dino 3, MAX OTT 6. Le gain depuis le relevé précédent est quatre. **28 analyses complètes restent indéterminées** avec leurs fenêtres et reçus complets et un profil observé correspondant : Strng 4, Selection 17, Dino 6, MAX OTT 1, soit six supplémentaires. Aucun résultat indéterminé n'a reçu une langue par défaut. Ces compteurs recoupent les contrôles et identifications ; ils ne s'y additionnent pas.

À 23:14:44 UTC, **29 variantes** ont enregistré une progression fournisseur après le correctif de file de 20:28, dont **sept validations réussies**. Les deux anciens travaux retirés pour changement de profil restent exclus des sondes. Un travail Strng présente encore un bail expiré à 22:56 et attend son prochain passage : rang global quatre parmi cinq voies fournisseur éligibles à 23:15, puis rang trois parmi six à 23:17. Il est premier sur sa propre voie fournisseur, sans autre bail actif de ce fournisseur ; son profil observé correspond toujours. La liste globale ne lance que le nombre de travaux autorisé par la capacité. Cette attente n'est ni une analyse terminée ni une nouvelle tentative effectuée ; sa reprise reste à vérifier au suivi suivant. Aucun bail n'a été forcé ou effacé.

### Santé et incident SQL précédent

Les deux Gateways répondent HTTP 200 / `ok=true`, sans lecture active au moment du contrôle. Le dispatcher est sain sans redémarrage ni marqueur STOP. L'admission est ouverte, le cron strict actif ; les quatre passages de cron de 23:09 à 23:12 réussissent. La capacité observée autorise deux travaux. Les protections de capacité et d'occupation fournisseur continuent à reporter des appels, notamment Dino ; ces reports ne comptent pas comme des fichiers sondés.

**Aucun nouvel échec HTTP du dispatcher ni diagnostic d'expiration SQL** depuis l'incident de 21:20. Les compteurs restent à un échec HTTP et un diagnostic sur chacun des deux Edge. Les lots de métadonnées non vides terminés passent de 332 à **409** depuis le correctif de pagination. La cause précise de l'incident antérieur demeure non établie ; aucun correctif spéculatif n'a été appliqué pendant ce contrôle.

La campagne et sa supervision restent **ACTIVES**, sans clôture. Aucune modification du traitement de production, des seuils, des limites ou des quarantaines. Les contrôles et reçus agrégés sont conservés dans `2026-10-04-language-campaign-heartbeat-0112.json`.

## Contrôle du 4 octobre à 02:13 Paris (00:13 UTC)

| Catalogue | Versions distinctes contrôlées depuis le lancement | Initialement inconnues, désormais identifiées | Encore sans langue |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 3 202 | 46 | 30 148 |
| Norva Selection | 56 | 5 | 178 |
| Dino | 2 427 | 1 298 | 7 571 |
| MAX OTT | 2 432 | 1 461 | 16 044 |
| **Total** | **8 117** | **2 810** | **53 941** |

La cohorte initiale reste entièrement visible, avec **41 382 fiches distinctes encore inconnues**. **841 nouvelles variantes contrôlées en 60 min 35 s**, soit **833 contrôles techniques/h**, contre 1 123/h dans la fenêtre précédente. La projection comporte **175 identifications supplémentaires**. Les requêtes par source sont successives ; aucune extrapolation de ce débit en délai de reconnaissance vocale complète n'est validée.

### Progression stricte et reprise de la file

**17 validations strictes réussies avec preuve complète** depuis le lancement (Strng 3, Selection 3, Dino 4, MAX OTT 7), soit deux supplémentaires. **33 analyses complètes indéterminées** possèdent toutes leurs fenêtres et reçus et correspondent au profil observé courant (Strng 4, Selection 20, Dino 8, MAX OTT 1), soit cinq supplémentaires. Aucun résultat indéterminé n'est transformé arbitrairement en langue. Ces ensembles recoupent les identifications et contrôles ; ils ne s'additionnent pas.

Le travail Strng dont le bail était expiré à 22:56 a bien repassé l'admission : à 00:15, il est en `retry_wait / PROVIDER_ACCOUNT_BUSY`, actualisé à 00:10, sans bail actif. Sa dernière progression fournisseur reste **22:51:40**, avec neuf tentatives fournisseur : il s'agit d'une reprise de l'ordonnancement, **pas d'une nouvelle capture ni d'une analyse achevée**. Un autre travail Strng a progressé à 00:12:31. Le suivi après correction de file compte 37 variantes ayant progressé et neuf validations réussies depuis le déploiement de 20:28. Les deux retraits de profils obsolètes ne comptent pas comme sondes.

Un travail Selection a également un bail expiré à 00:07 ; à 00:13, il attend derrière deux travaux de la même voie fournisseur. Son profil observé correspond. Aucun bail n'est effacé pour accélérer artificiellement la file.

### Ralentissement et protections fournisseur

Les protections de sondes sont actives, selon le relevé de 00:13:51, jusqu'à **00:34:09 UTC pour Dino** et **01:56:05 UTC pour MAX OTT**. Les déclarations d'occupation fournisseur provoquent aussi des reports. Les nouvelles tentatives de métadonnées reportées pour ces causes ont zéro tentative consommée et aucun bail actif. Ces protections sont conservées ; aucune nouvelle tentative forcée ni attribution de langue n'est effectuée. Huit métadonnées Strng invalides attendent leur échéance normale, après une tentative ; elles ne sont pas présentées comme des identifications.

Les deux Gateways sont sains (HTTP 200 / `ok=true`), sans lecture active au relevé. Dispatcher sain sans redémarrage, STOP absent, admission ouverte et cron strict actif, capacité observée de deux travaux. **Aucun nouvel échec HTTP ni diagnostic SQL** depuis l'incident de 21:20 ; 472 lots de métadonnées non vides terminés depuis la réduction de pagination, contre 409 précédemment. La cause précise de l'ancien incident SQL reste non établie.

Aucune modification du traitement de production pendant ce contrôle. La campagne et sa supervision restent **ACTIVES**, sans clôture. Reçu agrégé : `2026-10-04-language-campaign-heartbeat-0213.json`.

## Contrôle du 4 octobre à 03:14 Paris (01:14 UTC)

| Catalogue | Versions distinctes contrôlées depuis le lancement | Initialement inconnues, désormais identifiées | Encore sans langue |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 3 327 | 47 | 30 147 |
| Norva Selection | 60 | 5 | 178 |
| Dino | 2 646 | 1 407 | 7 462 |
| MAX OTT | 2 432 | 1 462 | 16 043 |
| **Total** | **8 465** | **2 921** | **53 830** |

Toutes les variantes initiales restent visibles ; **41 356 fiches distinctes** sont encore sans langue. **348 nouveaux contrôles en 61 min 26 s**, soit environ **340 contrôles techniques/h**, contre 833/h précédemment. La projection compte **111 identifications supplémentaires**. Les requêtes par source restent successives et ces mesures ne fournissent pas une échéance de fin des analyses vocales.

### Reprise fournisseur et analyses strictes

La reprise automatique des métadonnées **Dino est prouvée à 00:51:27 UTC**, après l'échéance de protection de 00:34:09 : premier lot de 29 contrôles, dont 16 identifications. Dix lots avec tentatives sont observés après cette échéance, le dernier à 00:58:02 avant de nouveaux reports d'occupation fournisseur. Dino a gagné 219 variantes distinctes contrôlées et 109 identifications pendant la fenêtre. Aucun circuit n'a été réinitialisé manuellement.

La protection MAX OTT reste active jusqu'à **01:56:05 UTC (03:56 Paris)**. Aucun nouveau contrôle distinct n'est compté pour ce catalogue pendant cette heure. Sa huitième validation stricte a toutefois été finalisée à 00:51:00, à partir d'une capture dont la dernière progression date de 00:11:31. Cette finalisation est une identification supplémentaire, pas une nouvelle version sondée.

Le total strict est **18 validations réussies avec preuve complète** (+1 : Strng 3, Selection 3, Dino 4, MAX OTT 8) et **38 analyses complètes indéterminées** (+5 : Strng 5, Selection 23, Dino 9, MAX OTT 1), avec fenêtres, reçus et profil observé correspondant. Aucun résultat indéterminé n'est converti arbitrairement en langue. Ces ensembles recoupent les autres compteurs.

Le contrôle ne trouve **aucun travail de la cohorte avec un bail de capture/finalisation expiré** à 01:14. Des progressions fournisseur existent à 01:14 pour Strng, 01:11 pour Selection et 01:12 pour Dino. Depuis le correctif de file de 20:28, 43 variantes ont progressé et dix validations ont réussi. Les retraits de travaux obsolètes restent exclus de ces sondes. Des reports ordinaires de capacité et d'occupation restent présents : la disparition d'un bail expiré ne prouve pas que chaque analyse soit terminée.

### Santé et continuité

Les deux Gateways répondent HTTP 200 / `ok=true`, sans lecture active au relevé ; capacité observée de deux travaux. Le dispatcher est sain sans redémarrage ni marqueur STOP, admission ouverte et cron strict actif. **Aucun nouvel échec HTTP du dispatcher ni diagnostic SQL** depuis l'incident du 3 octobre à 21:20. Les lots de métadonnées non vides terminés passent de 472 à **511**.

Aucune modification du traitement de production, des limites, seuils, baux ou quarantaines. Les reports ne sont pas comptés comme sondes ; le délai de fin n'est toujours pas certifié. La campagne et sa supervision restent **ACTIVES**. Reçu : `2026-10-04-language-campaign-heartbeat-0314.json`.

## Contrôle du 4 octobre à 04:15 Paris (02:15 UTC)

| Catalogue | Versions distinctes contrôlées depuis le lancement | Initialement inconnues, désormais identifiées | Encore sans langue |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 3 485 | 53 | 30 141 |
| Norva Selection | 65 | 6 | 177 |
| Dino | 3 481 | 1 861 | 7 008 |
| MAX OTT | 2 646 | 1 583 | 15 922 |
| **Total** | **9 677** | **3 503** | **53 248** |

**1 212 variantes distinctes supplémentaires en 60 min 46 s**, soit environ **1 197 contrôles techniques/h**. **582 identifications supplémentaires** ; **41 122 fiches distinctes** restent inconnues et toute la cohorte initiale reste visible. Les relevés par source sont successifs. Ce rythme n'est ni un débit de reconnaissance vocale ni une prévision de clôture exhaustive.

L'audit strict compte **20 validations réussies avec preuve complète** : Strng 3, Selection 4, Dino 4, MAX OTT 9, soit deux supplémentaires. **43 analyses complètes indéterminées** correspondent toujours au profil observé courant : Strng 6, Selection 25, Dino 11, MAX OTT 1, soit cinq supplémentaires. Ces ensembles recoupent les contrôles et identifications ; ils ne s'additionnent pas.

### Reprise automatique MAX OTT et santé

MAX OTT reprend ses métadonnées à **01:57:02 UTC**, après l'échéance de protection de 01:56:05 : cinq contrôles et trois identifications dans le premier lot. Neuf lots avec tentatives sont observés jusqu'à 02:15:03. Dino continue aussi, avec 49 lots après son échéance précédente et un dernier lot de 24 contrôles / 11 identifications à 02:14:45. Aucun circuit n'a été réinitialisé.

Les Gateways restent sains, HTTP 200 / `ok=true`, sans lecture active aux contrôles de 02:15 et 02:25. Dispatcher sain, aucun redémarrage au relevé, STOP absent, admission ouverte et cron strict actif ; capacité observée de deux travaux. Les lots de métadonnées terminés passent de 511 à **586**, puis **601** à 02:25. Aucun nouvel échec HTTP du dispatcher ni diagnostic d'expiration SQL : les anciens compteurs restent à un échec HTTP et un diagnostic par Edge. Cela ne couvre pas l'erreur distincte de finalisation décrite ci-dessous.

### Finalisation prioritaire : correctif déployé, erreur distincte encore ouverte

Un travail Strng a terminé sa piste à **01:31:35 UTC**, avec une preuve pour une piste attendue. Son bail expire à 01:36:01 ; à 02:18:55, il n'est toujours pas choisi par le sélecteur réel. La file faisait passer des captures répétées avant ce reçu prêt à finaliser.

La migration `20261004022500_prioritize_completed_language_finalizers` est déployée à **02:21:45 UTC**. Elle donne priorité aux finaliseurs complets à l'intérieur d'une même priorité de demande, dans chaque voie et dans l'ordre global. Les demandes manuelles restent premières ; l'isolation des voies, les baux actifs, les quarantaines, l'admission et la capacité ne sont pas modifiés. **21 contrôles SQL réussis** sur une copie du schéma sans données clients ni réseau ; attente reproduite avant correction. Les définitions des fonctions de validation et d'admission sont inchangées. Le conteneur de preuve est arrêté après le test.

Le cron reprend ce travail automatiquement à **02:22:00**, soit environ 15 secondes après déploiement. **Il échoue ensuite à la finalisation**, à 02:22:08, avec `LANGUAGE_VALIDATION_FINALIZE_FAILED`, et respecte son report jusqu'au 5 octobre à 02:22:08 UTC. Son compteur de tentatives fournisseur reste à huit et sa dernière capture reste 01:31:35 : aucune nouvelle sonde ni validation réussie n'est comptée.

Les contrôles en lecture seule concordent pour le profil, les indices audio, la taille, les dates, la génération active, le cache et l'appartenance de la source. **La cause exacte de cet échec RPC n'est pas encore établie.** Le niveau PostgreSQL `log_min_messages=fatal` n'a pas conservé son erreur ; aucune modification générale de journalisation ni nouvelle tentative forcée n'est faite. Voir `2026-10-04-language-finalizer-priority.md`. Cette analyse reste à terminer ; le correctif d'ordre ne suffit pas à la déclarer validée.

La campagne et la supervision restent **ACTIVES**, sans baisse des seuils ni modification des délais, limites ou quarantaines. Reçu agrégé : `2026-10-04-language-campaign-heartbeat-0415.json`.

## Contrôle du 4 octobre à 05:18 Paris (03:18 UTC)

| Catalogue | Versions distinctes contrôlées depuis le lancement | Initialement inconnues, désormais identifiées | Encore sans langue |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 3 984 | 62 | 30 132 |
| Norva Selection | 71 | 6 | 177 |
| Dino | 3 974 | 2 132 | 6 737 |
| MAX OTT | 2 909 | 1 730 | 15 775 |
| **Total de la cohorte** | **10 938** | **3 930** | **52 821** |

**1 261 contrôles supplémentaires en 62 min 28 s**, soit **1 211 contrôles techniques/h**. La cohorte compte **427 identifications supplémentaires**, sans suppression de variante. Le total global, interrogé ensuite, est de 52 820 variantes / 40 923 fiches inconnues ; l'écart d'une variante reflète des requêtes successives, sans photographie atomique. Le total de cohorte sert au calcul du gain. L'annonce intermédiaire de 428 utilisait ce dernier total global ; le gain consolidé par source est **427**.

**22 validations strictes réussies avec preuve complète** (Strng 4, Selection 4, Dino 5, MAX OTT 9), soit deux supplémentaires. **48 analyses complètes indéterminées avec profil courant correspondant** (6, 28, 11, 3), soit cinq supplémentaires. Ces ensembles se recoupent avec les contrôles et identifications. Le rythme technique ne prédit pas la fin des analyses vocales.

Les deux Gateways sont sains à 03:18 ; dispatcher sans redémarrage, STOP absent, admission ouverte et cron actif, capacité observée de deux travaux. **671 lots de métadonnées non vides terminés**, contre 586 au relevé précédent. Aucun nouvel échec HTTP du dispatcher ou diagnostic d'expiration SQL avant le déploiement décrit ci-dessous. Le travail Strng en échec de finalisation demeure en report jusqu'au 5 octobre à 02:22:08 UTC, sans nouvelle tentative ni capture.

### Diagnostic limité à la finalisation

L'erreur RPC précise du travail Strng n'est toujours pas connue. Un diagnostic est ajouté au seul échec de `finalize_catalog_file_audio_validation_job` : catégorie erreur RPC / résultat vide, code SQL/PostgREST sur liste autorisée et durée en millisecondes. Aucun argument, message brut, détail, identifiant, média ou preuve n'est journalisé. Le code de retour, le délai de reprise et toutes les validations restent inchangés.

**45 tests ciblés réussis**, dont quatre tests exécutables du diagnostic et de son filtrage. Santé du serveur de validation confirmée avant publication. Le déploiement attend la fin des travaux engagés, avec suspension temporaire des nouvelles admissions de **03:24:53 à 03:27:22 UTC** (environ 2 min 28 s), sans annulation ni réinitialisation de bail. Les deux Edge sont mis à jour successivement ; admission, cron et dispatcher reprennent automatiquement. Le serveur de validation est ensuite arrêté.

Version intégrée : PR **616**, commit de code `77574436cd88be2b184e418212a843401f1c8473`. Les deux fichiers de production correspondent au SHA-256 **`bfa8f6213a89a512e3ac33610a9a6ee191f3dc968319ab12fb9b4bff558e5bea`**, contrôlé à 03:29. Les contrats cloud CI passent ; les constructions de paquets étaient encore en attente lors de la fusion. Aucun client mobile ou web n'est modifié.

À 03:29, les deux Gateways sont sains, STOP absent, admission et cron restaurés ; **681 lots** sont terminés. La capacité adaptative indique une voie réseau occupée sur le Gateway principal et deux places sur l'autre, sans lecture active. Les nouvelles fenêtres de logs Edge commencent à 03:27:05 et 03:27:19 : zéro nouveau diagnostic SQL/finalisation dans ces courtes fenêtres. **Le zéro après recréation ne supprime pas les incidents historiques**, conservés dans le reçu antérieur et le relevé de 03:18.

Ce diagnostic ne résout pas à lui seul la finalisation Strng. Aucun échec n'est provoqué et aucun délai n'est contourné pour le tester en production ; la prochaine occurrence naturelle fournira un code exploitable. La campagne et sa supervision restent **ACTIVES**. Reçu : `2026-10-04-language-campaign-heartbeat-0518.json`.

## Contrôle du 4 octobre à 06:19 Paris (04:19 UTC)

| Catalogue | Versions distinctes contrôlées depuis le lancement | Initialement inconnues, désormais identifiées | Encore sans langue |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 4 385 | 71 | 30 123 |
| Norva Selection | 76 | 7 | 176 |
| Dino | 4 478 | 2 406 | 6 463 |
| MAX OTT | 2 954 | 1 764 | 15 741 |
| **Total de la cohorte** | **11 893** | **4 248** | **52 503** |

**955 contrôles supplémentaires en 61 min 4 s**, soit **938 contrôles techniques/h**, et **318 identifications supplémentaires**. La fenêtre conserve les 2 min 28 s de drainage du déploiement précédent ; aucun temps n'est retranché. Les 56 751 variantes initiales sont toujours visibles ; le contrôle global trouve 40 808 fiches inconnues. Les requêtes restent successives.

À 04:19, **24 validations strictes réussies avec preuve complète** (Strng 4, Selection 5, Dino 5, MAX OTT 10), soit deux supplémentaires ; **49 analyses complètes indéterminées avec profil courant correspondant** (6, 28, 11, 4), soit une supplémentaire. Les ensembles se recoupent avec les contrôles et identifications. Le débit technique ne prédit toujours pas la clôture des analyses vocales.

### Retard de consensus identifié et corrigé

À 04:25:20, une analyse MAX OTT dispose de six reçus pour six fenêtres depuis 03:41:30. Son bail a expiré à 03:46:01 ; le sélecteur réel la place dans les quatre candidats mais pas dans les deux exécutés. Le correctif précédent ne donnait priorité qu'aux travaux dont toutes les pistes étaient déjà finalisées, pas au consensus des fenêtres d'une piste. Une analyse Selection en attente au relevé initial s'est terminée naturellement à 04:22, avant la nouvelle correction, avec un résultat indéterminé.

La migration **`20261004043500_prioritize_completed_language_windows`** étend la priorité aux pistes dont les quatre ou six reçus sont présents et dont les curseurs concordent. **34 contrôles SQL réussis** dans une copie du schéma sans lignes clients ni réseau (13 nouveaux, 21 de régression) ; retard reproduit avant correction. Les fonctions de claim, validation, checkpoints, capacité et admission par source restent identiques. Les demandes manuelles, délais futurs, quarantaines, baux actifs et exclusions par source restent appliqués.

Déploiement transactionnel à **04:31:27 UTC**, sans redémarrage, pause du dispatcher, mutation directe de travaux ou appel fournisseur. SHA-256 du sélecteur : **`bee4c49c2932883178091cecb193f4e944980a569b02783be2bc00df8f7312ed`**. Le planificateur reprend naturellement le travail MAX OTT à 04:32 ; son consensus se termine à **04:32:00**, **indéterminé**. Les sept tentatives fournisseur et la dernière capture de 03:41:30 restent inchangées. Il s'agit d'une analyse complète sans langue attribuée, pas d'une nouvelle sonde ni d'une identification. Voir `2026-10-04-language-finalizer-priority.md`.

À 04:33, le relevé strict distinct compte **24 validations réussies et 51 analyses complètes indéterminées correspondant au profil courant** : deux clôtures supplémentaires depuis 04:19, dont Selection avant la correction et MAX OTT après. Le conteneur de preuve est arrêté.

### Santé et limites

Les deux Gateways sont sains, sans lecture active aux relevés ; capacité adaptative de zéro/deux à 04:19 puis deux/deux à 04:33. Dispatcher sain, STOP absent, admission ouverte et cron actif. Les lots de métadonnées terminés passent de 671 à **739** au relevé, puis **757** à 04:33. Aucun nouvel échec HTTP du dispatcher ni diagnostic SQL ou de finalisation dans les Edge depuis leur recréation à 03:27. L'ancien incident HTTP 500 / SQL 57014 du 3 octobre reste conservé, sans cause SQL exacte établie.

Le travail Strng ayant échoué à la finalisation SQL reste inchangé et reporté au **5 octobre à 02:22:08 UTC**, sans tentative forcée. Trois reprises de métadonnées Strng et trois MAX OTT conservent `metadata-request-failed` avec un seul essai et leurs délais ; aucune reprise Dino de ce type n'est présente au contrôle de 04:24. Ces erreurs par entrée sont distinctes d'un échec HTTP du dispatcher et ne démontrent pas une panne SQL. Un travail Dino sans première capture garde un bail expiré à 04:17 ; sa reprise reste à surveiller avec le sélecteur réel, sans forcer le bail.

La campagne et la supervision restent **ACTIVES**. Aucun seuil de confiance, compteur de tentative, bail, délai ni quarantaine n'est réinitialisé. Reçu : `2026-10-04-language-campaign-heartbeat-0619.json`.

## Contrôle du 4 octobre à 07:20 Paris (05:20 UTC)

| Catalogue | Versions distinctes contrôlées depuis le lancement | Initialement inconnues, désormais identifiées | Encore sans langue |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 4 653 | 88 | 30 106 |
| Norva Selection | 78 | 7 | 176 |
| Dino | 4 597 | 2 465 | 6 404 |
| MAX OTT | 3 629 | 2 185 | 15 320 |
| **Total de la cohorte** | **12 957** | **4 745** | **52 006** |

**1 064 contrôles supplémentaires en 61 min 29 s**, soit **1 038 contrôles techniques/h**, et **497 identifications supplémentaires**. Les 56 751 variantes de départ restent visibles. Le total global interrogé ensuite trouve 52 004 variantes / 40 395 fiches inconnues ; le gain utilise les sommes par source, puisque les requêtes sont successives.

**27 validations strictes réussies avec preuve complète** (Strng 5, Selection 5, Dino 5, MAX OTT 12), soit trois supplémentaires. **53 analyses complètes indéterminées avec profil courant correspondant** (6, 31, 11, 5), soit quatre supplémentaires depuis le relevé horaire de 04:19. Ces ensembles se recoupent avec les contrôles et identifications ; le débit technique n'est pas celui de la reconnaissance vocale.

### Deux expirations de finalisation et optimisation mesurée

Deux occurrences naturelles à 05:11 sur le premier Edge apportent enfin un code précis : **57014**, après **8 002 et 8 003 ms**. Le compteur générique de délais SQL reste à zéro car il ne couvre pas ce diagnostic ; il ne faut pas l'utiliser pour nier ces erreurs. La lecture des logs a été corrigée pour les couleurs ANSI et les clés entre guillemets, sans publier de message brut ni identifiant. L'étape SQL exacte interrompue reste inconnue ; l'échantillonnage ultérieur ne prouve aucune absence de verrou lors des échecs.

Une composante coûteuse est néanmoins mesurée : la sélection des destinataires d'un résultat film parcourt les variantes de 53 sources. Sa réécriture utilise le périmètre fournisseur et l'index des générations tout en conservant la vue visible canonique. Sur une coordonnée suivie : **1 918 ms → 4,542 ms**, et **1 328 081 → 427 accès aux blocs en mémoire**, avec le même destinataire. Ce chiffre concerne la requête, pas le RPC complet.

**23 assertions SQL isolées réussies**, dont huit comparaisons sur 35 combinaisons identité/fichier ; quatre comparaisons en lecture seule sur les catalogues réels confirment aussi les mêmes destinataires. Migration **`20261004054500_scope_audio_verification_recipients`** déployée à **05:45:39 UTC**, sans pause ni redémarrage. SHA-256 de la fonction : **`83bc052b380c5db8b4e7e188999491fd913f81619a8aa74f191ae666bd5fbc8d`**. Validation, ACL, admission, seuils, délais et baux restent inchangés. Conteneur de preuve arrêté. Détails : `2026-10-04-language-finalization-recipient-scope.md`.

### Santé et limites

À 05:21, deux Gateways sains, dispatcher sain, STOP absent, cron et admission actifs ; **812 lots métadonnées terminés**, contre 739 à 04:19. À 05:46 après déploiement : services toujours sains, capacité deux/deux, **850 lots terminés**. Aucun nouvel échec HTTP du dispatcher ; l'incident historique demeure compté.

Le travail Strng ayant échoué à 02:22 garde son report au **5 octobre à 02:22:08 UTC**, ses huit tentatives fournisseur et sa dernière capture à 01:31. Un autre travail Strng a terminé sa validation à 05:18. Le travail Dino sans capture a repassé l'admission à 05:02 ; son bail a expiré à 05:07 sans nouvelle preuve de capture. Une autre analyse Dino progresse à quatre fenêtres à 05:20. Les erreurs de métadonnées par entrée conservent leurs délais ; aucune reprise n'est forcée.

La diminution du coût SQL est prouvée ; **la disparition complète des expirations RPC ne l'est pas encore**. La campagne et la supervision restent **ACTIVES**, sans déclaration de clôture ni promesse de terminer les analyses vocales en une ou deux heures. Reçu : `2026-10-04-language-campaign-heartbeat-0720.json`.

À 05:50, l'audit distinct compte 27 validations / 57 analyses complètes indéterminées correspondant au profil courant ; les quatre clôtures supplémentaires ont précédé le déploiement. Aucun nouveau diagnostic de finalisation. À 05:51:54, 17 événements et dix lots avec tentatives ont été observés après publication ; aucune nouvelle capture stricte n'est prouvée dans cette courte fenêtre. Les reports de capacité et d'occupation sont conservés. Le prochain finaliseur naturel reste à vérifier.
