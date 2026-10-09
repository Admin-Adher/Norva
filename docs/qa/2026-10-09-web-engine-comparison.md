# NorvaEngine / Gateway : comparaison du 9 octobre 2026

## Conclusion

Le moteur FFmpeg/WebAssembly déjà présent sait démarrer et sauter rapidement sur un fichier synthétique H.264/AC-3, mais **les deux copies réelles testées ne valident pas son remplacement du Gateway**. Des défauts de fin de fichier et de sous-titre traversant un saut sont également reproduits en isolation. Aucun routage, seuil, timeout, modèle, concurrence, cache ou binaire de production n'est modifié par ce comparatif.

Code observé : `7689b8b4d8476131b4d2a81aaeaa77a4e5710a4c`, NorvaEngine 46. WatchPage et HLS.js 1.7.3 proviennent du dépôt courant. Les comptes restent isolés ; aucun identifiant ou accès fournisseur n'est publié.

## Copies réelles, mêmes fichiers, départ à zéro

Quatre sessions successives entre 20:37 et 20:44 Paris : Conclave Dino, puis Abduct MAX OTT, moteur navigateur puis Gateway pour chaque copie. Les profils courants et variantes visibles concordent avec le manifeste privé avant chaque admission. L'Edge authentifié crée les sessions ordinaires : `relay/enginePipe` pour le navigateur, `transcode` pour le Gateway. Réservation, heartbeat et expiration restent ordinaires. Un bypass de lecture du cache, prévu par l'API, compare ici les départs sans réutilisation ; aucune purge ni désactivation globale du cache.

| Copie | NorvaEngine | Gateway avec la réserve WatchPage |
| --- | --- | --- |
| Conclave, H.264/AAC, 2 sous-titres | Limite de préparation de 15 s atteinte, aucune première image | Session prête en 31,126 s ; aucune lecture à 130,197 s, 20,019 s chargées |
| Abduct, H.264/AAC, 21 sous-titres | Limite de préparation de 15 s atteinte, aucune première image | Première image en 5,211 s ; aucune lecture à 104,336 s, 22,023 s chargées |

Les délais client partent du bouton du banc. Les 15 secondes sont la limite interne existante du moteur, après création de session. Ils ne se confondent pas avec un délai clic → première image. Pour Conclave Gateway, la première version de l'instrumentation ignorait les frames affichées pendant la pause : **aucun TTFF visuel n'est revendiqué**. La disponibilité de vidéo et l'absence de lecture sont mesurées séparément. Le banc utilise WatchPage avec les réponses authentifiées, sans navigation complète depuis le catalogue ni écriture d'historique utilisateur.

Abduct navigateur reconnaît `avc1.640029` et AAC copié. Le premier demi-Mio arrive en 3,137 s ; trois plages de 1 Mio prennent 2,871 / 2,889 / 2,873 s, après une lecture de fin de fichier de 7 412 octets en 754 ms. Une autre plage est interrompue par la limite interne. Son `network_error` n'est donc pas une preuve autonome de panne fournisseur. Le premier append d'initialisation à 4,011 s n'est pas une première image exploitable.

Le Gateway conserve ses protections : Conclave est inéligible au démarrage accéléré (`encode-rate-below-minimum`, observation 0,208x) ; Abduct a une rafale de 18,452x mais elle est trop courte (`encode-rate-observation-too-short`). Aucun seuil n'est réduit pour obtenir un démarrage. La réception lente est observée, son attribution au stockage fournisseur ou au relais reste ouverte.

Ces échecs de départ arrêtent la comparaison réelle avant les sauts et l'écoute. Aucun gain réel, plusieurs minutes de fluidité, sélection de sous-titres réelle ou qualité sonore à l'écoute ne sont validés. Deux fichiers et un navigateur ne représentent pas tous les appareils ou formats.

## Contrôles synthétiques locaux

Fichiers locaux servis par plages HTTP, sans fournisseur. La vidéo reste décodée par les capacités du navigateur : ce n'est pas un moteur vidéo universel de type LibVLC.

- MKV H.264/AAC, deuxième piste AC-3 et SRT, 60 s : première frame en 137,9 ms, progression observée jusqu'à 52,112 s. Pas d'intervalle de frame supérieur à 250 ms observé pendant cette période. Le premier bouton de saut n'actionnait que le demuxer sur une zone déjà chargée : **ce saut n'est pas une preuve valide**, banc corrigé ensuite.
- Court H.264/AC-3 : première frame en 1,907 s, conversion AAC. Une attente d'environ 87 ms est observée ; un saut de bord vers 6 s après EOF produit ensuite une erreur média 3. Ce scénario n'est pas déclaré fluide.
- Court HEVC/AAC : première frame en 348,6 ms, fin à 6,53 s, avec un intervalle de frame de 763,9 ms. Compatibilité de cet extrait sur ce navigateur, pas certification de fluidité HEVC.
- MKV H.264/AC-3/SRT de 180 s : première frame en 831,8 ms. Saut réel de 22,546 à 90 s, hors du buffer `[0,52,005]`, retour `playing` 503 ms après la demande. Progression jusqu'à 176,006 s, sans autre intervalle supérieur à 250 ms observé après le saut. La piste audio est convertie en AAC, sans erreur média durant ce parcours ; l'écoute humaine et la fidélité du signal ne sont pas validées.

### Deux défauts reproduits

1. **Fin tronquée** : la source vaut 180 s selon FFprobe ; le moteur termine vers 176 s. La finalisation active `_dropWrites` pendant `av_write_trailer`, ce qui supprime aussi les derniers octets média encore retenus par le muxer.
2. **Sous-titre traversant perdu** : après saut à 90 s, la réplique 89–95 s n'est pas dans les cues récoltés. Les répliques futures 120–125 s et 170–178 s sont présentes. Aucun changement d'indice ou de langue n'est proposé pour masquer ce défaut.

### Expérience de finalisation, non intégrée

Deux parcours isolés au même point 170 s du même MKV : moteur courant, puis copie expérimentale utilisant `skip_trailer` et conservant les octets média de la finalisation. La [documentation FFmpeg](https://ffmpeg.org/ffmpeg-formats.html) décrit ce drapeau comme l'omission des index mfra/tfra/mfro. Le témoin finit à **176,015999 s**, l'expérience à **180,009375 s** ; le sous-titre 170–178 s est conservé dans les deux, sans erreur média ni intervalle supérieur à 250 ms durant ces courts parcours. Cela confirme la cause de la troncature. Les différences de temps de démarrage de ces deux parcours courts ne constituent pas une optimisation revendiquée.

Le candidat est conservé uniquement dans les artefacts locaux. Il reste à intégrer une finalisation atomique contrôlant les erreurs, les générations et interruptions, avec tests de régression avant déploiement. Il ne résout pas la couverture des sous-titres traversants ni l'attente réseau réelle. Aucun correctif moteur web n'est activé.

## Windows natif — PR749 distincte

Le prototype LibVLC reste en brouillon et désactivé par défaut. Deux blocages CI ont été corrigés : manifeste d'assets généré périmé (`6aea8f4c0`), puis assertion de contrat utilisant l'ancien appel sans type/conteneur (`90bd8592d`, 22 tests ciblés réussis). **Les dix contrôles observés de cette tête passent**, paquet Windows Portable et paquets Android compris. Cela ne remplace pas la validation des comptes réels, du cycle de session, des commandes et de l'accessibilité. La PR749 n'est pas fusionnée ni déployée par ce contrôle.

## Clôture

À **20:44:36 Paris**, les quatre sessions de test sont expirées, zéro claim actif du propriétaire ; les deux Gateways sont sains, zéro session et zéro pompe raw. Images inchangées `sha256:e7520bec0c63cdb224617f6991b7484f9b28079a2c24e4c76a9dcbf19f92b815`. Le contrôleur temporaire et le serveur local sont arrêtés, onglet de banc fermé. Aucun bail forcé, redémarrage Edge/Gateway ou seconde connexion fournisseur opérateur.

Reçus locaux : `.codex-artifacts/web-engine-comparison-20261009/`, dont `results.safe.json`, `short-fixtures.safe.json`, `final-health.safe.json`, `windows-ci.safe.json`, `eof-candidate.jpg` et le candidat EOF. Le [résumé JSON](2026-10-09-web-engine-comparison.json) contient les mesures sélectionnées et les limites du banc. Les erreurs média lors du retrait de `src` à la clôture ne sont pas attribuées aux fichiers.
