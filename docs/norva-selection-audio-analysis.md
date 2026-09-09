# Analyse audio des fichiers Norva Selection

Le badge « Langue non identifiée » signifie qu'aucune langue exploitable n'est
disponible. Les états d'attente et d'analyse proviennent d'une tâche durable
effective, via `audio_language_validation_job_status`, et non d'un simple tag
`und` ou de l'absence de métadonnées.

## Parcours serveur

Le worker `ops/hetzner/services/selection-audio-worker.mjs` charge uniquement le
registre de fichiers Selection contrôlés et livré avec le serveur. Il n'accepte
aucune URL fournie par un client. Les tâches sont dédupliquées par identifiant
externe **et SHA256 de l'URL**, entre les propriétaires actuels de ces mêmes
fichiers publics. Aucune identité de compte fournisseur n'est fabriquée.

Le manifeste est examiné toutes les cinq minutes. Une seule tâche est admise à
la fois. Le worker vérifie le conteneur via le Gateway, puis analyse les pistes
sans langue en quatre ou six fenêtres indépendantes. Les seuils stricts du
Gateway sont conservés ; une langue candidate ou une analyse ambiguë ne devient
jamais une langue vérifiée. Les pistes déjà étiquetées gardent leur provenance.

Chaque fenêtre est enregistrée avec son reçu et son profil exact. Une lease de
cinq minutes, renouvelée toutes les trente secondes, protège la reprise après
arrêt. Sa perte interrompt la requête Gateway. Les erreurs transitoires ont un
délai croissant, avec huit tentatives au maximum. Les erreurs terminales laissent
un état explicite sans annoncer une analyse en cours.

Les résultats sont enregistrés avant leur publication dans les catalogues. Une
publication interrompue est reprise sans analyser à nouveau le média. Chaque
propriétaire reçoit les pistes dans son cache `source:<id>` après vérification
de la source Selection canonique, du fichier, de l'URL, de la génération et des
époques de visibilité. Un import ultérieur réutilise ces résultats. Les sources
retirées et les fichiers remplacés ne récupèrent pas les anciennes preuves.

## Exploitation

Appliquer la migration `selection_audio_analysis_queue`, puis déployer les
modules Edge et le worker avec
`ops/hetzner/selection-audio-worker.compose.yml`. Le déploiement doit conserver
les overlays Edge en place, l'image Gateway installée et les secrets existants.
Le worker réutilise seulement le runtime Node de cette image ; il ne démarre pas
un deuxième serveur Gateway et ne charge pas de modèle supplémentaire.

Les secrets restent dans un fichier d'environnement privé sur le serveur.
Le conteneur est sans ports publiés, non root, en lecture seule, avec 512 MiB et
0,5 CPU. L'extraction et l'inférence restent soumises aux limites du Gateway.

Les contrôles utiles sont les comptes par `state`, `error_code`, les dates de
progression et `hydration_pending` dans `catalog_selection_audio_jobs`, ainsi que
la santé du conteneur. Les URLs, capabilities, reçus et preuves brutes ne sont
jamais renvoyés dans les réponses publiques du catalogue.

L'arrêt du seul service `selection-audio-worker` suspend les nouveaux sondages ;
les tâches et résultats durables restent conservés pour la reprise. Ne pas
supprimer la table ni réinitialiser massivement les tentatives pour un rollback.

## Validation

Les tests couvrent les droits SQL, l'admission unique, les leases, les reprises,
les preuves strictes, les ambiguïtés, la publication différée, les générations et
le changement d'URL. La validation finale doit contrôler de vraies langues
enregistrées et leur affichage sur le web et Android. Un import terminé ou une
réponse HTTP acceptée ne suffisent pas à certifier l'analyse vocale.
