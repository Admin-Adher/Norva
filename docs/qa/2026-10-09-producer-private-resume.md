# Coexistence du producteur partagé et de la reprise privée

## Défaut reproduit

Suite de PR744, sur la même base `6519aadea`. Une lecture ordinaire admise comme producteur du cache complet était systématiquement exclue du cache privé. Si elle se fermait avant EOF, elle pouvait ne laisser aucun cache utilisable. Le dernier essai réel Severance (13 s au départ, 122 s à la reprise) reste la référence antérieure, et non une mesure de ce correctif.

## Correction

- Conserver le contexte du producteur et mémoriser uniquement un abandon positivement acquitté par l'autorité.
- Lors d'une fermeture ordinaire, drainer le transport et FFmpeg, libérer l'encodeur, attendre les publications éventuelles et abandonner le producteur avant de capturer la fenêtre privée.
- Autoriser cette conversion seulement pendant `stopping`, après cet acquittement, sans publication en cours ou terminée. Une autorité absente, expirée, en erreur ou répondant `missing` ne l'autorise pas.
- Un heartbeat tardif ne réarme plus un producteur abandonné.
- Les contrôles de propriétaire, source, révision, fichier courant, pistes, sous-titres et réserve restent inchangés. Aucun nouveau téléchargement ni publication partielle partagée. Le parcours de décodeur conservé reste distinct.

## Preuves isolées du 9 octobre, 16:25 UTC

60 tests réussis, zéro échec/annulation/ignoré. Le vrai Gateway et FFmpeg utilisent une source MKV synthétique de 120 s, H.264 et AAC stéréo, dans un conteneur UID1000, réseau `none`, stockage temporaire séparé. Les échanges fournisseur/autorité/stockage sont des simulateurs loopback.

La fermeture avant EOF conserve une fenêtre privée, ferme la source et révoque l'ancien ticket. La réouverture revalide et réutilise 44 s disponibles ; un extrait servi est décodé sans erreur. Maximum une connexion fournisseur simultanée ; aucune publication vers le stockage partagé. Le témoin sur l'image de production inchangée échoue exactement sur `stores=0`, `session-ineligible`.

Les tests couvrent aussi publication complète, suivi de demande et préemption, course publication/fermeture, abandon refusé et heartbeat tardif. Le premier passage Linux a annulé le test du heartbeat parce que son timer de test était `unref` et n'avait plus de ressource active ; un `ref()` limité à la fixture corrige cette attente. Le test réel de conversion passait déjà. Ce premier résultat reste conservé : 59 réussis, une annulation.

Reçus locaux : `.codex-artifacts/producer-private-resume-20261009/isolated.safe.json`, `isolated-final.safe.json`, `baseline.safe.json` et opérateurs de preuve associés. Les conteneurs ont été retirés ; aucun média client ni appel fournisseur de production dans ces preuves.

## Limites au stade du correctif

Pas encore de mesure réelle après correction, pas de validation à l'écoute, ni gain revendiqué sur Normal ou Severance. Une identité fournisseur insuffisante, une réserve trop courte ou une couverture de pistes incomplète continue à refuser le cache. Une seule connexion et la conservation d'une fenêtre ne garantissent pas un débit suffisant pour la suite de la lecture.

Déploiement et essai public à consigner séparément après leurs résultats effectifs. Aucun changement d'interface, de seuil, de limite ni d'activation globale du pilote.

## Intégration et déploiement — 16:35 UTC / 18:35 Paris

PR745 fusionnée par `3696c26b85f2f779aaae5b32890e01b9fd9651d3`. Code `0f6737bbaca1470534e0776ae855c9f3aeac000f`, fixture de test complémentaire `8e10b49f5`. La première CI complète trouvait une ancienne fixture VM de sous-titres qui omettait la nouvelle dépendance `privateResumeProducerReleased` : 6 194 réussis / un échec / 32 ignorés. Cette fixture charge désormais la garde réelle et vérifie aussi les cas producteur refusé/abandonné. 24 tests locaux réussis (groupe recoupé). CI suivante : **6 195 réussis, 32 ignorés, zéro échec** sur 6 227 tests ; contrats, région et syntaxe réussis. Aucun changement d'interface ou de client Android.

Image déployée : `sha256:3472d834c7095cbf4c1776117e704f19ae1e1c0bce49fa37b8b81c701d486c10`. Arbre source : `5d5327b73c6fc9a140201f7563a304c26e195a59d860ed0c951cebf4e5c79bdd`. Comparaison de 94 fichiers : deux sources modifiées, 92 préservées, permissions vérifiées. Canary réseau isolé, UID1000, GPU réel et tests fonctionnels réussis, puis retiré. L'image porte le commit applicatif ; la correction ultérieure de fixture ne change aucun fichier embarqué.

Pause d'admission **16:34:53.676375–16:35:04.659808 UTC**, soit 10,983433 s. Drainage naturel, aucun bail forcé. Deux Gateways remplacés séquentiellement ; environnements, volumes et configuration préservés. Les deux Edge sont restés inchangés. Cron, admission, worker et dispatcher permanent restaurés et vérifiés ; opérateur apply consommé. Les 94 empreintes et la santé sont relues sur chaque Gateway à 16:35:16. Pilote toujours restreint, aucun seuil ou quota changé.

## Rejeu public de Severance — 16:35–16:37 UTC

Même copie anglaise Strng S1E1, 475 790 063 octets / 3 434,773 s, MKV réel malgré le libellé MP4 de la fiche de série. Départ par « Lire depuis le début », sans autre lecture du compte.

- Clic 16:35:26.084 UTC ; première image 16:35:37.562498, **11,48 s depuis le clic** (10,964 s au compteur interne).
- Préparation serveur 8,824 s, FFmpeg prêt en 0,531 s. Le démarrage effectif attend 16:36:41.586202 : **75,50 s depuis le clic**.
- À 16:36:54.408, temps vidéo 12,808 s, `paused=false`, `readyState=4`, erreur nulle ; buffer `[0.042333,112.071333]`, soit environ 99 s devant. Fermeture volontaire par Retour vers 16:36:55.
- Le producteur est admis, une instance FFmpeg et la réponse préouverte sont utilisées. À 16:37:06, abandon acquitté une fois, zéro session, pompe ou claim du compte restant ; les deux Gateways sont sains.
- **Aucune fenêtre privée stockée.** Le motif n'est plus `session-ineligible` mais `unverified-input`. Les contrôles de coexistence sont franchis ; le contrôle de fraîcheur reste bloquant.

La réponse courante porte `providerValidatorEvidence=weak-or-absent`. Le code de collecte récent (`snapshotRecentSamples`) appartient au broker de plages terminées. Ce départ à zéro utilise la pompe linéaire préouverte : elle n'a pas de broker ni de snapshots de plages complètes à la fermeture. Les échantillons récents nécessaires ne sont donc pas disponibles. La réponse complète n'a pas atteint EOF et son arrêt normal ne doit pas devenir une attestation de fichier complet. Une collecte adaptée aux lectures linéaires, avec sa propre preuve et ses bornes, reste à concevoir/tester ; aucune confiance artificielle n'est accordée au titre, à la taille seule ou au nom de fichier.

Le buffer disponible n'était pas insuffisant au moment de cette fermeture. Ce résultat isole une autre limite réelle ; il ne démontre **aucun gain de reprise** sur Severance. Pas de réouverture répétée après constat de zéro fenêtre. Les positions et conditions diffèrent du relevé PR744 : ne pas présenter 75,5 s comme une comparaison A/B du correctif. Aucune acceptation à l'écoute ni fluidité durable revendiquée sur les 13 s de lecture effective. Aucun gain sur Normal.

Navigateur revenu à la grille Séries ; sélection française initiale restaurée sans lecture. Reçus et empreintes dans le JSON compagnon. Les essais sont arrêtés. La conservation de quatre échantillons validés, l'isolation des comptes et le refus de données incomplètes restent requis pour la prochaine étape.
