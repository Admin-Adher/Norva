# Reprises lentes : Normal et Severance

7 octobre 2026. Suite du rapport `2026-10-07-recent-resume-multiformat-matrix.md`.

## Diagnostic et correction

L'audit précédent reste valide : Normal et Severance repartent, mais trop lentement. Le succès de Silo ne constitue pas une validation de toutes les VOD.

- La clé des entrées source conservées sérialisait directement les objets des pistes. L'ordre des clés d'un profil provenant de JSONB ou d'une sonde pouvait changer cette clé sans changer ses faits. La sérialisation devient canonique, en conservant toutes les valeurs et l'ordre des tableaux.
- Sur Severance, les requêtes de saut transmettent explicitement le sous-titre index 3, tandis que la réouverture utilise le choix automatique. Pour les seuls octets source conservés, une sélection dans le même ensemble de rendus préparés ne doit pas créer une autre entrée. L'ensemble exact, l'audio sélectionné et les faits du fichier restent liés ; le nouveau lecteur conserve sa sélection et produit son propre HLS. Aucun rendu HLS d'une autre piste n'est substitué.
- Normal possède deux pistes audio et restait limité à des acquisitions de 2 Mio même pendant une lecture continue. Le nouveau relevé observe des acquisitions successives prenant souvent 1–1,6 s. La croissance séquentielle existante devient accessible aux MKV à plusieurs pistes **dans le pilote seulement** : petites fenêtres initiales, croissance après deux fenêtres consommées par la même lecture, retour aux petites fenêtres après chaque nouveau saut. Le maximum de 8 Mio par requête et le plafond mémoire existant restent inchangés, avec une seule connexion fournisseur.

Le 7 octobre à 09:14 Paris, un nouveau témoin Normal reprend à 180 s : session créée à 07:14:20.710 UTC, première image à 07:14:47.228, lecture à 07:16:35.923, soit **135,212 s** jusqu'à `play_started`. À 09:16:08, 80 s sont chargées, mais le lecteur attend encore à zéro. Une seconde reprise à 297 s démarre en **114,168 s**. Le cache est cette fois retrouvé, mais sa validation fraîche refuse une cible dont le chemin a changé. Cette garde reste intacte. Le motif générique `fresh-read-unavailable` du compteur agrégé est précisé par le diagnostic de session `target-changed` ; il ne démontre pas des données manquantes sur cette nouvelle cible.

Les positions des essais diffèrent ; aucune comparaison ne garantit un multiplicateur universel. L'ordre des propriétés est un défaut reproduit localement, pas une attribution rétrospective certaine de chaque absence du cache dans l'audit précédent.

## Vérifications avant production

- PR693, code `cd2084860bd7d40b9d029eef303698caf6a08c8a`, intégrée par `97e87609568a43654d1242b5321b00e49e6cc444`.
- Tests ciblés : 253 tests, **247 réussis, 6 ignorés, zéro échec**. Les tests exercent les octets renvoyés, les fenêtres après un nouveau saut, les annulations, l'isolation et la vérification fraîche du cache.
- Canary réel sous UID1000, réseau isolé, aucun volume de production : santé, GPU et **18 tests fonctionnels réussis**. Conteneur arrêté et supprimé ; aucun média fournisseur appelé. Le libellé de fixture hérité du reçu cite MP4, mais la sélection réellement exécutée couvre la croissance MKV, les profils et l'entrée conservée ; ne pas présenter ce libellé comme une nouvelle preuve MP4.
- Image candidate `sha256:63717edee76af73f1916d7b564050bcb394359d4d83d174843d8f593375c19e2`. Deux fichiers Gateway changés, 85 conservés ; 194 fichiers Edge inchangés.
- Aucun changement de seuil de réserve navigateur, de codec, de langue, de piste sélectionnée, de délai fournisseur ou de quarantaine. Extension à tous les propriétaires désactivée.

## Déploiement et essais réels

Les cinq contrôles CI du code sont réussis, paquets compris. Déploiement vérifié à 07:26:38 UTC : deux Gateways sains, 87 empreintes concordantes, Edge inchangés. Pause des nouvelles admissions de 07:23:12.509 à 07:26:07.968, soit 175,459 s, principalement en attente de drainage naturel ; aucun bail forcé. Cron, worker et admissions restaurés, même dispatcher permanent.

Premier rejeu Normal à 344 s : **80,151 s** de création de session à lecture, contre 135,212 / 114,168 s aux positions 180 / 297 avant correction. Première image client en 14,850 s ; préparation Gateway 13,117 s. La politique initiale reste inéligible au démarrage court, cadence 1,468× inférieure à son minimum 2×. Le lecteur garde sa réserve existante. Les fenêtres source passent réellement à 8 Mio ; leurs durées restent variables, dont une à 14,494 s dans la fenêtre observée. **L'attente est réduite dans cet essai, mais Normal n'a pas une reprise rapide validée.** Aucun multiplicateur causal garanti ni accélération universelle déduit de positions différentes.

Normal a ensuite atteint 128,083 s de lecture relative, sans pause ni erreur DOM, avec 68 s de réserve restante. Extrait de sortie locale : H.264 / AAC-LC 48 kHz stéréo, 48 images, intervalle maximal 42 ms, aucune erreur de décodage. Ce contrôle court ne certifie pas tout le film.

### Severance / Dissociation FR S1E1

Même copie exacte que l'audit précédent, 5 006 492 901 octets, deux pistes audio, trois sous-titres préparés. Après redémarrage du Gateway, première reprise à 207 s en **55,559 s**, avec acquisition du profil ; ce n'est pas un test de cache chaud. Saut à 573 s en **58,171 s**, politique initiale inéligible à 1,073× : ce résultat est plus lent que les anciens sauts, à d'autres positions, et n'est pas présenté comme un gain. Le lecteur a néanmoins repris automatiquement.

Sortie de l'épisode puis réouverture à 593 s : **21,774 s**, première image client 18,359 s, préparation Gateway 16,759 s dont FFmpeg 15,051 s. La politique normale qualifie 4,246×, sans baisse des seuils. L'entrée conservée est maintenant retrouvée malgré le retour au choix automatique des sous-titres ; une validation fraîche de 1,677 s est réellement effectuée. **La cible de livraison change et le cache est refusé** : aucun hit ni octet ancien injecté ne sont revendiqués. Le préfixe fraîchement acquis de 65 536 octets est transmis au chemin normal, puis les lectures ordinaires continuent.

Le cache reconnaît donc mieux le même profil, mais ces deux copies Strng ne prouvent pas une réutilisation effective après changement de cible. Leur clé de livraison variable reste une limite ; les protections de taille, cible et quatre empreintes fraîches restent inchangées.

Severance progresse de 125,654 s à 07:36:09 jusqu'à **321,815 s à 07:39:25 UTC**, toujours `paused=false`, `readyState=4`, sans erreur DOM. Ces observations espacées montrent une progression sur plus de cinq minutes ; elles ne constituent pas une mesure exhaustive des micro-saccades. Le contrôle local après saut décode 48 images sans erreur, intervalle maximal 42 ms, audio AAC-LC 48 kHz stéréo. Un premier contrôle vidéo de la réouverture échoue à 07:35:10 (zéro image, une ligne d'erreur non conservée) ; sa cause exacte n'est pas établie. Le collecteur choisit ensuite un segment courant au lieu du plus ancien : à 07:36:00, 48 images, intervalle maximal 42 ms, zéro erreur et AAC-LC. Cette adaptation concerne uniquement le diagnostic, pas le produit. Aucune acceptation à l'écoute ni certification du film entier ou du lecteur TV n'est revendiquée.

## État final et limites

Lectures de test fermées normalement, navigateur revenu aux Films. À **09:39:59 Paris**, les deux Gateways sont sains sur la nouvelle image, zéro session active sur chacun, pilote toujours limité à la liste autorisée ; extension globale désactivée. Aucun lecteur ni bail forcé.

La reconnaissance du cache et les lectures séquentielles à plusieurs pistes sont corrigées et déployées. Normal reste lent (80 s dans cet essai) ; Severance varie de 22 s à la réouverture à 58 s après saut. Le changement de cible de livraison empêche une réutilisation sûre des données conservées dans les essais Strng. Le succès antérieur de Silo demeure la preuve de réutilisation effective ; il n'est pas attribué à ces nouveaux essais. Ash (timeline) et Beach Party (connexion refusée) restent des incidents distincts non corrigés par cette livraison. Aucun déploiement documentaire supplémentaire n'est nécessaire.

Preuves locales : `.codex-artifacts/recent-resume-slow-20261007/`. Aucune URL média, donnée d'accès ou identité de compte incluse dans ce rapport.
