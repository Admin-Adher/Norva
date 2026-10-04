# Maintenance des langues — 5 octobre 2026, 01:05 Paris

Contrôles du 4 octobre à partir de 23:05 UTC. La campagne permanente reste
active ; ce relevé ne clôt pas les quatre films prioritaires. Les reçus locaux
sont conservés sous `.codex-artifacts/language-heartbeat-0105/`.

## Manifeste initial

Les relevés de 23:09 portent exclusivement sur les 56 751 variantes et
43 125 fiches initiales des quatre catalogues du compte contrôlé. Toutes les
variantes du manifeste restent visibles.

| Catalogue | Contrôles techniques uniques | Identifiées, compteur historique | Encore inconnues |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 8 004 | 138 | 30 056 |
| Norva Selection | 85 | 9 | 174 |
| Dino | 7 245 | 3 912 | 4 957 |
| MAX OTT | 5 786 | 3 444 | 14 061 |
| **Total** | **21 120** | **7 503** | **49 248** |

Depuis 21:49 : **491 contrôles techniques uniques et 79 identifications
supplémentaires**. Il reste 38 739 fiches inconnues selon ce compteur historique,
qui exclut les confirmations humaines. Les 113 contrôles des quinze dernières
minutes sont répartis entre Strng (107) et MAX OTT (6). Aucun débit de
reconnaissance vocale ou délai d'achèvement n'est extrapolé.

L'audit strict du manifeste reste à **38 validations complètes et 78 analyses
complètes indéterminées compatibles avec le profil courant**, comme à 22:00:41.
Ces ensembles recoupent les autres compteurs et ne s'additionnent pas.

## Activité globale

Le dispatcher découvre toujours **54 sources / 47 propriétaires**. Hors
manifeste initial, 50 sources de 46 propriétaires ont toutes été appelées :
**3 789 tentatives et 1 688 identifications en reçus cumulés**, soit +223 / +50
depuis 21:48. Ces reçus peuvent compter plusieurs opérations sur un même fichier.

Une validation stricte supplémentaire est terminée à **23:00:30**, hors des
sources et du manifeste initiaux : une piste attendue, terminée et documentée ;
empreinte, date, profil, taille du cache et variante active concordent. Elle
n'incrémente pas les totaux du manifeste ci-dessus. Six travaux ont progressé
depuis 22:00 ; ce n'est pas six analyses terminées.

Les priorités passent à **653 indices / trois propriétaires**, avec 7 119
variantes visibles et 367 variantes de films connues. Le périmètre a changé
depuis les 420 indices / 6 845 variantes / 180 connues du relevé précédent :
la différence ne constitue pas un gain comparable d'identifications.

La fenêtre dispatcher 22:00–23:09:56 contient 1 220 événements, dont 74 lots
avec tentative, 631 tentatives, 128 identifications et 26 échecs en reçus.
Aucun nouvel échec HTTP n'y apparaît. Les reports de capacité dominent
(978 événements), avec aussi des reports fournisseur et des circuits ouverts.
À 23:09:38 les deux Gateways déclarent deux places et aucun lecteur ; cette
disponibilité est ponctuelle. Le principal a dix storyboards différés.

## Quatre copies prioritaires

| Copie exacte | État à 23:06–23:10 UTC |
| --- | --- |
| Lost on a Mountain in Maine | Travail manuel existant : cinq fenêtres/reçus, sept tentatives, dernière capture 22:27:38. Report `PROVIDER_ACCOUNT_BUSY`, sélectionné par le sélecteur ordinaire. |
| The Legend of Ochi | Travail manuel existant : zéro capture/tentative fournisseur, report fournisseur. |
| Bolt from the Blue | Profil et cache exacts, ancien `PROFILE_CHANGED` conservé. Aucune admission supplémentaire : quotas de deux travaux manuels et quatre fournisseur atteints. |
| I Want to Live on Mars | Profil exact absent. Aucun nouveau POST ; une future demande exige une évolution observée des gardes. |

Lost progresse de deux à cinq reçus. **Trois** fenêtres anglaises sont qualifiées
(0,994023 / 0,957841 / 0,985339), une insuffisante et une faible (0,93953).
Le seuil de quatre preuves n'est pas atteint : aucune langue n'est publiée.
Les anciens reçus ne sont pas combinés aux nouveaux travaux. Aucune admission
en double, modification de seuil, relance humaine ou connexion fournisseur
opérateur n'a été effectuée pendant ces contrôles.

## Incident des confirmations humaines

Le registre conserve les cinq confirmations initiales (une espagnol, quatre
anglais). Leur projection retourne zéro à 23:08. L'unique prédicat différent
est l'époque globale de visibilité utilisateur ; les coordonnées de fichier,
source, titre, identité vérifiée, génération, configuration, visibilité et faits
techniques du profil sont tous inchangés. Seule la date de sonde est exclue de
la comparaison, conformément à la fonction existante.

L'époque utilisateur est passée de 131 810 à 131 853 ; dernière mise à jour
22:28:47. L'époque source reste 117 618. Ces dates ne prouvent pas l'opération
historique responsable. Le navigateur confirme le défaut sur la carte
Innocent Voices, revenue à « Langue non identifiée ».

La lecture du code et des fonctions déployées confirme que les enrichissements
éditoriaux et les publications audio Selection peuvent incrémenter cette époque
globale pour d'autres contenus. Ce mécanisme d'invalidation de cache ne signifie
pas que les cinq fichiers écoutés ont changé. Il n'identifie pas à lui seul
l'opération exacte responsable de chaque incrément historique.

La correction préparée retire seulement la comparaison avec cette ancienne
époque globale dans la projection. Toutes les gardes propres au fichier et à
la source, la visibilité réelle et le CAS d'écriture restent présents. Les
contrôles Edge au début et à la fin de la requête continuent de rejeter une
réponse qui traverse un changement d'époque courante. Aucune confirmation n'est
réécrite ni réenregistrée ; les dates et preuves d'écoute d'origine sont conservées.
Le script de républication ponctuelle préparé en préflight n'a pas été appliqué.

Une revue indépendante du SQL et des chemins catalogue/historique/lecture ne
relève pas d'objection bloquante. Les **34 tests JS** de projection, affichage et
finalisation des réponses réussissent. Les **63 assertions SQL** réussissent
dans PostgreSQL isolé, réseau désactivé, sans données clients. La régression
échoue sur l'ancienne fonction puis réussit sur la correction, y compris en
rejouant les migrations avec des fins de ligne CRLF. Le conteneur de preuve
est arrêté après conservation du résultat.

Migration : `20261005011500_revalidate_human_audio_visibility.sql`, SHA-256
`9984c92f1d4d70ce0ecd7564c2d4e5af2ed6195dc91d918127b1e755799cef78`.
Elle refuse une définition de départ inattendue, après normalisation des fins
de ligne. Code `6cf07a35814e99f2d668185c0d1402bf5e2b40e1`, PR 649.
Le préflight de production à 23:21:16 reste en lecture seule : cinq lignes
originales intactes, zéro résultat projeté, writer et ACL attendus.

**Correction intégrée et déployée à 23:23:33 UTC.** PR 649 intégrée dans main
par `f0259177ac7e55811e08cee0dc1f940606707b2f`, après réussite des contrats cloud,
types Edge, base jetable, parcours Web/mobile, acceptation GoTrue, politique
notifications et tests Android. Les constructions de paquets étaient encore en
cours lors de la fusion. La preuve SQL spécifique est celle décrite ci-dessus ;
la tâche CI « base jetable » couvre son propre graphe de migrations.

Application SQL unique avec limite d'attente de verrou de trois secondes et
transaction `REPEATABLE READ`. Les contrôles dans le même snapshot comparent les
cinq confirmations originales, observations automatiques, déclarations fournisseur,
variantes et travaux correspondants, plus définition du writer et ACL. Tous sont
inchangés. Cinq projections attendues vérifiées avant commit, zéro nouvelle ligne
humaine, zéro nouvelle écoute. Définition de lecture corrigée : MD5
`8e3ffa9461352c918024dfe68f6fe4aa` ; writer inchangé :
`6f33530afddceab3a785331edfd038c6`. Aucun redémarrage, pause de traitement,
nouveau bail ou appel média n'est nécessaire.

À 23:23:50–55, les API authentifiées des **deux Edge** restituent chacune les
cinq langues attendues avec provenance humaine dans les rayons et l'historique.
Rayons : 1 491 / 1 454 ms ; historique : 577 / 909 ms. Mesures ponctuelles,
pas un débit ou une garantie de latence. Le navigateur rechargé montre ensuite
Espagnol pour Innocent Voices, Anglais pour Proie, Pécheurs, California King et
Amoché/Broke. Capture `restored-audio-badges.jpg` et reçu `ui-badges.safe.json`.
Le navigateur est revenu aux rayons sans démarrer de lecture.

### Occupation du compte MAX OTT

À 23:15:26, la garde fournisseur de cinq minutes voit un marqueur `gateway`
rafraîchi à 23:15:20, malgré zéro lecteur et zéro bail actif de sonde/validation
du compte au même instant. Cette activité peut provenir d'une extraction en
arrière-plan : onze storyboards du compte ont des checkpoints depuis 22:00,
dont dix avec progression du nombre de tuiles ; l'un termine à 23:15:48.
Un checkpoint à 23:15:19,995 précède de peu le marqueur, mais le lien exact avec
chaque écriture n'est pas journalisé.

La concurrence réelle des storyboards et la garde fraîche sont prouvées ; aucun
processus bloqué ni motif pour forcer une connexion n'est établi. À 23:17:17,
neuf storyboards sont encore différés. Aucun marqueur, bail ou délai n'est supprimé.

Au contrôle final de 23:24:15, Lost conserve cinq reçus mais a repris naturellement
une huitième tentative, reportée `LANGUAGE_CAPTURE_INFERENCE_DEFERRED` ; aucun
sixième reçu ni langue publiée n'est encore prouvé. Ochi est maintenant sélectionné
par le worker, avec zéro capture. Aucune admission opérateur supplémentaire.

## Santé et incidents historiques

Deux Edge sains, deux Gateways HTTP 200 / ok ; admissions, crons et dispatcher
permanent actifs, découverte conservée, un appel dispatcher en vol au maximum.
Aucun redémarrage ni déploiement n'a été effectué par les audits.

Santé à 23:24:14 après correction SQL : deux Edge et Gateways sains, dates de
démarrage inchangées, admission/crons/dispatcher actifs. Les reçus hors manifeste
atteignent alors 3 818 tentatives / 1 698 identifications ; le relevé de 23:09
ci-dessus reste horodaté séparément. Les compteurs uniques du manifeste n'ont
pas été réexécutés après correction.

Aucun diagnostic de finalisation dans les fenêtres Edge depuis 21:38 ; les
quatre erreurs HTTP historiques restent conservées. Le finaliseur Strng de
02:22 reste reporté au 5 octobre à 02:22:08 UTC. Les deux quarantaines Dino
restent partielles, sans forçage. Le travail Strng autrefois suivi pour reset
de checkpoint a six reçus et est complet mais indéterminé depuis **15:44**,
avec 35 tentatives ; ce résultat historique n'est ni un nouveau succès de
cette heure ni une langue identifiée. Son délai reste le 5 octobre à 15:44.

## Google Play et parcours de récupération

Les pages de publication Mobile 46 et TV 38 ont été relues : toutes deux
restent **en cours d'examen**, après les vérifications rapides Google. Aucune
action demandée, aucun nouvel import ou redémarrage d'examen. La disponibilité
sur Google Play n'est pas encore établie. Les quatre contrôles de la PR
documentaire 648 sont désormais réussis, paquets Android et Windows compris.

Le parcours Web de récupération reste en ligne. HIT original et les corruptions
distantes restent ouverts ; aucun nouvel essai média ou des alias n'a été lancé.
Le suivi Play se terminera après publication effective des deux versions, sans
arrêter la maintenance permanente des langues.
