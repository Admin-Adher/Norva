# NorvaEngine : attendre la fin réelle de la lecture avant un saut

10 octobre 2026, suite du transport progressif dans **PR756 en brouillon**. Candidat non déployé ; aucune activation générale du moteur web ni modification du Gateway. Résultats dans le JSON homonyme et reçus locaux sous `.codex-artifacts/web-engine-stop-drain-20261010/`.

## Défaut reproduit et correction

Le moteur interrompait sa boucle de lecture avant de réinitialiser le démuxeur et le muxeur pour un saut. Son ancienne attente était limitée à 2 000 tours de 5 ms. Une lecture réseau pouvait dépasser ces dix secondes et conserver le contexte LibAV alors que le saut commençait à le réinitialiser.

Le test avant correction montre que l'arrêt retourne avec la lecture encore non résolue et la boucle toujours active. Le correctif conserve la promesse de cette boucle et attend sa fin réelle. Les paquets arrivant après une demande d'arrêt sont écartés avant capture des sous-titres ou écriture du muxeur.

Les délais réseau et l'annulation existants continuent de borner la lecture. Aucun délai, taille de plage, nombre de connexions, route, piste audio ou réserve de démarrage ne change. `progressiveRanges` reste désactivé par défaut. **Ce défaut de concurrence est établi ; son rôle dans toutes les pauses des copies réelles ne l'est pas.** Attendre correctement une réception lente ne la rend pas rapide.

## Vérification contrôlée

**139 tests ciblés réussis, zéro échec et zéro ignoré**, dont trois contrôles nouveaux : réponse dépassant l'ancienne garde, erreur pendant l'arrêt et refus des paquets tardifs. Ce groupe recoupe les précédents rapports ; les nombres ne sont pas additionnés.

Avec le vrai module LibAV livré, le serveur synthétique garde une réponse sans corps pendant onze secondes. À onze secondes, l'arrêt attend toujours le worker ; après libération, il termine en 11,014 s. Le saut à 12 s et la lecture jusqu'à EOF produisent **17 744 103 octets exactement identiques au témoin**, sous-titres compris. SHA-256 `06e49bbac2f43f0fee6228944b88c5fc61c493cd64986d60a4bddcff5d9f07ff`.

Deux calibrations du banc sont conservées : un chemin de module avec espace mal décodé, puis un préfixe déjà fourni au worker qui lui permettait de terminer avant la fin de la réponse. Le contrôle final retarde tout le corps pour établir une lecture effectivement en attente. Le champ brut `holdMs` inclut du traitement ultérieur et ne mesure pas uniquement l'attente réseau ; `stopElapsedMs` mesure l'arrêt.

## Navigateur et AAC

Deux fixtures Matroska avec B-frames sont lues par le moteur réel, avec serveur local à 128 Kio toutes les 250 ms. Onglets muets.

| Cas | Première image | Saut vers 18 s | Résultat |
| --- | ---: | ---: | --- |
| AAC-LC stéréo 44,1 kHz, SRT | 1,376 s | 72 ms, **dans le tampon déjà complet** | EOF atteint ; ce saut ne mesure pas un redémarrage du démuxeur |
| AAC-LC 5.1 48 kHz, ASS | 1,217 s | **5,723 s**, hors du tampon disponible | Saut réel du moteur, EOF atteint, réplique future collectée |

Aucune erreur média dans ces essais. Des intervalles initiaux entre images de **758 et 739 ms** restent observés avant les sauts ; ces deux lectures ne sont pas certifiées entièrement fluides. Aucun nouvel intervalle de gel mesuré après le saut ASS dans la courte fenêtre restante, environ treize secondes. Les contrôles de sous-titres restent limités aux fixtures.

Le compteur brut du serveur conserve sa limite déjà documentée : il attend artificiellement après le dernier octet et peut compter deux handlers alors que la première plage est reçue. Ce compteur n'est pas présenté comme une preuve de deux connexions fournisseur. Aucun appel média fournisseur n'est effectué dans cette étape.

Les deux sorties identiques du contrôle LibAV sont redécodées : AAC-LC stéréo 48 kHz, zéro diagnostic audio. **Aucune validation à l'écoute ni nouvelle preuve sur un film entier.** Aucun changement de rendu WebView ou de lecteur Android natif ; aucune nouvelle matrice émulateur revendiquée.

## Nettoyage et état

Les six fichiers médias/sous-titres synthétiques sont supprimés uniquement du répertoire d'essai, avec tailles et hashes conservés. Onglet et serveur temporaires arrêtés. Aucun média fournisseur sauvegardé dans cette étape. Le manifeste i18n est actualisé uniquement pour l'empreinte du moteur ; les références générées accidentellement sur les pages sans rapport sont annulées avant commit.

Le code reste dans le brouillon PR756. **Aucun gain supplémentaire sur Normal, Conclave ou une autre VOD réelle n'est revendiqué.** Il reste à valider les sauts sous réception irrégulière sur des copies réelles et la qualité à l'écoute avant de modifier le routage public.

## CI et suite sur copies réelles, 10 octobre à 12:11 Paris

Les **cinq contrôles de `ff27db9a4946ab53944377468b72840d43d530d2` réussissent**, paquets Android et Windows compris. Run `38042065160`, job contrats `114184119253` : **6 327 tests réussis, 34 ignorés, zéro échec**. Ce groupe recoupe les 139 tests ciblés ; les nombres ne sont pas additionnés.

Le propriétaire a autorisé les essais de lecture et confirmé l'arrêt des lectures concurrentes. Deux copies sont relues via sessions Edge ordinaires, avec visibilité, génération de source, profil exact et occupation du compte vérifiés avant ouverture. Le moteur candidat de PR756 est chargé dans un banc temporaire avec WatchPage. `progressiveRanges` est activé uniquement dans ce banc. **Le MP4 est volontairement forcé dans le moteur expérimental pour cette comparaison : son résultat ne caractérise pas le chemin MP4 habituel de Norva.** Aucune route publique n'est modifiée.

| Copie | Session prête | Première image depuis le clic | Suite observée |
| --- | ---: | ---: | --- |
| Vice-versa 2, MP4 H.264/AAC | 0,781 s | Aucune | Limite moteur de 15 s atteinte ; premier 512 Kio en 8,057 s, puis 1 Mio en 4,291 s. Les en-têtes MP4 annoncent un bloc `moov` d'environ 5 Mio ; le moteur n'a pas terminé son ouverture. |
| Conclave, MKV H.264/AAC, essai corrigé | 0,825 s | 10,979 s | Interruption dès 0,300 s de vidéo ; tampon jusqu'à 0,997 s. Saut à 300 s demandé à 40,345 s : pas de reprise visible avant l'arrêt volontaire vers 137,7 s. |

La réception progressive est réellement utilisée sur Vice-versa 2, avec 1 703 936 octets servis avant complétion des réponses. Elle ne suffit pas à faire terminer l'ouverture dans cet essai. Sur Conclave, les plages terminées de 1 Mio et 4 Mio prennent respectivement **21,424 et 59,167 s**. Le setup du saut prend **48,092 s**, puis une plage de 4 Mio vers sa cible reste en attente et est annulée lors de l'arrêt. Son entrée `network_error` après 49,214 s décrit cette annulation : elle n'est pas attribuée à un refus du fournisseur. Aucun accès simultané supplémentaire ou changement de seuil n'est introduit.

Un premier essai Conclave est **exclu de la comparaison** : la création de session a répondu en 55,509 s, après la limite totale de 45 s du banc. Le banc avait déjà demandé sa fermeture avant d'utiliser cette réponse tardive. Ce défaut de synchronisation du banc est corrigé avant le seul rejeu supplémentaire : budget séparé pour la création, refus de charger une réponse arrivée après arrêt. La limite de démarrage du moteur reste 15 s. Les reçus du premier essai sont conservés ; aucun échec de production n'en est déduit. Le mauvais décodage UTF-8 des sélecteurs locaux et le type MIME CSS du banc sont également corrigés **avant toute lecture**.

Ces lectures ne valident ni les sauts fluides, ni le remplacement du Gateway, ni la qualité à l'écoute. Les onglets sont muets. La première erreur HTML `Empty src attribute` des observations précède le chargement du moteur ; elle ne prouve pas une erreur de décodage AAC. Aucune nouvelle certification audio n'est ajoutée.

Trois sessions d'essai sont expirées normalement ; les deux comptes fournisseur ciblés ont **zéro session restante** au contrôle final. Contrôleurs, serveur local, tunnel et onglet temporaire sont arrêtés. Aucun média fournisseur n'a été écrit par le banc ; seuls les reçus restent. Gateway principal, deux Edge et dispatcher de langues sains. Aucun bail forcé, déploiement Gateway/Edge, changement du relais ou des gardes. Les nouveaux reçus sont sous `.codex-artifacts/web-engine-seek-real-20261010/`.

## Windows et trajet réseau

PR757 est intégrée par `35ba5704af2cdd0f9a3ad0f73b94f3d7b168febe`. Le portable natif intégré, distinct du lecteur web, a été vérifié après ouverture manuelle. **Windows `2.1.5-native.2` est publié à 11:59:56 Paris**, en préversion non signée. API publique et téléchargement HTTP 200 vérifiés ; EXE 239 558 491 octets, SHA256 `bbcb0d10eaed6c6f668777893239d9d633c100de89f4477d33091b90b05a95e3`. Les cinq checks de la tête documentaire `7900deb65` passent aussi. [Release et sources correspondantes](https://github.com/Admin-Adher/Norva/releases/tag/v2.1.5-native.2).

La dernière demande NodeMaven — essai isolé aux États-Unis sur un autre ISP/trajet, gratuité/durée/limites/IP à confirmer, relais courant préservé — reste lue sans réponse lors du contrôle. Aucun provisionnement, frais ou modification de production. **PR756 reste en brouillon ; aucun nouveau gain de fluidité web n'est revendiqué.**
