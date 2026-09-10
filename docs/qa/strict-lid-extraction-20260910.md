# Diagnostic et extraction audio stricte — 10 septembre 2026

## Résultat réel

Contrôle arrêté après un petit lot interne, sans ouverture d'un nouveau déploiement massif. Quatre fichiers ont été essayés sur trois identités fournisseur distinctes : un fichier diagnostique mis en quarantaine, puis un autre fichier de ce même fournisseur, et deux fichiers d'autres fournisseurs.

| Fournisseur anonymisé | Fichier | Résultat observé |
| --- | --- | --- |
| A | Premier échantillon diagnostique | Refus `VOD_CHANGED` avant correction du chemin temporaire, puis quarantaine normale à quatre tentatives. Aucun réarmement de cette quarantaine. |
| A | Nouveau fichier après correction finale | Six extractions réussies, validation stricte obtenue, anglais (`en`) enregistré dans le cache exact partagé à 19:03:30 UTC. |
| B | Fichier témoin | Six extractions réussies avant la dernière modification ; six extraits insuffisants pour la preuve de parole. Aucune langue certifiée. |
| C | Fichier reproduisant le défaut | Deux échecs avant la correction finale, puis six extractions réussies. Une fenêtre acceptée, deux de confiance insuffisante, trois insuffisantes pour la preuve de parole. Consensus strict non atteint. |

Les douze fenêtres des fournisseurs A et C ont réussi avec la correction finale. Les six fenêtres du témoin B constituent une référence de fonctionnement sous la révision diagnostique précédente, pas un nouveau test de B après la dernière modification. Ce lot n'est ni représentatif de tous les catalogues ni une mesure statistique du taux de succès.

Une seule nouvelle certification est démontrée. Le cache a été contrôlé en lecture seule : `audio_lang_verified_at` présent et langue `en`. Aucun tag, identifiant TMDB, sous-titre ou langue n'a été forcé. Les quatre tâches du lot n'ont plus de bail actif au dernier contrôle. L'activité habituelle hors de ce lot n'a pas été arrêtée.

## Cause et correction

Le diagnostic précédent ne montrait qu'un échec FFmpeg/HTTP 5xx. Le journal interne distingue maintenant la phase de requête, le statut HTTP amont, le code de transport, les délais et un motif d'intégrité fermé. Aucun message brut, URL, accès fournisseur, identifiant de compte ou transcription n'est ajouté à ces diagnostics.

Le défaut observé était un HTTP 206 valide suivi de `effective-target-changed`, sans validateur ETag et avec un chemin final différent. L'adresse d'entrée du fournisseur produisait un nouveau chemin CDN temporaire à chaque réouverture ; le broker l'interprétait comme un changement de cible pendant les recherches d'octets de FFmpeg.

La validation stricte résout désormais l'adresse une fois par fenêtre et réutilise cette cible exacte pour les recherches suivantes. Le proxy reste celui du compte initial. Une cible expirée ne déclenche aucune résolution de secours. Les contrôles de taille, coordonnées, encodage, ETag/Last-Modified et changement de cible restent actifs. Le simple renouvellement des valeurs de requête reste admissible uniquement avec un ETag fort identique et la même identité protocole/hôte/chemin/clés de requête.

La reconnexion de lecture vidéo finie, les protections 458/407, les délais de libération fournisseur, la priorité du lecteur et les limites de tentatives ne sont pas modifiés.

## Déploiement

La révision finale du service `norva-media-gateway` est saine, version de santé 166. Empreinte SHA-256 du JavaScript normalisé LF :

`ef0f9652b91adfecddfc070ab04731e021adeb407342a8f22a7e37ef56a055f5`

L'environnement est identique à celui relevé avant le premier déploiement de cette intervention. La modification est un overlay du seul JavaScript de la passerelle, sans migration, nouveau drapeau, remplacement des fonctions Edge ou changement de modèle Whisper.

Les fichiers Compose/env d'origine étaient absents du serveur. Le déploiement a donc conservé la configuration Docker complète et les conteneurs précédents arrêtés pour un retour arrière. Aucun conteneur ni fichier utilisateur n'a été supprimé. Le script opérateur refuse le déploiement si une lecture ou un travail local est actif et refuse un retour arrière depuis une autre révision.

Une unique reprise opérateur a été faite sur le premier nouvel échantillon alors qu'il attendait encore, avant sa quarantaine : uniquement la date de prochaine tentative, sans remise à zéro des compteurs. Elle n'a pas résolu le défaut de chemin. Aucune quarantaine existante n'a été réarmée ; le test final du fournisseur A utilise un autre fichier auparavant jamais essayé.

## Tests et limites

- Suite ciblée passerelle/validation : 558 tests, 555 réussis, aucun échec, trois tests nécessitant des médias externes non exécutés localement.
- 121 tests ciblés exécutés dans l'image Linux du serveur, Node 20.20.2 / Undici 7.29, réseau externe désactivé : succès.
- Reproducteur HTTP réel local : ancien code en échec, nouveau code en succès avec chemin signé tournant et sans ETag. Cas négatifs : expiration, changement de validateur, hôte/chemin et forme de requête ; absence de réessai caché et préservation du parcours vidéo fini.
- Suite globale locale : 4 041 réussis, neuf ignorés, un fichier de test en échec sur sa recherche littérale de fins de ligne LF dans le workflow Android existant. Les cinq tests de ce fichier passent sur une copie de contrôle avec fins de ligne normalisées. Aucun fichier Android/workflow n'a été modifié pour masquer ce défaut local.
- L'état actuel des interfaces et la lecture mobile/TV ne sont pas certifiés par ces tests serveur ; aucun rendu de l'application n'a été modifié.

Le seuil d'apprentissage approuvé de 99 % sur au moins 200 fichiers de validation indépendants n'a pas été abaissé ni activé par ce correctif. Les pistes réellement vérifiées restent prioritaires. Une extraction réussie seule ne vaut jamais certification linguistique.

## Reproduction opérateur

Les scripts datés dans `ops/hetzner/scripts/` conservent les contrôles exacts de révision et utilisent le plan privé déjà présent sur le serveur. `read-strict-lid-extraction-proof-20260910.py` est entièrement en lecture seule et ne retourne que les états anonymisés du lot, la santé, l'empreinte de code et les événements diagnostiques à champs fermés.
