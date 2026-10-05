# Fenêtre audio inexploitable — 5 octobre 2026

## Blocage observé

Le contrôle de 00:07 UTC retrouve Lost on a Mountain in Maine avec cinq reçus
sur six et neuf tentatives fournisseur. Deux premiers reçus ont expiré après
leur durée normale de deux heures ; les trois suivants sont encore lisibles.
Le résultat reste incomplet, sans langue publiée. Les trois fenêtres anglaises
qualifiées constatées précédemment ne constituent pas quatre preuves courantes.

Les journaux du Gateway contiennent 54 échecs locaux
`LID_CAPTURE_PREPARATION_FAILED` entre 22:25 et 00:10, généralement en quelques
centaines de millisecondes. Le dernier, à 00:08:00.727, concorde avec la mise à
jour du travail Lost à 00:08:00.730. Il existe aussi trois reports de capacité ;
ces constats ne démontrent pas une privation générale de calcul par les storyboards.

Le buffer courant de la sixième fenêtre a été enregistré à 23:54:13.593,
avec sa durée de vie habituelle de trente minutes. La capture contient
611 477 échantillons PCM, soit **38,2173125 secondes**. Sa préparation échoue
immédiatement, puis le même buffer est réutilisé pour des tentatives locales.

## Reproduction sans accès fournisseur

À 00:13:29 UTC, le VAD de production a été exécuté sur cette acquisition déjà
présente, avec les mêmes binaire, modèle et plan de sélection. Il réussit et
retourne **zéro segment de parole détecté**. Le sampler retourne `invalid-audio`
en 170 ms. Les fichiers PCM temporaires sont supprimés dans le bloc de nettoyage ;
aucun appel fournisseur n'est effectué. Le reçu sûr est
`targets-lost-window6-production-vad.safe.json`, sous
`.codex-artifacts/language-heartbeat-0207/`.

Une première exécution diagnostique omettait le chemin par défaut du binaire
VAD et retournait `unavailable`. Elle n'est pas une preuve du comportement réel
et reste distincte de la reproduction correcte ci-dessus.

Une recherche de soixante secondes peut légitimement fournir moins de soixante
secondes de PCM. Avec du VAD positif, une fenêtre contiguë de vingt secondes
peut être sélectionnée dans ces 38,217 secondes. Sans cette sélection, le
fallback impose l'ancre locale de vingt secondes et donc les secondes 20 à 40.
Les dernières 1,783 secondes nécessaires sont absentes. Le refus de ce fallback
est correct : ni déplacement d'ancre, ni remplissage artificiel ne sont justifiés.
L'origine de la durée acquise plus courte n'est pas attribuée par cette preuve.

## Correction ciblée

Le défaut de reprise se situe dans la classification : le Gateway efface le
motif précis de préparation, puis l'Edge le traduit systématiquement en
`LANGUAGE_CAPTURE_INFERENCE_DEFERRED`. Un échec déterministe sur les mêmes
échantillons devient ainsi une attente transitoire.

La correction déployée distingue uniquement le cas où le VAD a réussi sans
parole sélectionnable et où la fenêtre complète à l'ancre ne tient pas dans
l'acquisition. Ce cas doit terminer le travail comme **incomplet et indisponible**,
avec le délai existant de la fonction d'échec. Les pannes VAD, les annulations
et les reports de calcul restent transitoires. Aucun reçu de langue ne peut être
créé pour l'extrait incomplet ; aucun ancien reçu n'est prolongé ou réécrit.
Le helper Edge applique son délai existant de vingt-quatre heures avant l'appel
SQL. Ce délai n'annonce pas une relance automatique : l'admission automatique
conserve le résultat terminal du même profil. Une demande manuelle ultérieure
doit respecter ce délai et les autres gardes ordinaires.

Les seuils de langue, les vingt secondes requises, les strates, les ancres,
les durées de conservation, la mono-connexion et la priorité lecture restent
inchangés. Cette correction ne trouve pas la langue de Lost et ne répare pas
un fichier média.

## Validation locale

La sélection, le passage capture/inférence, le pipeline et les reçus signés
réussissent **64 tests**, sans échec ni test ignoré. Un second groupe couvrant
le magasin, les accès du worker, la sélection et le handoff réussit 101 tests
sur 102 ; le verrou Linux est ignoré sur Windows. Ces groupes se recoupent,
leurs nombres ne s'additionnent pas.

Le nouveau test fait passer un PCM synthétique de même durée par le sampler,
le mapping Gateway, la réponse HTTP et le worker Edge réels. Il vérifie un
échec terminal incomplet, le recours au délai d'échec existant, aucun appel
Whisper, aucune acquisition supplémentaire, aucun ACK et aucun nouveau reçu.
Les cas VAD indisponible, invalide ou échoué conservent leur report court.
Une capture de quarante secondes sans parole reste analysable à l'ancre ;
une capture plus courte avec parole VAD garde sa sélection existante.

## Intégration et preuve dans le runtime

PR 651 est intégrée dans main, fusion
`f1f2699b01c9da6b327de6c8209c99a521b0b3ee`. Le code déployé est
`30448e957f6d5c24cf8761e973148b53ea1855c5`. Les cinq check-runs publiés
sur ce code ont réussi : contrats cloud, paquets Android Phone et TV,
Windows Portable et Vercel Preview Comments. Le dernier paquet Windows
s'est terminé à 00:25:28 UTC. Cela ne constitue pas une publication Google Play.

Deux erreurs de fixture du canary ont été corrigées avant l'application
en production ; elles restent distinctes des résultats du produit :

1. Le test d'encodage GPU utilisait une image synthétique de 64 × 64 pixels,
   inférieure au minimum de 128 × 128 de ce chemin matériel. La fixture est
   passée à 128 × 128.
2. Le test de permissions exigeait `0644` pour tous les fichiers, y compris
   les fichiers package hérités en `0664` de l'image de base. Il vérifie désormais
   les sources en `0644` et les permissions des packages contre leur référence
   inchangée en `0664`.

Ces deux corrections portent sur l'opérateur de preuve. L'image candidate et
le code applicatif n'ont pas changé entre ces essais. Les canaries sont arrêtés
et retirés après chaque tentative ; aucun remplacement de production n'a
précédé la preuve réussie.

Le canary Gateway réussit à **00:27:50 UTC** : UID/GID `1000:1000`, réseau
`none`, aucun volume de production, répertoire temporaire distinct, encodage
VAAPI réel réussi et toutes les sources lisibles. Le vrai binaire VAD et son
modèle correspondent aux empreintes de build. Le test appelle le sampler réel
avec le plan de fenêtre 6 pour une durée de 5891,136 secondes :

| Acquisition synthétique | Résultat constaté |
| --- | --- |
| 611 477 échantillons, 38,2173125 s | VAD réussi sans parole ; `LID_CAPTURE_AUDIO_WINDOW_UNAVAILABLE` ; aucun fichier sélectionné |
| 640 000 échantillons, 40 s | VAD réussi sans parole ; `anchor-fallback` conservé ; vingt secondes sélectionnées |

Les deux sources synthétiques sont restées inchangées ; la sortie du second
cas est privée, puis tous les fichiers synthétiques ont été supprimés. Deux
appels VAD, zéro appel Whisper et zéro requête fournisseur. Le test ne crée
aucun reçu de langue et ne certifie aucune langue.

Le canary Edge réussit à **00:27:56 UTC**, avec seulement une requête
`norva-playback/health`, puis est arrêté. Il utilise le réseau normal Edge
pour lire la configuration ; il n'est pas décrit comme isolé du réseau.
Aucune requête média fournisseur n'est effectuée par cette preuve.

## Déploiement contrôlé du 5 octobre

Les 84 fichiers Gateway et les 193 fichiers Edge ont été comparés à la
référence de production. Le Gateway change trois sources et conserve les
81 autres fichiers. L'Edge ne change que `norva-playback/index.ts` et conserve
les 192 autres fichiers, dont les corrections de récupération des variantes,
de badges humains et de déclarations fournisseur.

| Élément | Version déployée |
| --- | --- |
| Image des deux Gateways | `sha256:d378abf26bbbe0f2ec25af3eec7f75c24a9b4fc459109786d532892c9c5170dc` |
| Arbre des sources Gateway | `97149bff41b205be58f1ede5f1d19317a7d677878acee7dd91159a064ad26cee` |
| Playback des deux Edge | `c7f3b17f76661d5e52b263705e70bc74c2b509820e6a8d6c62328d7b278a39c9` |

Les deux Edge sont recréés à 00:28:36 et 00:28:40 UTC, depuis
`/home/adrien/.norva/lid-unusable-capture-20261005/edge/runtime-functions`.
La pause d'admission Edge va de **00:28:29.510 à 00:28:44.731 UTC**, soit
**15,221 secondes**. Les Gateways restent inchangés pendant cette phase.

Les deux Gateways démarrent à 00:29:18 et 00:29:22 UTC, leur remplacement
étant validé sain à 00:29:21 et 00:29:23. La pause d'admission Gateway va
de **00:29:07.157 à 00:29:24.336 UTC**, soit **17,179 secondes**. Les Edge
restent inchangés pendant cette phase. Aucune migration SQL n'est appliquée.

Le drainage utilise les gardes ordinaires et ne force aucun bail. Les reçus
confirment la restauration des admissions, du cron et du worker après chaque
phase, ainsi que la conservation du même dispatcher actif. Aucun compteur,
délai ni quarantaine n'est modifié par l'opérateur.

Les contrôles de **00:29:39–00:29:41 UTC** retrouvent les deux Gateways et les
deux Edge sains, les 84 et 193 empreintes attendues, les admissions et le cron
actifs, le worker et le dispatcher en cours, et aucun marqueur STOP restant.
Les canaries sont arrêtés. Les reçus sûrs sont regroupés dans le
[JSON de preuve](2026-10-05-language-capture-unusable-window.json).

## Observation ordinaire à 00:30–00:31 UTC

L'audit de 00:30:06 compare les quatre copies au relevé de 00:23:49 sans appel
fournisseur ni nouvelle admission. Lost conserve **cinq reçus enregistrés,
strictement identiques**, le curseur 5 sur 6, le passage 0 et neuf tentatives
fournisseur. La présence de ces reçus en base ne certifie pas leur validité
temporelle courante. Le travail conserve son ancien report
`LANGUAGE_CAPTURE_INFERENCE_DEFERRED`, mis à jour à **00:22:00**, avant le
déploiement. Profil, génération, empreinte et piste attendue sont inchangés ;
aucune validation ni quarantaine nouvelle.

Ochi reste en report `PROVIDER_ACCOUNT_BUSY`, avec zéro capture et zéro
tentative fournisseur sur le travail manuel admis à 21:53. Bolt conserve
son profil complet et l'ancien travail `PROFILE_CHANGED`, sans reçu ; aucune
nouvelle admission. Mars reste sans profil et sans travail. Les deux places
manuelles et les quatre places du compte fournisseur sont encore occupées.
Les anciens travaux expirés restent distincts des travaux actifs.

À 00:30:49, le Gateway principal déclare zéro capacité de fond pour
`foreground-work` : une opération prioritaire et quatre en attente. Le secondaire
déclare deux places disponibles. Il n'y a ponctuellement aucune lecture,
aucun broker strict ni inférence Whisper active dans ces réponses. Quatre
checkpoints de storyboards du compte ciblé sont corrélés entre 00:29:37 et
00:30:43 ; ce sont des checkpoints, sans augmentation de tuiles démontrée
sur cette courte fenêtre.

Le marqueur `gateway` du compte MAX OTT a été rafraîchi à **00:30:43.216 UTC**.
À 00:30:51, il déclenche toujours la garde ordinaire de cinq minutes, malgré
zéro session et zéro bail actif sur ce compte. Sa fin théorique est 00:35:43.216
si aucun nouveau marqueur n'intervient. Aucune garde ni limite n'a été modifiée.

Les journaux contrôlés à 00:31:12 ne contiennent **aucune nouvelle erreur typée**
dans la fenêtre depuis 00:29. Ce résultat ne prouve pas encore l'exécution
naturelle de la branche corrigée. L'acquisition originale de la fenêtre 6 avait
sa date d'expiration normale à **00:24:13.593 UTC**, avant le déploiement ;
les buffers Gateway sont vides au relevé. Il serait donc incorrect d'affirmer
que le nouveau code a reclassé cette même acquisition.

La classification reste prouvée par le canary fonctionnel ; sa première
observation naturelle reste à suivre. Une transition vers
`LANGUAGE_CAPTURE_AUDIO_WINDOW_UNAVAILABLE` serait une analyse **incomplète et
indisponible**, avec le délai existant, et non une analyse complète indéterminée.
Aucune nouvelle capture ni langue identifiée n'est revendiquée ici. Le correctif
ne restaure pas les secondes manquantes et ne répare pas le fichier média.
La maintenance globale reste permanente.

À **00:35:49 UTC**, une nouvelle lecture seule constate que le worker a
réexaminé Lost à **00:35:01** et l'a reporté pour `PROVIDER_ACCOUNT_BUSY`.
Les cinq reçus, le curseur, le passage, le profil et les neuf tentatives
fournisseur sont inchangés. La nouvelle classification de fenêtre n'a donc
toujours pas été exercée sur ce travail. Les quotas restent occupés ; aucun
POST pour Bolt ou Mars n'est envoyé.

## Validation du correctif sur le traitement ordinaire, 01:13–01:16 UTC

La garde d'activité du compte s'est libérée naturellement. Lost est passé à
`running` à 01:13:01 avec sa dixième tentative fournisseur, puis à `failed`
à **01:14:10.455 UTC**, code **`LANGUAGE_CAPTURE_AUDIO_WINDOW_UNAVAILABLE`**.
C'est une nouvelle acquisition ordinaire ; le buffer ancien avait expiré avant
le déploiement. Aucun opérateur n'a relancé Lost ni forcé un bail.

Le relevé final de 01:16:39 confirme les cinq reçus historiques, leur empreinte
et leur ordre, le curseur 5/6, le passage 0, la piste, le profil et la génération
inchangés. Ces cinq reçus ont tous dépassé leur validité de deux heures et ne
sont pas cinq preuves courantes. Aucun reçu supplémentaire, aucune langue
validée et aucune quarantaine nouvelle. Le délai normal d'échec va jusqu'au
**6 octobre 01:14:10.451 UTC**, soit vingt-quatre heures ; il n'annonce pas une
relance automatique après cette date.

La branche corrigée est donc désormais vérifiée sur un travail réel : la boucle
de préparation s'arrête avec un motif précis et les preuves sont conservées.
L'analyse reste incomplète. Ce constat ne répare pas le média et n'identifie
toujours pas sa langue.

La place libérée a permis l'admission ordinaire de Bolt à 01:15:04 après
prélecture complète des gardes et vérification du marqueur exclusif inutilisé.
Le travail est en file, passage 0, sans capture à 01:16:39. Ochi a terminé une
première capture insuffisante à 01:16:18. Voir le
[suivi de campagne](2026-10-05-language-campaign-heartbeat-0308.md).
