# Phase 0 — Plan de migration additif Provider Access Lifecycle

Statut : plan uniquement, aucune migration SQL créée ou appliquée.

Principe directeur : tout est ajouté avec les flags OFF. Une phase ne commence que lorsque les preuves de sortie de la phase précédente sont archivées. Un déploiement de schéma n’active jamais à lui seul un comportement utilisateur.

## 1. Point de départ et risques à contenir

Le modèle actuel associe configuration active, catalogue et source_id :

- update remplace directement le ciphertext actif : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-cloud\index.ts:1357-1417 ;
- Xtream écrit B au fil de l’eau dans les lignes de A : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\_shared\xtream-sync.ts:296-338 ;
- un prune risqué conserve A+B : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\_shared\xtream-sync.ts:805-830 ;
- M3U supprime A avant d’écrire B : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-source-sync\index.ts:2790-2803 ;
- plusieurs lecteurs accèdent directement aux tables sans lifecycle central : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-cloud\index.ts:2420-2440 et C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-catalog\index.ts:2814-2858 ;
- playback ne filtre ni staging, ni deleted, ni enabled lors du chargement de config : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-playback\index.ts:6105-6140.

La migration doit d’abord créer l’isolation et les invariants, puis les workflows.

## 2. Flags obligatoires

Tous les flags sont créés ou configurés avec la valeur effective OFF, y compris lorsque la lecture de configuration échoue :

- provider_catalog_visibility_abstraction_v1_enabled
- provider_source_transitions_v1_enabled
- provider_access_v1_enabled
- provider_access_auto_detection_v1_enabled
- provider_access_notifications_v1_enabled
- provider_access_visibility_v1_enabled
- provider_credential_transition_v1_enabled
- provider_replacement_v1_enabled

Les flags de livraison email, push et in-app restent eux aussi séparés et OFF jusqu’à leurs phases respectives.

L’ordre d’activation suit exactement les phases 0 à 16 de la section 5. Un flag aval ne peut être ON si son flag amont ou son gate de données est OFF.

**Interdiction de séquence : aucun rappel, enqueue de notification, email, push ou message in-app Provider Access avant que la Phase 5 E2E A vers B soit totalement verte.** Le code et le schéma d’outbox peuvent être préparés plus tard en Phase 11, jamais activés par anticipation.

## 3. Architecture de données cible à confirmer

Le plan est additif. Les noms définitifs restent à valider lors de la revue de schéma.

### 3.1 Snapshot et cycles d’accès

- table 1:1 de snapshot provider access par source ;
- cloud_source_access_cycles pour les périodes successives ;
- provenance de date : user_entered, provider_reported ou inferred ;
- statut courant séparé de sync_status ;
- une seule période active par source ;
- préférences de rappels séparées de la preuve d’expiration.

Le backfill initialise UNKNOWN. Il ne transforme jamais une date de config_hint en expiration confirmée.

### 3.2 Lifecycle et transitions

Le modèle cible défini dans C:\Users\AdrienHernandez\Documents\Norva repo\docs\audits\provider-access-lifecycle-2026-08-22\04-final-data-model.md:59-202 est la référence :

- cloud_source_lifecycle, service-owned, porte lifecycle_state, catalog_visibility, replacement_root_id, liens A/B, state_version, rollback_until et purge_after ;
- cloud_source_transitions porte A, B, état, décision d’identité, readiness, versions attendues, compteurs bornés, fenêtre de rollback et idempotence ;
- cloud_source_identity_assessments porte les preuves versionnées et la décision SAME_CATALOG, DIFFERENT_CATALOG ou AMBIGUOUS ;
- cloud_source_lifecycle_events est append-only.

Le contrat API expose deux projections métier, « candidat d’identifiants » et « remplacement », mais leur stockage peut partager cloud_source_transitions. Le schéma de Phase 2 doit distinguer explicitement le genre de transition et interdire les transitions incohérentes.

Pour un candidat même catalogue, la configuration candidate chiffrée, son key_id/purpose, la révision active attendue et le snapshot de rollback restent service-only. Le swap conserve le même source_id.

Pour un remplacement, la transition référence A et une vraie source B staging/hidden. Elle porte également l’état du remapping des données utilisateur et les générations de workers. Une contrainte garantit un seul remplacement non terminal par A.

Ni les secrets candidats ni les snapshots de rollback n’apparaissent dans une projection utilisateur.

### 3.3 États internes et projections API

Les états DB restent ceux du modèle final :

- lifecycle : staging, ready_to_switch, active, replaced, failed, cancelled, purge_pending, purged ;
- transition : VALIDATING, STAGING, IMPORTING, READY_TO_SWITCH, COMMITTING, COMPLETED, FAILED, CANCELLED.

La machine de transition est canonique et partagée par les candidats et remplacements. SAME_CATALOG, DIFFERENT_CATALOG et AMBIGUOUS sont des décisions d’identité, pas des états.

Le rollback est une opération compensatrice idempotente et un événement append-only :

- avant COMPLETED, la compensation rétablit A avant un terminal FAILED ou CANCELLED ;
- après COMPLETED, la transition d’origine reste COMPLETED et l’événement ROLLBACK_APPLIED porte la preuve de l’inversion ;
- aucun état ROLLED_BACK ou synonyme ne doit être ajouté.

Un état DB inconnu ne peut jamais être traité comme READY_TO_SWITCH.

### 3.4 Staging

La décision de C:\Users\AdrienHernandez\Documents\Norva repo\docs\audits\provider-access-lifecycle-2026-08-22\03-staging-isolation-adr.md:10-26 s’applique :

- Option A retenue uniquement après création et preuve d’une abstraction centrale fail-closed ;
- B est alors une vraie cloud_source staging/hidden, et les tables source-scopées peuvent être utilisées ;
- tant qu’un lecteur, rollup, cache, fleet ou projection non source-scopée échappe au prédicat, la création de B dans les tables actives reste NO-GO ;
- si l’inventaire ne peut pas être fermé, fallback obligatoire vers l’Option B physiquement séparée avec promotion par pointeur/génération.

Dans les deux cas, une copie massive de dizaines de milliers de lignes dans la transaction de promotion est exclue ; la bascule doit rester O(1) sur les lignes de contrôle.

### 3.5 Idempotence et événements

- registre d’idempotence sans secrets en clair ;
- journal append-only des transitions et décisions ;
- événements de notifications liés au cycle d’accès ;
- payloads allowlistés ;
- unicité par cycle + kind, pas seulement source + kind.

L’outbox import existante fournit un modèle de leases, retries, Resend et DLQ : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-import-notify\index.ts:255-430. Son unicité actuelle source_id + kind ne suffit pas aux cycles Provider Access : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\_shared\xtream-sync.ts:69-97.

Ces objets de notification ne sont créés qu’en Phase 11, après le gate bloquant de Phase 5. Leur présence dans l’architecture cible n’autorise aucun enqueue anticipé.

## 4. Invariants DB requis

Avant toute activation :

- enums/status contrôlés par CHECK ;
- expires_on supérieur ou égal à started_on ;
- une seule période active ;
- une seule transition candidate appliquable ;
- un seul remplacement pending ;
- STAGING implique invisible et non jouable ;
- REPLACED implique invisible ;
- COMPLETED ne redevient jamais pending ;
- source_revision augmente à chaque mutation pertinente ;
- B staging ne compte pas comme source commerciale, mais reste liée un-à-un à A ;
- la promotion vérifie le quota dans la transaction ;
- aucune policy ne permet à un utilisateur de changer user_id, ciphertext, lifecycle, visibilité ou révision.

Le contrôle de quota actuel n’est pas atomique : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-cloud\index.ts:863-905. Le nouvel invariant doit être DB-side.

## 5. Phases strictes

L’ordre ci-dessous est impératif. Il est interdit de fusionner, permuter ou sauter une phase. Les ajouts de schéma restent additifs, les flags restent OFF par défaut et les incidents se corrigent en avant.

### Phase 0 — Audit complet

Actions :

- figer les livrables Phase 0 et le contrat API v1 ;
- cartographier cloud_sources, catalogues, identités, history, favorites, EPG, fleets, caches et aliases ;
- définir les jeux A/B : disjoints, overlap, vide, timeout, A plus grand que B et inversement ;
- archiver les limites live.

Gate :

- cycle de vie actuel documenté ;
- inventaire des lectures/écritures fermé ;
- aucun code produit, migration ou mutation live.

Rollback : documentation seulement.

### Phase 1 — Abstraction de visibilité, flag OFF

Actions :

- créer la règle serveur centrale active + visible + enabled + not deleted ;
- migrer en shadow Home, Live, Movies, Series, Search, Recommendations, Continue Watching, Favorites, History, EPG, source picker, playback, caches, fleets et vues admin ;
- corriger le décalage enabled versus sync_status ;
- garder provider_catalog_visibility_abstraction_v1_enabled OFF.

Preuve du décalage : toggle écrit enabled dans C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-cloud\index.ts:1436-1445, tandis que le contexte catalogue raisonne notamment sur sync_status dans C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-catalog\index.ts:2517-2578.

Gate :

- matrice des surfaces à 100 % ;
- aucune lecture directe non justifiée ;
- source staging synthétique invisible partout ;
- vues/RPC et RLS validées sur clone.

Rollback :

- flag OFF ;
- conserver l’abstraction additive ;
- aucun staging réel avant gate vert.

### Phase 2 — Modèle de transitions

Actions :

- ajouter cloud_source_lifecycle, cloud_source_transitions, cloud_source_identity_assessments et événements ;
- ajouter lifecycle, visibilité, révisions CAS, contraintes et indices uniques partiels ;
- créer les primitives d’idempotence et les RPC promotion/rollback non exposées ;
- initialiser les sources historiques active/visible sans changer leur réponse ;
- garder provider_source_transitions_v1_enabled OFF.

Précautions Supabase :

- RLS sur toute table exposée ;
- ownership dans USING et WITH CHECK ;
- vues security_invoker ou non exposées ;
- RPC privilégiées avec search_path fixe et EXECUTE révoqué à PUBLIC ;
- aucun service_role dans un client.

Gate :

- migration répétable sur clone ;
- aucune source historique cachée ;
- invariants DB et concurrence validés ;
- advisors sans finding bloquant ;
- locks et tailles d’index mesurés.

Rollback :

- flags OFF ;
- conserver le schéma et l’audit ;
- forward-fix des contraintes/index, aucun drop en incident.

### Phase 3 — Nouveaux credentials, même catalogue

Actions :

- interdire l’ancien PATCH credentials ;
- créer candidat chiffré, validation gateway-only et comparaison non mutante ;
- gérer SAME_CATALOG, DIFFERENT_CATALOG et AMBIGUOUS ;
- safe swap CAS sur le même source_id ;
- conserver snapshot + génération ancienne jusqu’au premier refresh sain ;
- rollback automatique sur échec.

Gate :

- SAME_CATALOG prouvé ;
- DIFFERENT_CATALOG ne touche jamais A ;
- AMBIGUOUS exige une décision explicite ;
- aucun mélange, y compris overlap d’IDs et échec après batch ;
- cache invalidé par révision et worker tardif rejeté.

Rollback :

- provider_credential_transition_v1_enabled OFF ;
- annuler les candidats non appliqués ;
- restaurer snapshot/génération par CAS ;
- ne jamais rouvrir le PATCH historique.

### Phase 4 — Nouveau fournisseur

Actions :

- créer B staging/hidden ;
- importer et valider B ;
- appliquer décision d’identité ;
- promotion atomique A replaced/hidden, B active/visible ;
- soft-delete seulement après la fenêtre de rollback ;
- cleanup borné, reprenable et post-remapping.

Le reaper historique supprime des favoris et détache l’historique : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\migrations\20260707170000_reap_deleted_sources_raise_timeout.sql:16-71. Il reste interdit avant remapping prouvé.

Gate :

- B invalide, vide, timeout et partielle laissent A intacte ;
- B invisible pendant staging ;
- promotion O(1), CAS/idempotente et quota atomique ;
- history, favorites et progression préservés ;
- rollback avant purge opérationnel.

Rollback :

- provider_replacement_v1_enabled OFF ;
- annuler/figer B sans toucher A ;
- conserver A et B pour réconciliation ;
- cleanup staging uniquement après état terminal.

### Phase 5 — E2E Provider A vers B

Actions :

- exécuter le parcours complet avec erreurs injectées ;
- prouver A disponible avant switch ;
- prouver B invisible avant switch ;
- prouver B seule visible après switch ;
- prouver zéro mélange, rollback, quota, remapping et cleanup durable ;
- répéter sur web, Android phone et Android TV.

Gate bloquant :

- tous les cas E2E totalement verts ;
- aucun angle mort de visibilité ;
- aucune perte favoris/history/progression ;
- aucune notification Provider Access créée ou envoyée.

**STOP : ne pas continuer en Phase 6 tant que cette phase n’est pas totalement verte.**

Rollback :

- tous les flags transitions/remplacement OFF ;
- appliquer 07-rollback-plan.md ;
- conserver les preuves et corriger en avant.

### Phase 6 — Modèle Provider Access, sans notifications

Actions :

- ajouter snapshot et cloud_source_access_cycles ;
- initialiser UNKNOWN sans autorité de visibilité ;
- enregistrer dates et provenance ; le champ d’opt-in éventuel reste à false et n’est pas collecté avant la Phase 9 ;
- garder auto-detection, visibilité et notifications OFF.

Gate :

- une seule période active ;
- source d’échéance traçable ;
- aucune donnée brute fournisseur ;
- aucune notification/enqueue/claim.

Rollback :

- provider_access_v1_enabled OFF ;
- conserver cycles et audit ;
- aucune incidence catalogue.

### Phase 7 — Détection automatique Xtream

Actions :

- extraire et normaliser account info via gateway ;
- distinguer actif, expiration attendue, expiration confirmée, indisponibilité et erreur temporaire ;
- exécuter d’abord en shadow ;
- ne jamais écrire de réponse fournisseur complète.

Gate :

- erreur réseau/gateway classée temporaire ;
- date manuelle jamais convertie en expiration confirmée ;
- preuves allowlistées, versionnées et reproductibles.

Rollback :

- provider_access_auto_detection_v1_enabled OFF ;
- snapshot revient à UNKNOWN/CHECK_FAILED_TEMPORARY par CAS ;
- aucune visibilité modifiée.

### Phase 8 — Visibilité liée à l’accès

Actions :

- implémenter EXPECTED_EXPIRED, EXPIRED_CONFIRMED, ACCESS_UNAVAILABLE_CONFIRMED et hide/unhide ;
- garder la décision distincte de sync_status et enabled ;
- maintenir Settings/restauration accessibles ;
- canary interne seulement.

Gate :

- date manuelle et erreur temporaire ne masquent jamais ;
- confirmation fiable masque ;
- restauration ACTIVE réaffiche immédiatement, caches inclus ;
- source disabled/deleted ne se réactive pas.

Rollback :

- provider_access_visibility_v1_enabled OFF ;
- lever seulement hidden_reason provider_access ;
- préserver les autres causes de masquage.

### Phase 9 — Onboarding

Actions :

- collecter date, durée et opt-in rappels ;
- expliquer clairement fournisseur versus plan Norva ;
- ne créer aucune notification avant Phase 11.

Gate :

- dates calculées côté serveur ;
- opt-in explicite ;
- accessibilité et copies validées ;
- aucune régression création de source.

Rollback :

- masquer les nouveaux champs UI ;
- conserver données déjà saisies ;
- aucun effet sur visibilité ou livraison.

### Phase 10 — Settings

Actions :

- ajouter Provider Access et Restore catalog access ;
- exposer les trois parcours : prolongation, nouveaux credentials, nouveau fournisseur ;
- conserver les actions de restauration même si le catalogue est caché.

Gate :

- actions routées vers les endpoints v1 ;
- aucun fallback PATCH ;
- états loading, disabled, retry et terminal accessibles.

Rollback :

- flag UI OFF ;
- endpoints restent fail-closed ;
- aucune donnée supprimée.

### Phase 11 — Outbox notifications

Précondition absolue : Phase 5 entièrement verte.

Actions :

- créer queue, cron, leases, retries, idempotence, supersession et DLQ ;
- dédupliquer par access_cycle_id + event_kind + channel ;
- préparer les événements, delivery flag OFF.

Gate :

- deux crons sans doublon ;
- même Idempotency-Key après timeout ;
- cycle remplacé supersede les pending ;
- source supprimée/remplacée ou opt-out annule les pending ;
- aucun I/O externe.

Rollback :

- provider_access_notifications_v1_enabled OFF ;
- stopper claims ;
- supersede pending, conserver audit.

### Phase 12 — Email

Actions :

- activer email d’abord sur comptes internes explicitement autorisés ;
- utiliser Resend avec payload gelé et idempotency stable ;
- interdire serveur et credentials dans le contenu.

Gate :

- une livraison par cycle/kind ;
- ack ambigu réconcilié sans doublon ;
- opt-out et adresse courante respectés.

Rollback :

- flag email OFF ;
- aucun nouveau claim email ;
- conserver sent/DLQ et ne pas renvoyer aveuglément.

### Phase 13 — Push

Actions :

- brancher l’outbox sur FCM existant ;
- payload minimal et deep-link non sensible ;
- canal indépendant de l’email.

Gate :

- token absent/invalide classifié ;
- aucun secret ;
- idempotence et opt-out prouvés.

Rollback :

- flag push OFF ;
- supersede pending push ;
- email reste indépendant.

### Phase 14 — In-app

Actions :

- ajouter bannière et écran d’état ;
- lire les événements sanitisés ;
- fournir restore/dismiss sans mutation implicite.

Gate :

- pas de bannière pour erreur temporaire ;
- cohérence web/phone/TV ;
- focus, TalkBack et D-pad validés.

Rollback :

- flag in-app OFF ;
- aucun changement du snapshot métier.

### Phase 15 — Analytics et dashboard

Actions :

- mesurer funnel, transitions, échecs, rollback, notifications et temps de restauration ;
- dashboard agrégé sans host, username, URL ou payload fournisseur ;
- définir seuils de pause rollout.

Gate :

- métriques allowlistées ;
- cardinalité et rétention bornées ;
- alertes opérationnelles testées.

Rollback :

- collecte nouvelle OFF ;
- conserver l’audit métier minimal ;
- aucun impact fonctionnel.

### Phase 16 — Rollout

Ordre strict :

    interne
    → 1 %
    → 5 %
    → 20 %
    → 50 %
    → 100 %

Chaque palier exige une fenêtre d’observation, zéro invariant violé, taux d’échec/rollback sous seuil et validation explicite. Aucun passage automatique.

Rollback :

- revenir au palier précédent ou flags OFF ;
- ne pas down-migrer ;
- conserver transitions, audit et catalogues rollbackables ;
- forward-fix avant reprise.

## 6. Matrice de validation minimale

| Axe | Cas obligatoires |
|---|---|
| Identité | même catalogue, différent, ambigu, overlap d’IDs, même host différent catalogue |
| Import | vide, timeout, erreur après batch, A plus grand que B, B plus grand que A |
| Concurrence | deux candidats, deux remplacements, create concurrent au quota, ancien worker tardif |
| API | replay même clé, clé réutilisée avec autre payload, If-Match absent/périmé |
| Visibilité | toutes surfaces, cache chaud/froid, source disabled/deleted/replaced/staging |
| Données utilisateur | favoris, historique, progression avant/pendant/après switch et rollback |
| Notifications | crons parallèles, cycle superseded, source supprimée, Resend ambigu |
| Sécurité | RLS cross-tenant, projection sans ciphertext, logs et erreurs sans secrets |
| Plateformes | web, Android phone, Android TV, navigation Back et états hors ligne |

## 7. Limites live

Phase 0 n’a pas vérifié :

- le schéma ou les volumes de la base live ;
- les versions Postgres/Supabase réellement déployées ;
- les grants, RLS et fonctions SECURITY DEFINER live ;
- le coût de backfill, les locks et la réplication ;
- les versions Edge actives ;
- les secrets Vault, cron et workers live ;
- Resend/FCM réels ;
- une promotion A vers B ;
- la préservation live de favoris/historique ;
- les caches multi-isolates après révision.

Aucun déploiement, migration, message, notification ou mutation live n’est inclus dans ce plan.

Références de besoin : C:\Users\AdrienHernandez\.codex\attachments\fa42029c-5545-4451-9a09-3a29d86d014d\pasted-text-1.txt:672-883, :952-1043, :1640-1662, :1789-1928 et :1963-2100.
