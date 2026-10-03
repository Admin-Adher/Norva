# Norva Selection — contrôle exhaustif des 554 films sans langue audio

## Périmètre et méthode

Le compteur de 554 films a été confirmé dans le navigateur de production sur le
compte QA ordinaire « Test client », source Norva Selection, sans autre filtre.
Ces 554 cartes correspondent à **557 versions physiques**. Toutes les versions
ont été rapprochées de leur URL exacte, des tags du catalogue partagé, du profil
audio et du résultat de leur travail d'analyse, lorsqu'il existe. Le contrôle
n'est pas limité à un lot. Il ne constitue pas une écoute réussie de 557 fichiers.

Le fichier JSON voisin conserve une ligne pour chacune des 557 versions, sans
URL, identifiant de compte, reçu de validation ni transcription. L'original privé
de la cohorte est conservé sur le serveur, avant réparation. La langue du synopsis,
la nationalité du film et le titre traduit ne sont pas des preuves de langue audio.

## Résultat mesuré à 04 h 45, heure de Paris

Au contrôle SQL du 3 octobre 2026 à 02:45:53 UTC :

- 554 → **530 films** encore sans langue audio identifiée ; 557 → 533 versions.
- **24 versions sorties de la cohorte inconnue** : portugais ; une contient aussi
  une piste chinoise. Les résultats distinguent pistes sondées et langue vérifiée.
- Le navigateur avait confirmé 531 juste avant ce relevé ; une nouvelle analyse
  a terminé entre les deux contrôles. Le compteur évolue avec le traitement.

| État des 533 versions restantes | Nombre |
| --- | ---: |
| Analyse terminée, aucune langue concluante | 53 |
| Réinitialisation des reçus de validation nécessaire (96 échecs, 112 attentes) | 208 |
| Refus lié à une lecture active (138 échecs, 32 attentes) | 170 |
| Capacité d'analyse momentanément indisponible | 77 |
| Reprise locale de capture (17 échecs, 2 attentes) | 19 |
| Refus Gateway en attente de reprise | 1 |
| Profil audio incomplet, échec | 1 |
| Absence du registre des fichiers audio audités | 3 |
| Analyse en cours | 1 |

Les trois fichiers sans travail audité sont **Get Lucky**, **Sawadikap Pei** et
**Godzilla Minus One**. Leur identité n'est pas dans le manifeste audio actuel ;
ils n'ont pas été introduits arbitrairement dans le parcours de certification.

## Défauts corrigés et publication effective

1. **Résultats finis absents du catalogue partagé.** L'ancien hydrateur ne
   publiait que sur les lignes matérialisées par propriétaire. Les cartes partagées
   non lues conservaient le cliché initial. Le nouvel RPC publie les résultats
   finis, vérifie le certificat lié à l'URL exacte, recalcule les unions de langues
   et invalide les facettes de tous les propriétaires visibles. L'acquittement
   durable intervient après cette publication ; une erreur reste à reprendre.
2. **Tags fournisseurs effacés par un résultat inconclusif.** Le premier contrôle
   après publication a révélé la perte de 25 déclarations espagnoles. Le correctif
   de secours restaure et conserve les déclarations explicites acceptées par le
   catalogue original, quand aucune piste observée ne donne une langue. Ce secours
   ne marque pas ces déclarations comme audio vérifié et n'écrase pas une langue
   observée. Les 177 films espagnols du filtre ont été conservés.
3. **Refus avant sonde débitant le budget d'analyse.** Les deux sorties locales
   « lecture active » / « extraction active » n'attestaient pas que cette requête
   n'avait ouvert aucune connexion fournisseur. Le worker ne pouvait donc pas
   rendre la tentative. Elles fournissent désormais cette attestation ; la
   réservation appartenant à l'autre lecture/extraction reste intacte. La lecture
   garde sa priorité et aucune connexion supplémentaire n'est ouverte.

Les migrations `20261003010000` et `20261003011000` sont appliquées en production.
Le premier rafraîchissement a publié 234 fichiers / 233 cartes sur tout Selection,
y compris des fichiers déjà connus : ce nombre n'est pas le gain de la cohorte.
Le second passage est idempotent. Aucun catalogue propriétaire n'a été reconstruit.

Les deux Gateways ont reçu la même image :
`sha256:035a687d0f2262ebaa920ed7cbef432eabe4c43b2f0452cc6c43cb7ba942002a`.
Le SHA256 normalisé de `src/index.js` vaut sur les deux :
`d8d0f9f57a0261ba8cd2785a79aedd7ca6e94cd72de5fa511e7daa61cda81f25`.
Le worker a été arrêté avec sortie propre, les déploiements ont attendu des
Gateways inactifs, les anciens conteneurs ont été conservés pour retour arrière,
les configurations ont été vérifiées identiques avant/après et le worker a repris.

## Vérifications

- **66 tests ciblés réussis** : 20 préemption/sonde, 41 worker/client audio et
  5 d'isolation de l'admission héritée. Le premier contrôle CI a signalé deux
  dépendances manquantes dans la fixture d'admission ; elle a été adaptée au
  protocole d'attestation, en conservant ses assertions de priorité et de capacité.
  Le nouveau test vérifie les deux refus, aucune création de processus fournisseur,
  l'attestation spécifique à la requête et le maintien de l'autre réservation.
- Rejeu PostgreSQL isolé avec **233 résultats finis réels**, puis annulation des
  écritures de test : liaison fichier/certificat, refus d'un profil d'une autre URL,
  limite de 250, absence de droits clients, idempotence, maintien des variantes et
  des données éditoriales, conservation du secours fournisseur.
- Vérification réelle des facettes sur le compte QA ordinaire dans le navigateur,
  après actualisation. Aucun changement de client Android/WebView : ce correctif
  publie les données communes et corrige le protocole d'analyse serveur.

## Limites précises

**Les 530 langues audio restantes ne sont pas résolues.** Certaines analyses sont
inconclusives ; d'autres attendent ou ont épuisé leur budget. Le correctif de refus
protège les prochaines tentatives, mais ne réinitialise pas les 138 anciens échecs.
Le mécanisme existant de récupération opérateur ne les admet pas : pas de remise
à zéro automatique ou d'augmentation silencieuse du budget.

Le code de réinitialisation des reçus a été constaté sur 208 fichiers. Sa cause
fine (expiration, changement de liaison ou autre rejet) n'est pas démontrée par
le code d'erreur stocké ; elle ne doit pas être présentée comme une expiration
confirmée. Le worker actuel appelle directement le Gateway principal ; une
différence de secret entre routes n'explique pas ce constat, les secrets comparés
sont identiques. Les contrôles restent stricts et aucune langue incertaine n'est
forcée à partir de TMDB ou de la majorité portugaise du catalogue.

## Reproduction et sauvegardes

Opérateurs versionnés : `audit-selection-audio-20261003.py`,
`prove-selection-audio-publication-20261003.py`,
`inspect-selection-audio-runtime-20261003.py`,
`deploy-selection-audio-drain-20261003.py`,
`close-selection-audio-audit-20261003.py`.

Preuves serveur et sauvegardes privées dans
`/home/adrien/.norva/selection-audio-audit-20261003/` : baseline immuable,
états originaux du catalogue commun et de l'acquittement, résultat de publication,
reçu de déploiement des deux Gateways et inventaire final sans données privées.
Le contenu privé reste sur ce serveur. Appliquer les deux migrations dans l'ordre
pour reproduire le comportement final ; la seconde préserve les tags fournisseurs.
