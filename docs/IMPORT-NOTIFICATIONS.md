# Norva — Notifications de cycle de vie d'import (email + push) — WIP

> Prévenir l'user, de façon **premium**, quand l'import d'un provider **démarre** et quand il est **terminé**
> (et en cas d'**échec persistant**) — pour qu'il puisse fermer l'app et être rappelé. **Anglais uniquement**
> (Norva est English-only, pas d'i18n en roadmap).
>
> **État au 30/06** : design validé, **prep livrée** (table + templates), **reste à câbler** (cron digest +
> hooks + UX + push mobile Phase 2).

---

## 1. Décisions verrouillées (avec l'owner)
- **Push mobile** : **email d'abord** (Phase 1, tous appareils) ; la vraie push native (FCM) est **Phase 2**.
- **Anti-spam** : **digest groupé** — plusieurs imports qui démarrent/finissent dans une courte fenêtre = **un
  seul email** (« Your 5 catalogs are ready »).
- **Échec** : **oui**, notifier l'échec **persistant** (après retries), pas les ratés transitoires.
- **Langue** : **anglais only**.

## 2. Pourquoi le mobile est le point dur
Les apps (`clients/android-phone`, `android-tv`, `samsung-tizen`) sont des **wrappers WebView** qui chargent
`norva.tv/app.html` — **aucune infra push (FCM) aujourd'hui**. Donc :
- **Email** : marche partout, infra déjà là (Resend, cf. `norva-auth-email` + le précédent Phase 3 sous-titres).
- **Push app-fermée** : nécessite soit un **bridge FCM natif** (Firebase dans le wrapper Android → token → pont
  JS → backend → FCM HTTP v1 + **nouvelle release Play Store** ; iOS = APNs, pas d'app iOS native), soit du
  **Web Push** (peu fiable dans un WebView wrappé). → **Phase 2, bridge FCM natif** retenu.

## 3. Architecture (queue + cron digest)
Le moteur **n'envoie jamais d'email inline** — il **insère un event** dans une file ; un **cron digest** envoie.

**Table `cloud_import_notifications`** (migration `20260630210000`, **appliquée + commitée**) :
`id, user_id, source_id, kind ('import_started'|'import_completed'|'import_failed'), payload jsonb, status
('pending'|'sent'|'skipped'), created_at, sent_at`, **`unique(source_id, kind)`**.
- L'`unique(source_id, kind)` = **garde d'idempotence** : le moteur tourne en dizaines d'isolates → insert
  `ON CONFLICT DO NOTHING` → un event ne part **qu'une fois** par source par kind.
- Service-only (RLS, `service_role` seul).

**Cron digest** (~2 min) → route edge : balaie les `pending`, **groupe par `(user_id, kind)`** dans une
fenêtre, résout l'email depuis `auth.users`, **rend via `_shared/import-email.ts`**, envoie via **Resend**,
passe les lignes en `sent`. 1 provider → email simple ; N dans la fenêtre → **digest**.

## 4. Les emails (anglais, brandés, `_shared/import-email.ts` — **livré**)
Render functions pures, sans effet de bord, chacune prend un **tableau** de providers (1 = simple, N = digest) :
- `renderImportStarted` — *« Thanks for trusting Norva, Adrien — we're building your **Promax 4K OTT** catalog.
  Large providers can take a few minutes; we'll email you the moment it's ready. Feel free to close the app. »*
- `renderImportCompleted` — *« Your **Promax 4K OTT** catalog is ready — 36,000 movies · 12,000 series ·
  5,000 channels. [Open Norva] »* (deep-link `norva.tv/app.html`).
- `renderImportFailed` — *« We hit a snag importing **Promax 4K OTT** — we're on it, nothing to do on your
  side. [Contact support] »*.
- Style brandé identique à `norva-auth-email` (thème sombre, logo, CTA `#5b7cfa`).

## 5. Les hooks de cycle de vie (À FAIRE — dans le moteur partagé)
À insérer dans `_shared/xtream-sync.ts` (**après** la dédup — cf. `SYNC-ENGINE-DEDUP.md`) pour exister **une
seule fois** :
- `import_started` : à l'ajout, **1er sync seulement** (pas les refreshs). Insert `ON CONFLICT DO NOTHING`.
- `import_completed` : quand finalize passe `ready`, **1ère fois seulement**. payload = compteurs
  (movies/series/channels). À la complétion, **`skipped` un éventuel `import_failed` pending** de la même
  source (supersession, évite « échec » puis « succès » contradictoires).
- `import_failed` : sur **échec persistant** (erreur non-transitoire / budget de continuation épuisé), pas sur
  les 503 transitoires.
- **Refreshs auto = silencieux** (seulement les imports initiaux).

## 6. UX (À FAIRE)
- **Message à l'ajout** : « You'll get an email (all devices) — and a mobile notification — when it's ready.
  You can close the app. »
- **Bannière/toast in-app** à la complétion si l'app est ouverte (réutilise le polling catalogue existant).

## 7. Statut des tâches
| # | Tâche | État |
|---|---|---|
| 37 | Table `cloud_import_notifications` | ✅ table faite · ⏳ cron digest à faire |
| 38 | Hooks lifecycle dans le moteur partagé | ⏳ bloqué par la dédup (#36) |
| 39 | Templates email anglais brandés | ✅ `_shared/import-email.ts` |
| 40 | UX ajout + bannière in-app | ⏳ |
| 41 | **Phase 2** push FCM natif (mobile app-fermée) | ⏳ projet à part |

## 8. Fichiers
- `supabase/migrations/20260630210000_import_lifecycle_notifications.sql` — table (appliquée live).
- `supabase/functions/_shared/import-email.ts` — templates anglais (livré, importé par rien encore).
- À venir : route cron digest (vraisemblablement dans `norva-cloud` ou une petite fonction dédiée +
  `cron.schedule`), hooks dans `_shared/xtream-sync.ts`, message UX + bannière côté `public/js`.
