# Démarrage VOD — validation du 16 septembre 2026

## Périmètre et état

Travail demandé : corriger et mesurer le premier démarrage MP4, MKV et MPEG-TS, sans confondre première image, lecture effective et reprise depuis un cache.

- Compte de test KING365 ; une connexion fournisseur à la fois. Aucun changement de compte ni de route proxy pendant ces essais.
- Gateway actif : `norva-media-gateway:startup-reliability-20260916-r6`, code serveur `4a712787da8379c74286f4fa06d469617c68bed4`.
- Web : le pilote `6bd1adf53d8376355b675c9e45c34445478e40a0` (WatchPage `96be1bddb8`) a été publié puis rejeté sur la mesure réelle. Retour au tampon MP4 de sécurité publié avec `38de25b1f53de0d7c2e79440632ecb1a9bf97ffd` ; [CI verte](https://github.com/Admin-Adher/Norva/actions/runs/35051340837), 4 916 réussis, 0 échec, 21 ignorés. Version `e662010afb` et refus de l'ouverture MP4 anticipée vérifiés dans le navigateur de production.
- Les fenêtres expérimentales et les nouveaux caches restent limités au compte pilote. Le partage de fragments entre utilisateurs reste désactivé.
- La copie de travail principale et ses modifications préexistantes sont conservées. Les changements sont publiés sur `codex/vod-startup-reliability-20260916`, pas fusionnés dans `main`.

## Corrections réellement livrées

1. MPEG-TS fini et déjà identifié : suppression du nouveau parcours de fin de fichier destiné à estimer une durée déjà connue, y compris lorsque le démultiplexage doit revenir à une découverte complète. Le repli de découverte et les contrôles des pistes sont conservés.
2. MPEG-TS : démarrage séquentiel sans la double prélecture lorsque aucun cache validé ne peut servir ; petites fenêtres réservées au pilote. Réouvertures planifiées distinguées des erreurs réseau.
3. MKV : connexion de lecture continue rétablie. L'essai de découpage du premier téléchargement en 2 Mio provoquait une nouvelle URL signée puis `VOD_CHANGED` ; cet essai a été retiré.
4. MP4 : transport par plages séparé des critères du cache. Un fichier comportant plusieurs pistes audio ou des sous-titres peut désormais utiliser ce transport sans supprimer ses pistes.
5. MP4 natif : fenêtres de 8 Mio rétablies. L'essai de 2 Mio a dégradé la continuité, il n'est pas conservé sur ce chemin.
6. MP4 HLS : l'ouverture anticipée sur plusieurs apports mesurés à >= 2x a été testée puis retirée. Les premiers apports rapides ne prédisaient pas le ralentissement ultérieur. La politique MP4 garde sa réserve de sécurité ; les politiques MKV/MPEG-TS déjà vérifiées restent distinctes.
7. Diagnostics bornés : étapes de démarrage, plages téléchargées et motifs de refus de validation du cache, sans URL ni secret fournisseur.

## Méthode

Instrumentation avant le clic de lecture ; première image et premières images successives mesurées séparément avec `requestVideoFrameCallback`. Deux minutes de temps mural à partir du mouvement, éléments vidéo visibles, vitesse 1x. Les interruptions `waiting` après le démarrage, le temps média réellement avancé et les images perdues sont relevés. Les vidéos sont arrêtées par la navigation normale.

Une session lancée depuis zéro peut réutiliser des métadonnées codec déjà connues : ce n'est pas une première découverte de fichier. Une reprise est indiquée explicitement. Les durées d'une plage incluent potentiellement la contre-pression locale ; elles ne constituent pas à elles seules une mesure isolée du débit du fournisseur.

## Mesures

| Version / titre | Chemin | Départ effectif | Vidéo lue / 120 s | Attente après démarrage | Images perdues |
|---|---|---:|---:|---:|---:|
| Avant correctif — Un long dimanche de fiançailles | MPEG-TS, départ 0 | 10,53 s | 87,49 s | 31,65 s / 1 coupure | 0 |
| R2 — Upside-Down Magic | MPEG-TS, première découverte, départ 0 | 15,84 s | 119,89 s | 0 | 0 |
| R2 — Bons baisers de Paris | MPEG-TS, reprise 370 s | 29,74 s* | 119,64 s | 0 | 0 |
| R6 — Justice pour mon enfant | MKV, nouvelle session à 0 | 8,22 s | 119,98 s | 0 | 0 |
| R6 — Seven Sisters | MP4 HLS, départ 0, avant correctif longues séquences web | 114,54 s | 119,56 s | 0 | 0 |
| R6 — Origin Unknown | MP4 natif, reprise 445 s | 8,00 s | 102,12 s | 17,87 s / 4 coupures | 0 |
| R6 + pilote web retiré — Mise à mort du cerf sacré | MP4 HLS, départ 0 | 10,28 s | 68,91 s | 51,15 s / 1 coupure persistante | 0 |
| R6 — Bons baisers de Paris, répétition | MPEG-TS, reprise 513 s | Échec serveur à 60 s | Aucune image | `PLAYLIST_TIMEOUT` | Non mesurable |

*Bons baisers de Paris : instrumentation installée trop tard pour mesurer le clic ; 29,74 s est la télémétrie applicative de première image, pas un chronométrage complet du clic au mouvement. Les deux minutes de continuité sont mesurées indépendamment après démarrage.

Les résultats d'un titre ne certifient pas tout le catalogue. Les latences des essais successifs ne constituent pas un A/B réseau contrôlé.

### Constats importants

- Justice pour mon enfant : serveur prêt en 5,59 s, première image à 7,75 s, mouvement à 8,22 s. Le découpage MKV retiré avait auparavant arrêté ce même fichier après 7,64 s de vidéo (`VOD_CHANGED`). Pas de nouvelle erreur lors du test R6.
- Seven Sisters : serveur prêt en 11,84 s contre 41,50 s dans l'essai initial, première image prête à 14,31 s ; lecture retenue jusqu'à 114,54 s. La première séquence de 12,5 s dépassait le plafond de 12,25 s de l'observation adaptative. Une extension du plafond a été évaluée puis retirée avec l'ouverture MP4 anticipée.
- Mise à mort du cerf sacré : serveur prêt en 5,05 s, première image à 6,99 s, ouverture adaptative à 10,28 s (4 apports, 21 s ajoutées en 3,234 s, réserve 28,97 s). Le tampon se vide ensuite après 68,9 s de vidéo : 51,15 s d'attente. Ce résultat invalide l'activation, même si le démarrage était proche de 10 s.
- Origin Unknown : session obtenue en 1,10 s, métadonnées à 6,22 s, mouvement à 8,00 s. La réserve tombe ensuite et quatre coupures commencent après environ 98 s de lecture. Ce test n'est pas déclaré fluide.
- Upside-Down Magic : les deux premières minutes sont réussies, mais un téléchargement prolongé ensuite a fini par échouer sur des erreurs fournisseur transitoires après environ 725 Mo. Ce problème au-delà de la fenêtre de test n'est pas déclaré résolu.
- Bons baisers de Paris, répétition du 16 septembre à 03:20 UTC : échec à la reprise 513 s, malgré la suppression du parcours supplémentaire de durée. 22 ouvertures de plages (18 terminées, 3 interrompues), aucun segment en 60,007 s. Journal : `co located POCs unavailable`, `reference picture missing during reorder`, `mmco: unref short failure`. La recherche de position et le démarrage du décodage restent à isoler ; ces messages ne prouvent pas à eux seuls une panne GPU ou un fichier irrécupérable. Aucun élargissement de délai ou changement de décodeur non mesuré n'a été appliqué.
- Aucun nouveau cache de reprise n'a encore servi les échantillons : identité HTTP forte absente/faible, donc refus volontaire. Les succès de démarrage ci-dessus ne sont pas des succès de réutilisation du cache.

## Tests et sécurité

CI finale après retrait : 4 937 tests, 4 916 réussis, 21 ignorés, aucun échec. CI du pilote : 4 938 tests, 4 917 réussis, 21 ignorés, aucun échec. Son échec en lecture réelle montre pourquoi les tests automatisés ne suffisent pas. Après retrait de l'ouverture MP4, 23 tests ciblés passent : contrat serveur/Edge/navigateur, réserve MP4 maintenue, MPEG-TS et annulation. Fixture FFmpeg MPEG-TS exécutée dans Linux : décodage identique et moins de parcours de fin, connexion unique ; résultats synthétiques distincts des mesures réelles.

Sur Windows, deux échecs de la première suite complète ont été isolés : dépendance Undici locale ancienne (absence de SOCKS5ProxyAgent) et manifeste généré non rafraîchi. Le manifeste a été régénéré ; la CI avec les dépendances verrouillées est verte.

Le redémarrage R6 est terminé, contrôlé par garde de retour arrière, sans modification des autres conteneurs. Les tâches actives ont pu finir ; aucune n'a été interrompue. La vignette différée issue du test MKV a été conservée avec son identité exacte puis remise dans la file normale après les essais : `storyboardsRequeued: 1`, `storyboardResumeComplete: true`. Cela certifie sa remise en file, pas l'achèvement de sa génération. Les crons, le code serveur et les invariants de déploiement ont été revérifiés ; aucune session de lecture ni pompe native n'est restée active à la clôture des tests.

## À compléter avant généralisation

- Stabiliser le MP4 natif sur une fenêtre de deux minutes et répéter plusieurs titres à zéro.
- Isoler la recherche et le décodage MPEG-TS à la reprise 513 s ; l'échec intermittent est confirmé, pas résolu.
- Obtenir une identité fiable sur un échantillon puis mesurer une véritable réutilisation du cache avant toute extension.
- Une comparaison des routes KING365 a été proposée, avec une connexion à la fois et avertissement de changement possible d'IP. Aucune comparaison ni bascule nouvelle n'a été faite sans cette autorisation spécifique.

Aucun objectif « moins de 10 s partout » ni « tous formats pleinement opérationnels » n'est certifié à ce stade.
