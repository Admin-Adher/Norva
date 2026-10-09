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
