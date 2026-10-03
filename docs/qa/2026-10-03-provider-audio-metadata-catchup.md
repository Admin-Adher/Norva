# Rattrapage des langues fournisseur

## Défaut et correction

L'audit initial a confirmé environ 62 000 fiches films avec au moins une version sans langue. La récupération des déclarations de piste partageait une file avec les sondes de médias et la reconnaissance vocale, à un passage sur douze. Une réponse valide sans langue interrompait le lot. Des déclarations rapides à récupérer restaient donc derrière des fichiers inconclusifs ou des analyses longues.

Le correctif ajoute un curseur durable dédié aux métadonnées audio Xtream, partagé par le planificateur existant pour toutes les sources éligibles. Un tour de métadonnées alterne avec chaque étape existante. Les sources M3U conservent leur cadence et le traitement Selection existant.

- Au plus 32 opérations par lot, démarrées dans un budget de 35 secondes, séquentielles et espacées d'au moins une seconde. Chaque opération distante conserve son délai de 55 secondes ; le budget total du répartiteur reste 105 secondes.
- Une réponse valide sans langue est mémorisée et permet de passer au fichier suivant. Elle ne devient ni une langue ni une preuve sonore.
- Les erreurs sont conservées avec leur délai de réessai ; la perte d'un appel garde un verrou temporaire. Une lecture, une limite fournisseur ou une capacité indisponible suspend le lot.
- Les sondes et la reconnaissance vocale poursuivent leur rotation. Aucun seuil de reconnaissance ni quarantaine de fichier n'est assoupli.
- Les écritures utilisent le contrôleur existant qui vérifie le propriétaire, la source, la génération, les accès et le fichier. Un changement de catalogue ou d'identifiants réinitialise le curseur concerné et invalide les anciennes déclarations.
- Les nouvelles sources sont découvertes automatiquement par la file d'enrichissement existante. Aucun compte ou fournisseur particulier n'est codé en dur.
- Le compteur reste fondé sur les données réellement identifiées ; les pays, sous-titres et libellés ambigus ne sont pas transformés arbitrairement en langues audio.

## Vérifications avant déploiement

Tests JS ciblés : 118 réussis lors du contrôle des modules et intégrations concernés ; 65 réussis lors du contrôle suivant du répartiteur et de son maintien de la cadence M3U.

Base isolée : copie du schéma de production sans aucune ligne utilisateur, PostgreSQL sans réseau, données synthétiques et transaction annulée. Les 28 contrôles valident les droits, l'isolation, les écritures de déclaration réelles, les délais de réessai, la priorité de lecture et le changement d'accès. Ils couvrent également la rotation du planificateur et la conservation du curseur de synopsis.

## État

Déploiement global effectué le 3 octobre 2026 à 11:51:13 UTC. Le rattrapage des données reste en cours. L'existence de ce correctif ne signifie pas que chaque fichier fournit une langue exploitable. La complétude du catalogue et le gain de débit doivent être mesurés séparément.

## Préproduction sur données réelles

Révision e3b78ba6da43ea6d3e6b34366e620617487d0d5d : vérification des contrats et compilations Windows, Android téléphone et TV réussies (GitHub Actions 37120116011). La migration a été appliquée par le propriétaire des RPC protégées, supabase_admin.

Le candidat isolé du routage public a traité 28 fichiers Strng en 36,18 s, sans erreur ; les 28 réponses ne contenaient aucune déclaration exploitable et restent inconnues. Dino et MAX OTT ont respecté les reports liés aux activités fournisseur ; aucune protection de lecture n'a été contournée.

## Déploiement et activation effective

- Deux répliques Edge remplacées successivement, après absence de travaux sous bail : `norva-edge-functions` et `norva-edge-functions-2`, contrôles de santé réussis, image et environnement conservés.
- Référence du code Edge : `e3b78ba6da43ea6d3e6b34366e620617487d0d5d`, intégrée à la PR 599. Les commits suivants de cette PR ne changent que le rapport et le rôle de déploiement de la migration.
- Reçu serveur : `/home/adrien/.norva/provider-audio-catchup-20261003/deployment.safe.json` ; retour arrière conservé dans ce répertoire privé.
- SHA-256 des fichiers réellement montés sur les deux répliques :
  - `norva-playback/index.ts` : `8c3326911b9b970a30de4d68878d7d3dbebc00d8807f7db4707b57118ff5fa5f`
  - `norva-source-sync/index.ts` : `0c52d7f77c40afb578114484e394717e558c15f36e318c0f82839a082c985e2b`
  - `_shared/provider-audio-metadata-batch.mjs` : `a4e62dfc16e65d60bc50166b31afa700336d8e216be274d4d02e4c49ce1dd474`
- Le cron existant, actif chaque minute, a effectivement exécuté `provider-audio-metadata` avec `fleetRotationProtocol=2` à 11:54 UTC. Les sources M3U poursuivent leur protocole 1 ; une source Xtream de compte non interne a poursuivi sa rotation à 11:57 UTC.
- Couverture contrôlée : 10 sources Xtream éligibles, six propriétaires, dont un non interne. L'accès n'est pas conditionné au statut interne. Les sources futures sont admises par la réconciliation existante lorsqu'elles sont prêtes, visibles et éligibles.

## Mesures et limites

Le filtre web affichait encore **62 042** fiches avec au moins une version sans langue à 11:50 UTC. Ce nombre n'est pas le nombre de fichiers et comprend des fiches ayant également une version identifiée. Il n'est ni masqué ni artificiellement diminué par ce correctif.

La seule mesure réelle de débit du nouveau lot ayant effectivement atteint le fournisseur pendant cette fenêtre est **28 réponses en 36,18 s** sur Strng. Elles sont toutes inconclusives, sans erreur, et ne prouvent pas un gain de langues identifiées. Les essais Dino/MAX OTT et plusieurs passages automatiques ont été différés par les activités fournisseur et la capacité serveur. Les traces d'activité et fenêtres de priorité existaient bien ; elles n'ont pas été supprimées pour forcer un résultat.

Le garde de capacité du Gateway principal a notamment indiqué une opération de transcription et plusieurs travaux prioritaires, même avec zéro session vidéo locale. Un créneau de métadonnées disponible a ensuite confirmé le report par compte fournisseur. Les reports restent récupérables et le traitement continue via le planificateur. Aucune échéance de traitement des 62 000 fiches n'est certifiée par cet essai.

**Ce qui est validé** : nouveau parcours réel, progression après métadonnées vides, déploiement identique, activation automatique, limites de charge, priorité de lecture, tests d'écriture et de projection isolés avec les fonctions réelles.

**Ce qui ne l'est pas encore** : fin du rattrapage global, débit représentatif en exploitation prolongée et attribution positive d'une langue visible dans l'interface par ce nouveau lot pendant cette fenêtre. L'absence de langue explicite nécessite toujours une sonde ou une reconnaissance concluante ; les fournisseurs inaccessibles ou fichiers inconclusifs ne peuvent pas être déclarés identifiés.

## Résultats de validation complets

- 28 contrôles SQL réussis dans une base isolée sans données utilisateur, incluant propriétaire, bail, reprise, changement de génération/configuration, écrivain réel et projection effective.
- Régression ciblée JS réussie ; les 11 contrôles GitHub sur `e0a557a9ca39a7f34e3aa32a0348b42ed579238b` sont réussis, dont contrats, typage Edge, base jetable, parcours simulé web/mobile et compilations.
- La suite générale Windows locale a obtenu 5 729 réussites, 4 échecs, 1 annulation, 55 ignorés : trois appels à un chemin Git absent, un contrôle bash absent et un test Gateway dépassant son délai. Elle n'est pas déclarée verte. La CI Linux de la même modification, incluant les contrats cloud, est verte ; aucun de ces échecs locaux ne porte sur le nouveau lot.
- Les deux prévisualisations Vercel ont été limitées par le quota journalier de builds. Elles ne constituent pas une preuve de déploiement ; le déploiement concerné ici est celui des fonctions Edge sur Hetzner, contrôlé séparément. Aucun bundle d'interface n'est changé dans cette PR.