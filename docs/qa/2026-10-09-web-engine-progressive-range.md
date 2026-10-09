# NorvaEngine : données progressives et index de reprise conservé

Suite de [l'analyse initiale bornée](2026-10-09-web-engine-bounded-demux.md), dans **PR756 en brouillon**. Candidat de révision 49 ; **aucun déploiement ni remplacement du Gateway**. Production vérifiée en révision 48 à **23:55:16 Paris**, le 9 octobre. Le JSON homonyme contient les mesures ; reçus sous `.codex-artifacts/web-engine-progressive-20261009/`.

## Résultat et limite

Le moteur web FFmpeg/WebAssembly fonctionne sur les fichiers contrôlés. Ce travail ne fournit pas un LibVLC natif dans le navigateur : la vidéo dépend encore des codecs acceptés par celui-ci. Le lecteur Windows natif publié suit un autre parcours.

Sur une trace réseau synthétique identique, restituer les octets pendant leur arrivée supprime une pause de six secondes mesurée avec l'attente d'une plage complète. Les six comparaisons de sortie avec le vrai module LibAV conservent exactement les mêmes octets et sous-titres.

**Conclave reste irrégulier.** Le dernier essai démarre en 5,5 s et reprend après un saut en 11,4 s, puis avance environ 70 s sans nouvelle pause après une interruption initiale supplémentaire de 2 s. Plusieurs pauses précèdent ce saut. Les essais réseau ne sont pas simultanés ; leur différence ne constitue pas un gain causal attribuable intégralement au code. **La fluidité des copies réelles n'autorise pas encore l'activation.**

## Changements du prototype

- Option `progressiveRanges: true`, **désactivée par défaut**, employée uniquement dans le banc. Aucun branchement public n'active cette option.
- Une réponse bornée alimente LibAV par tranches contiguës positives avant sa fin, via un [lecteur de flux HTTP](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream/getReader). Le cache ne reçoit la plage qu'après réception complète et validation.
- Offset, fin, total numérique et taille actuelle concordants avant livraison du premier octet ; `Content-Length` cohérent lorsqu'il existe. Réponse tronquée, surlongue, décalée ou taille modifiée refusée. Reprise réseau interdite après consommation d'un préfixe : arrêt de cette génération de remuxage et parcours de récupération existant.
- Lectures concurrentes du démuxeur, de l'index et du préchargement sérialisées. Une lecture disjointe attend la fin de la réponse précédente. Aucun nouveau dispatcher ni connexion fournisseur parallèle.
- Délai initial de 15 s maintenu jusqu'au premier fragment utilisable. Une réponse commencée pendant cette phase peut continuer après ce fragment dans la limite existante de 60 s par requête ; aucune extension sans fragment utilisable.
- Repères `Segment`, `TimestampScale` et position `Cues` conservés lorsqu'ils viennent d'un en-tête entièrement validé et de structures `Info`/`SeekHead` complètes. Seulement des nombres et leur périmètre de session, sans seconde copie média ni index partagé entre comptes. URL ou taille différente impose la lecture ordinaire ; nouveau chargement efface les repères.
- Les lectures positives courtes des éléments d'index sont assemblées avant parsing. Le sous-titre traversant la reprise reste couvert par le test de l'index.

Tailles initiale/ordinaire/reprise, nombre de fenêtres LRU, sélection des pistes, codec, modèle de langues, réserve de démarrage, routes, claims, heartbeat, TTL et gardes de production inchangés. L'index accepte désormais plusieurs lectures courtes ; ce helper commun est couvert également hors de l'option progressive.

## Tests et comparaison avec LibAV réel

**410 tests ciblés réussis, zéro échec et zéro ignoré**, couvrant moteur, cycle de lecture et WatchPage. Ce groupe recoupe les 114 tests du précédent rapport ; ne pas les additionner. Dix-huit nouveaux tests de transport progressif et quatre tests d'index vérifient notamment : lecture avant fin de réponse, sérialisation, interruption, erreur tardive unique, annulation, EOF, statuts 401/403/458, Range incohérent, taille inconnue/modifiée, longueur contradictoire et absence de relecture du début après éviction du cache.

Module LibAV réellement livré, trois fichiers synthétiques, départ à zéro et reprise à 12 s :

| Cas | Comparaison plage complète / progressive |
| --- | --- |
| H.264 sans B-frames, AAC 48 kHz stéréo, SRT, 90 s | MP4 et sous-titres identiques aux deux positions ; EOF atteint |
| H.264 avec B-frames, AAC 44,1 kHz stéréo, SRT, 30 s | Même résultat |
| H.264 avec B-frames, AAC 48 kHz 5.1, ASS, 30 s | Même résultat |

**Six paires identiques**, mêmes nombres de requêtes par paire ; maximum d'une réponse active dans ce banc Node. Les six sorties candidates sont redécodées : AAC-LC, zéro diagnostic audio. Ces résultats portent sur des fixtures et ne sont pas une acceptation à l'écoute sur des films entiers. Tous les essais navigateur sont muets.

## Navigateur, trace contrôlée

Même fichier de 90 s depuis zéro ; serveur local à chunks de **128 Kio toutes les 250 ms** dans les deux bras séquentiels :

| Mesure | Plage complète | Restitution progressive |
| --- | ---: | ---: |
| Première image depuis clic | 2,705 s | 1,881 s |
| Pause après démarrage | 6,054 s | Aucune observée |
| Plus grand intervalle d'images >250 ms | 6,091 s | Aucun |
| Position finale | 90,005 s | 90,005 s |
| Erreur média intermédiaire | Aucune | Aucune |

Réplique de fin à 80–85 s observée ; sous-titre traversant également relevé. Reprise distincte à 12 s sur le fichier avec B-frames : première image 3,110 s, fin atteinte, aucun défaut média mais **un intervalle initial de 897 ms**. Ce cas n'est pas présenté comme entièrement fluide.

Le compteur brut `maxActive` du serveur navigateur vaut **2** : le helper attend artificiellement 250 ms après avoir écrit son dernier octet déclaré. Ses handlers se recoupent alors de 33–249 ms, alors que la plage précédente est déjà entièrement reçue. Ce compteur n'atteste pas deux corps média reçus simultanément ; il ne remplace pas les tests de sérialisation ni la mesure du banc Node. Ce défaut de définition du compteur est conservé dans les preuves.

## Conclave, deux admissions ordinaires séquentielles

Même copie exacte Dino, départ à zéro, saut demandé à 120 s. Profil et révision de source relus avant chaque admission, compte libre au contrôle, route authentifiée Edge ordinaire. Aucun appel média opérateur parallèle ni modification de configuration.

| Mesure | Progressif avant conservation de l'index | Progressif avec repères conservés |
| --- | ---: | ---: |
| Première image | 5,063 s | 5,512 s |
| Saut demandé, temps mural | 85,382 s | 57,927 s |
| Saut → lecture | 35,617 s | 11,408 s |
| Analyse initiale des pistes | 13 ms | 45 ms |
| Mise en place du saut | 25,987 s | 9,625 s |
| Repères d'en-tête réutilisés | Non | Oui, reçu `cueHeaderReused=true` |
| Position au dernier relevé | 126,328 s, en attente | 190,445 s, lecture active |

Premier essai : pauses 3,625 / 4,694 / 0,383 s avant saut ; après reprise, pause de 25,060 s puis nouvelle attente. Une relecture de 4 Mio depuis l'octet zéro pour retrouver l'index coûte **13,242 s**. Le correctif conserve ce repère déjà connu. Sa suppression est vérifiée par le chemin `cueHeaderReused` et un test d'index sans appel à l'octet zéro, sans prétendre que les requêtes restantes sont toutes rapides.

Second essai : pauses avant saut de **4,392 / 3,531 / 1,055 / 6,427 / 4,376 s**. Après reprise, interruption de 1,964 s, puis environ **70 s de progression sans nouvelle attente mesurée**, de 120,209 à 190,445 s. Dix cues ASS capturées sur la piste principale ; aucune couverture exhaustive du film ou de la piste forcée, qui reste sans cue dans cette fenêtre. Les sous-titres traversants sont vérifiés sur les fixtures, pas certifiés à toutes les positions de cette copie.

Les fenêtres complètes de 4 Mio varient fortement entre les essais. La restitution progressive évite d'attendre tous leurs octets avant de les démuxer ; elle ne crée pas les données manquantes. Livraison fournisseur et relais restent non départagés. Les compteurs `progressiveBytes` désignent les octets consommés par les lecteurs, pas des octets réseau uniques. La télémétrie des fenêtres ordinaires est un anneau borné, pas une liste exhaustive.

Aucune erreur de décodage intermédiaire relevée. Les erreurs média 4 initiale/finale viennent du retrait de `src` dans le banc. La dernière plage `network_error` de chaque essai est annulée par l'arrêt opérateur ; elle n'est pas comptée comme une panne réseau autonome. Heartbeats sans erreur et expirations ordinaires attestées.

## Clôture et publication

À **23:55:27 Paris**, les deux sessions d'essai sont expirées. Deux Gateways sains, zéro session/pompe Gateway dans ce snapshot, image `e7520bec…` inchangée. **Une autre session du propriétaire reste active et est préservée** : aucun zéro global revendiqué. La première tentative de nettoyage du contrôleur, trop largement conditionnée à l'absence de toute session du propriétaire, s'est arrêtée ; son garde a été borné aux seules sessions du banc, toutes expirées, avant arrêt du processus exact. Aucun accès de cette autre session n'a été révoqué.

Contrôleurs, tunnel, serveurs locaux et onglets temporaires arrêtés ; zéro écouteur sur les trois ports de preuve. **16 fichiers médias/sous-titres synthétiques supprimés**, hashes et métriques conservés, zéro média restant. Aucune copie média fournisseur n'a été sauvegardée. Reçus bruts contenant les coordonnées de session gardés privés, extractions publiques sans URL privée.

Production publique vérifiée : révision 48 et SHA-256 `ec21b67c217d6407e0f3d37eaa0d8991fe77cc0f4b5b3e693c096c6b3f007f78`, shell/intégrité conformes, 60 entrées du manifeste concordantes. Le candidat 49 reste en **PR756 brouillon**, sans fusion. Les quatre checks de la tête précédente `f094e8e4d` passent ; la nouvelle tête doit encore recevoir sa propre validation CI. Aucun rendu WebView ni lecteur Android natif modifié et aucune nouvelle matrice émulateur revendiquée. Le manifeste d'assets est régénéré et vérifié ; aucune traduction native ne change.

## Contrôle CI du code et différence entre plateformes

Code `37b9e3f49a723a058ced43d3c90763b0c0497f4f` : contrats cloud réussis, run `37996658517`, job `114044359171`. **6 358 tests, 6 324 réussis, 34 ignorés, zéro échec** ; groupe SQL isolé distinct : 40 réussis. Résultat de la suite à **00:00:59 Paris le 10 octobre**. Vercel Preview Comments réussi. Paquets Android Phone/TV et Windows encore en construction à cette observation, sans prétendre qu'ils sont validés. Le complément documentaire suivant ne modifie pas le moteur.

| Plateforme | Parcours vérifié dans le code |
| --- | --- |
| Windows publié | LibVLC natif, `LibVLCSharp.WinForms` / `VideoLAN.LibVLC.Windows`, fichier ouvert dans `Media(engine, uri)` ; décodage matériel activé |
| Android téléphone/TV | Media3/ExoPlayer natif, extracteurs de conteneurs et `NativeRenderersFactory` ; le User-Agent contenant « VLC » ne signifie pas que LibVLC est exécuté |
| Web | Élément vidéo et MediaSource ; NorvaEngine utilise FFmpeg/LibAV en WebAssembly pour démuxer, remuxer et convertir l'audio si nécessaire, puis remet la vidéo aux codecs du navigateur. Le routage public conserve le Gateway pour MKV ; les Conclave de ce rapport forcent le parcours moteur dans le seul banc isolé |

Références locales : `clients/windows-player/PlayerWindow.cs` et `PlayerProtocol.cs`, `clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java`, équivalent TV, `public/js/norvaEngine.js`, `public/js/api.js`. Les pauses réelles de ce relevé correspondent à une réserve épuisée pendant l'attente de données/fragments. Le banc contrôlé prouve une attente évitable dans le moteur ; les sessions réelles ne départagent pas livraison et relais. Il n'existe pas de preuve que la même réception irrégulière serait systématiquement fluide sur tous les lecteurs natifs. Intégrer du code ouvert n'enlève ni la contrainte de débit ni les étapes supplémentaires imposées par le navigateur.
