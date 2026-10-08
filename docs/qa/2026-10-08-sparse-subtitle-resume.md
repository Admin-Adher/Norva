# Reprise récente et sous-titres espacés — 8 octobre 2026

## Conclusion et périmètre

Poursuite autorisée de l'optimisation de Normal après PR705. Le candidat qui utilise l'assembleur HLS natif pour certifier les intervalles sans sous-titre est **rejeté avant déploiement** : un sous-titre futur connu disparaît dans un rejeu synthétique avec saut. Aucun gain supplémentaire sur Normal n'est démontré. Le pilote reste limité au compte déjà autorisé.

Un correctif indépendant est préparé : un `ENDLIST` écrit à l'arrêt d'un encodeur ne prouve pas une couverture de sous-titres au-delà de ses fragments finalisés. La capture du cache et la publication de sa continuation doivent toutes deux respecter cette borne. La normalisation du seul blanc final de l'en-tête WebVTT conserve aussi le même référentiel pour `WEBVTT\n` et un fragment avec réplique. Aucun changement de texte, de piste, de langue, de réserve, de durée de vie ou d'identité du fichier.

## Expériences isolées

Image de référence `sha256:6359a11315e1a778bdcc1ef6a6cfed8d63b7f75d15a408765995b47418ee63f8`, FFmpeg de production, utilisateur 1000, réseau `none`, fichiers synthétiques en tmpfs, conteneurs supprimés en fin d'essai. Aucune lecture fournisseur ou navigateur lancée pour ces expériences.

1. HLS natif sait produire des fragments WebVTT finalisés vides avant la première réplique forcée à 70 s. Un même muxeur refuse cependant deux pistes WebVTT. Le premier essai conserve cette erreur.
2. Distribution de la même vidéo à un muxeur HLS par sous-titre : un seul encodage et aucune entrée média supplémentaire. Le premier échappement tee était incorrect ; FFmpeg pouvait continuer la seule voie principale avec un code de sortie zéro. Un autre essai utilisait POST et recevait 501 sur le récepteur local. Ils ne constituent pas des réussites. La version corrigée PUT consomme 40 corps locaux, 1 333 296 octets, sans stockage de la vidéo dupliquée.
3. Le partage du writer séquentiel de production bloque les premiers WebVTT encore ouverts : aucune playlist vidéo avant la borne de 10 s. Arrêt du seul processus de preuve. Une sortie locale distincte enlève ce blocage dans le prototype, sans modifier le writer vidéo déployé.
4. Comparaison A/B/A contrôlée en ordre ancien/natif/natif/ancien, fichier synthétique 90 s à débit d'entrée fixé à huit fois le temps réel. Première playlist vidéo : ancien **2 563 / 2 578 ms**, natif **2 566 / 2 569 ms**. Ce sont des publications serveur synthétiques, pas des démarrages utilisateur ni une mesure sur Normal. Aucun gain démontré.
5. Une réplique 2,023–14,023 s n'existe que dans le premier fragment natif 0–4 s. Les fragments suivants sont vides. Le prototype de projection conserve donc les répliques entières au-delà de leur premier fragment ; un fragment vide isolé ne suffit pas à conclure à leur absence.

## Échec bloquant du candidat complet

Fixture de 240 s, une piste forcée et deux pistes ordinaires. La piste forcée contient notamment une réplique **150,021–155,021 s**, prouvée dans l'entrée. L'extraction depuis le début la retrouve. Après une reprise à **132 s**, avec prélecture à **117 s**, elle manque dans la sortie native alors que la réplique ordinaire à 190,021 s est conservée.

Une comparaison supplémentaire, sans tee ni encodeur vidéo pour la voie de contrôle des sous-titres, utilise `copyts`, une vidéo copiée, aucun seek de sortie sur cette voie et mesure ses PTS : origine vidéo **116,021 s**, durée couverte affichée **123,936 s**, piste forcée vide. L'extraction des paquets de l'entrée par ffprobe retrouve pourtant la réplique forcée à 150,021 s, y compris avec son propre intervalle de lecture démarrant à 117 s. Cela invalide la certification d'une absence par les seules listes HLS natives dans ce scénario. Cela ne prouve pas la cause interne précise du chemin de saut, ni que le fichier réel Normal présente exactement ce cas.

Autre limite retrouvée : un seek de sortie absolu à 60,5 s supprime une réplique débutant à 60,021 s et se prolongeant jusqu'à 110,021 s. Choisir un raccord hors d'une réplique connue évite cette coupure particulière ; cela ne répare pas la disparition de la réplique future à 150 s. Cette sélection et le candidat de muxage sont donc retirés du code livrable.

Le reçu `functional.safe.json` du prototype avait réussi ses assertions partielles (cache acquis, réplique traversante, décodage de courts extraits). **Il n'est pas une validation du candidat.** La revue de toutes les pistes a révélé la réplique manquante. Ce même premier script avait omis l'option 90 kHz déjà présente en production et émettait des diagnostics PTS/DTS : ils sont conservés, pas attribués au runtime déployé. L'expérience indépendante `absolute-clock-proof` conserve les horodatages 90 kHz et n'a pas ces diagnostics, mais reproduit la piste forcée manquante.

## Correctif retenu et vérifications

- `captureSubtitleWindow` refuse une fenêtre vidéo dépassant la dernière durée de sous-titres réellement annoncée, même avec `ENDLIST`.
- Le constructeur de continuation applique la même limite ; il ne publie pas la suite vidéo comme si la piste était entièrement couverte.
- En-tête WebVTT : seul le blanc final est normalisé ; les contrôles du timestamp map restent inchangés.
- **53 tests ciblés réussis** sur le code retenu : cache privé, horloge glissante, sous-titres ; trois nouveaux cas de non-régression. Les 80 tests intermédiaires du candidat retiré ne sont pas le décompte du code livré.
- Inventaire read-only à 08:34 UTC : les deux Gateways conservent les 89 fichiers et permissions de PR705 ; les deux Edge conservent leurs 194 fichiers. Aucun runtime ni environnement modifié à cet instant.

## État de livraison

Correctif retenu en préparation ; intégration, canary et déploiement à consigner après vérification. Aucun candidat de muxage natif n'est activé. Aucun nouveau temps de reprise réel n'est revendiqué. Les résultats antérieurs Vice-versa 2 / Normal de PR705 restent distincts.

## Preuves

Reçus locaux sous `.codex-artifacts/sparse-subtitle-resume-20261008/` : `native-hls-proof.safe.json`, `tee-proof*.safe.json`, `admission-first.safe.json`, `admission-proof.safe.json`, `local-tee-proof.safe.json`, `startup-ab.safe.json`, `functional.safe.json`, erreurs synthétiques conservées, `absolute-clock-first.safe.json`, `absolute-clock-proof.safe.json`, `deployment-reference.safe.json`. Le code rejeté est conservé dans `rejected-candidate/`, exclu du runtime.
