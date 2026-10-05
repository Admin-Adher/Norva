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

La correction préparée distingue uniquement le cas où le VAD a réussi sans
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

Déploiement et observation du traitement ordinaire restent à consigner.
