# Minnal : tâche présente, préfixe absent et récupération du profil

## Diagnostic en production

Le contrôle du 11 octobre à 13:17 UTC confirme que le MPEG-TS exact de Minnal
(927 773 232 octets) est dans la file privée de deux fichiers. Le runner tourne.
Ses essais ont toutefois tous répondu « deferred ». Aucun préfixe de démarrage
n'a été stocké depuis le déploiement général.

L'appel interne ciblé à 13:18:52 UTC révèle le motif réel :
`exact-file-evidence-unavailable`. La variante et ses deux miroirs de profil
contiennent un profil `gateway_inband`, observé à 12:29:31 UTC, avec
`metadataComplete=false`. La taille, la durée, H.264 et la piste AAC existent,
mais cette observation de lecture ne certifie pas l'inventaire complet.
`hasExactGatewayInbandVodProfile` refuse correctement cette preuve.

La sonde locale du préfixe TS utilise la complétude Matroska pour ce marqueur :
elle ne peut donc pas déclarer complète la table d'un TS. La lecture peut garder
cette observation utile ; la préparation anticipée exige la sonde complète.
La tâche s'arrêtait avant celle-ci et la relançait indéfiniment sans maintenance.

Le signal d'activité fournisseur était également récent (`gateway`), sans
lecture utilisateur ni claim cloud actif observé. Il ne prouvait **pas** la cause
du premier refus : le rejet du profil le précédait. Une demande de sonde complète
à 13:21 UTC a ensuite été reportée par `provider-account-busy`, sans tentative
fournisseur. La provenance de ce signal d'activité n'est pas attribuée ici.
Il n'a pas été effacé ni contourné.

## Deux caches et deux situations distinctes

Le dernier essai général reprenait à **9 077 secondes (2 h 31 min 17 s)**.
La minute préparée depuis zéro ne couvre pas cette position. Les caches mémoire
de reprise étaient vides après la recréation des Gateways du déploiement général.
Cette absence ne signifie pas que Minnal est exclu du cache : la réouverture
privée HLS à 8 857 secondes avait réellement réutilisé des données lors du pilote.
Les TTL et la perte de RAM au redémarrage restent inchangés.

## Correction

PR775 ajoute une récupération ciblée quand le validateur d'un film signale un
profil exact incomplet ou un inventaire audio invalide :

- Résolution unique de la variante visible et possédée ; absence ou ambiguïté
  n'autorise aucune sonde.
- Résolution hors réseau de la cible, contrôle strict de présence du compte,
  de lecture récente et de tâche source avant la maintenance.
- Réutilisation du backfill de profil existant, avec sonde fraîche, barrières
  distribuées, circuit, génération, admission et attestation de drainage.
- Fin du cycle après maintenance ; le préfixe attend le cycle suivant et refait
  les contrôles. Aucun `metadataComplete=true` n'est inventé.
- Journaux bornés : les motifs fixes sont conservés, jamais le texte fournisseur.
  `profile-refreshed` signifie profil complété, pas minute déjà disponible.

La correction ne généralise pas la file à tous les titres, ne prépare pas de
préfixe HLS pour une voie MP4 native et ne change pas l'éligibilité générale.
Les épisodes sans profil complet restent hors de cette récupération ciblée.

## Vérification

**58 tests ciblés réussis** : récupération en deux cycles, variante absente ou
ambiguë, présence/tâche active, transport incertain, isolation, révocation,
validation des preuves et conservation bornée. Contrats CI réussis sur
`c1a919956cdc533f0ef9a4546ea75959a0547e18`, run `38143653349`, job `114482428277`.
Les tests supplémentaires font partie de la suite CI, ils ne s'y additionnent pas.

Canary Edge sain, sources exactes, un seul fichier Edge modifié, zéro accès
fournisseur. L'activation ne recrée pas les Gateways et préserve leurs caches,
les flags généraux, les routes et la file privée. Les admissions sont drainées
naturellement puis restaurées ; aucun bail ni signal de présence forcé.

Le premier adaptateur de déploiement a rencontré une liste d'alias Docker nulle
avant rotation de service ; les admissions ont été restaurées. Le cas nul a été
corrigé. La première activation a terminé à 13:31:43 UTC. Une seconde révision
conserve explicitement le contrôle de présence stricte avant la sonde de profil.
Son reçu et la clôture de production sont consignés ci-dessous après contrôle.

## Clôture en production

Révision finale activée de **13:36:05 à 13:36:19 UTC** (15:36 Paris) sur les
deux réplicas Edge et le runner, avec images/environnements/routes conservés.
Les deux Gateways gardent leurs identifiants de conteneur et n'ont pas redémarré.
La portée générale reste active. Retour arrière des trois services conservé.

À 13:37 UTC, le runner signale le motif précis `account-presence` pour Minnal,
sans ouvrir de préparation média. Aucun claim utilisateur ni session/pompe
Gateway actif. La preuve exacte de métadonnées demeure partielle et le préfixe
n'est pas encore stocké : **la récupération automatique est déployée, mais la
préparation réelle reste reportée par l'admission fournisseur**. Aucune nouvelle
rapidité de Minnal n'est revendiquée. L'activité fournisseur n'est pas assimilée
à une lecture de l'utilisateur et sa réservation n'est pas forcée.

Les tâches continueront leur cycle normal lorsque les contrôles autoriseront
l'accès. Le correctif supprime le report définitif dû au profil partiel ; il ne
garantit ni un cache toujours rempli, ni une réouverture rapide à toute position.

Preuves sanitaires privées dans `.codex-artifacts/startup-cache-20261010/` :
`minnal-current-cache.remote.py.safe.json`, `minnal-deferral.remote.py.safe.json`,
`minnal-profile.remote.py.safe.json`, `minnal-refresh.remote.py.safe.json`,
`minnal-profile-focused.log`, `minnal-stage{,2}.safe.json`,
`minnal-apply{,2}.remote.py.safe.json`. Aucun accès, ticket ou identifiant publié.
