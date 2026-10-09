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
