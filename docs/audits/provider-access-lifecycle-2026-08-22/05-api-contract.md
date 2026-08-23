# Phase 0 — Contrat API Provider Access Lifecycle v1

Statut : proposition contractuelle, non implémentée.

Date de référence : 2026-08-22.

Ce document décrit le contrat cible. Il ne constitue ni une migration, ni une autorisation de modifier le comportement de production. Tant que les préconditions de sécurité ne sont pas prouvées, les nouvelles mutations restent désactivées.

## 1. Objectifs normatifs

Le contrat doit :

- séparer l’état d’accès fournisseur de l’état de synchronisation ;
- empêcher toute mutation directe des identifiants actifs ;
- valider et comparer des identifiants candidats sans toucher au catalogue actif ;
- préparer un remplacement dans un staging invisible ;
- garantir une bascule atomique, idempotente et protégée par CAS ;
- ne jamais supprimer A avant que B soit prêt ;
- ne jamais exposer de secret ou de réponse fournisseur brute ;
- échouer fermé si un flag, une révision, un invariant ou une preuve manque.

Les termes « DOIT », « NE DOIT PAS » et « PEUT » sont normatifs.

## 2. État actuel justifiant un nouveau contrat

| Constat actuel | Preuve |
|---|---|
| Les routes sources actuelles ne sont pas versionnées et regroupent create, update, test, sync, hard-sync, toggle, finalize et delete. | C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-cloud\index.ts:682-732 |
| PATCH/PUT remplace immédiatement le ciphertext actif puis lance le sync en arrière-plan. | C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-cloud\index.ts:1357-1417 |
| Le client peut actuellement proposer des champs internes comme config_ciphertext, sync_status, sync_error et config_hint. | C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-cloud\index.ts:1368-1381 |
| La validation Xtream obtient exp_date, mais le hint persistant ne conserve pas expiresAt. | C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-cloud\index.ts:1611-1646 |
| Le catalogue Xtream est upserté sous le même source_id avant le prune. | C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\_shared\xtream-sync.ts:296-383 |
| Le prune est refusé au-delà de 50 % ou après une erreur de fetch, en conservant explicitement un superset ancien + nouveau. | C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\_shared\xtream-sync.ts:805-830 |
| M3U supprime les anciennes lignes avant les nouveaux upserts. | C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-source-sync\index.ts:2790-2803 |
| Playback lit un item puis construit l’URL avec la configuration active, mise en cache 60 secondes sans révision. | C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-playback\index.ts:4389-4553 et :6105-6129 |
| Le quota est vérifié par un count-then-insert non atomique. | C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-cloud\index.ts:863-905 |

Conséquence : le contrat historique PATCH /sources/:id ne doit plus accepter de changement de configuration fournisseur une fois le nouveau workflow disponible. Il reste limité aux champs cosmétiques explicitement autorisés.

## 3. Versionnement

### 3.1 Identité du contrat

- Préfixe HTTP : /v1
- Version de document : provider-access.norva/v1
- En-tête obligatoire sur toute mutation : Norva-Contract-Version: provider-access.norva/v1
- Réponse : apiVersion vaut toujours provider-access.norva/v1

L’absence ou une valeur inconnue de l’en-tête sur une mutation retourne CONTRACT_VERSION_UNSUPPORTED sans aucune écriture.

Une évolution additive peut rester en v1. Tout changement de sens d’un état, d’une précondition, d’un code d’erreur ou d’une garantie de visibilité exige v2.

Un client v1 qui reçoit un enum inconnu doit le traiter comme non actionnable : aucune promotion, aucun masquage, aucune suppression.

### 3.2 Enveloppe commune

Succès :

    {
      "apiVersion": "provider-access.norva/v1",
      "kind": "CredentialCandidate",
      "requestId": "uuid",
      "data": {}
    }

Erreur :

    {
      "apiVersion": "provider-access.norva/v1",
      "requestId": "uuid",
      "error": {
        "code": "SOURCE_REVISION_MISMATCH",
        "message": "The source changed. Refresh and try again.",
        "retryable": false
      }
    }

La réponse d’erreur NE DOIT PAS contenir de champ details libre.

## 4. Préconditions communes

Toute mutation DOIT vérifier, dans cet ordre :

1. flag fonctionnel lisible et activé ;
2. JWT utilisateur vérifié côté serveur ;
3. appartenance de la source, avec réponse identique pour « absent » et « autre utilisateur » ;
4. source non supprimée et état compatible ;
5. Idempotency-Key valide ;
6. If-Match correspondant à la révision attendue ;
7. absence de transition concurrente incompatible ;
8. invariants DB ;
9. écriture transactionnelle.

Si la lecture des flags échoue, le flag est considéré OFF.

### 4.1 Idempotency-Key

Idempotency-Key est obligatoire pour POST, PUT et PATCH créant ou modifiant un état métier.

- même clé, même utilisateur, même ressource et même empreinte canonique : retourner la même ressource et le même résultat ;
- même clé avec un payload différent : 409 IDEMPOTENCY_KEY_REUSED ;
- deux requêtes concurrentes : une seule opération est créée ;
- une réponse réseau ambiguë se résout par GET de la ressource ou replay avec la même clé, jamais par une nouvelle clé automatique ;
- la clé n’est jamais utilisée comme preuve d’autorisation.

Le stockage d’idempotence conserve une empreinte du payload, pas les credentials en clair.

### 4.2 CAS et ETag

GET source/provider-access/transition retourne :

    ETag: "source-rev-42"

Une mutation liée à la source exige :

    If-Match: "source-rev-42"

Une mutation d’une transition exige aussi sa révision dans le body ou un ETag de transition. La vérification finale se fait dans la même transaction que l’écriture, avec verrou de ligne. Une simple comparaison TypeScript avant l’appel DB n’est pas suffisante.

Réponses :

- en-tête manquant : 428 PRECONDITION_REQUIRED ;
- révision périmée : 409 SOURCE_REVISION_MISMATCH ou TRANSITION_REVISION_MISMATCH ;
- l’échec CAS ne produit aucune écriture partielle.

## 5. États contractuels

### 5.1 Accès fournisseur

Valeurs :

- UNKNOWN
- ACTIVE
- EXPIRING
- EXPECTED_EXPIRED
- EXPIRED_CONFIRMED
- ACCESS_UNAVAILABLE_CONFIRMED
- CHECK_FAILED_TEMPORARY
- RESTORING

Règles :

- une date manuelle dépassée peut produire EXPECTED_EXPIRED, jamais EXPIRED_CONFIRMED ;
- CHECK_FAILED_TEMPORARY ne masque jamais le catalogue ;
- seul un résultat fournisseur authentifié et classifié peut confirmer l’indisponibilité ;
- l’accès est indépendant de sync_status, enabled et du plan Norva ;
- Settings reste accessible même lorsque le contenu est masqué.

Le modèle DB canonique de C:\Users\AdrienHernandez\Documents\Norva repo\docs\audits\provider-access-lifecycle-2026-08-22\04-final-data-model.md:109-171 conserve des états plus compacts dans cloud_source_access_cycles. La projection API est déterministe :

| État DB | Projection API autorisée |
|---|---|
| unknown | UNKNOWN ou CHECK_FAILED_TEMPORARY selon le dernier contrôle |
| valid | ACTIVE |
| warning | EXPIRING ou EXPECTED_EXPIRED selon la provenance de l’échéance |
| expired | EXPIRED_CONFIRMED uniquement avec preuve fournisseur fiable |
| revoked | ACCESS_UNAVAILABLE_CONFIRMED |
| restored | RESTORING pendant vérification, puis ACTIVE |

Le client ne soumet jamais directement l’un de ces états.

### 5.2 Comparaison de catalogue

- SAME_CATALOG
- DIFFERENT_CATALOG
- AMBIGUOUS

Hostname, URL, username et password ne suffisent jamais. La comparaison serveur utilise l’identité existante, les stream IDs, les catégories, un échantillon de contenus, une empreinte et l’overlap.

### 5.3 Machine de transition unique

- VALIDATING
- STAGING
- IMPORTING
- READY_TO_SWITCH
- COMMITTING
- COMPLETED
- FAILED
- CANCELLED

Cette machine est identique pour CredentialCandidate et Replacement. Le sens opérationnel dépend du genre de transition :

| État canonique | Candidat même catalogue | Remplacement |
|---|---|---|
| VALIDATING | Vérification des credentials et comparaison d’identité. | Vérification des credentials B et de son identité. |
| STAGING | Secret candidat et preuves isolés ; A reste active. | B existe en staging/hidden. |
| IMPORTING | Refresh candidat dans une génération invisible. | Import du catalogue B invisible. |
| READY_TO_SWITCH | SAME_CATALOG ou décision manuelle sûre, contrôles passés. | B complète, saine et prête à promouvoir. |
| COMMITTING | Swap CAS, refresh de vérification et éventuelle compensation. | Promotion atomique A/B. |
| COMPLETED | Nouvelle configuration vérifiée. | B active, A replaced. |
| FAILED | Échec compensé ; A est intacte. | Échec compensé ; A est intacte. |
| CANCELLED | Annulation sans effet actif. | Staging annulé ; A est intacte. |

COMMITTING n’est jamais piloté par retry aveugle du client. Une transition ne passe à FAILED qu’après compensation réussie ou preuve qu’aucun commit n’a eu lieu.

### 5.4 Rollback compensateur

Le rollback n’est pas un état canonique.

- avant COMPLETED, une compensation restaure A puis termine la transition en FAILED ou CANCELLED selon la cause ;
- après COMPLETED, une reverse promotion ou restauration est une opération compensatrice idempotente distincte ;
- la transition d’origine reste COMPLETED ;
- l’événement append-only ROLLBACK_APPLIED, les révisions avant/après et l’identifiant de compensation rendent le résultat observable ;
- le GET sanitisé peut exposer compensationApplied et compensationEventId, jamais un pseudo-état ROLLED_BACK.

Un état inconnu, une readiness absente ou une compensation non prouvée bloque l’action.

## 6. Endpoints Provider Access

| Méthode et chemin | But | Préconditions principales |
|---|---|---|
| GET /v1/sources/{sourceId}/provider-access | Snapshot, cycle actif, préférences, actions autorisées et ETag. | Propriétaire ; source non supprimée. |
| GET /v1/sources/{sourceId}/provider-access/cycles | Historique paginé et sanitisé des cycles. | Propriétaire. |
| PUT /v1/sources/{sourceId}/provider-access/terms | Crée ou remplace le cycle déclaré par l’utilisateur. | Flag access ON, Idempotency-Key, If-Match. |
| PATCH /v1/sources/{sourceId}/provider-access/preferences | Active ou désactive les rappels. | Flag access ON, Idempotency-Key, If-Match. |
| POST /v1/sources/{sourceId}/provider-access/checks | Crée un contrôle non destructif. | Flag auto-detection ON, Idempotency-Key, If-Match. |
| GET /v1/sources/{sourceId}/provider-access/checks/{checkId} | Lit le résultat sanitisé du contrôle. | Propriétaire. |
| POST /v1/sources/{sourceId}/provider-access/extensions | Déclare une prolongation des identifiants actuels et ouvre RESTORING. | Flag access ON, Idempotency-Key, If-Match. |

PUT terms accepte une période calendaire explicite ou une durée autorisée. Le serveur calcule les dates ; le client ne soumet pas un provider_access_status arbitraire.

POST checks retourne 202 et une ressource Check. Un timeout ou une panne gateway donne CHECK_FAILED_TEMPORARY et ne modifie ni visibilité ni catalogue.

## 7. Endpoints candidats

| Méthode et chemin | But |
|---|---|
| POST /v1/sources/{sourceId}/credential-candidates | Chiffre un candidat et lance validation puis comparaison, sans modifier la configuration active. |
| GET /v1/sources/{sourceId}/credential-candidates/{candidateId} | Retourne état, comparaison, horodatages et actions autorisées, jamais les credentials. |
| POST /v1/sources/{sourceId}/credential-candidates/{candidateId}/decision | Résout AMBIGUOUS par KEEP_AS_SAME_CATALOG, REPLACE_WITH_NEW_CATALOG ou CANCEL. |
| POST /v1/sources/{sourceId}/credential-candidates/{candidateId}/apply | Applique uniquement un candidat SAME_CATALOG ou explicitement confirmé, avec snapshot de rollback. |
| POST /v1/sources/{sourceId}/credential-candidates/{candidateId}/cancel | Annule avant commit. |

POST credential-candidates :

- exige provider_credential_transition_v1_enabled ;
- exige Idempotency-Key et If-Match ;
- accepte les secrets uniquement dans le corps TLS entrant ;
- ne retourne que candidateId, state, comparison et sourceRevision ;
- ne modifie ni config_ciphertext actif, ni source_id, ni cloud_media_items ;
- n’écrit pas dans le registre d’identité canonique à partir d’un catalogue actif mélangé.

POST apply :

- refuse DIFFERENT_CATALOG avec DIFFERENT_CATALOG_REQUIRES_REPLACEMENT ;
- refuse AMBIGUOUS sans décision explicite ;
- conserve l’ancienne configuration chiffrée jusqu’au premier refresh sain ou à l’échéance de rollback ;
- synchronise dans une génération isolée ;
- ne termine COMPLETED qu’après refresh vérifié ;
- restaure automatiquement l’ancienne configuration sur échec vérifiable.

REPLACE_WITH_NEW_CATALOG produit une autorisation de créer un remplacement à partir du candidat ; le client ne doit pas renvoyer les secrets.

## 8. Endpoints remplacements

| Méthode et chemin | But |
|---|---|
| POST /v1/sources/{sourceId}/replacements | Crée une transition à partir d’un candidateId DIFFERENT_CATALOG ou d’un candidat dédié. |
| GET /v1/sources/{sourceId}/replacements/{replacementId} | Retourne état, progression bornée, contrôles et actions autorisées. |
| POST /v1/sources/{sourceId}/replacements/{replacementId}/promote | Demande la bascule atomique lorsque l’état est READY_TO_SWITCH. |
| POST /v1/sources/{sourceId}/replacements/{replacementId}/cancel | Annule et programme le nettoyage du staging, sans toucher à A. |

Création :

- exige provider_replacement_v1_enabled ;
- réserve une transition unique pour A ;
- autorise B en staging sans consommer un second droit commercial ;
- ne donne aucun accès playback à B ;
- retourne 202 et une Location vers la transition.

Promotion :

- exige Idempotency-Key, If-Match source et révision de transition ;
- vérifie même user, A active, B staging, B prête, non vide et saine, aucune transition concurrente ;
- fait B active/visible et A replaced/invisible dans une seule transaction ;
- ne crée aucune fenêtre A+B visible ;
- remappe ou préserve favoris, historique et progression avant tout cleanup ;
- n’exécute aucun delete catalogue massif dans la requête.

Le staging doit être invisible côté serveur pour Home, Live, Movies, Series, Search, Recommendations, Continue Watching, Favorites, History, EPG, source picker, playback, enrichissement et vues admin utilisateur.

## 9. Erreurs stables

| HTTP | Code | Retryable | Sens |
|---:|---|---:|---|
| 400 | INVALID_REQUEST | non | Structure ou enum invalide. |
| 401 | AUTHENTICATION_REQUIRED | non | JWT absent ou invalide. |
| 404 | SOURCE_NOT_FOUND | non | Source absente, supprimée ou non possédée. |
| 404 | TRANSITION_NOT_FOUND | non | Transition absente ou non possédée. |
| 409 | SOURCE_REVISION_MISMATCH | non | CAS source échoué. |
| 409 | TRANSITION_REVISION_MISMATCH | non | CAS transition échoué. |
| 409 | IDEMPOTENCY_KEY_REUSED | non | Même clé, payload différent. |
| 409 | TRANSITION_ALREADY_PENDING | non | Une transition incompatible existe. |
| 409 | INVALID_TRANSITION_STATE | non | Action impossible dans l’état courant. |
| 409 | DIFFERENT_CATALOG_REQUIRES_REPLACEMENT | non | Le candidat ne peut pas être appliqué sur A. |
| 409 | REPLACEMENT_NOT_READY | non | B n’a pas atteint READY_TO_SWITCH. |
| 422 | CANDIDATE_CREDENTIALS_REJECTED | non | Refus authentifié, sans diagnostic sensible. |
| 422 | CATALOG_COMPARISON_INSUFFICIENT | non | Preuves insuffisantes ; état AMBIGUOUS. |
| 428 | PRECONDITION_REQUIRED | non | If-Match ou Idempotency-Key manque. |
| 503 | FEATURE_DISABLED | non | Fonction non ouverte ; aucune mutation et aucun fallback. |
| 503 | PROVIDER_CHECK_TEMPORARY_FAILURE | oui | Réseau/gateway temporaire ; aucune décision destructive. |
| 500 | INVARIANT_VIOLATION | non | Invariant DB refusé ; alerte opérateur, aucune fuite. |

Les messages utilisateur sont génériques et localisables. Le code est l’interface stable. Un statut HTTP fournisseur brut n’est pas un code public.

## 10. Données sensibles et journalisation

Interdits dans réponses, logs, traces, métriques, notifications et payloads d’erreur :

- URL fournisseur complète ;
- username, password ;
- token M3U ou playlist privée ;
- ciphertext ou ancienne configuration ;
- réponse fournisseur complète ;
- empreinte réversible des credentials.

Autorisé par allowlist :

- source_id ;
- display_name ;
- access status ;
- date d’expiration ;
- decision code ;
- transition_id ;
- request_id ;
- durée et compteur agrégés non identifiants.

Le chemin direct actuel peut propager HttpError.details et le worker le journalise : C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-cloud\index.ts:4598-4602 et C:\Users\AdrienHernandez\Documents\Norva repo\supabase\functions\norva-source-sync\index.ts:260-265. Le contrat v1 interdit ce comportement.

## 11. Autorisation et isolation Supabase

- Les tables de candidats, snapshots de rollback, staging, idempotence et preuves détaillées ne sont pas exposées directement au Data API public.
- Si une table est dans un schéma exposé, RLS est obligatoire.
- Une policy authenticated seule ne suffit pas : chaque accès utilisateur doit inclure l’ownership.
- Les ciphertexts restent service-only ; une vue utilisateur ne renvoie qu’une projection sanitisée.
- Les RPC de promotion privilégiées sont placées dans un schéma non exposé, EXECUTE est révoqué à PUBLIC, et l’appelant/ownership est vérifié explicitement.
- Une vue publique éventuelle utilise security_invoker lorsque la version Postgres le permet ; sinon elle est révoquée aux rôles publics et appelée via une couche contrôlée.
- La service_role ne doit jamais atteindre un client.

## 12. Compatibilité et fermeture de l’ancien chemin

Avant d’activer provider_credential_transition_v1_enabled :

- PATCH/PUT /sources/:id doit refuser serverUrl, username, password, playlistUrl, epgUrl, config, configCiphertext et config_ciphertext avec DIRECT_CREDENTIAL_MUTATION_FORBIDDEN ;
- sync_status, sync_error, config_hint et last_synced_at deviennent non modifiables par le client ;
- display_name reste la seule mutation historique indépendante autorisée, avec sa propre allowlist ;
- aucun fallback vers l’ancien PATCH n’est permis si le contrat v1 échoue.

## 13. Limites live et de preuve Phase 0

Ce contrat n’a pas été exercé contre une base Supabase locale ou live. Aucun RPC, RLS, advisor, Edge Function, cron, email, push, cache distribué ou charge catalogue n’a été validé. Les 68 tests ciblés existants passaient lors de l’audit, mais aucun ne couvre ce contrat ou une transition A vers B.

Références de besoin : C:\Users\AdrienHernandez\.codex\attachments\fa42029c-5545-4451-9a09-3a29d86d014d\pasted-text-1.txt:565-669, :672-850, :952-1043, :1430-1475 et :1611-1662.
