# Norva — Scalabilité & coûts fournisseurs : état & reprise

> **But de ce fichier** : mémoriser les optimisations de scalabilité déjà en place
> et **ce qu'il reste à faire quand Norva aura beaucoup d'users multi-pays** — pour
> reprendre sans rien re-découvrir.
>
> _Dernière mise à jour : 2026-06-23._

Branche dev : **`claude/eager-carson-2zlqwy`** · Projet Supabase : **`oupsceccxsonaalhueff`**.

---

## TL;DR

La lecture passe par le **relais Cloudflare** (edge mondial, **zéro frais
d'egress** — le bon choix pour proxifier de la vidéo à l'échelle). Certains
fournisseurs IPTV redirigent la VOD vers des **nœuds backend en IP-brute** que
`fetch()` ne peut pas joindre (erreur Cloudflare **1003**) → le relais streame ces
nœuds via **socket TCP**. Trois optimisations de charge sont en place. Le gros
levier restant — le **cache de titres global** — a sa **fondation posée** ; sa
**bascule de lecture est volontairement différée** (zéro bénéfice tant qu'il n'y a
pas de recoupement multi-users, et c'est le changement le plus risqué du système).

---

## ✅ Fait & déployé (live)

### Lecture (relais `services/norva-relay`)
- **Socket TCP pour nœuds IP-brute** — `proxyPlayback` → `trySocketPath` /
  `fetchNodeViaSocket`. `fetch()` se prend un 1003 sur ces nœuds ; `connect()` les
  atteint (token lié à la même IP de sortie Cloudflare). Gardé aux 401/403 — les
  titres qui marchent gardent le chemin `fetch()` rapide.
- **#1 — Cache de hint socket** (`SOCKET_HINTS`, LRU in-isolate) : un flux confirmé
  « socket-only » saute le `fetch` qui 403 **et** la sonde de range → ~½ des
  allers-retours fournisseur par range request. Auto-réparant (re-apprend si le
  load-balancer déplace le titre).
- **Diagnostics** `X-Norva-Upstream-Status / -Reason / -Final` : sur tout échec
  fournisseur, le vrai statut + raison est exposé (header CORS-readable + log
  Worker `tag:"norva-relay-upstream-error"`).

### Métadonnées
- **#2 — Cache `get_vod_info`** : relais `/vod-info/<token>` + **edge Cache API**,
  clé `(host fournisseur, vod id)`, TTL 24h → **1 fetch par titre/PoP** au lieu de
  par-lecture, partagé entre tous les users. Sert le libellé audio
  « Anglais · AAC · Stereo · 128 kbps » (même donnée que le lecteur mobile natif).
- Libellé **sous-titres incrustés** dérivé du titre (`SUBT AR` →
  « Burned-in subtitles (Arabic) ») — parsing local, pas de pipeline externe
  (décision : « gratuit + bonne couverture arabe + fiable » n'existe pas ensemble,
  et le contenu arabe est déjà hardsubbé).

### Cache de titres global — FONDATION (#3, la moitié sûre)
- Table **`public.catalog_titles`** `(item_type, provider_tmdb_id)` créée + RLS
  (service-role only) + sentinelle `'0'` exclue par contrainte. Migration
  `supabase/migrations/20260623270000_catalog_titles_foundation.sql`.
- **Backfill** : **16 751** titres matchés copiés depuis `cloud_titles`.
- **Dual-write** best-effort dans `supabase/functions/_shared/vod-title-projection.ts`
  (déployé sur `norva-source-sync` **et** `norva-cloud`) → chaque sync maintient
  `catalog_titles` à jour ; un échec ici ne casse jamais la projection per-user.
- ⚠️ **Rien ne lit `catalog_titles`** → **zéro impact** lecture (purement additif,
  réversible).

---

## ⏳ À FAIRE quand on aura beaucoup d'users (le « ne pas oublier »)

### A. Bascule de lecture du cache de titres global (#3 — la moitié risquée + le gain)
> Design complet & étapes : [`global-title-cache-design.md`](./global-title-cache-design.md).

- **Trigger** : quand le **recoupement multi-users** est matériel (plusieurs
  users / pays partagent les mêmes titres TMDB). Aujourd'hui ~0 % (1 catalogue) →
  le gain (÷10-100 sur l'enrichissement TMDB + stockage) n'existe pas encore.
- **Mesurer le trigger** (relancer périodiquement) :
  ```sql
  select count(*)                                              as user_title_rows,
         count(distinct (item_type, provider_tmdb_id))         as distinct_titles,
         round(count(*)::numeric
               / nullif(count(distinct (item_type, provider_tmdb_id)), 0), 2) as overlap_factor
  from public.cloud_titles
  where provider_tmdb_id is not null and provider_tmdb_id <> ''
    and provider_tmdb_id !~ '^(tt)?0+$';
  ```
  `overlap_factor` nettement **> 1** (titres per-user / titres distincts) → implémenter.
- **Étapes** (additives, réversibles) :
  1. ✅ Créer `catalog_titles`.
  2. ✅ Dual-write depuis la projection.
  3. ✅ Backfill depuis `cloud_titles`.
  4. ⏳ **Read cutover** : faire lire `titleRailItem` / `listGenreItems` /
     `listMediaItems` (`supabase/functions/norva-catalog/index.ts`) depuis
     `catalog_titles` par `(item_type, provider_tmdb_id)`, **derrière un flag**,
     **vérifié contre la sortie actuelle**. ⚠️ Changement le **plus risqué** (tous
     les reads rails/grille). Le serve i18n est déjà lang-aware → seule la *source*
     des métadonnées change.
  5. ⏳ **Thin `cloud_titles`** : retirer les colonnes métadonnées migrées une fois
     les reads stables (garder identité + lien per-user + variant_count).
- **À ajouter au cutover** : TMDB **changes API** (refresh incrémental des titres
  au `tmdb_synced_at` vieux) + **daily id exports** TMDB (seed bulk) — opèrent sur
  la table globale, une fois pour tous.

### B. Monitoring par fournisseur
- Les diagnostics relais loggent `tag:"norva-relay-upstream-error"` (status, host,
  reason, finalUrl). → brancher une **alerte** (Cloudflare Logpush / Workers
  Analytics Engine) **par host fournisseur** quand le taux d'échec grimpe = un
  fournisseur a changé de pattern (nouvel auth/redirect à traiter).

### C. Harness de test multi-fournisseurs
- Avant/pendant le lancement : un script qui, pour **1 titre par fournisseur** (un
  par type d'abonnement de tes users), lance la lecture via le relais et vérifie un
  `206` / flux OK (header `X-Norva-Relay-Path`). Détecte vite un fournisseur dont
  l'auth/redirect casse, **avant** que les users s'en plaignent.

---

## 🧱 Garde-fous (à respecter quoi qu'il arrive)
- `provider_tmdb_id = '0' / ''` = sentinelle no-match → **jamais** une clé ni une
  identité (ne pas joindre dessus).
- Années de sortie **plafonnées** à `[1900, année courante + 1]`.
- Les ids TMDB du fournisseur sont fiables pour l'**identité** ; la validation TMDB
  ne gate que la confiance dans les **métadonnées** TMDB (jamais l'identité).

## 🧭 Coordonnées clés
| Élément | Où |
|---|---|
| Relais (socket, caches, diagnostics) | `services/norva-relay/src/index.js` — CI `deploy-relay.yml` sur push `main` |
| Cache `get_vod_info` | relais `/vod-info/<token>` + edge Cache API |
| Table cache global | `public.catalog_titles` (clé `item_type, provider_tmdb_id`) |
| Dual-write | `supabase/functions/_shared/vod-title-projection.ts` |
| Reads à basculer (étape 4) | `supabase/functions/norva-catalog/index.ts` (`titleRailItem`, `listGenreItems`, `listMediaItems`) |
| Design détaillé | [`global-title-cache-design.md`](./global-title-cache-design.md) |
