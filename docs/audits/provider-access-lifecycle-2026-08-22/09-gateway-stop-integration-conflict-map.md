# Cartographie d’intégration — gateway-stop isolé

Date : 2026-08-23. Cette analyse a été réalisée en lecture seule contre le
worktree utilisateur ; aucun de ses fichiers n’a été modifié, stashé ou indexé.

## Base et ordre des commits

- Base isolée : `2e74a9fd`.
- Branche : `codex/gateway-stop-isolated`.
- À appliquer après le lot Phase 3 qui fournit les tables/routines provider :

```text
3466e56b  feat(gateway): stop provider transport for account deletion
e2290280  feat(account-delete): expose opaque transport stop scope
fe295228  feat(account-delete): execute transport stop receipts
c6af7799  fix(account-delete): revalidate transport stop before gateway
1d316088  docs(provider): record transport stop fence proof
b6ca04c4  test(account-delete): recover expired transport stop claim
616f2bf4  docs(gateway): record idempotent transport stop retry
23c81d7e  test(account-delete): make duplicate begin one transport action
993ca3c4  fix(account-delete): persist gateway transport retry
57941399  docs(provider): map isolated gateway stop integration
61071ae9  docs(provider): distinguish phase 3 crash evidence
673cb67f  docs(gateway): record authenticated stop boundary
f290ca23  test(account-delete): fence direct Auth deletion
af9e038f  docs(account-delete): align caller with durable deletion
d0ad7d76  test(gateway): preserve provider handoff extraction boundary
3e998a81  docs(provider): record consolidated local suite
a314694c  fix(account-delete): snapshot gateway stop scope durably
0890f113  test(account-delete): make transport smoke rerunnable
0e3f4946  docs(provider): refresh phase 3 local proof run
f530b782  test(account-delete): fence reaper behind transport stop
80ba4d80  fix(account-delete): archive legal billing atomically
```

## Fichiers à conflit potentiel

| Fichier | Modifications utilisateur observées | Lot isolé | Chevauchement | Intégration |
|---|---|---|---|---|
| `services/media-gateway/src/index.js` | validation Xtream, spool catalogue, egress DNS et proxy | route stop opaque près de `8179`; helper près de `14373` sur la base | textuel : non | cherry-pick normal attendu ; vérifier que `proxyKeyFromUrl()` reste `providerAccountAffinityKey()` |
| `supabase/functions/norva-account-delete/index.ts` | aucune modification non commitée observée | claim, revalidation, retry/receipt gateway | non observé | cherry-pick normal, puis test Edge ciblé |
| `supabase/migrations/` | migrations Phase 3 non commitées, dont affinities et sous-graphe `82780/82783` | `20260823182792`–`20260823182796` | dépendance, non conflit textuel | appliquer le sous-graphe fournisseur et l'archive légale en premier ; ne pas appliquer `82792`–`82796` seul |
| `tests/` | nombreux tests VOD/provider non commités | tests Node, SQL et Deno du transport stop | aucun même chemin observé | cherry-pick normal, puis suites ciblées |
| `supabase/tests/catalog_background_owner_snapshot_concurrency_smoke.sql` | nouveau smoke utilisateur non commité | aucun changement isolé au même chemin | non textuel | son teardown direct `auth.users` est désormais refusé par le guard durable ; le corriger seulement dans le troisième worktree par un bypass de fixture post-assertions |

## Vérification sémantique obligatoire lors du troisième worktree

Le hash transmis au gateway doit rester :

```text
SHA-256(providerAccountAffinityKey(source URL))
```

Le gateway compare ce hash à `proxyKeyFromUrl(session.sourceUrl)`. La révision
utilisateur modifie `providerSlotKeyFromUrl`, mais pas `proxyKeyFromUrl` lors de
l’analyse ; cette distinction doit être recontrôlée après résolution de conflit.
Ne remplacer ni le hash d’affinité par un slot incluant le mot de passe, ni par
une valeur exposant une URL ou un identifiant de compte.

Après le claim, `82794` fige ce périmètre opaque dans l'action durable avec son
epoch. La revalidation et l'appel gateway utilisent exclusivement ce snapshot :
la disparition en parallèle d'une source ou d'une ligne d'affinité ne peut donc
ni élargir, ni vider le périmètre qui a été autorisé.

## Procédure d’intégration ultérieure

1. Créer un troisième worktree propre depuis le commit qui contient les
   modifications utilisateur validées.
2. Vérifier la présence des migrations d’affinité, de l'archive légale et
   `82780`/`82781`, puis appliquer `82792` à `82796` dans cet ordre.
3. Cherry-pick les commits ci-dessus dans cet ordre.
4. Résoudre seulement si la vérification sémantique de clé l’exige.
5. Exécuter les contrats Node, les smokes PostgreSQL transport/provider et `deno test --config supabase/functions/deno.partners.json --allow-env --allow-net --allow-read --allow-write --allow-run supabase/tests/account_deletion_transport_stop_crash_runtime_test.ts`.
6. Ne pas activer de flag, déployer Edge v3 ou publier le gateway dans cette étape.
