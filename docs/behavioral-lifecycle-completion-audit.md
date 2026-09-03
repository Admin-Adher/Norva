# Audit de complétude — moteur de cycle de vie comportemental

Date de contrôle local : 4 septembre 2026

Périmètre : spécification `pasted-text-1.txt`

Branche de préparation : `codex/behavioral-lifecycle`
État d'autorisation : **déploiement dormant autorisé ; aucune activation et aucun message réel autorisés**.

## Lecture du statut

- **Prouvé localement** : comportement exécuté ou contrat contrôlé par un test automatisé local.
- **Préparé, preuve externe requise** : code et procédure présents, mais la preuve exige le staging, un appareil, un transport réel ou le temps du pilote.
- **Interdit à ce stade** : l'action serait une activation, un envoi réel ou un pilote que l'autorisation actuelle ne couvre pas.

Un statut « prouvé localement » ne signifie jamais « vérifié en production ».

La baseline agrégée Hetzner/GA4 antérieure au déploiement est conservée dans [`behavioral-lifecycle-baseline-2026-09-04.md`](./behavioral-lifecycle-baseline-2026-09-04.md). Elle confirme notamment un seul import accepté sur 71 tentatives et seulement trois tentatives sous Android `1.3.16` : l'import reste donc une porte produit, sans que cet échantillon permette de juger la correction récente.

## Matrice exigences → preuves

| Exigence | Implémentation et preuve directe | Statut | Preuve encore nécessaire |
|---|---|---|---|
| Quatre parcours `no_source`, `import_unresolved`, `catalog_ready_no_first_play`, `continue_watching` | `20260903180000_behavioral_lifecycle_engine_v1.sql` crée quatre parcours fermés, onze étapes et leurs sorties de conversion ; `behavioral-lifecycle.integration.sql` rejoue entrées, sorties et annulations | Prouvé localement | Rejouer sur un clone Hetzner réaliste puis sur comptes internes |
| Délais configurables et arrêts immédiats | Les étapes stockent `delay_minutes`; les triggers mettent à jour la projection et `norva_cancel_behavioral_lifecycle_jobs` annule la file et les cartes in-app après conversion | Prouvé localement | Observer les courses avec les workers de staging |
| `continue_watching` à J+7 uniquement avec contenu réellement nouveau | `requires_new_content`, `last_new_content_at > resume_anchor_at` et contrôle final avant transport | Prouvé localement | Générer un vrai delta catalogue interne et observer le message |
| Modèles anglais clairs, sans données sensibles | Onze copies anglaises ; `norva_behavioral_step_copy_safe` protège modèles et copies de file contre URL/domaines privés, secrets, paiement et interpolation ; le gate préactivation vérifie les copies exactes | Prouvé localement | Relecture éditoriale finale avant pilote |
| Aucune promesse de nouveauté sans signal | Toute mention `new/latest/updated/changed` exige `requires_new_content=true`, puis un signal postérieur à la reprise | Prouvé localement | Contrôle d'un vrai catalogue ayant changé |
| Liens profonds Web/WebView/Android | Liste blanche `settings/sources`, aide import bornée, `home`, `home/resume`; canonicalisation Android; reçus d'ouverture; destination sûre si l'état a disparu | Prouvé localement | Installer la build sur un téléphone et ouvrir chaque notification réelle |
| Reprise à la position enregistrée sans identifiant dans le message | `HomePage.consumeLifecycleResumeIntent()` résout la dernière lecture reprenable dans l'historique authentifié, puis transmet son offset au lecteur | Prouvé localement | Lecture réelle, fermeture, notification, reprise sur appareil |
| Vérité Hetzner sans PII exposée à l'administration | `behavioral_lifecycle_user_state` projette inscription, source, tentative, famille d'erreur, import, catalogue, lecture, reprise, pays, langue, plateforme, version, fuseau, consentement et abonnement ; RLS et grants service-only ; l'admin reçoit des agrégats | Prouvé localement | Comparer les agrégats avec le schéma et les données Hetzner réels |
| File durable, idempotence et déduplication | `behavioral_lifecycle_outbox`, `dedupe_key` unique, leases, `SKIP LOCKED`, versions de configuration, statuts terminaux | Prouvé localement | Charge réaliste avec la configuration de pool de staging |
| Deux workers concurrents | `behavioral-lifecycle.concurrency.sql` ouvre deux sessions `dblink` vers l'instance exacte et prouve quatre claims disjoints avec quatre leases | Prouvé localement | Rejouer avec le pool et la latence du staging |
| Annulation après conversion | Réévaluation immédiate, contrôle final sous verrou et événement `message_cancelled_after_conversion` | Prouvé localement | Course conversion/transport sur staging |
| Backoff, tentatives bornées, TTL et DLQ | Claim/échec borné, dates d'expiration, `dead_letter`, rejeu unique audité avec confirmation typée | Prouvé localement | Simuler erreurs réseau réelles FCM/Resend en staging |
| Collapse key par parcours | Contrainte SQL et payload FCM data-only avec collapse key canonique | Prouvé localement | Observer le remplacement sur un téléphone hors ligne |
| Purge FCM fail-closed | Purge uniquement sur erreur structurée `UNREGISTERED`/jeton invalide ; jamais sur quota, projet, réseau ou 429 ; tests HTTP simulés | Prouvé localement | Jeton interne réellement révoqué |
| Accepté, livré et ouvert sont distincts | Statuts/outbox distincts ; réponse FCM = `provider_accepted`; Android enregistre `delivered` seulement après affichage puis `opened` à l'ouverture | Prouvé localement | Transport FCM et reçus sur téléphone réel |
| Transport email Resend | Transport partagé, clé d'idempotence, réponse 2xx avec ID obligatoire, 429/timeout bornés et diagnostics nettoyés ; webhook signé existant pour livraison/ouverture | Prouvé localement | Envoi interne, réception, ouverture et désinscription réels |
| Plafonds globaux | Maxima absolus tous parcours confondus : 1 push/24 h, 3/7 j et 2 emails/7 j ; l'admin peut seulement les réduire | Prouvé localement | Observer les reports dans le staging |
| Silence 21 h–9 h et fuseau | `norva_behavioral_next_allowed_at` applique la zone du compte/token ; intégration couvre changement de fuseau | Prouvé localement | Test temporel avec appareil réel dans une zone différente |
| Cooldown 7–14 jours | Contrainte et RPC bornent la valeur ; un nouveau déclencheur attend le dernier transport accepté du parcours + cooldown | Prouvé localement | Observer un cycle complet ou accélérer l'horloge en staging |
| Consentement et désinscription | Email marketing refusé sans opt-in ; trigger de préférence annule immédiatement les messages concernés ; messages de service restent séparés | Prouvé localement | Désinscription via lien email interne et réconciliation Hetzner |
| Push uniquement avec permission accordée | Autorisation SQL juste avant transport, état du jeton, contrôle Android avant `notify()` | Prouvé localement | Accepter/refuser manuellement sur Android 13+ |
| Permission push contextuelle | Le nudge est rendu dès l'écran post-inscription de connexion M3U/Xtream, avec explication ; aucune demande système au lancement | Prouvé localement | Vérifier sur téléphone frais, TalkBack et refus/réacceptation |
| Déduplication inter-parcours et priorité opérationnelle | `norva_behavioral_journey_relevant` impose `no_source → import_unresolved → catalog_ready_no_first_play → continue_watching`; un état prioritaire annule le niveau inférieur ; les lignes opérationnelles passent avant le marketing | Prouvé localement | Observer volumes et claims sur données réelles |
| Administration Marketing complète | Onglet Parcours : statuts, éligibilité, entrées/sorties, étapes, délais, plafonds, consentements/exclusions, previews Android/Web/email, métriques, plans d'expérience, audit, DLQ et coupe-circuit | Prouvé localement | Monter l'UI sur les agrégats du staging puis revue opérateur |
| Porte de préparation de l'import avant pilote | Table append-only sans PII ; attestation liée au commit, à la version Android et au SHA-256 ; contrôles M3U, Xtream, catalogue >=25 000, guidage d'erreur et WebView ; preuve réussie et fraîche exigée à chaque évaluation pilote | Prouvé localement | Rejouer les cinq scénarios sur le staging et l'artefact Android exacts, puis enregistrer l'attestation réelle |
| Test interne et arrêt d'urgence | Runtime singleton fermé par défaut ; confirmations `START INTERNAL TEST`, `START PILOT`, `EMERGENCY STOP`; pilote exclut comptes internes | Prouvé localement | Ouverture volontaire en `internal_test` après autorisation de déploiement |
| Pas de rattrapage rétroactif à l'activation | L'éligibilité exige un déclencheur postérieur à `activated_at`; chaque activation démarre une nouvelle version/cohorte | Prouvé localement | Compte ancien + compte frais après activation interne |
| Registre exact des 16 événements | Contrainte fermée : `message_eligible`, `message_queued`, `message_sent`, `message_provider_accepted`, `message_delivered`, `message_opened`, `deep_link_opened`, `source_form_opened`, `source_attempted`, `import_success`, `first_play`, `playback_resumed`, `trial_started`, `subscription_started`, `message_cancelled_after_conversion`, `email_unsubscribed` | Prouvé localement | Exhaustivité dans le journal canonique Hetzner et réconciliation sémantique des jalons client avec Firebase/GA4 ; pas une égalité artificielle des événements de transport serveur dans GA4 |
| Métrique principale mature à 72 h | Dénominateur limité aux inscriptions âgées d'au moins 72 h ; agrégation par pays, plateforme, version et parcours | Prouvé localement | Attendre des cohortes réelles matures |
| Groupe témoin stable 10 % | Bucket déterministe, holdout indépendant des versions, jamais configurable hors 10 % | Prouvé localement | Contrôler la distribution réelle du pilote |
| Un seul paramètre expérimental | Snapshot immuable ; delta limité à `delay`, `channel`, `copy` ou `cta`; refus des modifications multivariées | Prouvé localement | Première variante après baseline mature |
| Fenêtres 24 h, 72 h, 7 j et décisions J+7/J+14 | Fonctions d'agrégation, maturité, garde-fous et états `not_started/pending/ready`; aucune significativité statistique inventée | Prouvé localement | Pilote autorisé et écoulement réel de 7 puis 14 jours |
| Déploiement progressif et rollback | Ordre documenté ; gate DB en lecture seule ; déploiement Edge quiescent ; collecteur et validateur de preuve dormante ; runtime fermé | Préparé, preuve externe requise | Autorisation explicite de déploiement puis exécution contrôlée |
| Résultats mesurables face au témoin | Le calcul est prêt mais aucune cohorte réelle n'a été exposée | Interdit à ce stade | Autoriser séparément le pilote 10 %, attendre la maturité et analyser les trois parcours prioritaires |

## Scénarios obligatoires

| Scénario du brief | Preuve locale | Reste à faire |
|---|---|---|
| Inscription puis source dans la même session | Intégration PostgreSQL + contrat Web | Staging Auth/WebView |
| Aucune tentative | Éligibilité et délais `no_source` | Horloge et compte interne réels |
| M3U, Xtream et catalogue >25 000 entrées | Tests existants d'import volumineux + état lifecycle | Import staging réel de chaque forme |
| Import invalide, timeout, 404/5xx et retry | Familles bornées, backoff, UI contextuelle, tests de transport | Pannes contrôlées sur staging |
| Conversion avant échéance | Annulation SQL et carte in-app supprimée | Course worker réelle |
| Permission refusée | Autorisation push refusée, jeton non ciblable | Refus manuel Android |
| Email désinscrit | Préférence et annulation immédiate | Clic réel sur désinscription interne |
| Téléphone hors ligne plusieurs jours | TTL/collapse/déduplication | Appareil réel hors ligne puis reconnexion |
| Changement de fuseau | Calcul SQL et mise à jour du jeton | Appareil réel dans une autre zone |
| Déconnexion avant lien profond | Fallback/auth round-trip borné | Session expirée sur Web et Android |
| Rejeu et deux workers | Idempotence + test `dblink` concurrent réussi | Pool staging |
| Accessibilité et navigation Android | Contrats UI, cibles tactiles et tests instrumentés | TalkBack, Back, focus et geste/3 boutons sur appareil |

## Résultats de validation locale

- PostgreSQL 16.15 jetable : migration complète validée et commitée dans la transaction de test.
- Scénarios transactionnels : `BEHAVIORAL_LIFECYCLE_INTEGRATION_OK`.
- Concurrence à deux workers : `BEHAVIORAL_LIFECYCLE_CONCURRENCY_OK`.
- Le test de concurrence transporte désormais explicitement socket, port, base et rôle actifs ; il ne peut plus tomber silencieusement sur un autre cluster local.
- Suite Node : 3 512 tests découverts, 3 504 réussis, 8 ignorés, 0 échec lors de la dernière exécution complète.
- Contrats lifecycle/FCM/Resend/evidence : 61/61 réussis lors de la dernière exécution ciblée.
- Playwright : 12/12 sur Chromium desktop et profil Android mobile, dont la porte de préparation import absente et le payload exact de son attestation.
- ADB : outil présent dans le SDK, mais aucun téléphone détecté lors du contrôle du 4 septembre 2026 ; aucune preuve physique n'est donc revendiquée.
- Recompilation Android locale : le défaut Windows/JDK `java.io.IOException: Unable to establish loopback connection` a été isolé au sélecteur interne du daemon Gradle. Sans modifier le projet, `JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:/norva-jdk-sockets` et le SDK Android explicite ont permis une réexécution forcée de `:app:testDebugUnitTest :app:assembleDebug` avec Gradle 8.13 : `BUILD SUCCESSFUL`, 39/39 tâches exécutées, 27/27 tests JVM réussis dans sept rapports. L'APK debug reconstruit pèse 20 945 022 octets et porte le SHA-256 `f653b9474a3ff84e6750b002aa66d77a9c276b38a5eb10b0ce796cf9ecdf7960`. Le workflow CI `build-android-phone` conserve néanmoins `testDebugUnitTest`, `lintDebug` et `assembleDebug` comme gate obligatoire avant publication.
- Lint Android : `:app:lintDebug --rerun-tasks` réussit également avec 27/27 tâches exécutées ; le rapport HTML local a été produit sans erreur bloquante.
- Baseline de production en lecture seule : 126 inscriptions, 71 tentatives de source, une acceptée ; 48 tentatives en Inde et quatre au Bangladesh. Les 16 événements exacts du moteur sont absents de GA4 avant déploiement, tandis que huit événements produit existent déjà et `catalog_ready` manque. Les détails et limites d'interprétation sont figés dans `behavioral-lifecycle-baseline-2026-09-04.md`.
- Porte de complétion : `validate-behavioral-lifecycle-completion-evidence.js` exige les sept preuves externes, J+14, un pilote autorisé avec témoin 10 %, les garde-fous intacts et un gain positif recalculé pour les trois parcours prioritaires. Trois tests réussissent, dont quatorze falsifications refusées ; l'artefact reste explicitement sans autorité de déploiement, activation ou envoi.

Ces nombres doivent être rafraîchis après toute nouvelle modification du périmètre.

## Sept preuves externes encore manquantes

1. Scénarios sur schéma et données Norva de staging réels.
2. Livraison et ouverture FCM sur compte interne.
3. Livraison, ouverture et désinscription email sur compte interne.
4. Permission Android, liens profonds et reçus sur téléphone physique.
5. Réconciliation Hetzner, Firebase et GA4 selon le mapping documenté : Hetzner canonique pour les 16 événements, GA4/Firebase pour les jalons client et produit pertinents.
6. Pilote 10 % explicitement autorisé.
7. Résultats matures J+7 et J+14, dont un gain mesurable sur les trois automatisations prioritaires.

Ces portes sont également encodées dans le validateur final. Son succès futur vérifiera la cohérence formelle des preuves ; il ne remplacera ni leur collecte indépendante ni une autorisation d'action.

## Verdict de complétude

La préparation locale est techniquement cohérente, testable, révocable et fail-closed. Elle n'est **pas terminée au sens du brief** : aucune preuve de staging/production, aucun transport réel, aucun pilote et aucun résultat J+7/J+14 n'existent encore. Le prochain état sûr est le déploiement désormais autorisé de l'instrumentation sous arrêt d'urgence. L'ouverture du runtime, l'attestation réelle de préparation import, le pilote et tout envoi restent des portes séparées.
