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

Le code reste dans le brouillon PR756. **Aucun gain supplémentaire sur Normal, Conclave ou une autre VOD réelle n'est revendiqué.** Il reste à valider les sauts sous réception irrégulière sur des copies réelles et la qualité à l'écoute avant de modifier le routage public. Contrôle CI de la nouvelle tête à consigner après le push.
