# Reprises récentes : extension et vérification sur plusieurs VOD

Demande : poursuivre l'amélioration jusqu'à un parcours fiable sur davantage de films et séries. Ce rapport distingue les gains observés, les refus de cache corrects et les limites de généralisation. Pilote de validation récente toujours limité au propriétaire autorisé ; aucune modification du modèle de concurrence, des routes ou des réserves du lecteur.

## Corrections intégrées

- PR687, code `72fcab486d83f9040ab3c70c6152b4dc3db3db01`, fusion `fb806e499770d2c0702ec9f8a3cf07f099d87b4c` : arrêter les lectures de validation restantes dès qu'une réponse complète établit un changement de cible. Drainage avant repli ordinaire ; une acceptation exige toujours quatre prélèvements frais, taille exacte, cible et profil concordants. Les composants de cible sont comparés sous forme de digests privés ; les diagnostics ne publient que quatre booléens, aucun accès fournisseur.
- PR688, code `75611e65a3f366709d7b14fb08d7ba28e0460feb`, fusion `79dbce8f88efb916faa217a53cd70dd6c47c73ce` : réutiliser les octets source retenus pour un MKV dont le graphe de sous-titres est partiel. La lecture reconstruit exactement les pistes ordinaires. Aucun cache de playlist incomplet ni piste supprimée. Binding du profil comprenant le nombre de sous-titres source, les renditions préparées et la sélection. Plafonds inchangés : 64 Mio par entrée, 256 Mio agrégés, dix minutes pour la preuve récente.

PR687 : 147 tests réussis, cinq ignorés, plus un test HTTP réel de changement de cible ; groupes susceptibles de se recouper. PR688 : 31 tests ciblés et sept tests de régression supplémentaires, groupes recoupés. Canary combiné : 29 tests réussis sous UID1000 avec GPU, réseau none et stockage séparé, sans média fournisseur ; arrêté et retiré. L'erreur locale initiale d'encodage cp1252 du script de préparation a été corrigée en UTF-8 avant tout effet distant.

## Déploiement vérifié

7 octobre UTC, pause admissions 00:42:08.276431–00:42:24.170242 (15,894 s), drainage naturel, aucun bail forcé. Deux Gateways remplacés, même dispatcher conservé ; cron, admission et worker restaurés. Edge, Web et Android inchangés.

Image `sha256:9764c42dc7344c5c13f489327bc20a233725c90d4902f629e53a8e891e56942b`, arbre `dc2dd48d70d274c792bd42e05026afdb6341aab72c107b792c637f7d8273116e`. Trois fichiers modifiés et 83 conservés. À 00:44:38 UTC, les 86 empreintes concordent sur les deux Gateways sains. Marqueur apply consommé : ne pas rejouer.

## Mesures et périmètre

Les positions changent entre lecture et reprise ; ces essais ne sont pas un benchmark à position constante. Le TTFF client et la durée session créée → play_started ont des origines distinctes. Les événements peuvent parvenir dans un ordre différent. Un relevé DOM et un segment décodé ne constituent pas une certification de tout le film ni une écoute humaine.

Les essais précédents du Robot Sauvage (MP4) et Breaking Bad S1E3 (MKV multipiste) restent documentés dans `2026-10-07-recent-resume-input-window.md` et `2026-10-07-recent-multiaudio-input.md`.

### Abduct, copie MAX OTT MULTI-SUB

Une piste audio, 21 sous-titres source, huit préparés selon le plafond ordinaire. Avant extension : reprise à 469 s, première image 44,044 s, lecture effective 91,202 s après création. Cette mesure variable ne doit pas être attribuée uniquement à l'absence du nouveau cache. Un segment de cet essai montrait un intervalle vidéo de 167 ms, sans diagnostic de décodage ; conserver cette limite.

Après déploiement, lecture sans cache à 582 s : première image 28,908 s ; lecture effective 28,628 s ; préparation FFmpeg 21,073 s. Fermeture normale après 48,645 s relatives, puis conservation de 19 315 673 octets.

Reprise à 630 s : quatre prélèvements validés en 5,320 s, mode `partial-subtitles`, mêmes une piste audio et huit sous-titres préparés ; première image 10,823 s, lecture effective 10,019 s ; préparation FFmpeg 2,768 s. Aucun changement de politique de réserve. Les deux segments de sortie contrôlés après déploiement contiennent chacun 48 images, intervalle maximal 42 ms, aucun diagnostic de décodage ; audio AAC-LC stéréo 48 kHz.

La reprise atteint 124,320 s relatives, non pausée, readyState 4, sans erreur aux relevés. Le broker poursuit des lectures fournisseur ordinaires au-delà des plages retenues ; aucun blocage de raccord observé. Le segment limité de l'essai antérieur avec un intervalle de 167 ms reste distinct de ces deux contrôles post-déploiement.

### Conclave, copie Dino MKV

Lecture sans cache à 782 s : première image 13,670 s ; lecture effective 12,860 s ; fermeture normale à 31,963 s relatives. Une fenêtre HLS est bien conservée.

Reprise à 814 s : rejet `target-changed` en 1,399 s après la première plage fraîche complète. Nouveau diagnostic : protocole, hôte et noms de paramètres identiques, chemin différent. Aucune URL n'est publiée et aucune équivalence du chemin n'est inventée. Les trois lectures de contrôle restantes sont évitées ; le cache rejeté ne sert aucun média. Repli ordinaire : première image 22,409 s, lecture effective 21,552 s, préparation FFmpeg 18,795 s. Ce film reste plus lent à reprendre ; le gain démontré est la suppression des vérifications inutiles, pas une accélération universelle du média.

### Fallout S1E2, copie Dino MKV — contrôle avant les deux nouvelles corrections

Deux pistes audio et deux sous-titres. Sans cache à 70 s : première image 8,703 s, lecture effective 9,500 s. Reprise à 135 s : première image 16,051 s, lecture effective 17,590 s, validation 3,727 s ; quatre prélèvements et taille concordants mais cible différente, donc cache refusé correctement. La lecture ordinaire progresse jusqu'à 105,509 s relatives sans erreur aux relevés. Aucun gain post-déploiement n'est revendiqué pour cette série ; cette observation a motivé le rejet anticipé PR687, testé en HTTP réel puis sur Conclave en production.

### Vice-versa 2, copie MAX OTT MP4

Lecture sans cache à 312 s : première image 32,593 s, lecture effective 31,735 s, préparation FFmpeg 30,351 s. Fermeture normale après 37,883 s relatives.

Reprise à 349 s : première image 5,351 s, lecture effective 4,936 s, validation fraîche 3,252 s, fenêtre HLS de 47 secondes et 8 Mio d'entrée conservée. La continuation est prête en 6,551 s ; le temps de lecture dépasse la frontière à 62,112 s, readyState 4, non pausé et sans erreur au relevé. Les deux segments locaux contrôlés ont chacun 48 images, intervalle maximal 41,667 ms, aucun diagnostic de décodage et sortie AAC-LC stéréo 48 kHz. Ce test confirme la continuité du chemin MP4 antérieur ; ce gain n'est pas attribué aux deux seuls correctifs PR687/688.

## Limites de fiabilité

Vice-versa 2 atteint finalement 124,514 s relatives, non pausé, readyState 4, sans erreur aux relevés ; huit lectures fournisseur ordinaires sont observées pendant la continuation. Conclave atteint 46,518 s après repli, également sans erreur. Toutes les lectures de test sont fermées normalement par retour à Films. Au contrôle final à 00:54 UTC, les deux Gateways sont sains et ne déclarent aucune session active.

Les cinq checks de PR687 et les quatre checks observés de PR688 sont tous réussis, paquets Android Phone/TV et Windows compris. Aucun code natif ou WebView modifié, aucune nouvelle matrice d'émulateurs revendiquée. Les attachements Codex ont été refusés à la limite de 100 ; aucune pièce supprimée.

Une identité changeante, une taille non démontrable, une réponse de plage invalide, l'expiration ou un profil différent rendent le cache inéligible et déclenchent le chemin ordinaire. Une validation par prélèvements n'est pas une comparaison intégrale du fichier. Une source vide, endommagée ou lente ne devient pas fiable grâce au cache. Le premier démarrage et les reprises hors des plages retenues ne bénéficient pas nécessairement d'une accélération.

Reçus : `.codex-artifacts/recent-resume-broader-20261007/`, `.codex-artifacts/recent-subtitle-input-20261007/receipts/`, et les fichiers préfixés `broader-`/`abduct-` du dossier `.codex-artifacts/recent-resume-integration-20261006/`. Les données d'accès fournisseur restent privées.
