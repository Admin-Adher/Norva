# Lecteur vidéo Windows natif — prototype intégré

## Périmètre confirmé

Le propriétaire a confirmé : « Oui, lecteur vidéo natif intégré ». Les écrans Norva restent dans la coque Electron ; la vidéo est décodée et affichée par un processus Windows WinForms/LibVLC, sans élément vidéo HTML ni conversion HLS préalable. Ce chantier ne remplace pas le moteur WebAssembly du site.

Le chemin est désactivé par défaut, activable uniquement dans une construction Windows disposant du runtime avec `NORVA_DESKTOP_NATIVE_PLAYER=1`. Aucun paquet publié ni installation utilisateur remplacée pendant ces essais. Aucun déploiement Gateway ou Edge pour ce prototype.

## Implémentation

- .NET 10.0.401, LibVLCSharp.WinForms 3.10.1 et VideoLAN.LibVLC.Windows 3.0.24 ; dépendances verrouillées. Compilation Windows x64 autonome réussie. Le premier usage de `dotnet publish --locked-mode` échouait ; remplacé par la propriété MSBuild `RestoreLockedMode=true`.
- IPC limité au contenu principal et à l'origine exacte du catalogue. URL transmise au processus natif par stdin, jamais dans la ligne de commande. Pas d'options LibVLC arbitraires, de chargement de fichier local ou de repli automatique vers une autre copie.
- Transport local de plages bornées à deux Mio, demandes fournisseur séquentielles, fermeture attendue avant la suivante. La lecture LibVLC directe avait ouvert deux demandes sur la fixture ; le transport séquentiel en limite désormais le maximum à une. Il ne remuxe et ne réencode aucun octet.
- Réponse 206, intervalle exact, taille stable, éventuel validateur stable et corps complet exigés. Erreurs, réponse 200 ignorant Range, trou ou changement de fichier refusés ; aucun octet partiel réutilisé. Les réponses ouvertes sont arrêtées et drainées à la fermeture.
- Une session cloud exacte pilote le lecteur. Autorisation renouvelée après succès du heartbeat ; expiration locale après vingt secondes. Sortie réelle du processus puis drainage du transport avant publication de la fermeture. La session suivante reste bloquée jusqu'à l'accusé de fermeture cloud exact. Les fermetures non acquittées peuvent être relues après rechargement du catalogue.
- Commandes natives : pause, sauts de dix secondes, timeline, pistes audio, sous-titres, plein écran, clavier et Retour. Couleurs chargées depuis les tokens de `main.css`. Les messages ne contiennent pas les réponses ou accès fournisseur.

Le pilote est borné aux VOD finies du mode cloud. Le Live, les playlists et le mode local conservent leur parcours antérieur. Le cache privé distant n'est pas annoncé comme pris en charge par ce premier lecteur ; ses tickets ne sont pas remis à LibVLC. Une interruption avant la fin connue ne doit pas être marquée comme film terminé.

## Preuves locales

Fichiers synthétiques de soixante secondes, serveur HTTP loopback, aucun accès média fournisseur :

| Fichier | Codecs | Contrôle |
| --- | --- | --- |
| MKV | H.264, AAC et AC-3, SRT | Décodage natif, pause, recul, changement AAC → AC-3 et sélection des sous-titres, plein écran. Progression jusqu'à la fin. |
| MP4 | H.264 / AAC | Fin normale, maximum une requête amont simultanée, aucune connexion restante. |
| MPEG | MPEG-2 / MP2 | Fin normale, maximum une requête amont simultanée, aucune connexion restante. |

Le compteur LibVLC `lostPictures` reste nul dans ces essais. Ce compteur n'est ni une mesure exhaustive de tous les gels, ni une acceptation humaine de l'écoute. La sélection d'une piste SRT ne constitue pas à elle seule une preuve visuelle de toutes ses répliques.

Le banc Electron complet charge le vrai preload isolé et le vrai contrôleur IPC. Premier événement `playing` à 1 123 ms ; fermeture demandée puis drainage à 5 715 ms. Deuxième lancement, reprise à vingt secondes : événement `playing` à 6 299 ms depuis le début du banc. Sans nouvelle autorisation, fermeture `authorization_expired` à 26 714 ms. Maximum une requête amont, zéro connexion finale. Ces délais concernent une fixture locale et des événements LibVLC, pas la première image d'une VOD distante. Les heartbeats de ce banc sont simulés : la validation cloud authentifiée réelle reste à faire.

Tests : 179 assertions/tests ciblés réussis dans le groupe natif et contrats Android existants. Cinq premiers échecs étaient des tests structurels ne retrouvant plus la frontière du bloc Live ; le bloc d'origine a été conservé et la délégation Windows placée à l'intérieur. Tests de routage Windows ajoutés séparément. Reçus : `.codex-artifacts/windows-native-20261009/`, fichiers `runtime-*.safe.json`, `electron-fixture.safe.json`, `regressions-final.tap` et `routing.tap`.

## Travail restant avant distribution

- Parcours authentifié réel avec historique, fermeture/révocation et reprise sur plusieurs copies, sous les gardes ordinaires. Aucun débit ou gain réseau promis par ce lecteur.
- Couverture des choix audio/sous-titres et de leur persistance, volume, localisation complète, accessibilité Windows et écoute humaine.
- Rejouer les erreurs et le retour au catalogue dans l'application complète, et les contrôles Android exigés pour le glue partagé avant fusion.
- Construire et inspecter le paquet portable final ; compléter les notices et les sources correspondantes des dépendances avant distribution. Le fichier de notices actuel documente l'état expérimental, sans prétendre à une validation de distribution.

L'intégration est donc un prototype local vérifié, pas une généralisation du lecteur Windows ni une preuve que toutes les VOD démarrent rapidement.

## Préparation de la version Windows 2.1.5-native.1 — 9 octobre, soirée

À la demande explicite du propriétaire, préparation d’une préversion portable Windows x64 avec lecteur LibVLC activé par défaut lorsque le runtime est présent. La vidéo est native ; les écrans restent dans Electron. Aucune activation du moteur WebAssembly, modification du Gateway ou nouvelle concurrence fournisseur.

Le parcours Windows transmet maintenant les préférences audio/sous-titres validées, restaure un identifiant de piste natif exact ou une langue technique unique, et préserve la désactivation explicite des sous-titres. Volume natif, libellés issus des traductions Norva et historique échantillonné toutes les quinze secondes avec enregistrement final avant fermeture. La fin naturelle ne déclenche l’épisode suivant qu’après l’accusé exact de fermeture cloud.

### Copies réelles, sessions ordinaires

Les essais utilisent les profils/fichiers exacts, une seule requête fournisseur en vol, les heartbeats et expirations ordinaires. Les demandes système séquentielles et leurs redirections ne sont pas des connexions simultanées.

- **Conclave, Dino** : départ et saut de dix secondes réellement contrôlés ; nouvelle ouverture à 120 s avec événement LibVLC `playing` à 4,764 s depuis le début du banc incluant la création de session. Près de trois minutes de progression, compteur `lostPictures=0`, fermeture/drainage attestés. Ce compteur ne prouve pas chaque intervalle d’image, et l’événement n’est pas une mesure de première image.
- **Vice-versa 2, MAX OTT** : événement `playing` vers 19 s, puis attente/interruption importante. Les plages de 2 Mio prennent environ 5,6–5,9 s ; la lecture avance ensuite jusqu’à 112 s dans la fenêtre observée, avec images perdues signalées. La limite de réception reste ouverte ; aucune responsabilité réseau précise attribuée.
- **Application complète** : catalogue réel authentifié → reprise de Conclave → commandes natives en français → sous-titres désactivés et volume modifié → Retour. Heartbeat HTTP 200, historique HTTP 201, fermeture de session HTTP 200. Le premier essai révélait une sauvegarde chaque seconde ; cadence corrigée à quinze secondes et test de régression ajouté. La session QA est courte, isolée et sans jeton de rafraîchissement.

Reçus locaux : `.codex-artifacts/windows-native-20261009/real-4-resume.safe.json`, `real-1-instrumented.safe.json`, `full-app.safe.json` et capture `full-app-controls.jpg`. Aucun accès fournisseur dans ce rapport.

### Distribution et limites

Notices complètes ajoutées, licences .NET/LibVLC/VLC incluses, dépendances verrouillées et sources officielles de VLC 3.0.24 et LibVLCSharp 3.10.1 conservées avec leurs SHA-256 pour publication avec l’exécutable. Les runtimes x86/ARM inutilisés sont exclus du paquet x64. Version non signée ; aucune promesse de certification Windows.

81 tests ciblés réussis avant le dernier test d’historique ; le sous-groupe actualisé de 27 tests natifs/historique réussit (groupes recoupés). Compilation native réussie. Contrôles CI, matrice Android et inspection de l’exécutable final à compléter avant publication. Cette préversion ne certifie ni tous les formats existants, ni toutes les VOD, ni la qualité humaine à l’écoute. Les limites du transport lent restent distinctes.
