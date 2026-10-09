# Reprise sans cache et priorité du saut MP4 — 9 octobre 2026

## Résultat avant déploiement

Le pilote PR730/731 reste limité au compte autorisé. La comparaison ancienne/nouvelle image et les traces publiques distinguent deux limites : **aucun cache vidéo réutilisable lors des échecs publics**, et **une attente évitable du saut MP4 derrière une continuation réseau précédente**. Le second défaut est corrigé dans le candidat ; aucun démarrage réparé ni gain de fluidité sur Le Robot Sauvage n'est encore démontré.

## Réponse à la question sur le cache

Contrôle public de Conclave, session créée le 9 octobre à `08:38:28.328 UTC` : échec `PLAYLIST_TIMEOUT` à `08:39:28.628`, zéro segment et zéro seconde de playlist. L'événement public `gateway_502` arrive à `08:39:31.229` ; aucune première image.

Le relevé à `08:43:23 UTC` trouve **zéro entrée et zéro octet de cache HLS préparé sur les deux Gateways**, aucun stockage HLS ou d'entrée récente depuis leur démarrage, et zéro octet de plage de reprise réutilisé dans cette tentative. Les processus ont été remplacés lors du déploiement à `08:00:40/43 UTC` : leurs caches privés en mémoire ne survivent pas à ce remplacement. Les démarrages publics suivants, tous échoués avant préparation de la vidéo, n'ont pas reconstitué une fenêtre HLS réutilisable.

Le secondaire possède à ce relevé un préfixe MKV de 2 Mio, deux stockages historiques, zéro réutilisation et une expiration. Ces compteurs sont agrégés au processus ; ils ne démontrent pas qu'une vidéo préparée a été conservée. Trois hits du broker pendant la tentative sont des lectures locales **à l'intérieur de la session**, pas trois reprises accélérées.

La conservation du décodeur exige une lecture prête, une fermeture à une position disponible, puis une reprise à cette position **dans les dix secondes**, sous nouvelle autorisation et revalidation. Le cache récent de données est un autre mécanisme : au plus dix minutes pour les preuves échantillonnées, trente minutes pour le cache historique éligible. Aucun de ces mécanismes n'est une conservation permanente du film. La promesse de reprise immédiate ne s'applique donc pas à cette tentative à froid.

## Comparaison bornée, mêmes copies et positions

Images comparées : ancienne `efd3ae83ac95f4b8ecf563f4cc39e085e50db06550acb2664b9c94a43a36b2f9` et déployée `b7daa15239a9e156792eb684601eb8f76fdfd3916ad8217a02e5006484e23624`. Conteneurs temporaires, caches séparés **vides volontairement**, même environnement fournisseur/proxy et ressources de calcul. Claims Edge réels, heartbeat 0,5 s, délai 1 s, fermeture et expiration ordinaires, essais séquentiels. Aucun changement de route/IP ou augmentation de concurrence.

| Copie / position | Ancienne image | Image déployée | Portée |
| --- | --- | --- | --- |
| Conclave, Dino MKV / 1 222 s | Prêt serveur 48,398 s | Prêt serveur 36,406 s | API du banc, pas première image navigateur ; débit variable, pas gain attribué au code. |
| Le Robot Sauvage, MAX OTT MP4 / 660 s | Limite serveur 60 s | Limite serveur 60 s | Aucun segment produit ; environ 62,6 s jusqu'au retour API avec nettoyage. |

Sur une même plage Conclave de 2 Mio, réception complète en 26,601 s puis 20,717 s, dont 25,902 s puis 20,429 s d'attente de lecture réseau instrumentée. Aucune attente de publication HLS n'est observée dans ces fenêtres. Cela ne départage pas relais et livraison fournisseur.

## Défaut MP4 reproduit

Le décodeur lit l'en-tête depuis zéro. Après le préfixe d'amorçage, le broker continue une réponse jusqu'à 9 Mio. Le décodeur ouvre une nouvelle réponse locale à l'index de reprise (octet 124 764 178) **avant de fermer l'ancienne**. Le nouveau besoin attend le slot fournisseur pendant que l'ancienne continuation lente est encore reçue.

Dans l'essai instrumenté borné à 40 s, la nouvelle demande apparaît 25,664 s après la première, mais l'ancienne réponse ne se ferme pas dans la fenêtre observée. Le test de régression isolé reproduit ce blocage sur l'ancien code.

Le début du MP4 reçu passivement confirme aussi un index volumineux : boîte `ftyp` de 32 octets, puis boîte `moov` de **4 165 413 octets** à l'offset 32. Le préfixe conservé pour ce seul diagnostic est incomplet ; aucun appel réseau supplémentaire n'est effectué pour l'obtenir. La réception lente de cet index reste un coût avant le saut et n'est pas corrigée par la priorité du saut.

## Correction bornée au pilote MP4

- Le broker annonce le besoin fournisseur réel après les recherches dans ses caches.
- Une nouvelle demande non recouvrante peut interrompre une ancienne continuation non atomique déjà partiellement transmise, après validation de sa réponse 206, de sa plage et de son identité.
- Seul le transport de cette ancienne continuation est fermé. Sa réponse locale reste ouverte ; les octets reçus restent transmis une seule fois et la reprise réseau recommence à l'octet suivant, derrière le nouveau saut si elle est toujours nécessaire.
- Une plage partielle n'entre pas dans le cache. La fermeture et la grâce ordinaires de 2,5 s précèdent l'ouverture suivante ; maximum une connexion fournisseur.
- Les demandes couvertes par le cache, recouvrantes ou atomiques n'interrompent pas la continuation. Mode désactivé inchangé.
- Un changement de fichier bloque aussi les réponses déjà en attente avant qu'elles ouvrent une nouvelle connexion.

La priorité est activée uniquement pour les MP4 finis des propriétaires déjà admis au pilote de reprise récente. Aucun élargissement de liste, aucun changement de timeout de démarrage, de réserve, codec, modèle, route, bail ou délai.

## Vérification du candidat

**199 tests réussis, cinq ignorés, zéro échec** sur les quatre suites broker, barrière de rétention, transfert et fenêtre rendue. Six nouveaux cas vérifient les octets exacts des deux réponses, l'absence de trou/doublon, la concurrence maximale de un, le changement d'identité terminal et les exclusions cache/recouvrement/atomicité/désactivation. Les groupes antérieurs ne sont pas additionnés.

Le test de changement d'identité a découvert qu'une réponse déjà en attente pouvait reprendre après une erreur terminale d'une autre réponse. Une garde est ajoutée au début de la boucle et après l'acquisition du slot ; ce cas passe sans nouvelle requête après le rejet. Une erreur préalable de chemin de fixture a été corrigée avant la reproduction utile du blocage ; elle n'est pas une panne produit.

Un premier essai réel du candidat n'atteint pas le saut avant 60 s : environ 3,10 Mo seulement ont été reçus sur la continuation. Un second essai à `08:36:26 UTC` observe réellement **`new-range-yield`** : demande de saut à 35,972 s, fermeture de l'ancienne réponse locale 4,318 s plus tard, grâce de libération ordinaire comprise. La première petite plage de la cible (16 366 octets) est reçue en 1,813 s. La plage suivante ne livre ensuite qu'environ 958 ko en 18,1 s d'attente de corps observée ; le démarrage atteint toujours sa limite de 60 s. **Le mécanisme corrigé est exécuté sur la copie réelle, mais la lecture n'est pas réparée.**

Les métriques de lecture encore pendantes après interruption ne sont pas additionnées aux durées terminées. Les essais du banc ne certifient ni l'affichage des sous-titres ni la qualité à l'écoute. Aucune nouvelle validation AAC ou fluidité sur ces copies n'est revendiquée.

## État de livraison

Code candidat : `85b0d374dbbda6334dfdfd51e88182d5fe751567`. Image, canary, CI et éventuelle application seront consignés séparément après observation. À ce stade, **production inchangée par cette correction**. Les conteneurs d'essai sont arrêtés et les claims expirés normalement ; le lecteur public a été ramené au catalogue après collecte du diagnostic.

Reçus sous `.codex-artifacts/retained-startup-ab-20261009/` : tests, comparaisons, traces et `public-cache-audit.safe.json`. Les identifiants, accès et URLs restent dans les fichiers privés serveur. Les limites et le déploiement précédent restent conservés dans [le rapport du pilote](2026-10-09-retained-owner-pilot.md).
