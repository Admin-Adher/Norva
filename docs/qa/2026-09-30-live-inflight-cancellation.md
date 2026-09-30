# Annulation Live pendant la préparation — 30 septembre 2026

## Défaut mesuré

Le retour Android à 17:18:52.117 UTC a fermé le reçu final, mais le travail du fournisseur a continué jusqu’à 17:19:44.557 : 52,44 s après Back. La création Edge ne connaissait aucun transport Gateway avant sa réponse ready. Le rejet client d’un résultat tardif protégeait l’écran, sans arrêter cette préparation.

## Correction candidate

- Préparation serveur durable, propriétaire et appareil exacts, durée 180 s ; aucune requête fournisseur lors de sa création.
- Réservation du playback UUID avant I/O. Annulation et claim provider partagent le verrou SQL de la préparation ; un reçu annulé ne peut jamais réclamer ni supplanter une nouvelle lecture.
- Annulation exacte par propriétaire + playback UUID sur chaque Gateway. Le POST préparé et le flux raw restent suivis jusqu’à leur drainage réel. Les analyses codecs reçoivent aussi le signal et attendent la fin effective de leur enfant.
- Réponse 200 seulement après drainage Gateway, expiration du reçu cloud et fin du POST Edge (`settled_at`). Sinon 202 ; le client attend avant la lecture suivante.
- Génération du processus de chaque route stockée dans la préparation. Un vieux POST ou jeton raw est refusé avant I/O après remplacement du Gateway. Une génération ou un routage différents restent non acquittés : aucune durée écoulée ne vaut preuve d’arrêt.
- Un jeton Live préparé autorise uniquement `/raw`, pas les routes de sous-titres ou de travail auxiliaire.
- Les clôtures raw couvrent la durée maximale existante de 2 h plus la fenêtre de préparation, avec un registre borné sans éviction des clôtures actives. VOD et cache partagé ne prennent pas ce protocole.

## Preuves exécutées

### SQL PostgreSQL réel (PGlite 0.5.8)

`NORVA_REQUIRE_PREPARATION_SQL=1 node --test tests/live-preparation-sql.test.js` : 10 tests réussis. Migration réelle et fonction `claim_cloud_playback_session` historique exécutées ensemble ; identité, appareil, rejet des rôles publics, expiration, annulation avant/après begin, claim unique et nouvelle lecture non supplantée.

Le runtime PGlite local est `C:/Users/Adrien/.codex/tmp/selection-capture-sql-runtime/node_modules`. La suite est obligatoire en CI ; aucun résultat ignoré ne peut être compté comme validation SQL.

### Gateway réel isolé, réseau désactivé

Image production de référence `c386551e7f03bf4bfae63f4975d65cf165a95d73c82e0ce704264d2450333029`, avec les deux fichiers candidats montés en lecture seule. Conteneur `--network none`, sans port publié, 2 CPU, 1 Go, source HTTP synthétique en loopback et secret QA éphémère. Aucun flux fournisseur ni configuration production.

- Raw réellement ouvert : annulation acquittée en 57 ms, lecteur terminé, zéro connexion source et zéro raw pump. Rejeu du jeton refusé 409 ; route auxiliaire refusée 401 ; aucune connexion supplémentaire.
- POST HLS en préparation avec un vrai processus FFmpeg : annulation acquittée en 35 ms ; POST initial 409 ; zéro enfant, session, admission, réservation et connexion source. POST tardif refusé 409.
- Annulation acquittée sur processus A, puis arrêt et remplacement effectifs par B : ancien POST refusé 400 et ancien raw refusé 409, sans connexion source. Nouvelle annulation portant l’ancienne génération : 202, jamais un faux acquittement.

Scripts reproductibles : `tests/fixtures/live-preparation-runtime.py` et `tests/fixtures/live-preparation-restart-runtime.py` (à lancer uniquement dans le conteneur isolé décrit).

Reçus privés :

- `/home/adrien/.norva/live-inflight-cancel-20260930/qa/integration.safe.json`, SHA-256 `36e4ca9a90ff98e33bb6dac96078eabc72cd08e0038715a7a4fcf893d238f096`.
- `/home/adrien/.norva/live-inflight-cancel-20260930/qa/restart.safe.json`, SHA-256 `6d8e5c39eba3ba890e33b87c0e15277e69c81576b1908cf7bd13a724a0fcdc41`.

Les tests unitaires des routes exécutent aussi un `reader.cancel()` rejeté : le travail reste traçable et les réponses restent 202. Le succès local n’est pas une mesure de latence réseau fournisseur.

## À vérifier après publication

Le rejeu physique de Back pendant une préparation TF1, avec le compte utilisateur existant et les métriques des deux Gateways. Ce rapport ne déclare pas le correctif déployé ni ce dernier contrôle réalisé.
