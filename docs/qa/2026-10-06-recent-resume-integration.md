# Reprise récente : taille réelle et limite de continuité

## Conclusion — 7 octobre 2026, 00:08 Paris

**État historique arrêté à 00:08 Paris.** La poursuite demandée ensuite a produit PR682, un nouveau pilote restreint et deux reprises réelles traversant la fin du cache. Voir [le rapport du 7 octobre](2026-10-07-recent-resume-input-window.md). Les échecs et la désactivation ci-dessous sont conservés dans leur chronologie.

Le Robot Sauvage a réellement repris en **5,618 s**, après un démarrage normal mesuré à **34,584 s**. Les positions diffèrent : ce n'est pas un benchmark à position constante. **La continuation a dépassé la réserve locale et le lecteur a ensuite échoué. Le pilote n'est pas validé pour une lecture fluide.**

Le seul drapeau `PRIVATE_RESUME_RECENT_SAMPLES_ENABLED` est désormais désactivé sur les deux Gateways, avec la même image et les mêmes sources. Cache historique conservé. Vérification à 22:07:53 UTC le 6 octobre : deux Gateways sains, 86 empreintes concordantes, admissions/cron/worker/dispatcher actifs. Edge inchangés. Seul Adrien avait reçu cette politique pilote, aucun autre compte.

## Réponse à la question de la taille manquante

Le Gateway peut récupérer le total exact dans le GET ordinaire de lecture, sans exiger sa présence préalable dans le profil. `ensureBoundedMkvInputPump` et `preopenBoundedMkvInputPump` utilisent un Content-Range cohérent et conservent le total dans la session et son profil de lecture. Pour un HTTP200 complet dont la longueur reste inconnue, le chemin séquentiel ne fixe la taille qu'à l'EOF réel. Ni durée ni débit estimé ne remplacent une taille exacte.

Trois tests repassent : taille MKV découverte dans le GET conservé, sans deuxième connexion ; HTTP200 chunked avec taille connue et contrôle EOF ; HTTP200 inconnu lié seulement à l'EOF réel. Ils sont inclus dans les 229 tests de transport et ne doivent pas être additionnés.

**Correction de diagnostic : le profil du Robot possédait déjà 1 118 403 839 octets depuis 20:12:56.210 UTC.** Seule la télémétrie de préparation était absente. L'explication initiale attribuant son cas à une taille inconnue était erronée ; PR681 corrige la télémétrie. Cet essai ne prouve donc pas une reprise chaude réelle d'une copie initialement sans taille.

## Politique du pilote, maintenant désactivé

- Quatre prélèvements de 64 Kio (256 Kio) : en-tête et trois positions des plages déjà reçues. Aucun appel fournisseur ajouté à la sortie.
- Conservation avec fenêtre HLS privée et liaisons propriétaire/source/génération/fichier/taille/profil/piste/sous-titres.
- Quatre lectures fraîches séquentielles, même route et claim ordinaires, hors anciens caches de plages. Comparaison SHA-256, taille et cible.
- Budget de lecture huit secondes, suivi du drainage et de la grâce ordinaires ; aucun raccourcissement de la libération du compte.
- Validité dix minutes, politique historique avec validateur fort inchangée. Rejet si différence, expiration ou preuve absente.
- Plusieurs pistes audio et graphes de sous-titres partiellement conservés restent exclus. Aucune piste supprimée pour obtenir un hit.

C'est une preuve **partielle de fraîcheur**, pas un ETag fort fabriqué ni une preuve intégrale des octets. Une modification de même taille hors des quatre prélèvements peut passer inaperçue, démontré dans le prototype. La validation audiovisuelle synthétique ne certifiait pas la continuation d'une VOD réelle.

## Correctifs intégrés

| PR | Code / tête finale | Fusion | Objet |
|---|---|---|---|
| 679 | aad20ae9a478a8f6f8696628f7b9afc2f53f78d2 / ad80e900a37912160a74599ec7a7c3b68ea1a046 | c09ed0b4e14c92d2538a951bbdd13f07220bf1fa | Cache récent borné, désactivé par défaut, liste de propriétaires propre |
| 680 | 7e14ddac58b1d85c65bfe15d18db1f600f50cb4c | 5b6c42caf464cc7751c74c92d2a6ff372b0e361b | Broker indexé recréé après validation, succès et rejet |
| 681 | d4a825257919f2aa20ed593008ba13787dcf8404 / cc0b1d136cdf05f972ae2cc8d7af48b4bc4ff551 | 71499043688ed97de42925775b4fd3cc953169d2 | Politique Gateway/Edge/Web et télémétrie de taille |

Premier Conclave : après rejet de validation, le broker préparé était fermé et le démarrage normal perdait son entrée indexée, puis échouait gateway_502. PR680 corrige ce défaut ; échec conservé.

Deuxième Robot : quatre prélèvements correspondants, serveur rapide, mais politique perdue entre Gateway, Edge et WatchPage ; le client attendait sa réserve normale. PR681 transmet les provenances séparées (validateur fort ou prélèvements), exige une fenêtre cohérente et vérifie le tampon réellement chargé. Aucune vitesse d'encodage fabriquée.

## Essais réels (UTC le 6 octobre, Paris +2 h)

| Copie | Mesure | Résultat et limite |
|---|---|---|
| Conclave Dino MKV FR | à 393 s : TTFF 24,805 s ; reprise normale à 483 s après PR681 : 19,178 s | Lecture normale ; capture ultérieure rejetée pour couverture sous-titres. Aucune reprise chaude réussie revendiquée. |
| Abduct MAX OTT MULTI-SUB | départ 5,339 s ; préparation après saut à 430 s : 24,716 s | 21 sous-titres, huit préparés : graphe incomplet exclu du cache. Aucune certification de langue. |
| Robot MAX OTT MP4 FR, reprise normale à 310 s | première image 21:54:59.380339, TTFF 34,584 s ; serveur 31,100 s | Progression observée, sortie normale ; 30 788 196 octets HLS conservés. AAC-LC stéréo 48 kHz constaté dans les segments produits. |
| Même Robot, reprise chaude à 356 s | première image 21:58:41.851381, TTFF 5,618 s ; validation 4,043 s, Gateway 4,073 s | Quatre prélèvements correspondants, taille/cible concordantes, réserve 50 s. **Échec de continuité ensuite.** |

À 21:59:54.836, arrêt à 51,941951 s relatives, paused=true, readyState=2, tampon finissant à 51,989333 s. Aucun segment de continuation au relevé voisin. Premier FFmpeg dépassant le délai de 60 s, puis deuxième lancement observé. Une plage de 1 à 9 Mio dure 55,177 s, 5 246 082 octets reçus avant son remplacement ; nouvelle plage encore en cours. Continuation trop lente démontrée, cause interne stockage fournisseur/relais non attribuée.

Erreur levelLoadError à 22:03:16.143666, puis erreur de lecture, confirmée dans l'interface à 22:03:39. Sortie normale vers Films, sans nouveau réessai. **Première image rapide ne signifie pas lecture fluide.** Compteurs d'images indisponibles dans le pont DOM ; aucune certification basée seulement sur l'horloge.

Piste suivante **non implémentée** : conserver de manière bornée les plages déjà reçues utiles à l'index/en-tête et les réutiliser après preuve fraîche et liaisons exactes. Il faudrait démontrer le gain de continuation et traverser le bord du cache. Augmenter arbitrairement la réserve ou diminuer les gardes n'est pas un correctif démontré.

## Tests et CI

- PR679 : Linux 6 023 tests, 5 993 réussis, 30 ignorés ; cinq checks finaux réussis, paquets compris. Première CI échouée sur quatre fixtures VM corrigées, sans changement de logique Gateway.
- PR680 : 167 tests ciblés réussis, cinq ignorés ; cinq checks réussis, paquets compris.
- PR681 : 86 tests de politique réussis ; 229 tests de transport réussis, six ignorés. Groupes recoupés avec les relevés précédents. Première CI échouée sur manifeste i18n obsolète, régénéré. Onze checks non annulés de la tête finale réussissent, Windows/Phone/TV compris.
- Android 37536299421 : six configurations réussies sur code applicatif identique, téléphone gestes/trois boutons, polices 1/1,3, assertions WebView. TV consent/D-pad seulement, pas preuve décodeur TV. Matrices redondantes 37536298501 et 37536495860 annulées.
- Cloudflare 37536900202 réussi à 21:57:53 ; navigateur WatchPage.d5630ee231213a20.js, hls.js 1.7.3 conservé.
- Canary Gateway réseau isolé, UID1000, GPU réel, stockage séparé, douze contrats dont broker HTTP synthétique séquentiel. Aucun média fournisseur. Canary Edge santé sur son réseau normal. Tous arrêtés.

## Déploiements et désactivation

Pauses Gateway : 21:25:33.732004–21:25:44.537132 ; 21:36:26.987461–21:36:37.608935 ; 21:52:05.759281–21:52:52.464724. Image finale sha256:df6625ec02c36068fbdcbe6535425ff650b8c07437740deb0d1e1eafd38cbdfb, arbre 55e4f04197fa00151bd1988668e167aa019f1534eef8f4380b861627ac483808 ; 86 fichiers vérifiés.

Pause Edge 21:53:05.429678–21:54:12.142076. Playback SHA256 cb73c412c27975263fb42e1015fbad6d9da9993a84c50a27a4a6508103b15a29 ; runtime /home/adrien/.norva/recent-resume-policy-20261006/edge/runtime-functions ; 193 autres fichiers et permissions préservés sur 194. Ne pas restaurer un ancien runtime.

Désactivation pilote : pause 22:05:00.883988–22:07:09.896150 (129,012162 s), attente naturelle de travaux sous bail. Même image, un seul drapeau devient false. Contrôles des autres variables, volumes, réseau, ressources et 86 empreintes. Aucun bail forcé, route tournée, quota/délai raccourci. Worker/admissions/cron restaurés ; dispatcher conservé, Edge inchangés. Santé et désactivation vérifiées à 22:07:53.659495. Marqueur opérateur consommé, ne pas rejouer.

Attachements PR679–681 refusés à la limite100 ; aucun ancien attachement supprimé.

## Reçus

Répertoires locaux .codex-artifacts/recent-resume-integration-20261006/, recent-resume-replay-fix-20261006/ et recent-resume-policy-20261006/. Mesures browser-observations.safe.json, robot-final-splice.safe.json, robot-terminal.safe.json, robot-size-evidence.safe.json, CI/canaries/déploiements et disable-receipts/. La capture robot-cache-playing.png montre en réalité l'attente au bord du cache ; ne pas l'utiliser comme preuve de fluidité. Aucun identifiant, URL fournisseur, secret ou transcription publié.
