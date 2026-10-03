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

