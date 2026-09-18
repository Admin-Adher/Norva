# Reprise et audio — contre-vérification du 17 septembre 2026

## État

Symptôme confirmé par l'utilisateur : audio **robotique, métallique, avec grésillements**.
Cause non établie, aucun correctif audio déployé. Réutilisation du cache autour de la position sauvegardée non démontrée.
La configuration CodexCN reste inchangée ; SSH est opérationnel indépendamment du fournisseur de modèle.

## Essais et limites de preuve

Variante observée : ES Royalteen, stream 1014841, source 900004 (différente du sourceId 900001 de l'ancien compte rendu), MP4, H264, AAC LC 5.1 48 kHz, piste espagnole 1.

1. Session `45275bd1-cb5b-43ef-93ec-7ee64f7774d7`, reprise 989 s : Gateway prêt en 6323 ms. La fenêtre a été interrompue après environ 90 s. L'instrumentation initiale visait le lecteur caché `video-player`, pas `watch-video` : elle ne constitue pas une preuve de fluidité. La trace conserve l'en-tête et des plages éloignées de la cible exacte 478044748 ; aucune réutilisation intérieure démontrée.
2. Session `7e66850b-2ebf-4dbd-98f5-edab6c450760`, reprise 1036 s : Gateway prêt en 6090 ms, progression observée de 166,767 s, 2 images perdues sur 5010, un événement waiting de 8 ms. **Essai invalide pour l'exclusion fournisseur** : la fenêtre avait déjà été restaurée avant le lancement. Lecture arrêtée après découverte. Ces chiffres ne valent pas acceptation du runbook.
3. Fenêtre suivante, détecteur basé sur les noms d'exécutables : huit échantillons, aucune session pilote créée. Abandon confirmé par deux exécutables `ffmpeg` PID 3755031 et 3755032 sur le principal et deux brokers strict LID. Aucun travail de file actif au même instant. Il ne s'agit donc pas uniquement du défaut de recherche textuelle des anciennes fenêtres ; la cause des deux abandons antérieurs reste indéterminée.

## Audio

La sortie de la deuxième session utilise AAC stéréo 48 kHz, 160 kbit/s, avec `aresample=48000:async=1:first_pts=0`.
Un segment décodé hors ligne se termine sans avertissement. Les huit premiers segments comptent 1828 paquets audio : pas de trou >40 ms ni de chevauchement >10 ms, écart maximal mesuré 0,000001 s.
Cela vérifie une partie de la continuité et du décodage, **pas la qualité sonore perçue**. Les segments ont depuis été supprimés par le nettoyage des sessions ; ils ne sont plus disponibles pour une comparaison source/sortie.

Après arrêt, les deux éléments vidéo sont en pause, à vitesse 1 et preservesPitch=true. Cette observation ne prouve pas l'absence de double lecture pendant l'ancien symptôme.
Le test synthétique antérieur réfute la perte automatique du canal central lors du downmix standard. Le paquet AAC corrompu à 1368,2 s est hors de l'ancienne fenêtre entendue 806–989 s ; il ne prouve pas la cause signalée.

## Blocage d'isolation identifié

`backgroundJobBlockedByViewer` applique le bail aux files, mais les routes de probe/détection peuvent ouvrir un broker sans passer par cette admission. `claimLanguageEnrichmentNetwork` ne consulte pas le bail ; son branchement est en outre conditionnel à LANGUAGE_METADATA_LANE_ENABLED, observé désactivé sur le principal.
Un simple contrôle d'inactivité avant lecture ne ferme donc pas la course. Répéter le même essai n'apporterait pas une preuve d'exclusion.

Travail restant : couvrir les admissions fournisseur de métadonnées, y compris les appels déjà admis avant le bail, tout en préservant la priorité lecteur et les réponses de report réessayables. Tester cette intégration avant activation ; ne pas présenter les huit tests unitaires du bail comme une couverture de ces routes.
Ensuite : capturer un extrait source et sa sortie sur le même passage, séquentiellement et sous exclusion vérifiée, comparer décodage, saturation, chronologie et rendu navigateur ; corriger la cause constatée, puis reprendre l'acceptation du cache.

## Restauration vérifiée

Résultat du contrôleur : restored=true, checkpointsEqual=true, leaseHeld=false, cleanupError=null.
Nouvelle lecture indépendante : zéro session pilote, bail libre, quatre secondaires Running=true et Paused=false.
Six checkpoints vérifiés, savedFrames=intactFrames : 156 / 24 / 120 / 30 / 126 / 30.
Le principal reprend des analyses ; cela ne constitue pas une session pilote résiduelle.
Aucun redémarrage du principal ni déploiement audio/cache lors de cette contre-vérification.

Traces serveur : `/home/adrien/.norva/resume-recheck-20260917/trace-first.jsonl`, `trace-second.jsonl`, `trace.jsonl`, `restoration.json`.
Ne pas réutiliser un ancien marqueur WINDOW_READY pour autoriser une nouvelle lecture.
