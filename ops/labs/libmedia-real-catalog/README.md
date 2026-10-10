# AVPlayer : banc isolé sur le catalogue réel

Ce banc **n'est chargé par aucune page Norva publiée**. Il évalue libmedia/AVPlayer sur des films et épisodes possédés par le compte de test, sans fichier vidéo synthétique. Le SDK, les décodeurs et les films ne sont pas distribués dans ce dossier.

## Ressources épinglées

- `@libmedia/avplayer` **1.3.1**, tarball du registre npm. SHA-256 du tarball employé : `cb42d0f08bfc56bf673c0be5171dcedaab81c9d26d0630f5a4c94a88c1c93b93`.
- `npm/package/dist/umd/avplayer.js` : `4efacaa1e4720310cbc301124898ee82d9ff9dbbff5c7ba82b1393db346f2be2`. Les chunks UMD doivent être conservés avec cette version.
- Décodeurs et polyfill issus du commit libmedia `152f629d3021fd8013efa464fcb7b55f9fbe7753`, sous `dist/decode/`, `dist/resample/`, `dist/stretchpitch/` et `dist/cheap-polyfill.js`.
- Décodeurs examinés : H.264, HEVC, AAC, AC-3, E-AC-3, MPEG-2, MPEG-4, MP3. Leur présence ne prouve pas leur utilisation ni leur qualité sur un film donné.
- [Source et licences libmedia](https://github.com/zhaohappy/libmedia/tree/152f629d3021fd8013efa464fcb7b55f9fbe7753), [API AVPlayer](https://zhaohappy.github.io/libmedia/docs/).

Le SDK ne reçoit les URL privées que depuis le contrôleur local et n'utilise aucun script CDN pendant une lecture. Toute distribution ultérieure nécessite de conserver les licences et les obligations des composants effectivement inclus.

## Contrôleur obligatoire

`serve.cjs` écoute uniquement `127.0.0.1:19610`. Les POST `/real/start` et `/real/finish` exigent cette origine et sont transmis au contrôleur d'exploitation sur `127.0.0.1:19611`. **Ce contrôleur et son manifeste privé ne sont pas dans Git.** Ne pas remplacer celui-ci par une URL fournisseur écrite dans le HTML.

Le contrôleur doit vérifier avant chaque essai : compte autorisé, variante actuellement visible, révision et profil inchangés, compte fournisseur libre, aucun essai précédent ouvert. Il crée une session Edge ordinaire avec claims, entretient son heartbeat et expire exclusivement la session allouée à l'essai. Un marqueur consommé ne doit pas être rejoué. Une variante d'expérience est admise seulement pour un changement concret du parcours.

Contrat de départ : `{ index, route: 'engine', position: 0, variant: 'avplayer-coalesced' }`. La réponse privée fournit `url`, `mode`, `codecProfile`, `ext`, `title`. Le contrôleur ne doit jamais exposer une URL ou un secret dans une erreur. La clôture retourne `{ closed: true, heartbeatErrors: [] }`. Un watchdog doit fermer les claims même si le navigateur disparaît.

Le client général ne déclare pas `nativeNetworkRecovery`. Le test HEVC distinct du rapport utilisait ce transport existant, restreint à la copie revue, pour séparer la décision serveur du décodeur. Ce test ne vaut pas activation d'une capacité web en production.

## Exécution et mesures

Après préparation contrôlée des ressources et du contrôleur, lancer `node ops/labs/libmedia-real-catalog/serve.cjs`, puis ouvrir `http://127.0.0.1:19610/real.html`. Les choix doivent correspondre au manifeste revu. Un seul essai à la fois ; arrêt et expiration vérifiés avant la copie suivante.

- Réponses HTTP 206 bornées à 2 Mio, total numérique et offsets exacts, `Content-Length` cohérent lorsqu'il existe. Pas de HEAD ni de GET ouvert jusqu'à la fin du film.
- Transfert progressif par blocs d'au plus 64 Kio pour réduire le nombre d'échanges avec les workers. Pas d'attente de la réponse entière avant lecture.
- Une seule requête source à la fois. Annulation à l'arrêt et lors d'un déplacement disjoint. Cache uniquement en mémoire de cette session : au plus quatre fenêtres complètes ; réponse partielle jamais conservée comme fenêtre réutilisable.
- `enableWorker: true`, WebCodecs autorisé, MSE choisi seulement si les codecs le permettent ; décodage logiciel autrement. Isolation multithread non activée lors des essais du rapport.
- Mesures réelles de `video.currentTime`, `readyState`, images rendues/perdues et plages disponibles lorsque MSE est utilisé. Les horloges et le compteur de débit du SDK seul ne suffisent pas dans ce mode.
- JSON affiché borné pour éviter le retraitement de tout l'historique à chaque échantillon. Historique complet conservé à la clôture dans `browser.safe.json`.
- À la clôture, expiration et sauvegarde précèdent la destruction potentiellement lente du SDK. Une erreur termine l'essai et interdit un nouveau saut ; ce garde a été ajouté après les mesures, sans nouvelle lecture revendiquée.
- Son muet : absence d'erreur signalée n'est pas validation à l'écoute. Les changements de pistes et la couverture des sous-titres restent des critères distincts.

La limite de 60 s par réponse et celle de préparation sont des gardes du banc. Leur expiration doit être distinguée d'une corruption de fichier. Les plages de 8 Mio ont été écartées après une expiration réelle.

`summarize-results.py` recalcule les phases à partir de `browser.safe.json`. Il exclut les échantillons après un événement terminal, sépare le saut des autres interruptions et utilise l'horloge de la vidéo MSE. Garder aussi les reçus d'origine : le résumé seul n'explique pas la cause d'une pause.

À la fin : expirez les sessions d'essai, fermez le contrôleur, le tunnel et le serveur local. Ne fermez aucune session utilisateur étrangère à ce banc.
