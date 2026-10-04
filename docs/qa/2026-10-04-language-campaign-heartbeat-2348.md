# Maintenance des langues — 4 octobre 2026, 21:48 UTC / 23:48 Paris

La maintenance permanente reste active pour les comptes actuels et futurs. Ce
contrôle ne clôt ni le manifeste initial ni les quatre fichiers prioritaires
encore sans confirmation. Reçu agrégé :
`2026-10-04-language-campaign-heartbeat-2348.json`.

## Manifeste initial immuable

Les requêtes successives de 21:48–21:49 portent uniquement sur les 56 751
variantes / 43 125 fiches initiales de quatre catalogues du compte contrôlé.
Toutes les variantes du manifeste restent visibles.

| Catalogue | Contrôles techniques uniques | Identifiées selon le compteur historique | Encore inconnues |
| --- | ---: | ---: | ---: |
| Strng IPTV 8K | 7 664 | 135 | 30 059 |
| Norva Selection | 85 | 9 | 174 |
| Dino | 7 100 | 3 838 | 5 031 |
| MAX OTT | 5 780 | 3 442 | 14 063 |
| **Total** | **20 629** | **7 424** | **49 327** |

Depuis le relevé de 20:08 : **+182 contrôles techniques uniques et +62
identifications**. Douze contrôles ont été observés dans les quinze dernières
minutes, sur Strng. Le compte initial conserve 38 765 fiches sans langue selon
ce compteur. Celui-ci exclut les confirmations humaines publiées : il ne remet
pas en cause les badges espagnol d'Innocent Voices et anglais de Prey.

L'audit strict compte **37 validations complètes** et **78 analyses complètes
indéterminées compatibles avec le profil courant**, inchangées depuis 20:08.
Ces ensembles recoupent les contrôles techniques et les identifications ; ils
ne s'additionnent pas. Aucun débit de reconnaissance vocale, total global de
variantes uniques, classement exhaustif des indisponibilités ou délai de fin
n'est établi par ces audits.

**Complément à 22:00:41 UTC (5 octobre 00:00 Paris)** : une nouvelle validation
Dino du manifeste initial a réussi à **21:57:11**. Piste attendue/terminée et
preuve complète : 1/1/1 ; variante dans la génération active, cache, empreinte,
date, profil et taille concordants. L'audit strict relancé confirme désormais
**38 validations complètes / 78 analyses complètes indéterminées au profil
courant**. Le tableau des identifications et contrôles ci-dessus conserve son
horodatage 21:48–21:49 ; il n'est pas incrémenté par extrapolation.

## Découverte globale et titres affichés

À 21:48, le service découvre **54 sources / 47 propriétaires**, dont 50 sources
de 46 propriétaires hors manifeste initial, toutes déjà appelées. Leurs
**3 566 tentatives / 1 638 identifications** sont des reçus cumulés, susceptibles
de répéter des fichiers. Ils ne s'ajoutent pas aux chiffres uniques ci-dessus.

La découverte passe de 53 à 54 sources à **20:38:52**, puis appelle la source
supplémentaire à 20:38:59. Celle-ci existait depuis septembre ; sa configuration
était déjà prête lors du contrôle. Le changement précis de son éligibilité
n'est pas observé. Il s'agit d'une inclusion effective supplémentaire, et non
d'une preuve de création d'un nouveau compte ou import. À 21:50:55, cette
source totalise 94 appels de dispatcher, 131 tentatives et 60 identifications
en reçus, sans certification de fichiers uniques.

Les 420 indices de priorité, 6 845 variantes visibles et 180 variantes de films
avec langue connue sont inchangés depuis 20:08. Les dates des indices peuvent
être rafraîchies ; les compteurs « depuis priorité » ne sont pas des différences
monotones entre relevés. Les inventaires des séries prioritaires initiales ne
présentent toujours pas de progression démontrée dans cet audit.

## Capacité : reprise réelle, sans modification des limites

La dernière progression fournisseur d'un travail strict est désormais **21:46:06**,
postérieure à celle de 18:36 du précédent relevé. Ce travail a conclu
indéterminé ; la dernière validation stricte réussie globale reste celle de
17:44. L'audit global utilise une borne historique fixe à 10:05 pour certaines
agrégations, pas automatiquement l'heure du heartbeat précédent.

À 21:50, le Gateway principal déclare une capacité de zéro pour
`foreground-work`, avec une opération active et quatre travaux prioritaires
en attente. Le secondaire est libre. À **21:51:15**, le principal retrouve
naturellement deux places, zéro opération active et zéro travail prioritaire
en attente. Les journaux montrent 89 checkpoints de storyboards sur 13 travaux
depuis 20:08 ; douze ont une progression réelle du nombre de vignettes.

Ces observations établissent une concurrence effective des travaux prioritaires
et une libération naturelle, pas la cause exacte de chaque report historique.
Le contrôle d'admission stricte courant consulte le Gateway principal ; la
capacité libre du secondaire ne certifie pas qu'elle soit disponible pour ce
circuit. Aucun processus bloqué ni défaut justifiant de changer les limites
n'est démontré. La file différée et ses délais sont conservés.

## Quatre fichiers ciblés

À 21:49, Lost on a Mountain in Maine conserve un ancien travail expiré avec un
reçu ; Ochi un travail expiré sans reçu ; Bolt un ancien `PROFILE_CHANGED`
sans reçu. Leurs profils actuels et caches exacts concordent. Mars n'a pas de
profil exact. Les anciens travaux et leurs résultats restent conservés.

Innocent Voices et Prey restent confirmés humainement et publiés. Aucune
nouvelle demande n'est créée pour ces films ni pour les trois autres copies
confirmées humainement. L'ancien travail automatique Prey a expiré, ce qui
ne retire pas son badge humain et ne constitue pas une analyse terminée.

Trois requêtes ordinaires, séquentielles et sans réessai automatique ont été
effectuées après prélecture des profils, anciens travaux et quotas :

| Fichier exact | Opération et résultat |
| --- | --- |
| I Want to Live on Mars | Profil à 21:53:33 : HTTP 200, report `provider-account-busy`, zéro tentative fournisseur et zéro profil enregistré. |
| Lost on a Mountain in Maine | Admission manuelle ordinaire à 21:53:43 : HTTP 202. |
| The Legend of Ochi | Admission manuelle ordinaire à 21:53:52 : HTTP 202. |
| Bolt from the Blue | Prélecture à 21:54:01 : limites de deux travaux manuels et quatre travaux fournisseur atteintes, aucun POST envoyé. |

À 21:54:26, les deux nouveaux travaux sont en `retry_wait` pour
`PROVIDER_ACCOUNT_BUSY`, sans tentative fournisseur ni fenêtre nouvelle. Les
profils correspondent ; les anciens tuples de preuves observés avant et après
sont conservés. Cette comparaison ne certifie pas chaque colonne de la base.
Aucun nouveau passage après consensus n'est demandé, aucune ancienne ligne
n'est remise artificiellement en file. L'admission n'est pas une capture ou
une langue identifiée. L'opérateur consomme un marqueur exclusif avant chaque
requête ; un résultat incertain ne doit pas être rejoué aveuglément.

À **21:56:35**, Lost est en exécution avec une tentative mais encore zéro
reçu : ce premier état ne prouve pas une capture achevée. À **21:58:18**, le
nouveau travail Lost possède **deux fenêtres, deux reçus et deux tentatives**,
dernière progression à 21:57:50. Il est de nouveau en file dans le sélecteur
réel. Son analyse reste incomplète et aucune langue nouvelle n'est publiée.
Ochi conserve `PROVIDER_ACCOUNT_BUSY`, zéro tentative et zéro capture. Aucun
autre appel opérateur n'a été envoyé après les trois requêtes initiales.

Le contrôle final à **22:00:42** conserve ces deux reçus Lost et le report
Ochi sans capture. Bolt et Mars restent dans les états décrits ci-dessus.
Ces quatre identifications demeurent ouvertes et suivies sous les gardes
ordinaires ; aucun travail simplement admis n'est annoncé terminé.

## Santé, incidents et limites conservés

Deux Gateways HTTP 200 / ok, deux Edge sains, admission et crons actifs,
dispatcher permanent unique, compteurs conservés. Quatre échecs HTTP cumulés
historiques restent enregistrés, sans nouvel échec dans la fenêtre inspectée
depuis 20:08. Les erreurs par entrée et les reports ne sont pas assimilés à
des succès. Aucun nouveau diagnostic de finalisation dans les fenêtres Edge
commençant à 21:38:12 et 21:38:16 : cela n'efface pas les incidents antérieurs.

Le finaliseur Strng de 02:22 garde son report au 5 octobre à 02:22:08, huit
tentatives et la capture de 01:31 ; les deux quarantaines Dino restent
incomplètes. Aucun bail, délai, compteur ou quarantaine n'est forcé.

Au contrôle de santé final à **21:58:24**, les deux Gateways restent HTTP
200 / ok, admission/cron/découverte actifs. Le principal est à nouveau occupé
par du travail prioritaire, le secondaire déclare deux places. Cela confirme
une capacité variable, pas une disponibilité permanente. Les captures Lost
et les admissions ciblées n'ont pas arrêté le dispatcher.

Le parcours de récupération des versions refusées est distinct et déjà
documenté dans `2026-10-04-refused-version-recovery.md`. Les quatre contrôles
de la PR documentaire 645 sont maintenant réussis, paquets compris. Le refus
HIT et les corruptions des autres originaux restent ouverts. Aucun nouvel
essai des alias ou des fichiers refusés n'est entrepris dans ce contrôle.

Aucune modification de code, configuration, concurrence ou déploiement n'est
effectuée par cet audit. La campagne globale reste permanente et indépendante
du PC ; la réussite d'un lot ne justifiera pas d'arrêter sa découverte.
