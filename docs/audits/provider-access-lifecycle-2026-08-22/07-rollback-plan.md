# Phase 0 — Plan de rollback Provider Access Lifecycle

Statut : runbook proposé, non exercé en production.

Objectif : revenir à un état sûr sans détruire de catalogue ni réintroduire le PATCH direct des credentials. Le rollback est d’abord un arrêt par flags, puis un forward-fix. Les down migrations et suppressions immédiates sont exclues pendant un incident.

## 1. Principes

1. Couper l’entrée avant de réparer l’état.
2. Ne jamais supprimer A pour réparer B.
3. Ne jamais réutiliser une réponse réseau ambiguë comme preuve d’échec.
4. Lire l’état transactionnel par transition_id avant toute nouvelle action.
5. Réutiliser la même Idempotency-Key pour rejouer la même intention.
6. Toute restauration de configuration utilise CAS et augmente source_revision.
7. Les workers tardifs doivent échouer par génération/lease/CAS.
8. Les tables et événements additifs sont conservés pendant l’incident.
9. Aucun secret n’est copié dans un ticket, log ou commande opérateur.
10. Après la fenêtre de rollback, préférer un nouveau candidat ou remplacement à une inversion destructive.

## 2. Pourquoi un rollback explicite est nécessaire

L’existant ne fournit pas de point de retour sûr :

- l’update écrase le ciphertext actif avant le refresh : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-cloud\index.ts:1387-1415 ;
- les items B sont visibles sous le source_id A pendant l’import : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\_shared\xtream-sync.ts:296-338 ;
- un échec/prune dangereux conserve A+B : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\_shared\xtream-sync.ts:805-830 ;
- M3U effectue un delete-first : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-source-sync\index.ts:2790-2803 ;
- la config playback peut rester en cache 60 secondes : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-playback\index.ts:6105-6129 ;
- le reaper peut supprimer les favoris et détacher l’historique : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\migrations\20260707170000_reap_deleted_sources_raise_timeout.sql:16-71.

Le nouveau workflow doit donc conserver l’ancienne configuration et l’ancienne génération jusqu’à vérification.

## 3. Niveaux d’arrêt

### Niveau 1 — Kill switches fonctionnels

Ordre recommandé :

1. provider_access_visibility_v1_enabled OFF ;
2. provider_replacement_v1_enabled OFF ;
3. provider_credential_transition_v1_enabled OFF ;
4. provider_access_notifications_v1_enabled OFF ;
5. provider_access_auto_detection_v1_enabled OFF ;
6. provider_access_v1_enabled OFF si le snapshot lui-même est en cause.

Chaque flag OFF bloque de nouvelles opérations. Il ne supprime aucune ligne et ne réactive pas le PATCH historique.

### Niveau 2 — Gel des workers

- ne plus créer de claims ;
- laisser les requêtes déjà parties terminer, mais refuser leurs écritures si lease/generation/revision n’est plus courante ;
- ne pas tuer un worker en supposant qu’il n’a rien écrit ;
- relever les transitions COMMITTING et les réponses réseau ambiguës ;
- stopper cleanup et reaper liés aux transitions.

### Niveau 3 — Réconciliation

- charger source, transition, révisions, génération active, liens A/B et journal ;
- déterminer l’état DB, pas l’état perçu par le client ;
- choisir le rollback spécifique ci-dessous ;
- écrire un événement de décision sanitisé ;
- invalider caches et reprendre uniquement les jobs autorisés.

## 4. Rollback Provider Access

### Métadonnées ou détection incorrectes

Action :

- mettre auto-detection OFF ;
- conserver les snapshots de preuve ;
- repasser le snapshot courant à UNKNOWN ou CHECK_FAILED_TEMPORARY par une correction CAS auditée ;
- ne pas modifier sync_status ;
- ne pas effacer les dates saisies par l’utilisateur.

### Masquage erroné

Action :

- mettre visibility OFF ;
- lever seulement hidden_reason = provider_access ;
- préserver enabled=false, deleted_at et les restrictions plan existantes ;
- invalider immédiatement les caches catalogue/playback ;
- vérifier Settings, Home, Search et playback.

Une date manuelle dépassée ou une erreur temporaire ne doit jamais être « réparée » en écrivant une fausse confirmation ACTIVE ou EXPIRED.

### Notifications

Action :

- mettre notifications OFF ;
- arrêter les nouveaux claims ;
- marquer les pending du cycle concerné superseded ;
- laisser sent et dead-letter intacts pour audit ;
- ne pas rappeler un email déjà accepté par Resend si l’ack DB est ambigu ;
- reprendre avec le même delivery/idempotency key après réconciliation.

## 5. Rollback d’un candidat même catalogue

| État | Action sûre | État de A |
|---|---|---|
| VALIDATING | CANCELLED, révoquer le lease, programmer l’effacement du candidat selon rétention. | Inchangé. |
| STAGING | CANCELLED par utilisateur ou opérateur ; secret candidat isolé. | Inchangé. |
| IMPORTING | Stopper la génération candidate et la nettoyer par batches. | Ancienne config et génération actives. |
| READY_TO_SWITCH | CANCELLED ou maintien borné ; aucun swap actif. | Inchangé. |
| COMMITTING | Lire la transition. Si le swap a eu lieu mais que le refresh échoue ou révèle un autre catalogue, restaurer snapshot + génération par CAS avant de terminer FAILED. | Même source_id, ancienne config et ancien catalogue. |
| COMPLETED dans la fenêtre de rollback | Opération compensatrice interne utilisant le snapshot conservé ; la transition reste COMPLETED et un événement ROLLBACK_APPLIED est écrit. | Restaurée après refresh de contrôle. |
| COMPLETED après la fenêtre | Forward-fix : nouveau candidat ou remplacement. | Ne pas inverser automatiquement. |
| FAILED ou CANCELLED | Nettoyage asynchrone du candidat uniquement. | Inchangé. |

Conditions d’une compensation pendant COMMITTING :

- snapshot ancien présent et déchiffrable avec key_id connu ;
- source_revision égale à la révision attendue ;
- aucune transition plus récente ;
- ancienne génération intacte ;
- opération idempotente ;
- nouvelle source_revision publiée ;
- caches invalidés par révision, pas seulement par TTL.

Si l’ancien accès est expiré, restaurer les données et la configuration ne signifie pas rendre le catalogue visible. L’état d’accès décide séparément de la visibilité.

## 6. Rollback d’un remplacement A vers B

| État | Action sûre | Garantie |
|---|---|---|
| VALIDATING | CANCELLED ; supprimer plus tard les secrets B selon rétention. | A intact. |
| STAGING ou IMPORTING | Couper le lease, CANCELLED, cleanup B par batches. | A reste seul actif/visible. |
| READY_TO_SWITCH | CANCELLED ou garder en attente bornée. | A intact ; B invisible. |
| COMMITTING avec réponse HTTP ambiguë | GET transition et journal ; replay uniquement avec la même Idempotency-Key. | La transaction doit montrer soit A actif, soit B actif, jamais les deux. |
| COMPLETED dans la fenêtre de rollback | Reverse promotion transactionnelle contrôlée ou forward promotion d’une version réparée, selon trafic utilisateur. Conserver les deux catalogues. | Aucun delete préalable. |
| COMPLETED après la fenêtre | Forward-fix par nouvelle transition. | Pas de down-switch automatique. |
| FAILED ou CANCELLED | Aucun changement sur A ; cleanup staging différé. | A intact. |

### 6.1 Reverse promotion bornée

Une reverse promotion n’est autorisée que si :

- A n’a pas été nettoyée ;
- son ancienne génération est complète ;
- son accès permet encore l’usage ou elle doit rester masquée ;
- les écritures utilisateur intervenues sur B sont inventoriées ;
- favoris, historique et progression peuvent être rejoués ou remappés sans perte ;
- la transaction vérifie les révisions A, B et transition ;
- B devient invisible avant que A soit visible dans la même transaction ;
- B est conservée après la bascule pour investigation.

Si une de ces conditions manque, utiliser un forward-fix. Ne pas faire de DELETE, de réaffectation partielle ou de restauration manuelle hors journal.

Cette primitive correspond au modèle atomique décrit dans C:\Users\AdrienHernandez\Documents\Norva repo\docs\audits\provider-access-lifecycle-2026-08-22\04-final-data-model.md:265-293.

### 6.2 Données utilisateur après promotion

Avant cleanup A, conserver :

- mapping logique titre/variant ;
- favoris ;
- historique ;
- progression ;
- préférences de piste/langue ;
- preuve des remappings ;
- événements créés après le switch.

Si un rollback survient après du trafic sur B, fusionner/rejouer ces écritures par identité logique. Un simple changement de source_id est insuffisant.

## 7. Réponses à des incidents précis

### A+B visible

1. flags remplacement et candidats OFF ;
2. visibilité staging OFF au niveau serveur ;
3. gel des workers de la transition ;
4. déterminer la génération autoritaire ;
5. masquer la génération non autoritaire, sans delete ;
6. invalider recherche, rails, EPG, recommandations et playback ;
7. vérifier chaque surface avant réouverture ;
8. lancer cleanup seulement après analyse de cause.

### B visible avant READY_TO_SWITCH

Traiter comme incident d’isolation :

- stopper toutes promotions ;
- désactiver la nouvelle abstraction de lecture seulement si le chemin historique n’expose pas B ;
- sinon appliquer un filtre serveur d’urgence par transition/génération ;
- ne pas compter sur un patch frontend.

### Timeout pendant promotion

- ne pas créer une seconde transition ;
- GET par replacementId ;
- replay avec même Idempotency-Key si le registre dit non exécuté ;
- si COMMITTING persiste, geler et réconcilier sous verrou ;
- ne jamais conclure « échec » à partir du timeout seul.

### Échec après swap de credentials

- arrêter le refresh candidat ;
- empêcher les continuations anciennes via generation/revision ;
- restaurer snapshot + génération par CAS ;
- terminer FAILED seulement après preuve de compensation et écrire ROLLBACK_APPLIED ;
- ne pas lancer un sync normal sur le catalogue actif avant vérification.

### Secret présent dans un log

Ce n’est pas un simple rollback :

- stopper le chemin émetteur ;
- restreindre l’accès aux logs ;
- lancer la procédure d’incident et de rotation autorisée ;
- ne pas recopier le secret dans le ticket ;
- préserver les identifiants de trace sanitisés.

## 8. Caches, leases et jobs

Toute bascule ou restauration doit :

- augmenter config_revision/source_revision ;
- changer l’identifiant de génération active ;
- invalider le cache de config playback ;
- invalider contexte catalogue, recherche, EPG, recommandations et overlays ;
- révoquer les leases de sync/finalize/enrichissement liés à l’ancienne génération ;
- annuler les notifications pending du cycle superseded ;
- empêcher un worker tardif de promouvoir ou pruner.

Le simple TTL de 60 secondes actuel n’est pas une garantie de rollback : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-playback\index.ts:6105-6129.

## 9. Ce qui ne doit jamais servir de rollback

- réactiver le PATCH direct des credentials ;
- baisser globalement le seuil anti-prune ;
- supprimer A avant diagnostic ;
- vider les tables staging avec une commande non bornée ;
- dropper les nouvelles tables/colonnes pendant l’incident ;
- modifier manuellement config_ciphertext ;
- marquer COMPLETED pour débloquer une UI ;
- réutiliser generic soft-delete/reaper avant remapping ;
- envoyer de nouveaux emails pour compenser sans vérifier l’idempotence ;
- rendre simultanément A et B visibles.

## 10. Preuves de sortie d’incident

Avant réactivation d’un flag :

- une seule source/génération active et visible ;
- aucune source staging jouable ;
- révisions cohérentes ;
- transition terminale ou explicitement gelée ;
- anciens workers refusés ;
- cache chaud et froid cohérents ;
- favoris, historique et progression comptés avant/après ;
- test de lecture sur toutes les surfaces ;
- aucun nouveau log sensible ;
- notifications sans doublon ;
- quota correct ;
- journal de décision et limites archivés.

## 11. Exercices obligatoires avant production

- échec injecté avant et après chaque écriture ;
- timeout réseau après commit réussi ;
- deux promotions concurrentes ;
- replay même clé et clé différente ;
- worker ancien après rollback ;
- A active, A expirée, A disabled et A soft-deleted ;
- B vide, B partielle et B avec overlap d’IDs ;
- rollback après favoris/progression créés sur B ;
- cache de config chaud dans plusieurs isolates ;
- cron notification parallèle ;
- cleanup interrompu puis repris.

GO uniquement si chaque exercice démontre zéro perte, zéro A+B visible et récupération idempotente.

## 12. Limites live

Ce runbook n’a pas été exécuté contre la production. Les éléments suivants restent inconnus :

- délai réel de propagation des flags ;
- capacité d’invalidation des caches multi-isolates ;
- durée et locks d’une reverse promotion ;
- volume des écritures utilisateur à remapper ;
- comportement des workers Edge déjà démarrés ;
- récupération live Resend/FCM ;
- restauration depuis sauvegarde ;
- état réel des grants/RLS et du reaper.

Jusqu’à un exercice contrôlé, le rollback opérationnel n’est pas prouvé et le remplacement reste NO-GO.

Références de besoin : C:\Users\AdrienHernandez\.codex\attachments\fa42029c-5545-4451-9a09-3a29d86d014d\pasted-text-1.txt:617-669, :672-883, :1789-1825, :2104-2138 et :2237-2258.
