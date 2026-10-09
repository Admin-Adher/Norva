# Lecteur vidéo Windows natif — préversion publiée

**État final du 9 octobre :** [Windows 2.1.5-native.1 x64 publié](https://github.com/Admin-Adher/Norva/releases/tag/v2.1.5-native.1), lecteur vidéo LibVLC activé par défaut. PR749 intégrée. Les premières sections ci-dessous décrivent les étapes historiques du prototype ; la section finale et le JSON associé donnent l’état de distribution actuel.

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

### Contrôles de livraison et défauts interceptés

Les six configurations Android du run 37979014341 réussissent : téléphone gestes/trois boutons aux échelles 1/1,3 (ResumeRecoveryInstrumentedTest), TV D-pad aux échelles 1/1,3 (ConsentDpadInstrumentedTest). Le code partagé est celui de 4537dfc9d ; les modifications ultérieures concernent le lecteur Windows, l’historique serveur et des tests.

Le retour de préférences complet révélait une perte réelle : `_shared/cloud-public-view.mjs` supprimait `stableId`, `role` et `disabled`. Le correctif borne les identifiants, les rôles et le booléen ; pas d’URL fournisseur ni de token admis. Test aller-retour écriture/lecture réussi. LibVLC attend aussi son état prêt et le succès de sélection avant de considérer une préférence appliquée.

Déploiement API du code 77506fe8e : helper SHA-256 `3d02fa19b78342f35b635cedb05b99332587d8166ad2fff013fb6853f9128e92`, deux Edge sains à 19:21:06/10 UTC. 193 autres fichiers et permissions conservés, 194 empreintes comparées. Pause d’admissions 19:20:49.350–19:21:13.562 UTC, drainage naturel, zéro bail forcé ; cron, worker et même dispatcher restaurés. Gateways inchangés et sains. Le premier staging avait détecté les fins de ligne CRLF locales ; aucun déploiement n’avait eu lieu. Le candidat a été remplacé par le blob Git canonique puis vérifié. Canary santé Edge arrêté, réseau normal Edge, aucun média fournisseur.

Rejeu authentifié après correction : préférence de piste exacte et `subtitle.disabled=true` reçues après rechargement du catalogue, menu natif « Désactivé », volume 65 retrouvé. Reprise à 1 646 s, événement `playing` 5,033 s après la transmission au contrôleur, position 1 674,722 s avant fermeture volontaire ; compteur d’images perdues nul. Trois sauvegardes HTTP 201 à 334,794 / 350,561 / 364,595 s du banc, la dernière étant celle de fermeture. Deux accusés d’expiration HTTP 200, pas une seconde connexion fournisseur.

La CI du code 77506fe8e compte 6 258 tests réussis / 34 ignorés / zéro échec. Les dix check-runs passent, paquet Windows compris. Les previews Vercel sont limités par quota (réessai proposé dans 24 h) ; ce sont des previews, pas une erreur du paquet Windows. Le portable téléchargé correspond à l’artefact 11639948075 (SHA de l’archive validé). Son inspection retrouve le runtime x64, les licences et les archives sources attendues.

**Ce premier portable n’a pas été publié** : son ouverture réelle a révélé que le serveur local servait la page de présentation pour `/app`, adresse utilisée par le retour de connexion. Correction de la route pour servir `app.html` et ouverture directe du catalogue. La navigation interne compare maintenant l’origine exacte, pour conserver le passage par `account.html` sans accepter un nom d’hôte ressemblant. Test HTTP réel sur le serveur assemblé avec dépendances de fond isolées : `/app`, `/app?returnTo=home` et `/app.html` servent le catalogue ; `/` conserve la présentation. Deux tests supplémentaires contrôlent les origines. Une erreur de syntaxe du premier test de route a été corrigée avant validation ; le code applicatif n’en dépendait pas. 31 tests ciblés réussissent ensuite, groupes recoupés.

La construction finale porte le code `5a78562f77e0ece7bd604ad023051d14b0539018`. Deux anciennes constructions devenues inutiles ont été annulées ; la troisième avait déjà terminé en échec sur la syntaxe de la fixture et a refusé l’annulation (409). Leurs résultats restent dans l’historique. L’ouverture du paquet final et sa publication restent à consigner ci-dessous.

Suite finale du code `5a78562f7` : **6 261 tests réussis, 34 ignorés, zéro échec** dans le run 37981024305. Le contrôle automatique de l’outil a refusé la suppression récursive du profil QA isolé, sans motif détaillé ; suppression non rejouée par un autre moyen. Le fichier d’export du jeton QA a été supprimé et le jeton était temporaire (quinze minutes, sans refresh). Le profil local restant est ignoré par Git et exclu explicitement de la liste de fichiers du paquet.


## Publication vérifiée — 9 octobre, 21:48 Paris

PR749 intégrée par `f0c97fc3b4924b4a677bf346da677a46677be194`. Le paquet distribué est construit sur le code `5a78562f77e0ece7bd604ad023051d14b0539018` : dix check-runs réussis, dont le portable Windows, 6 261 tests réussis et 34 ignorés. Les six configurations Android citées plus haut concernent les composants partagés ; aucune preuve de décodeur TV ou acceptation sonore humaine n’en est déduite. Les previews Vercel étaient limités par leur quota, sans erreur du build Windows.

- [Téléchargement Windows x64](https://github.com/Admin-Adher/Norva/releases/download/v2.1.5-native.1/Norva-Windows-2.1.5-native.1-x64.exe), 223 429 995 octets.
- SHA-256 de l’exécutable : `6f7d5e29c5003ab1d62ee0759adff3d1822cb9239ee859b1bff25255c4ac2c5e`.
- Run `37981024305`, artefact `11641965029`, archive SHA-256 `a6d756ae33f6d5dad8d68bc099d318e4c38c936e4d0220f27ba958d37937d0f2` vérifiée avant extraction.
- Huit fichiers critiques comparés au blob Git canonique dans l’ASAR, runtime x64 natif, licences et manifeste sources présents. Profil QA, artefacts et `.env` exclus.
- Sources VLC 3.0.24 et LibVLCSharp 3.10.1, leurs empreintes et `SHA256SUMS.txt` publiés avec l’exécutable. Les empreintes de téléchargement retournées par GitHub concordent.

**Ouverture du portable exact :** catalogue authentifié sur `/app#home`, reprise de Conclave dans `Norva.NativePlayer.exe` avec rendu Direct3D11. Position observée de 28:10 à 28:34, puis Retour à 28:42. Deuxième ouverture à la position sauvegardée, préférence « Désactivé » retrouvée. Le volume se réinitialise à 100 entre deux exécutions complètes de l’application ; sa conservation prouvée concerne les sessions au sein d’une même exécution.

La vérification finale a signalé un état d’accessibilité « disabled » après fermeture. La publication a été temporairement remise en brouillon par précaution. Les deux clics réels suivants ont permis de naviguer vers Films puis Séries, et aucun lecteur natif ne restait ouvert : blocage fonctionnel non reproduit, aucun correctif spéculatif. La latence précise de réactivation n’est pas déduite de ces observations ponctuelles. Publication rétablie et métadonnées publiques relues sans authentification. Le tag provisoire généré par GitHub à la première publication a été remplacé par `v2.1.5-native.1` avant communication du lien.

Deux Edge et deux Gateways sains au relevé 19:47:15 UTC, empreintes Edge inchangées depuis le déploiement ciblé du helper, cron/admission/worker et dispatcher permanents actifs. Aucun déploiement Gateway. Lectures de contrôle arrêtées ; fermeture de l’application de test demandée après le retour au catalogue.

Cette distribution est une **préversion portable non signée**, disponible au téléchargement manuel. Elle n’affirme ni une mise à jour automatique des installations existantes, ni une lecture rapide de tous les fichiers. La réception lente observée sur Vice-versa 2/MAX OTT, l’écoute humaine et l’audit complet d’accessibilité Windows restent des limites explicites. Le moteur web et son prototype de correction ne sont pas remplacés.

Preuves structurées : `2026-10-09-windows-native-release.json`. Reçus locaux : `final-package-inspection.safe.json`, `final-portable-close.safe.json`, `published-release.safe.json`, `release-health.safe.json` et capture `final-portable-playing.jpg` sous `.codex-artifacts/windows-native-20261009/`.
