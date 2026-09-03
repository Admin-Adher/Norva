# Relance comportementale Norva — architecture et exploitation

> Statut : préparé dans un worktree isolé et autorisé pour un déploiement dormant, mais non encore déployé ni activé au moment de cette photographie. Le coupe-circuit global est fermé par défaut, l'audience est limitée au test interne et les quatre parcours restent en brouillon avec un rollout à 0 %. Aucun message réel ne doit partir à la suite de cette seule publication.

La matrice exhaustive exigences/preuves et la liste fermée des validations externes restantes sont dans [`behavioral-lifecycle-completion-audit.md`](./behavioral-lifecycle-completion-audit.md). Elle distingue explicitement preuve locale, staging, appareil physique, pilote et résultats matures. La photographie agrégée antérieure au déploiement est figée dans [`behavioral-lifecycle-baseline-2026-09-04.md`](./behavioral-lifecycle-baseline-2026-09-04.md).

## Pourquoi Marketing affiche plus d’appareils que de comptes

Le nombre de comptes et le nombre de jetons push ne mesurent pas la même chose.

Snapshot observé pendant l’audit :

| Mesure | Valeur | Signification |
|---|---:|---|
| Comptes inscrits | 129 | lignes d’utilisateurs Auth |
| Jetons FCM enregistrés | 133 | installations/appareils enregistrés, y compris anciens jetons |
| Comptes ayant au moins un jeton | 114 | utilisateurs distincts associés à un ou plusieurs jetons |
| Comptes sans jeton connu | au moins 15 | 129 moins 114 |
| Jetons au-delà du premier par compte équipé | 19 | 133 moins 114 |

L’écart n’indique donc ni quatre comptes fictifs ni quatre inscriptions manquantes. Un même compte peut posséder plusieurs jetons après une réinstallation, un changement de téléphone ou une rotation FCM. Inversement, un compte peut n’avoir aucun jeton.

Les libellés Marketing distinguent désormais :

1. **comptes inscrits** ;
2. **jetons enregistrés** ;
3. **comptes avec jeton** ;
4. **permissions accordées** ;
5. **jetons ciblables et frais** ;
6. **comptes ciblables**.

Un jeton enregistré n’est jamais présenté comme une preuve de réception. Les états suivants restent séparés :

`enregistré → permission accordée → ciblable → accepté par FCM → livré → ouvert → lien profond ouvert`

Après installation de la migration, les anciens jetons ont une permission `unknown`. Ils ne deviennent ciblables qu’après une nouvelle déclaration explicite de l’application. Ce choix est volontairement fail-closed.

Sur Android, `message_delivered` n’est enregistré qu’après acceptation de l’affichage local par le système : permission `POST_NOTIFICATIONS` accordée sur Android 13+, notifications autorisées par le gestionnaire et par le canal `Norva guidance`, puis absence de `SecurityException` lors de la course d’affichage. La simple réception d’un message FCM data-only reste donc distincte d’une notification effectivement présentée.

## Parcours préparés

| Parcours | Entrée | Étapes | Arrêt |
|---|---|---|---|
| `no_source` | inscription sans source ni tentative | in-app T+15 min, rappel T+24 h, dernier rappel J+3 | première tentative ou source ajoutée |
| `import_unresolved` | import rejeté, interrompu ou bloqué | aide immédiate, push T+2 h, guide T+24 h | import réussi |
| `catalog_ready_no_first_play` | catalogue prêt sans lecture | confirmation immédiate, invitation T+4 h, dernier rappel J+2 | première lecture |
| `continue_watching` | position de reprise inactive depuis 48 h | rappel à 48 h, puis J+7 seulement si contenu pertinent | reprise, fin ou disparition de la position |

Les délais et canaux sont stockés dans `behavioral_lifecycle_steps`; ils peuvent être ajustés par configuration sans modifier le moteur.

## Modèle d’état

`behavioral_lifecycle_user_state` est la projection Hetzner des signaux utiles :

- inscription, pays, langue, plateforme, version et fuseau ;
- présence de source et nombre de tentatives ;
- dernière famille d’erreur d’import, import réussi et catalogue prêt ;
- première lecture, dernière lecture et position de reprise ;
- contenu nouveau réellement constaté ;
- consentement marketing et état d’abonnement.

Les événements métier mettent cette projection à jour puis réévaluent immédiatement les sorties de parcours. La conversion annule les messages encore en attente. Une dernière autorisation transactionnelle est également exécutée sous verrou juste avant chaque transport afin de couvrir la course « conversion entre sélection et envoi ».

La migration reconstruit une projection d'état à partir des comptes, préférences email, droits, sources, lectures et positions de reprise déjà présents. Ce backfill sert seulement aux volumes et à la compréhension du funnel : il ne crée aucun événement marketing historique et ne met aucun message en file. Chaque activation crée une nouvelle version et une nouvelle date de cohorte ; un compte de test `no_source` doit donc être créé après l'ouverture du runtime et l'activation du parcours pour être réellement éligible.

`behavioral_lifecycle_import_readiness` constitue une porte produit séparée, append-only et sans URL ni identifiant fournisseur. Chaque attestation lie un libellé de release, le commit Git exact, la version Android, un SHA-256 d'artefact et cinq résultats bornés : M3U, Xtream, catalogue d'au moins 25 000 entrées, guidage des erreurs et WebView Android. L'ouverture du mode pilote exige que la dernière attestation soit réussie et âgée de moins de quatorze jours. La pertinence d'un parcours la revérifie à chaque évaluation : son expiration referme automatiquement toute nouvelle livraison pilote, même si le runtime n'a pas été redémarré.

Le signal `catalog_ready_at` représente la première mise à disposition réelle du catalogue : un rafraîchissement ultérieur ne redémarre pas le parcours « première lecture ». La reprise est recalculée sur l’ensemble des titres inachevés du compte ; terminer un titre ne masque donc pas une autre lecture encore reprenable.

La file `behavioral_lifecycle_outbox` est durable, louée et idempotente. Elle sépare :

- `pending`, `processing` et `email_queued` ;
- `provider_accepted`, `delivered` et `opened` ;
- `suppressed`, `canceled` et `dead_letter`.

Un envoi push dont le résultat réseau est ambigu après le début du transport est placé en dead letter au lieu d’être renvoyé automatiquement. Cela privilégie l’absence de doublon.

La purge des jetons FCM est elle aussi fail-closed : elle exige une erreur structurée `google.firebase.fcm.v1.FcmError` de type `UNREGISTERED` ou `INVALID_ARGUMENT`, ou un message de jeton explicitement borné à une réponse HTTP 400/404. Une erreur générique de projet, de payload, de quota ou de disponibilité ne supprime jamais le jeton. Cette distinction suit les [codes d’erreur FCM](https://firebase.google.com/docs/cloud-messaging/error-codes) et les [recommandations de gestion des jetons](https://firebase.google.com/docs/cloud-messaging/manage-tokens).

## Confidentialité

Aucun événement de relance ne doit contenir :

- URL complète de fournisseur ;
- paramètres, identifiant ou mot de passe ;
- nom privé de playlist ;
- donnée de paiement ;
- réponse brute du fournisseur.

Les tables porteuses d’identité sont privées au rôle de service. L’administration ne reçoit que des agrégats. Les liens profonds sont limités à une liste blanche et reviennent vers un écran sûr si la ressource n’existe plus.

Le texte sortant est également traité comme une frontière de données. Une fonction PostgreSQL immuable est appelée par deux contraintes — modèle et copie placée en file — ainsi que par la RPC d’édition administrateur. Elle refuse les URL/domaines privés, adresses email, valeurs de secret ou de paiement, syntaxes d’interpolation et destinations incompatibles avec le parcours. Toute affirmation `new`, `latest`, `updated` ou `changed` exige `requires_new_content = true` ; cette condition est ensuite revérifiée juste avant transport par comparaison du dernier signal `new_content` avec la position de reprise. Le gate préactivation compare en plus le titre, le corps et le CTA exacts des onze modèles anglais revus. L’éditeur Marketing reproduit cette frontière en précontrôle non autoritaire : il limite les destinations selon le parcours, retire l’option de fraîcheur des parcours incompatibles, marque le champ concerné avec `aria-invalid`, explique le motif dans une région annoncée et bloque le bouton tant que le contenu est certainement invalide. PostgreSQL reste l’autorité finale et revérifie chaque sauvegarde. Après une mutation confirmée par le serveur, un échec distinct de rafraîchissement ne transforme jamais le succès en faux rejet : l’interface conserve l’état « enregistré », demande un rechargement et évite ainsi un rejeu opérateur ambigu.

Les CTA email appliquent une seconde liste blanche après construction du lien : origine et chemin Norva exacts, identifiant de livraison UUID unique, aucun paramètre étranger, familles d’erreur M3U/Xtream bornées et seulement `settings/sources`, son aide contextuelle, `home` ou `home/resume`. Une aide `import_unresolved` valide reste donc contextuelle dans l’email au lieu d’être silencieusement remplacée par l’accueil ; toute autre URL retombe sur l’application générique.

## Garde-fous

- 1 push maximum par utilisateur et par jour ;
- 3 pushs maximum sur sept jours glissants ;
- 2 emails de relance maximum sur sept jours, hors transactionnel ;
- silence local de 21 h à 9 h ;
- groupe témoin déterministe de 10 % ;
- déduplication inter-parcours ;
- priorité aux messages opérationnels ;
- permission Android `granted` obligatoire pour le push ;
- consentement applicable obligatoire pour tout email marketing ;
- Inde et Bangladesh uniquement dans la configuration pilote ;
- TTL, une collapse key canonique par parcours, backoff borné et dead-letter queue ;
- purge d’un jeton signalé invalide par FCM ;
- comptes administrateurs internes exclus des audiences réelles.

Les plafonds `1/24 h`, `3/7 jours` et `2 emails/7 jours` sont des maxima absolus au niveau du compte et tous parcours confondus. L’interface, la RPC d’administration et les contraintes PostgreSQL peuvent les réduire, mais aucune configuration de parcours ne peut les augmenter.

Lorsque plusieurs états bruts se chevauchent, un seul parcours reste pertinent. L’ordre serveur est `no_source`, puis `import_unresolved`, puis `catalog_ready_no_first_play`, puis `continue_watching`. Un parcours inférieur déjà en attente est annulé au tick ou à sa dernière autorisation avant transport ; être dans le groupe témoin d’un parcours prioritaire ne permet pas à un parcours inférieur de contaminer ce témoin.

Après une conversion, la ligne de livraison et son audit sont conservés, mais toute carte in-app `behavioral_lifecycle` encore visible pour ce parcours est retirée de la boîte de notifications. Le centre de messages ne peut donc pas demander à l’utilisateur de répéter une action déjà accomplie.

## Interface Marketing

L’onglet **Parcours** de `#admin/marketing/notifs` expose :

- le coupe-circuit global et le mode d'audience `internal_test` ou `pilot` ;
- les quatre scénarios, leurs événements d'entrée/sortie et leurs volumes actuellement éligibles ;
- les volumes potentiels interne, pilote et pays inconnu, distincts de l'éligibilité réelle ;
- le rollout, les pays, le cooldown, les plafonds et les heures silencieuses ;
- chaque étape éditable : canal, délai, modèle, CTA, lien profond, TTL, collapse et nature marketing ;
- un aperçu du message pour Android, Web et email ;
- les métriques de livraison, de conversion et le funnel principal à 72 h par pays, plateforme, version et parcours, limité aux cohortes ayant réellement disposé de 72 heures complètes ;
- la comparaison traitement/témoin à 24 h, 72 h et 7 jours, avec volumes, taux, écart absolu, uplift relatif indicatif et écart de désabonnement ;
- le plan expérimental immuable de chaque version : hypothèse, métrique principale, fenêtre, cible, variable testée et photographie des étapes ;
- une décision directionnelle J+7/J+14, distincte d'un test de significativité statistique, ainsi que l'évolution des rejets fournisseur face à la version précédente ;
- les compteurs de sûreté : clé de déduplication en double, transport démarré après conversion, rejet fournisseur et annulation après conversion ;
- l’état des échéances des rapports J+7 et J+14, sans prétendre qu’un rapport existe avant le démarrage et la maturation du pilote ;
- la dead-letter queue avec rejeu borné et confirmation typée ;
- un historique d'audit pseudonymisé des changements administratifs.
- la dernière attestation de préparation de l'import, limitée aux coordonnées de release, aux cinq résultats booléens et à son expiration, avec un formulaire exigeant la confirmation exacte `VERIFY IMPORT READINESS` ou `RECORD IMPORT FAILURE`.

Il affiche explicitement la différence entre comptes, jetons, permissions et destinataires réellement ciblables. Toutes les mutations administratives exigent un motif de 8 à 500 caractères. Les modèles d'un parcours actif restent en lecture seule jusqu'à sa mise en pause.

Le système est fail-closed :

- le runtime global démarre sur `emergency_stop = true` ;
- `START INTERNAL TEST`, `START PILOT` et `EMERGENCY STOP` sont les confirmations exactes des changements d'audience globaux ;
- `START PILOT` est refusé côté interface et côté PostgreSQL si la preuve M3U/Xtream/gros catalogue/guidage/WebView est absente, échouée ou expirée ;
- enregistrer conserve un brouillon ou une pause ;
- l’activation exige la saisie exacte de `ACTIVATE <journey_key>` ;
- un rollout à 0 % ne peut pas être activé ;
- une modification active invalide les anciens jobs en attente et démarre une nouvelle version de cohorte ;
- l’activation ne rejoue jamais rétroactivement tout l’historique ;
- une mise en pause annule les messages qui n’ont pas encore commencé leur transport ;
- un transport déjà commencé n’est jamais réétiqueté « annulé » pendant son exécution : son résultat reste journalisé ;
- un retry de dead letter exige `RETRY <delivery_id>`.

## Liens profonds

Les notifications comportementales utilisent uniquement :

- `/app.html#settings/sources` pour l’ajout et la réparation de source ;
- `/app.html#settings/sources/help/<failure_family>/<source_type>` pour une aide d’import contextualisée, où `failure_family` appartient à une liste fermée et `source_type` vaut uniquement `m3u` ou `xtream` ;
- `/app.html#home` pour le catalogue et la première lecture ;
- `/app.html#home/resume` pour reprendre la dernière lecture réellement inachevée du compte, sans placer d’identifiant de contenu dans l’URL.

Les seules familles d’erreur transportées sont `credentials`, `missing_credentials`, `endpoint_not_found`, `timeout`, `provider_busy`, `rate_limited`, `playlist_format`, `invalid_input`, `payload_too_large`, `provider_unreachable`, `infrastructure` et `unknown`. Aucune URL, aucun chemin fournisseur et aucune valeur de paramètre ne traverse le lien. L’écran Sources résout ensuite l’état actuel avec son API propriétaire et affiche une aide bornée ; il ne relance ni ne modifie automatiquement une source.

Le shell Android accepte uniquement cette liste blanche, refuse les paramètres dupliqués, canonicalise la destination, déduplique localement les identifiants de livraison et restitue les reçus de livraison/ouverture à la WebView après reconnexion. Les ouvertures Web et email sont également mesurées sans dépendre du shell Android. Une destination absente, expirée ou une reprise qui n’existe plus revient à un état sûr sur l’accueil.

## Mesure

Les événements sont enregistrés séparément :

- éligibilité et mise en file ;
- acceptation du transport ;
- livraison et ouverture ;
- ouverture du lien profond ;
- ouverture du formulaire, tentative, import réussi ;
- première lecture et reprise ;
- essai et abonnement ;
- annulation après conversion et désinscription.

Le registre borné contient exactement les seize événements requis : `message_eligible`, `message_queued`, `message_sent`, `message_provider_accepted`, `message_delivered`, `message_opened`, `deep_link_opened`, `source_form_opened`, `source_attempted`, `import_success`, `first_play`, `playback_resumed`, `trial_started`, `subscription_started`, `message_cancelled_after_conversion` et `email_unsubscribed`.

La métrique principale est la proportion d’inscrits atteignant un import réussi puis une première lecture en moins de 72 heures. Son dénominateur exclut les inscriptions âgées de moins de 72 heures : une cohorte récente ne peut donc plus faire artificiellement baisser le taux. Les comparaisons doivent être agrégées par pays, plateforme, version et parcours. Le taux d’ouverture n’est pas une conversion.

Chaque parcours expose aussi trois fenêtres d’expérience : 24 heures, 72 heures et 7 jours. Une fenêtre ne compte que les utilisateurs dont l’affectation traitement/témoin a eu le temps d’atteindre cette durée, sur la version courante du parcours et hors comptes internes. Le groupe témoin reste déterministe à 10 %. L’interface affiche l’écart absolu en points et l’uplift relatif lorsqu’il est calculable, mais ne présente jamais ces chiffres comme statistiquement significatifs sans analyse dédiée.

### Protocole d'expérimentation versionné

Une activation crée une ligne immuable dans `behavioral_lifecycle_experiment_versions`. Elle conserve le plan et la photographie des délais, canaux, textes, CTA, liens profonds et de la structure des étapes au moment exact où la version devient active. Le rôle de service peut lire et insérer ces versions, mais pas les modifier ni les supprimer.

La première version de chaque parcours est obligatoirement une baseline. Pour les versions suivantes, PostgreSQL calcule le delta avec la photographie précédente et impose une seule famille de changement parmi `delay`, `channel`, `copy` et `cta`. La variable déclarée doit correspondre au changement observé. Une modification simultanée de plusieurs familles, une modification de structure mêlée à un test, ou une cible absente sur une version non-baseline est rejetée côté serveur. Une refonte structurelle doit repartir en baseline ; mettre en pause puis reprendre une configuration inchangée conserve sa version.

Les cibles initiales sont explicites : `no_source` vise +20 % de tentatives de source et `catalog_ready_no_first_play` +15 % de premières lectures sur leur fenêtre principale de 72 heures. `import_unresolved` et `continue_watching` restent en baseline sans cible fabriquée jusqu'à ce qu'un niveau de référence mature permette de fixer un seuil crédible.

La décision serveur ne fabrique aucune preuve commerciale. À J+7, elle peut seulement signaler qu'une observation est disponible. À J+14, elle vérifie l'échantillon, les doublons, les envois après conversion, la hausse des désabonnements, l'évolution des rejets fournisseur et la cible relative. Sans version précédente comparable, le taux de rejet fournisseur est déclaré « baseline en cours » ; il n'est pas présenté comme une amélioration. Les statuts directionnels tels que `baseline_ready`, `target_met` ou `target_not_met` portent tous `statistical_significance_assessed = false` : une analyse dédiée reste nécessaire avant toute conclusion statistique.

Les événements de monétisation autoritaires `trial_started` et `subscription_started` sont attribués à la dernière affectation de cycle de vie des sept jours précédents. Un `email_unsubscribed` est attribué uniquement au dernier email marketing de cycle de vie dont le transport a réellement commencé dans les 30 jours ; un brouillon ou un email encore en attente peut être annulé, mais ne peut jamais revendiquer le désabonnement. Ces règles rendent les compteurs par parcours exploitables sans accepter de coordonnées d’attribution fournies par le client.

Les rapports de décision J+7 et J+14 restent à l’état `not_started` tant qu’aucune affectation pilote réelle hors comptes internes n’existe, puis `pending` jusqu’à leur échéance et `ready` ensuite. La préparation locale ne produit donc aucun résultat commercial fictif : les gains, désabonnements et seuils ne pourront être conclus qu’après un pilote explicitement autorisé et arrivé à maturité.

### Porte de déclaration « terminé »

`node scripts/validate-behavioral-lifecycle-completion-evidence.js <artefact.json>` valide uniquement une déclaration de preuve canonique et non un droit d'agir. Il exige les sept preuves externes, un déploiement lié à un commit, un pilote autorisé à 10 % avec témoin permanent de 10 %, une fenêtre arrivée à J+14, la réconciliation sémantique Hetzner/GA4/Firebase, zéro doublon ou relance après conversion et un gain positif recalculé à partir des comptes traitement/témoin pour `no_source`, `import_unresolved` et `catalog_ready_no_first_play`.

Le validateur recalcule les taux et refuse les chiffres incohérents, les preuves postdatées, un pilote trop court, les dépassements de 0,5 point, les champs inattendus et toute tentative d'utiliser l'artefact comme autorisation de déployer, activer ou envoyer. Aucun artefact de complétion réel ne peut être produit avant les validations externes et l'écoulement du temps.

## Ordre de déploiement

Le déploiement dormant est désormais autorisé. Cette autorisation ne couvre ni l'ouverture du runtime, ni l'activation d'un parcours, ni un envoi réel :

1. sauvegarder et vérifier l’état courant Hetzner ;
2. arrêter toutes les répliques `edge-runtime` avant toute modification du contrat DB/Edge ;
3. appliquer, dans l’ordre, `20260903180000_behavioral_lifecycle_engine_v1.sql` puis `20260904090000_behavioral_lifecycle_import_readiness_append_only.sql` ; la seconde migration retire explicitement les privilèges larges que certaines installations Supabase attribuent par défaut à `service_role` et ne lui rend que `SELECT, INSERT` sur l’attestation ;
4. exécuter `bash ops/hetzner/scripts/verify-behavioral-lifecycle-pre-activation.sh` : ce gate en transaction lecture seule vérifie les empreintes des deux migrations, les grants, RLS, 12 triggers, 15 RPC, les deux contraintes de copie, les quatre parcours et les onze modèles anglais exacts, l’absence de backlog et confirme `emergency_stop = true` ;
5. exécuter `NORVA_EDGE_QUIESCED_DEPLOY=1 bash ops/hetzner/scripts/04-deploy-edge-functions.sh` pour publier `norva-cloud`, `norva-lifecycle`, `norva-admin` et le worker email durable `norva-branded-email-worker` avec les autres fonctions montées ;
6. capturer la preuve dormante avec `capture-behavioral-lifecycle-dormant-evidence.sh` dans un répertoire sécurisé hors dépôt, puis exécuter `node scripts/validate-behavioral-lifecycle-dormant-evidence.js <artefact.json>` : elle lie le commit, les deux migrations, les quatre fonctions et leurs cinq dépendances partagées montées sur chaque réplique, ainsi que le gate DB, mais le collecteur et le validateur imposent tous deux `pilot_eligible = false` ;
7. publier le Web sans activer les parcours ;
8. construire et publier l’application Android qui remonte permission, fuseau et reçus ;
9. contrôler que les quatre parcours sont `draft`, rollout `0`, sans outbox inattendue ;
10. ouvrir le runtime en mode `internal_test`, activer un seul parcours et créer un compte de test frais après cette activation ;
11. tester les quatre parcours avec uniquement des comptes internes explicitement marqués, puis exécuter sur le commit et l'artefact Android exacts les scénarios M3U, Xtream, catalogue synthétique d'au moins 25 000 entrées, guidage d'erreur et WebView Android ;
12. enregistrer l'attestation append-only avec la confirmation exacte `VERIFY IMPORT READINESS` ; aucune URL, valeur de paramètre, identité ni secret ne doit être joint ;
13. repasser par le coupe-circuit, puis demander une autorisation distincte avant d'ouvrir le mode `pilot` et d'activer séparément Inde/Bangladesh à 10 % ;
14. observer au moins sept jours, puis augmenter à 50 % et 100 % seulement si les seuils et garde-fous sont respectés.

Le script Hetzner refuse désormais tout redémarrage Edge si une relation ou une signature RPC critique du moteur manque, si l’unique ligne runtime n’est pas sous arrêt d’urgence, si les quatre fonctions ou leurs dépendances partagées FCM/Resend/email/projection montées ne correspondent pas aux sources attendues, ou si les marqueurs de protocole exposés par `norva-cloud` et `/norva-lifecycle/health` divergent. En mode quiescent, il résout le conteneur PostgreSQL exact de Compose puis réexécute automatiquement le gate complet de préactivation en lecture seule avant de recréer la moindre réplique Edge. Ces contrôles ferment la fenêtre ancien code/nouveau schéma ; ils ne remplacent pas les validations fonctionnelles de staging ci-dessous.

## Validation avant production

À exécuter sur une base de staging réaliste :

- inscription puis source dans la même session ;
- aucune tentative ;
- M3U, Xtream et catalogue de plus de 25 000 entrées ;
- erreurs 400, 404, 413, 422, timeout et fournisseur indisponible ;
- conversion entre claim et transport ;
- première lecture et reprise ;
- permission acceptée, refusée puis révoquée ;
- consentement email absent puis retiré ;
- appareil hors ligne, changement de fuseau et session expirée ;
- deux workers concurrents et rejeu d’un même job ;
- vérification TalkBack, Android Back, tailles tactiles et navigation WebView.

### Matrice de traçabilité de la validation obligatoire

| Scénario obligatoire | Preuve automatisée locale | Résultat | Validation restant en staging ou sur appareil réel |
|---|---|---|---|
| Inscription puis ajout de source dans la même session | `tests/sql/behavioral-lifecycle.integration.sql` crée l’état `no_source`, enregistre la tentative, prouve l’annulation de la relance et retire sa carte in-app obsolète tout en conservant l’audit | Réussi | Rejouer avec Auth, WebView et base Norva de staging |
| Absence totale de tentative | intégration PostgreSQL : cohorte, éligibilité, groupe témoin et planification sans historique rétroactif | Réussi | Confirmer les volumes sur un clone de données réelles |
| M3U valide, Xtream valide et grosse playlist | suite Node complète, contrats Xtream existants et `tests/m3u-large-playlist.test.js` avec plus de 25 000 entrées | Réussi localement | Tester un accès interne M3U et Xtream réel sans journaliser ses secrets |
| 400, 404, 413, 422, timeout et fournisseur indisponible | contrats de classification/télémétrie et projection SQL des douze familles bornées | Réussi | Provoquer les réponses sur un fournisseur de test contrôlé |
| Import réussi entre éligibilité et envoi | intégration PostgreSQL : job réclamé, conversion, réautorisation finale et transport jamais démarré | Réussi | Observer la même course avec le worker Edge réel |
| Catalogue prêt puis première lecture | intégration PostgreSQL : entrée, étapes et annulation à `first_play` | Réussi | Vérifier les événements réels Web et Android |
| Lecture interrompue puis reprise | intégration PostgreSQL et contrats du lien `/app.html#home/resume`, résolu côté propriétaire après authentification | Réussi | Vérifier la reprise à la position réelle sur téléphone |
| États bruts chevauchants entre parcours | intégration PostgreSQL : `import_unresolved` et `continue_watching` vrais simultanément, priorité au parcours amont et annulation du rappel inférieur déjà en attente | Réussi | Confirmer les volumes agrégés sans exposer d’identifiant sur un clone de staging |
| Plafonds globaux, priorité et cooldown | intégration PostgreSQL : maxima inter-parcours 1 push/24 h, 3/7 jours, 2 emails/7 jours, message opérationnel réclamé avant le marketing et nouveau déclencheur reporté de 7 jours | Réussi | Observer les reports et l’ordre de claim avec les workers Edge de staging |
| Expérience 24 h, 72 h et 7 jours | intégration PostgreSQL : quatre comptes non internes, traitement/témoin, conversions avant/après 24 h, maturité stricte, version courante, écarts absolus et compteurs de sûreté | Réussi | Attendre la maturation de vraies cohortes pilote avant toute conclusion statistique |
| Une seule variable expérimentale | intégration PostgreSQL : snapshot baseline immuable, changement de délai seul accepté, variable déclarée incohérente rejetée, délai + texte rejetés sans incrémenter la version | Réussi | Vérifier que le premier changement pilote correspond au plan approuvé et à une seule famille |
| Attribution essai/abonnement | intégration PostgreSQL : un essai sans coordonnées client reprend la dernière affectation bornée des sept jours précédents, avec parcours, livraison et bras exacts | Réussi | Vérifier l’événement de facturation réel en staging puis dans les agrégats J+7/J+14 |
| Permission push acceptée, refusée puis révoquée | intégration SQL, politique Android JVM et instrumentation API 35 ; aucun reçu `delivered` si l’affichage local est interdit | Réussi localement | Valider la boîte système et Firebase sur un téléphone réel |
| Frontière HTTP FCM | `tests/fcm-transport-boundary.test.js` simule OAuth et FCM sans réseau : payload data-only exact, TTL borné, collapse canonique, libellé analytique, cache OAuth, acceptation fournisseur, jeton `UNREGISTERED` et quota 429 | Réussi localement, sans envoi | Réaliser un envoi interne autorisé et vérifier réception/ouverture sur Firebase et Android |
| Frontière HTTP Resend | `tests/resend-transport-boundary.test.js` exécute le module réellement appelé par le worker : requête multipart figée, clé d’idempotence, 2xx avec identifiant, 2xx ambigu, 429 avec diagnostic expurgé et timeout | Réussi localement, sans envoi | Réaliser un email interne autorisé, vérifier livraison puis désinscription réelle |
| Consentement email absent puis retiré | intégration PostgreSQL : suppression à la réautorisation finale après claim, annulation du brouillon plus récent et attribution du désabonnement au dernier email marketing dont le transport a commencé | Réussi | Vérifier un transport Resend interne et la désinscription réelle |
| Téléphone hors ligne plusieurs jours | intégration PostgreSQL : report, dépassement du TTL et annulation `ttl_expired` sans transport | Réussi | Rejouer avec un téléphone hors ligne puis reconnecté |
| Changement de fuseau horaire | intégration PostgreSQL : nouvelle zone lue après claim et report aux heures autorisées | Réussi | Vérifier le fuseau remonté par Android après changement système |
| Déconnexion avant ouverture du lien profond | contrat Node du trajet application → authentification → `returnTo`, avec chemin, requête bornée et fragment conservés | Réussi localement | Rejouer contre l’authentification hébergée |
| Rejeu d’un job et deux workers concurrents | intégration et concurrence PostgreSQL : idempotence, leases distinctes et une seule réclamation par ligne | Réussi | Exécuter sous la configuration de pool du staging |
| Accessibilité et navigation Android | Playwright bureau/mobile, cibles de 44 px, absence de débordement, Android Back et tests instrumentés API 35 | Réussi automatiquement | Contrôle manuel TalkBack, clavier, IME et navigation système sur appareil réel |

La matrice démontre la logique locale et les courses critiques. Les cases de la dernière colonne restent des portes de production : elles ne doivent pas être assimilées à une preuve de transport réel ou à une validation utilisateur.

## Retour arrière

1. Déclencher immédiatement `EMERGENCY STOP` dans le centre Marketing.
2. Mettre ensuite tous les parcours en `paused`.
3. Vérifier que les lignes `pending`, `processing` non démarrées et `email_queued` sont annulées et expurgées.
4. Laisser uniquement les transports déjà acceptés terminer leur journalisation.
5. Désactiver le cron du worker si une anomalie globale persiste.
6. Ne jamais supprimer l’historique d’audit pour masquer un incident.
7. Réactiver seulement avec une nouvelle version de configuration, une nouvelle date de cohorte et les confirmations typées requises.

## État de validation de cette préparation

- suite Node complète sur le dernier `origin/main` : 3 512 tests, 3 504 réussis, 0 échec et 8 ignorés faute de dépendances média locales ; les empreintes canoniques `AdminPage.js → app.js → app.html`, calculées après normalisation des fins de ligne, ont été recalculées puis la suite complète a été rejouée avec un code de sortie nul ;
- contrats ciblés moteur, Marketing, emails, push, invalidation FCM, liens profonds, onboarding et garde-fous front inclus dans la suite complète ; sélection focalisée lifecycle/FCM/Resend couvrant moteur, expérimentation, onze copies approuvées, précontrôle administrateur, CTA email contextuel, transports simulés, collapse canonique, retrait in-app après conversion, préflight, gate préactivation, preuve dormante et portes de validation indépendantes : 61/61 réussis ;
- syntaxe des modules JavaScript modifiés : valide avec `node --check` ;
- parsing PostgreSQL externe avec `pglast` : 234 instructions et 215 236 octets UTF-8 acceptés ;
- exécution réelle sur une base jetable PostgreSQL 16.15 : bootstrap de compatibilité, migration complète avec commit, validation positive des onze copies, rejets d’URL/secret/paiement/fraîcheur/destination, scénarios transactionnels, chevauchement inter-parcours, plafonds globaux, priorité opérationnelle, cooldown, attribution essai/désabonnement, cohortes matures 24 h/72 h/7 jours, snapshots expérimentaux immuables, rejet des changements multivariés, décisions J+7/J+14, scénarios concurrents et porte de préparation import réussis. Cette dernière refuse une preuve absente ou échouée, accepte une preuve réussie, reste idempotente pour le même SHA, refuse le rebinding d'un digest et cesse d'autoriser une cohorte pilote après quatorze jours ;
- concurrence PostgreSQL : quatre messages réclamés une seule fois par deux workers, répartis 2 + 2, avec quatre jetons de lease distincts et `attempt_count = 1` ;
- scripts de preuve : `tests/sql/behavioral-lifecycle.bootstrap.sql`, `tests/sql/behavioral-lifecycle.integration.sql`, `tests/sql/behavioral-lifecycle.concurrency.sql` et le contrôle opérateur `ops/hetzner/tests/behavioral_lifecycle_pre_activation_readiness.sql` ;
- bundling des quatre fonctions Edge concernées (`norva-cloud` : 462 653 octets, `norva-lifecycle` : 60 270 octets, `norva-admin` : 69 570 octets, `norva-branded-email-worker` : 17 384 octets) : réussi avec esbuild en externalisant les imports Deno `npm:` et `jsr:` ; syntaxe Bash du script de déploiement : valide avec `bash -n` ;
- préflight de déploiement exécuté sur une base PostgreSQL 16.15 jetable après bootstrap et migration complète : les dix relations et quinze signatures RPC exactes ont toutes été résolues (`contract = true`), l’unique runtime était sous arrêt d’urgence (`stopped = true`), puis la base de contrôle a été supprimée ;
- gate pré-activation exécuté par son vrai script sur PostgreSQL 16.15 : état sain accepté avec `BEHAVIORAL_LIFECYCLE_PRE_ACTIVATION_READY`, y compris fonction/grants/contraintes de copie et onze modèles exacts, puis état volontairement dangereux `emergency_stop = false` refusé. La transaction du gate et la session sont en lecture seule ; son SQL séparé contient 4 instructions et 16 377 octets UTF-8, et les bases jetables ont été supprimées ;
- collecteur `capture-behavioral-lifecycle-dormant-evidence.sh` : syntaxe Bash et deux blocs Python valides, refus sûr sans paramètres, sortie atomique mode `600` dans un répertoire externe mode `700`, inspection Docker limitée à cinq champs non sensibles sans copie de `Config.Env`, empreintes des deux migrations, des quatre fonctions et des cinq dépendances partagées sur toutes les répliques. L’artefact réel n’est pas encore produit, car il doit être capturé sur le checkout déployé et reste explicitement insuffisant pour rendre un pilote éligible ;
- validateur indépendant `validate-behavioral-lifecycle-dormant-evidence.js` : schéma fermé, JSON canonique, fichier non symbolique borné, mode `600` sous Unix, compte et parité des répliques, couverture exacte des neuf fichiers runtime, gate DB arrêté et liste complète des preuves encore manquantes. Les cas positifs staging/production et les falsifications d’éligibilité, de PII, de runtime, de source et de portes ont été testés ;
- validateur final `validate-behavioral-lifecycle-completion-evidence.js` : schéma fermé et sans autorité d'action, preuve des sept portes, chronologie staging/interne/pilote/J+14, mapping Hetzner/GA4/Firebase, six garde-fous à zéro, seuils de désinscription/rejet et gains des trois parcours recalculés à partir des effectifs. Ses trois tests couvrent l'artefact positif, quatorze falsifications et l'encodage canonique ; aucun artefact réel n'est encore disponible ;
- build Gradle final avec Gradle 8.13, SDK Android local et `JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:/norva-jdk-sockets` pour contourner le défaut de sélecteur Unix-domain du JDK sous Windows : réexécution forcée des tests JVM et de l'assemblage réussie, 39/39 tâches exécutées ; `lintDebug` forcé réussi sur 27/27 tâches ; régression instrumentée réussie séparément sur 61 tâches, dont 3 exécutées et 58 à jour ;
- tests JVM Android : 27/27 réussis dans 7 rapports, sans échec ni test ignoré, dont la politique d’affichage après révocation de permission globale ou désactivation du canal ;
- parcours navigateur Playwright : 12/12 réussis sur Chromium bureau (1 280 × 800) et profil Android mobile (412 × 915). Les scénarios montent les vraies classes `AdminPage` et `SourceManager`, interceptent toute RPC d’écriture, vérifient les quatre parcours, le coupe-circuit, les confirmations typées, les plans et décisions d'expérience, les comparaisons 24 h/72 h/7 jours, les garde-fous, les échéances J+7/J+14, les liens profonds bornés, l’absence de contexte sensible, les cibles de 44 px et l’absence de débordement horizontal. Le rendu vérifie aussi qu’un domaine externe désactive l’enregistrement, marque le titre invalide et produit une annonce accessible, puis que la correction réactive le bouton ; les destinations inutiles et le contrôle de fraîcheur hors parcours sont absents. Deux scénarios couvrent enfin l'attestation de préparation import absente puis son payload exact M3U/Xtream/gros catalogue/guidage/WebView, et deux scénarios forcent l’échec du rafraîchissement après des RPC confirmées afin de prouver que la sauvegarde de modèle, le coupe-circuit, l’activation et le rejeu DLQ conservent leur état réellement validé, annoncent l’avertissement séparément et n’émettent chaque mutation qu’une fois. Les captures sont sous `output/playwright/behavioral-lifecycle-initial-*.png`, `output/playwright/behavioral-lifecycle-typed-gate-*.png` et `output/playwright/behavioral-lifecycle-post-commit-refresh-*.png` ;
- tests instrumentés Android API 35 : 7/7 réussis sur l’AVD `Norva_API35`, dont la canonicalisation stricte des liens de cycle de vie, le rejet des origines/paramètres/fragments et faux identifiants de livraison non autorisés, ainsi que la file locale de reçus dédupliquée. Cette exécution a détecté puis fait corriger l’encodage `%2F` des séparateurs de route avant la réussite finale ;
- APK debug de contrôle reconstruit après la passe JVM forcée : 20 945 022 octets, SHA-256 `f653b9474a3ff84e6750b002aa66d77a9c276b38a5eb10b0ce796cf9ecdf7960` ;
- ADB local : une construction debug du même périmètre source a été installée et exercée par les 7 tests instrumentés sur l’émulateur API 35 en lecture seule, sans échec. Cette preuve instrumentée est distincte du hash de l'APK reconstruit ci-dessus. Un lancement à froid d’une construction intermédiaire avait aussi confirmé l’absence de `FATAL EXCEPTION` et d’ANR ; le WebView de cet AVD n’avait toutefois pas chargé `norva.tv` malgré la résolution DNS et la connectivité ICMP, et une signature debug n’est pas une preuve de vérification App Links en production ;
- aucun téléphone réel n’est détecté : les preuves FCM/email, consentement/permission, ouverture de notification, reprise réelle et annulation après conversion restent absentes ;
- rendu avec données réelles après migration : non réalisé ;
- déploiement dormant : autorisé mais non encore réalisé dans cette photographie ; activation et messages réels : non autorisés.

La validation PostgreSQL locale prouve désormais le SQL, les fonctions PL/pgSQL, les triggers, les verrous, l’attribution et les principaux scénarios de course dans un schéma de compatibilité. Elle ne remplace pas la parité de schéma, les extensions, les secrets ni les transports d’un staging Norva réel. La validation staging doit donc rester bloquante : appliquer la migration dans une base clone, exécuter les scénarios avec les tables et données réelles, monter l'interface Marketing sur ces données, tester un vrai transport FCM et email interne, puis installer une build Android sur un appareil ADB pour vérifier permission, notification reçue, ouverture du lien profond, reçus, reprise et annulation après conversion. Le pilote ne peut commencer qu'après ces preuves et doit démarrer par `internal_test`, jamais directement par `pilot`. Les rapports J+7/J+14 ne sont pas encore produits : leur mécanisme et leur statut de maturité sont prêts, mais leurs résultats exigent l’autorisation du pilote et l’écoulement réel du temps. Les décisions d’extension devront ensuite s’appuyer sur ces agrégats matures.
