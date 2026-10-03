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

Base isolée : copie du schéma de production sans aucune ligne utilisateur, PostgreSQL sans réseau, données synthétiques et transaction annulée. Les 24 premiers contrôles valident les droits, l'isolation, les écritures de déclaration réelles, les délais de réessai, la priorité de lecture et le changement d'accès. Des contrôles complémentaires couvrent la rotation du planificateur et la conservation du curseur de synopsis.

## État

Déploiement et mesures réelles à compléter. L'existence de ce correctif ne signifie pas que chaque fichier fournit une langue exploitable. La complétude du catalogue et le gain de débit doivent être mesurés séparément.
