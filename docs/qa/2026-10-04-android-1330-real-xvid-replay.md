# Android 1.3.30 — contrôle du film réel sur POCO, 4 octobre 2026

## Conclusion

**La distribution est confirmée et le blocage avant la première image a disparu.
La qualité de décodage du film réel reste en échec.** Le compteur de premières
images et les essais synthétiques ne suffisent pas à clore ce cas.

Contrôle demandé après installation Google Play, sur le téléphone physique de
l'utilisateur, par recherche, fiche, Reprendre, timeline et Retour. Aucun achat,
changement de compte, installation latérale ou changement de production effectué.

## Version et raison de la mise à jour

- Play Console : envoi 28, production **Norva Mobile 1.3.30 (44)**, état
  **Publiée**, daté du 3 octobre 2026.
- Téléphone : `versionName=1.3.30`, `versionCode=44`, installateur
  `com.android.vending`, dernière mise à jour affichée `2026-10-03 23:37:30`.
- POCO X7 Pro, Android API 36, navigation à trois boutons, `font_scale=1.0`.
- Cette version apporte la reconnaissance XVID/DX50 dans Matroska via
  `MatroskaFourccExtractor`, auparavant annoncé `video/x-unknown` par Media3
  1.5.1. Voir [le rapport de livraison](2026-10-02-xvid-native-playback-fix.md),
  PR 574. La version TV correspondante n'est pas revalidée par ce téléphone.

## Parcours réellement observé

Film : **Guerreiros da Virtude**, affiché **Magic warriors**, 1997, Norva Selection.

| Contrôle | Résultat |
| --- | --- |
| Recherche « Guerreiros » puis ouverture de la fiche | Affiche, synopsis français, durée, genres et indications PT/EN présents |
| Premier appui Reprendre | Première sortie vidéo environ **3,9 s** après le début de la commande d'appui ; image réellement visible |
| Pause vers 14 min 07 s | Commande fonctionnelle ; blocs de décodage nettement visibles |
| Glissement de la timeline jusqu'à 29 min 42 s | Position atteinte et nouvelle image, mais toujours dégradée |
| Retour Android | Retour à la fiche ; libération ExoPlayer et des décodeurs enregistrée |
| Réouverture par Reprendre | Retour à 29 min 42 s, puis progression à 29 min 46 s ; première sortie vidéo environ **2,2 s** après le début de la commande d'appui |
| Second Retour | Retour à la fiche et libération ExoPlayer confirmés ; application laissée au premier plan sans lecture active |

Ces délais sont des mesures opérateur jusqu'au journal `first render`, avec la
latence de la commande USB incluse. Ils ne sont pas présentés comme les mesures
internes de télémétrie Norva. Horodatages locaux du téléphone : première image
08:20:43.738, deuxième 08:27:37.703 ; libérations à 08:27:02.290 et 08:28:40.403.
Les commandes avaient commencé respectivement à 06:20:39.873 UTC et
06:27:35.460 UTC. L'audio n'a pas été certifié par écoute humaine.

## Défaut visuel reproduit et diagnostic

Les captures pendant la lecture, en pause et après déplacement présentent des
blocs et déformations importants, y compris après une nouvelle ouverture du
lecteur. Ce n'est donc pas seulement une image transitoire au premier démarrage.

Une extraction de référence limitée à une image à **847 secondes**, depuis
l'URL exacte de la variante du catalogue, avec FFmpeg sur le serveur, donne une
image propre de la même scène. Exécution réussie en 2 262 ms, sans erreur de
décodage signalée. La lecture du téléphone était fermée avant cette extraction.
Cela établit que la source peut être décodée proprement ; le chemin natif testé
ne le fait pas correctement.

Éléments concordants :

- Profil de la variante : MPEG-4 **Advanced Simple Profile**, 1280 × 720,
  Matroska, durée 6 157,44 s, taille 1 799 399 344 octets.
- Décodeur réellement sélectionné sur le téléphone :
  `c2.android.mpeg4.decoder` ; métriques de session `profile=1`, `level=16`.
- Son fichier XML installé annonce **ProfileSimple : Level3**.
- La déclaration correspondante dans le [code AOSP du décodeur](https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/codec2/components/mpeg4_h263/C2SoftMpeg4Dec.cpp)
  limite également le profil à `PROFILE_MP4V_SIMPLE`.
- L'adaptateur Norva actuel corrige le MIME mais ne transmet pas le profil
  MPEG-4 avancé dans `Format.codecs` et ne garantit pas sa compatibilité avec
  le décodeur sélectionné.

**L'incompatibilité de profil est une piste fortement étayée.** Ce relevé ne
prétend pas avoir isolé quelle fonction précise du flux avancé provoque les
blocs, ni avoir validé un correctif supplémentaire. Une correction doit vérifier
la capacité réelle du décodeur et produire une image correcte sur ce fichier,
avec un test visuel du résultat. Augmenter les délais ou compter les images
rendues ne résoudrait pas le défaut observé.

## Preuves conservées et limites

Captures et journal privé : `.codex-artifacts/android-1330-replay-20261004/`.
Les données de variante et la référence restent dans le dossier opérateur privé
`android-1330-real-20261004` sur le serveur. Aucun URL média ni identifiant de
compte n'est reproduit dans ce rapport.

| Fichier de preuve | SHA-256 |
| --- | --- |
| `paused.png` — défaut à 14:07 | `8889ce9050908d8a107d35ce49b580c74185399d601278afde17df191ca90d9c` |
| `source-847.png` — référence propre | `aa7709435e0c45568b488c348728451cdf95900f88f09413b7653e5cbecaed1d` |
| `reopened.png` — reprise à 29:46 avec défaut | `e833d53f0d19aadb369359c7bc39893359ce982b81a8895fda2ddad6355bd382` |

Le blocage de distribution du rapport du 2 octobre est levé pour le téléphone.
La validation visuelle du film reste **non acquise**. Ce contrôle ne recertifie
ni Android TV, ni la matrice gestes/texte 130 %, ni tous les fournisseurs, ni une
conversion partagée simultanée. La campagne de langues continue indépendamment.
