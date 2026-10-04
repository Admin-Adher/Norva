# Accélération de la campagne des langues — 3 octobre 2026

## Demande et périmètre

Réduire le délai de la campagne de 56 751 versions initialement sans langue sur les quatre catalogues contrôlés. La cible demandée est une à deux heures. Cela exigerait environ 28 000 à 57 000 versions examinées par heure. Le premier relevé unique donnait 295 versions en 43,4 minutes, soit 408 par heure ; ce débit inclut les métadonnées techniques et les profils, pas uniquement une analyse vocale complète.

## Correction déployée à 17:15:11 UTC

Le dispatcher avait un seul délai par source, alternait une requête de métadonnées et deux requêtes de profil, et soumettait toutes ces requêtes au créneau réservé aux profils. Ainsi une file d'analyse stricte pleine suspendait aussi les vérifications de métadonnées, qui n'ont pas besoin d'ajouter un travail à cette file.

Le format d'état 2 sépare les échéances des métadonnées et des profils. Les métadonnées peuvent avancer en dehors du créneau des profils. Les profils conservent leur priorité dans ce créneau. Les lots finis tournent entre fournisseurs. Les compteurs antérieurs sont conservés lors de la migration.

Une seule requête de campagne reste en vol. Les limites SQL et Gateway, les baux fournisseur, les contrôles de visibilité/propriétaire, les quarantaines et la priorité de lecture sont inchangés. Une occupation fournisseur réelle ou une issue HTTP incertaine suspend toujours les deux voies. Le worker strict existant garde sa place dans la limite réseau de production.

Empreinte du worker déployé : `73ae1152d3d62d1551e6bb86ce9d82f6d05a1dbcf4770d49cbfa1d2a3bb9ea73`.

## Vérification

`node --test tests/language-campaign.test.mjs tests/provider-audio-metadata-batch.test.js` : **20 tests réussis**. Couverture : migration avec bail incertain, absence de doublon d'admission, blocage fournisseur commun, file audio pleine sans suspension des métadonnées, rotation des fournisseurs, créneau de l'analyse, plafonds et temporisation des requêtes fournisseur.

Le seul conteneur relancé est `norva-language-campaign`. L'arrêt a attendu la requête en cours ; aucun bail n'a été supprimé. La sauvegarde du programme précédent et de l'état existe dans le répertoire privé de campagne. L'état 2 est effectivement chargé, le conteneur est sain et une seule requête est observée en vol.

## Mesures

Le script en lecture seule `ops/hetzner/scripts/language-campaign-progress-20261003.py` recoupe le manifeste initial avec les horodatages des déclarations fournisseur, des profils et de la progression d'analyse stricte. Il compte l'union des versions distinctes ayant reçu au moins un contrôle depuis le début. Les reports de capacité et répétitions ne gonflent pas ce total.

À 17:15:10 UTC, juste avant déploiement : **309 versions contrôlées**, en 51,1 minutes depuis le début. La fenêtre de mesure après modification conserve ce point de départ. Une langue déjà enregistrée puis rendue visible par une correction n'est pas comptée comme une nouvelle sonde.

La cible d'une à deux heures n'est pas validée. Le parcours actuel limite les métadonnées à une requête par seconde et par compte fournisseur, avec deux opérations réseau au maximum ; la campagne garde une place pour les captures strictes. Les médias sans déclaration demandent encore leurs extraits et leur consensus. La capacité théorique des simples requêtes n'est donc pas une promesse de délai d'identification complète.

La campagne et sa supervision horaire continuent. La clôture reste conditionnée à la classification de chaque version, avec distinction entre langue identifiée, résultat inconclusif et erreur de transport.

## Deuxième cause : résultat terminé remplacé par un conflit de cache

Le contrôle réel a ensuite reproduit un HTTP 409 `CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN` après environ 38 secondes. Il ne provenait pas de l'accusé SQL individuel : la finalisation HTTP rejetait le résultat agrégé parce que l'époque de cache du catalogue avait changé pendant le lot. Les écritures individuelles étaient pourtant déjà enregistrées. Le dispatcher traitait alors l'issue comme incertaine et attendait 21 minutes.

Les deux parcours bornés (`providerMetadataOnly`, `automaticUnknowns`, films avec propriétaire et source explicites) enregistrent maintenant un reçu de traitement terminé. Ils réutilisent la finalisation existante sans rejouer les appels fournisseur. L'accès à l'enrichissement et la visibilité sont revérifiés ; la génération, la révision de tête, la configuration et la visibilité de source doivent rester identiques. Seule l'avancée monotone de l'époque de cache utilisateur est adoptée par l'utilitaire partagé existant.

Le premier candidat a correctement échoué lors du contrôle d'une époque utilisateur modifiée ; ce cas a été intégré au test, qui exécute désormais la véritable fonction d'adoption de génération. **34 tests ciblés passent**, incluant changement réel de source, révocation d'accès, jeton invalide, publication concurrente et absence de second appel fournisseur. Les contrôles CI cloud et les constructions Android téléphone, TV et Windows ont réussi.

Essai corrigé sur le candidat isolé, avec le vrai MAX OTT : **HTTP 200, 9 métadonnées vérifiées en 36,75 secondes, 6 identifications, 3 résultats inconclusifs, aucun échec ni report dans ce lot**. Cela valide le reçu ; un lot de 9 ne certifie pas le débit soutenu de toute la campagne.

Code intégré par la PR 606, commit de fusion `99cf6f714b401172744f5f46c95de0f5988a5355`. Le déploiement des deux réplicas utilise la vérification des empreintes, un candidat isolé, une attente des travaux actifs et une restauration automatique de la configuration d'admission après cette attente.

Les deux réplicas ont été publiés à **17:42:17 UTC**. Empreinte de `norva-playback/index.ts` : `1cd3a5911fa2ab159a3578230b5fe8d8ded4e400e5ca795112ab08d261496331`. Santé des deux réplicas confirmée. Le candidat isolé a ensuite été arrêté.

La fenêtre naturelle sans travail actif ne se présentant pas, les nouvelles admissions d'enrichissement et le cron strict 159 ont été suspendus le temps de laisser finir les tâches en cours. L'état initial (`enrichment_paused=false`, cron strict actif) a été restauré dans le bloc `finally`, et le marqueur temporaire STOP du dispatcher retiré. Aucun bail SQL n'a été effacé et aucune analyse active n'a été annulée.

Premiers lots autonomes après déploiement : MAX OTT, **21 contrôles / 10 identifications** ; Strng, **16 contrôles / 16 résultats inconclusifs**. Les réponses ne présentent plus le conflit de finalisation observé avant correction. Dino respecte toujours son report d'occupation fournisseur. Ces compteurs de lots sont distincts du rapprochement des versions uniques.

## Débit prolongé et coût SQL

La première fenêtre de 2,55 minutes a donné 55 nouveaux contrôles uniques, soit environ 1 293/h. Cette pointe **ne s'est pas maintenue** : deux requêtes ont ensuite échoué sur un délai SQL, et le dispatcher a conservé son délai de sécurité de 21 minutes. À 18:02:04 UTC, la fenêtre de 19,42 minutes ne comptait que 79 nouveaux contrôles, soit 244/h. L'extrapolation initiale de deux jours n'est donc pas un délai confirmé.

Les statistiques cumulées de l'appel `claim_catalog_provider_audio_metadata` indiquaient 1,57 seconde en moyenne et 7,97 secondes au maximum sur 1 071 appels réussis. Le contrôle en lecture seule d'une page réelle de 256 candidats a pris 2 798 ms, contre 513 ms pour ses 32 premiers candidats. Cette mesure porte sur les vérifications d'éligibilité, pas sur le débit réseau global, et ne reproduit pas à elle seule toutes les expirations.

La migration `20261003181000` réduit à 32 la page de candidats par transaction, sans changer les conditions d'éligibilité, l'avancement du curseur, les baux ni les droits. Une page entièrement connue rend la main puis le prochain appel continue après son dernier identifiant. **31 contrôles SQL réussis** dans une copie de schéma sans réseau ni données de production, dont trois contrôles de continuation entre pages ; les **34 tests JavaScript** passent également.

Déploiement SQL confirmé à **18:01:46 UTC**, sans redémarrage : empreinte de la fonction `061190b4256e965731375d5d9e6083824a11afd00b259fe50565e3c5e2e8a693`. La comparaison exacte avant/après confirme que seule la taille 256 → 32 diffère. L'installation autonome n'a pas de registre de migrations Supabase CLI ; le script SQL, l'ancienne définition privée et le reçu de déploiement sont conservés. Une première tentative incluant un registre absent a été entièrement annulée par transaction avant application correcte.

À 18:02 UTC : **493 versions distinctes contrôlées depuis le lancement**, et le rapprochement du filtre effectué à 18:00 UTC donne **266 versions initialement inconnues désormais identifiées**, 56 485 encore inconnues. Ces deux nombres ne sont pas interchangeables : une déclaration récupérée peut rester inconclusive, et une correction de projection peut rendre visible une langue déjà enregistrée.

La cible d'une ou deux heures demeure non atteinte. Le débit durable après la réduction de page reste à mesurer ; aucun nouveau délai de fin complète n'est certifié. La campagne est active, les admissions d'enrichissement sont ouvertes et le cron d'analyse stricte est actif.

Le contrôle CI a détecté un identifiant de migration déjà utilisé. Le fichier est référencé définitivement sous `20261003181000` ; le contenu SQL et la fonction déployée sont identiques à ceux testés. Le reçu initial conserve le nom utilisé lors de l’application.

## Mesure soutenue à 20:12 UTC

Le rapprochement du manifeste donne 657 versions contrôlées à 18:11:21, 2 213 à 19:11:47 et **3 880 à 20:12:27**. Les deux fenêtres valent respectivement environ **1 545 et 1 649 contrôles uniques/h**, soit 1 597/h sur 121 min 6 s. Les expirations SQL responsables des reports de 21 minutes n'ont pas réapparu dans ces relevés : aucun échec HTTP du dispatcher depuis 18:01:46. Les journaux Edge actuels commencent à leur recréation de 19:23 ; les relevés antérieurs conservent la preuve de la période précédente.

Ces deux heures établissent un débit observé de **contrôles techniques** ; elles ne permettent pas d'annoncer le même débit de reconnaissance vocale ni une échéance certaine de fin. À 20:12, 1 247 variantes de la cohorte ont une langue identifiée, 55 504 restent inconnues. À 20:32, seules huit versions ont un travail strict passé à `verified` depuis le lancement, avec progression fournisseur et preuve pour toutes les pistes attendues. Ces ensembles se recoupent et ne doivent pas être additionnés.

Un blocage distinct de la file stricte a été corrigé à 20:28 : clôture des travaux devenus obsolètes par changement de profil observé, sans effacer leurs preuves ni toucher aux travaux actifs. Deux reprises de progression fournisseur sont observées après déploiement ; le débit vocal prolongé reste à mesurer. Voir `2026-10-03-language-worker-stale-profile.md` et le relevé `2026-10-03-language-campaign-heartbeat-2012.json`. La campagne continue, avec les limites de production et sans promesse de clôture en une ou deux heures.

## Mesure à 21:12 UTC

**5 139 variantes distinctes contrôlées**, soit +1 259 en 59 min 47 s depuis le relevé précédent : **1 263 contrôles/h**. Le rythme varie, et la moyenne de 1 597/h observée sur les deux heures précédentes n'est pas une garantie pour les suivantes. Aucune nouvelle erreur HTTP du dispatcher ni expiration SQL n'est détectée ; les gardes de capacité et d'occupation fournisseur reportent encore certains appels.

La projection affiche **1 757 variantes identifiées / 54 994 inconnues**. À 21:15, l'audit strict trouve **neuf validations réussies** depuis le lancement et **14 résultats de consensus indéterminés avec toutes les fenêtres enregistrées**, toujours rattachés au même profil observé. Les derniers ne reçoivent pas une langue arbitraire. Un nouveau travail Dino a été vérifié à 21:05:51, après le correctif de la file. La campagne continue ; aucun délai de clôture de toutes les analyses vocales n'est certifié.

## Mesure à 22:12 UTC — 4 octobre 00:12 Paris

**6 148 variantes distinctes contrôlées**, soit +1 009 en 60 min 16 s : **1 004 contrôles techniques/h**, contre 1 263/h à la fenêtre précédente. **2 185 variantes identifiées**, soit +428 ; **54 566 variantes / 41 884 fiches encore inconnues**. La cohorte initiale est intégralement conservée.

Un nouvel échec HTTP 500 du dispatcher apparaît sur les métadonnées MAX OTT à 21:20:10 UTC, accompagné du diagnostic SQL `57014` sur les deux Edge. Le premier lot terminé après cet incident est observé à 21:42:01 UTC : deux contrôles et deux identifications. La protection de 21 minutes a donc de nouveau réduit la fenêtre utile. Aucun nouvel échec HTTP n'est observé jusqu'à 22:18:57. La cause SQL précise n'est pas prouvée par les journaux conservés ; les 563 ms de durée moyenne cumulée des appels d'admission réussis ne caractérisent pas l'appel ayant expiré. La réduction de page a amélioré le rythme, mais n'a pas supprimé toutes les expirations.

L'audit strict relève **11 validations réussies avec preuve complète** (+2) et **22 analyses complètes mais indéterminées, rattachées au profil courant** (+8). Ce débit strict reste très inférieur au débit de simples contrôles de métadonnées. Les ensembles se recoupent et ne sont pas additionnés. Il n'est toujours pas possible de garantir une date de clôture exhaustive.

Deux Gateways sains, dispatcher actif sans redémarrage, admission ouverte et cron strict actif. La capacité adaptative observée varie entre un et deux travaux sans changement de configuration. Aucun bail ni résultat n'a été effacé ; aucune nouvelle modification du traitement n'a été déployée pendant ce contrôle. Reçu : `2026-10-04-language-campaign-heartbeat-0012.json`.

## Mesure à 23:12 UTC — 4 octobre 01:12 Paris

**7 276 contrôles techniques distincts**, soit +1 128 en 60 min 17 s : environ **1 123/h**. **2 635 variantes identifiées** (+450), **54 116 variantes / 41 490 fiches inconnues**. La cohorte initiale reste intégralement visible.

Les analyses strictes comptent **15 validations réussies** (+4) et **28 analyses complètes indéterminées rattachées au profil courant** (+6). Ces mesures se recoupent avec les contrôles techniques ; elles ne permettent toujours pas de prévoir la date de clôture exhaustive. L'attente d'un travail Strng au bail expiré est documentée : sa position dans la file globale passe de quatre à trois, sans profil obsolète, mais sa reprise n'est pas encore établie à 23:17.

Aucun nouvel échec HTTP du dispatcher ni délai SQL dépassé dans les deux Edge depuis l'incident antérieur. Services sains, admission et cron actifs, priorité de lecture et limites fournisseur conservées. Aucune nouvelle modification de production pendant ce contrôle. Reçu : `2026-10-04-language-campaign-heartbeat-0112.json`.

## Mesure du 4 octobre à 00:13 UTC — 02:13 Paris

**8 117 contrôles techniques distincts**, soit +841 en 60 min 35 s : **833/h**. **2 810 variantes identifiées** (+175), **53 941 variantes / 41 382 fiches inconnues**. Aucune variante initiale supprimée. Le ralentissement coïncide avec les reports d'occupation et les protections des sondes Dino et MAX OTT, encore actives à 00:13 ; aucune nouvelle expiration SQL n'apparaît.

**17 validations strictes réussies** (+2) et **33 analyses complètes indéterminées avec profil courant correspondant** (+5). L'ancien travail Strng au bail expiré a repassé l'admission, mais attend désormais pour occupation fournisseur sans nouvelle progression de capture : il ne gonfle aucun compteur de sonde ou d'analyse terminée.

Les Gateways et le dispatcher sont sains ; la campagne continue en conservant ses limites et protections. Aucune modification de production. Le débit technique ne fournit toujours pas de délai fiable pour achever l'ensemble des analyses vocales. Reçu : `2026-10-04-language-campaign-heartbeat-0213.json`.

## Mesure du 4 octobre à 01:14 UTC — 03:14 Paris

**8 465 variantes distinctes contrôlées**, soit +348 en 61 min 26 s : **340 contrôles techniques/h**, contre 833/h précédemment. **2 921 identifiées** (+111), **53 830 variantes / 41 356 fiches inconnues**, cohorte intégralement visible. Les délais de capacité, d'occupation et de protection fournisseur persistent, sans nouvelle expiration SQL.

Reprise automatique Dino prouvée à 00:51:27 UTC : 29 contrôles et 16 identifications dans le premier lot après protection, puis dix lots avec tentatives jusqu'à 00:58. MAX OTT attend encore l'échéance de 01:56 ; sa nouvelle validation stricte à 00:51 finalise une capture antérieure et n'ajoute pas une version distincte au total contrôlé.

**18 validations strictes réussies** (+1) et **38 analyses complètes indéterminées avec profil courant correspondant** (+5). Aucun bail de capture/finalisation expiré dans la cohorte au relevé de 01:14. Les services sont sains et la campagne reste active, sans modification de production ni prévision fiable de fin complète. Reçu : `2026-10-04-language-campaign-heartbeat-0314.json`.

## Mesure du 4 octobre à 02:15 UTC — 04:15 Paris

**9 677 contrôles distincts**, soit +1 212 en 60 min 46 s : **1 197 contrôles techniques/h**, contre 340/h dans la fenêtre précédente. **3 503 variantes identifiées** (+582), **53 248 variantes / 41 122 fiches inconnues**. MAX OTT a repris automatiquement après protection, premier lot à 01:57:02 ; Dino progresse également. Aucune nouvelle expiration SQL détectée.

**20 validations strictes réussies** (+2) et **43 analyses complètes indéterminées avec profil courant correspondant** (+5). Les compteurs se recoupent. Ces résultats ne valident toujours pas une clôture en une ou deux heures.

Un correctif de priorité de finalisation est déployé à 02:21:45, après reproduction isolée et 21 contrôles SQL. Le travail Strng concerné est repris par le cron en 15 secondes, puis rencontre une erreur distincte de finalisation. Cette reprise de file **n'est pas une analyse terminée ni une nouvelle sonde**. Le report normal et les preuves sont conservés ; la cause RPC précise reste à établir. Gateways sains et 601 lots de métadonnées terminés au contrôle de 02:25. Reçu : `2026-10-04-language-campaign-heartbeat-0415.json`.

## Mesure du 4 octobre à 03:18 UTC — 05:18 Paris

**10 938 contrôles distincts**, soit +1 261 en 62 min 28 s : **1 211 contrôles techniques/h**. La cohorte compte **3 930 identifiées** (+427) et **52 821 inconnues**. Le contrôle global effectué ensuite trouve une variante inconnue de moins ; les requêtes ne sont pas atomiques. **22 validations strictes réussies** (+2) et **48 analyses complètes indéterminées** (+5), avec profil courant correspondant ; ces ensembles se recoupent.

Pas de nouvelle erreur HTTP du dispatcher ni diagnostic SQL avant le déploiement ; Strng conserve son report de finalisation et ses preuves. Un diagnostic d'erreur limité est déployé sur les deux Edge après 45 tests ciblés, sans modification de l'admission, des seuils ou des reprises. Une pause technique des nouveaux lancements dure environ **2 min 28 s**, de 03:24:53 à 03:27:22, après la fenêtre de débit ci-dessus ; aucun travail actif n'est annulé. Le relevé suivant devra inclure cette pause dans son temps mural.

La campagne reprend automatiquement. Gateways sains, 681 lots de métadonnées terminés à 03:29 ; les logs des nouveaux Edge ne remplacent pas l'historique conservé. La cause de l'erreur de finalisation n'est pas encore établie et aucun délai de clôture exhaustive n'est certifié. Reçu : `2026-10-04-language-campaign-heartbeat-0518.json`.

## Mesure du 4 octobre à 04:19 UTC — 06:19 Paris

**11 893 contrôles distincts**, soit +955 en 61 min 4 s : **938 contrôles techniques/h**. **4 248 variantes identifiées** (+318), **52 503 variantes / 40 808 fiches encore inconnues**. Toute la cohorte initiale reste visible. Les 2 min 28 s du drainage précédent sont comprises dans la durée murale, sans correction favorable du débit.

**24 validations strictes réussies** (+2) et **49 analyses complètes indéterminées** (+1), avec profil courant correspondant. Ces compteurs se recoupent avec les contrôles techniques ; aucune prévision certaine de fin exhaustive n'en est déduite.

Un retard distinct du consensus des fenêtres est reproduit puis corrigé : une piste MAX OTT avec six reçus attendait depuis 03:41. Migration déployée à **04:31:27 UTC** après **34 contrôles SQL isolés**. Le cron clôt son consensus à **04:32:00**, indéterminé, sans nouvelle capture ni langue attribuée. À 04:33, les compteurs stricts passent à 24 réussites / 51 analyses indéterminées ; le second résultat supplémentaire est Selection, terminé avant correction à 04:22. Ces clôtures ne sont pas des contrôles techniques uniques supplémentaires.

Gateways sains, dispatcher, admission et cron actifs. Aucun nouvel échec HTTP du dispatcher ni diagnostic SQL depuis le dernier redémarrage Edge ; l'incident historique est conservé. La finalisation SQL Strng reste en report jusqu'au 5 octobre, avec diagnostic précis encore manquant. Reçu : `2026-10-04-language-campaign-heartbeat-0619.json`.

## Mesure du 4 octobre à 05:20 UTC — 07:20 Paris

**12 957 contrôles distincts**, soit +1 064 en 61 min 29 s : **1 038 contrôles techniques/h**. **4 745 variantes identifiées** (+497) et **52 006 encore inconnues** dans la cohorte intégralement visible. Le contrôle global suivant compte 52 004 variantes / 40 395 fiches inconnues ; le gain est calculé à partir des sommes par source.

**27 validations strictes réussies** (+3) et **53 analyses complètes indéterminées** (+4), avec profil courant correspondant. Les ensembles se recoupent. Le débit technique ne permet toujours pas d'annoncer une fin exhaustive des analyses vocales.

Deux erreurs naturelles de finalisation à 05:11 retournent **57014**, après environ huit secondes. Une requête de sélection des destinataires est effectivement trop large : **1 917,982 ms** et 1 328 081 accès aux blocs en mémoire. Une réécriture ciblée mesure **4,542 ms** / 427 blocs sur la même coordonnée. **Ce gain local ne représente pas le gain de la campagne entière et n'établit pas à lui seul la cause exacte des expirations.**

Après 23 assertions SQL isolées et quatre comparaisons d'ensembles en production, la migration est déployée à **05:45:39 UTC**, sans pause, appel fournisseur ni mutation directe de travaux. Les services sont sains, la campagne continue et le report Strng jusqu'au 5 octobre est conservé. Aucun nouveau seuil ou parallélisme n'est appliqué. Reçu : `2026-10-04-language-campaign-heartbeat-0720.json`.


## Contrôle du 4 octobre à 06:34 UTC — 08:34 Paris

**14 473 versions distinctes contrôlées**, soit +1 516 en 73 min 59 s : environ **1 229 contrôles techniques/h**. **5 165 variantes identifiées** (+420), **51 586 inconnues** dans la cohorte entièrement visible. La requête globale suivante compte 51 581 variantes / 40 082 fiches inconnues. Les contrôles, identifications et analyses strictes se recoupent.

L'audit strict compte **27 validations réussies**, inchangé, et **60 analyses complètes indéterminées** avec profil courant correspondant (+7 depuis 05:20). Les captures reprennent sur les quatre sources, mais aucune nouvelle validation réussie ne démontre encore le RPC complet après l'optimisation SQL de 05:45. Les deux anciennes erreurs 57014 restent conservées, sans nouveau diagnostic à 06:35.

Un défaut de temporisation est reproduit puis corrigé : **472 reports de lecture active**, sans tentative fournisseur, revenaient avec un délai de 1,5 seconde. Ils attendent désormais trois minutes. **21 tests réussis**, déploiement du seul dispatcher à **06:38:47 UTC**, arrêt gracieux et compteurs conservés. Aucune limite, quarantaine ou reprise forcée. Le gain de cette réduction des appels inutiles reste à mesurer ; il n'est pas présenté comme une accélération prouvée des analyses vocales. Voir `2026-10-04-language-live-session-backoff.md` et le reçu `2026-10-04-language-campaign-heartbeat-0834.json`.


## Contrôle du 4 octobre à 08:27 UTC — 10:27 Paris

| Catalogue | Versions distinctes contrôlées | Initialement inconnues, désormais identifiées | Encore sans langue |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 6 212 | 119 | 30 075 |
| Norva Selection | 84 | 9 | 174 |
| Dino | 5 568 | 2 995 | 5 874 |
| MAX OTT | 4 773 | 2 864 | 14 641 |
| **Total de la cohorte** | **16 637** | **5 987** | **50 764** |

**+2 164 contrôles techniques distincts en 113 min 12 s**, environ **1147/h**, et **+822 identifications** depuis le relevé de 06:34 UTC. Les 56 751 variantes initiales restent visibles. Le contrôle global suivant trouve 50 762 variantes / 39 574 fiches inconnues : les requêtes sont successives. Le gain est calculé à partir des sommes par source, sans utiliser le total global ultérieur.

**32 validations strictes réussies avec preuve complète** (+5 : Selection 1, Dino 1, MAX OTT 3), et **69 analyses complètes indéterminées correspondant au profil courant** (+9). Ces ensembles se recoupent avec les contrôles techniques et identifications. Le débit technique ne permet pas d'estimer la fin de toutes les analyses vocales.

### Finalisations naturelles après correction SQL

Les cinq nouveaux succès sont postérieurs à la correction de sélection des destinataires de 05:45:39 UTC. Le contrôle ciblé de 08:33 confirme, pour chacun, toutes les pistes terminées, les preuves complètes, ainsi que l'empreinte et le profil courant correspondants. Horaires UTC : Selection 06:42:26 ; Dino 07:23:21 ; MAX OTT 07:09:28, 07:18:22 et 08:20:21. **La réussite de finalisations complètes après publication est désormais prouvée** ; elle n'établit ni la cause exacte des expirations historiques ni leur disparition définitive.

Les deux anciens travaux au bail expiré ont été repris naturellement : MAX OTT est vérifié à 07:18:22 ; Strng à 07:50:38. Le second appartient à la source contrôlée mais **pas au manifeste initial** : il ne s'ajoute pas aux 32 validations de la campagne. L'autre finaliseur Strng, celui de l'erreur SQL à 02:22, reste distinct et reporté au **5 octobre à 02:22:08 UTC**, avec huit tentatives fournisseur et dernière capture à 01:31 inchangées.

### Quarantaines, temporisation et santé

Deux travaux Dino sont automatiquement mis en quarantaine pour absence de progression à 07:26:48 et 08:26:15 UTC. Ils possèdent seulement deux et une fenêtres sur six, après six et cinq tentatives fournisseur. Ils restent **incomplets**, sans langue attribuée ni indisponibilité définitive affirmée. Aucun bail, délai, compteur ou quarantaine n'est modifié.

À 08:28, les deux Gateways répondent sainement, capacité deux/deux, admission et cron strict actifs, dispatcher sain et STOP absent. Les logs conservés du dispatcher incluent toujours l'ancien HTTP 500 du 3 octobre à 21:20 ; **aucun nouvel échec HTTP après la correction du dispatcher**, jusqu'à 08:31:52. Depuis cette correction : 302 événements, dont 174 lots avec au moins une tentative, qui ne sont pas des comptes de fichiers distincts. Aucun nouveau diagnostic de finalisation : les deux 57014 de 05:11 sont toujours conservés ; le compteur générique SQL ne les couvre pas.

Aucun report naturel `live-session` depuis le déploiement de 06:38 jusqu'à ce contrôle. La temporisation de trois minutes reste couverte par les tests de régression, **mais son application en situation réelle n'a pas encore été observée**. L'absence de lecture active ne démontre pas le gain du correctif. Les reports fournisseur et de capacité continuent d'être respectés.

Aucune modification de production pendant ce contrôle. Campagne et supervision **ACTIVES**, clôture non atteinte. Reçu agrégé : `2026-10-04-language-campaign-heartbeat-1027.json`.
