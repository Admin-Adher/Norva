# Phase 2 dedup + soulagement scalabilité — tracker d'exécution

> **But** : suivi clair **fait / reste à faire** pour rendre Norva scalable à l'échelle
> mondiale (DB + egress), suite à l'audit du 2026-06-27. Plan détaillé + chiffrage :
> [`dedup-plan.md`](./dedup-plan.md). État live général : [`scaling-status.md`](./scaling-status.md).
>
> Branche dev : `claude/eager-carson-2zlqwy` · Projet : `oupsceccxsonaalhueff` ·
> _Dernière mise à jour : 2026-06-27._

## Verdict de l'audit (le problème en un chiffre)

À **un seul** gros provider (super8k, 272 764 items) la base atteignait **790 MB
(168% du free tier)** et l'egress **5,9 GB (119%)**. Causes **structurelles** :
1. **DB** — les 5 tables catalogue **per-user** (`cloud_media_items` + `cloud_live_*`
   + `cloud_title_variants` + `cloud_titles`) = **725 MB = 92% de la base**, clés sur
   `(user_id, source_id)` ⇒ stockage `O(users × catalogue)`.
2. **Egress** — chaque image (poster/backdrop) **proxifiée** par l'edge Supabase ⇒
   Supabase paie l'egress de chaque octet d'image, multiplié par chaque user.

---

## ✅ FAIT

### Soulagement immédiat (live en base)
- [x] **super8k mis en pause + purgé** (`config_hint.paused=true`, curseurs effacés ;
      272 764 media · 88 k title_var · 103 k live · 54 k titres supprimés ; `VACUUM FULL`).
      **DB 790 MB → 155 MB** (168% → 30% du quota). apdxes (l'user réel) intact.
- [x] **Index de tri non droppés** (les 4 backent de vrais tris du grid) — ils déménagent
      sur la table globale (payés 1×/provider).

### Egress — driver dominant corrigé (poussé sur dev)
- [x] **Images TMDB en direct** — `proxyImageUrl` (`public/js/cloudApi.js`) sert les URLs
      `tmdb.org`/`themoviedb.org` **directement** (zéro egress Supabase). **78,7% des posters
      VOD** sont TMDB ⇒ ~⅘ de l'egress images → 0. Host-fournisseur/http restent proxifiés
      (privacy + mixed-content). _Commit `ef39ff3`._
- [x] **EPG + selects catalogue** — évalués, **différés avec raison** : l'EPG est de
      l'ingress/compute (réponse déjà fenêtrée), pas de l'egress ; stripper `metadata`/
      `playback_hint` des listes (53%) casserait le play-from-grid (`playbackHintFromItem`) →
      nécessite un refactor client.

### Dédup Phase 2 — schéma global construit + validé (live en base, flag OFF)
- [x] **`catalog_media_items`** `(server_host, item_type, external_id)` + RLS service-only +
      4 index de tri + garde **keep-best** (testée empiriquement). Migration `20260627140000`.
- [x] **`catalog_title_variants` · `catalog_live_logical_channels` · `catalog_live_variants`**
      — jumelles globales, RLS service-only. Migration `20260627150000`.
- [x] **`backfill_catalog_from_cloud()`** (dedup per-user → global, idempotent) +
      **`catalog_dedup_report()`** (mesure le multiplicateur). Migration `20260627160000`.
- [x] **Validé** : backfill apdxes → 40 585 media / 27 665 title_var / 9 500 live →
      **`dup_factor = 1.00`** (clé correcte, pas de collapse erroné). Tables **tronquées**
      ensuite (rien ne les lit ; pas de gain à 1 user) ⇒ la base reste à 155 MB. Repopulables
      en 1 appel quand le dual-write ou l'échelle arrive.

### Dual-write au sync — construit + testé (live en base, flag OFF)
- [x] **`sync_source_to_catalog(p_source_id)`** — miroir **en bloc par source** vers le global
      (keep-best sur media, last-wins sur le raw provider), `statement_timeout` relevé à 300s
      (survit au cap 8s de l'authenticator pour les gros catalogues). Migration `20260627170000`.
      Testé sur apdxes : 40 585 / 27 665 / 9 500, **idempotent** (2ᵉ run = mêmes counts).
- [x] **Trigger `trg_cloud_source_mirror_on_ready`** sur `cloud_sources` (AFTER UPDATE OF
      sync_status, quand →`ready`) → appelle le miroir. **Un seul point** couvre tous les
      chemins (onboarding, re-sync, cron finalize) ⇒ pas d'édition des 2 finalize stabilisés.
      **GUC `app.norva_catalog_dual_write` (défaut OFF)** : no-op tant que non activé ⇒ zéro
      overhead/risque. Exception-gardé. Migration `20260627180000`. **Testé** : flag ON → miroir
      peuplé (40 585/9 500) ; flag OFF → 0 (rien ne se peuple). apdxes intact.
      _Activation : `alter role authenticator set app.norva_catalog_dual_write = '1';`_

---

## ⏳ RESTE À FAIRE (Phase 2, multi-session, additif + réversible)

Ordre conseillé. Tout reste **derrière un flag par défaut OFF** ⇒ zéro impact tant que non basculé.
- [ ] **Mirror-verify** : `catalog_media_mirror_diff()` (sur le modèle de `catalog_mirror_diff`)
      ⇒ prouver que le global est un miroir fidèle du per-user avant tout flip.
- [ ] **Lecture playback flag-gated** : `resolvePlaybackTarget` (`norva-playback`) lit
      `playback_hint` depuis `catalog_media_items` (global) + creds per-user, derrière
      `NORVA_CATALOG_MEDIA_READ_SOURCE` (défaut OFF). _Touche la lecture (critique) → incréments
      sûrs + mirror-verify clean d'abord._
- [ ] **Lecture grille/live flag-gated** : `listMediaItems` + rails live lisent le global
      (overlay), filtrage/état restent per-user.
- [ ] **Amincir le per-user** : une fois les reads stables sur le global, réduire
      `cloud_media_items` / `cloud_live_*` / `cloud_title_variants` à un **lien d'appartenance**
      (`user_id, source_id, external_id, available`) + `VACUUM FULL`. **C'est ici que le gain
      stockage se matérialise.**
- [ ] **Test de dédup réel** : ré-importer super8k (user A) **dans le schéma global** + ajouter
      un **2ᵉ user même provider** → vérifier `dup_factor ≈ 2` côté per-user mais **+0 stockage
      global** (le vrai test « des milliers d'users d'un provider connu »).
- [ ] **Flip à l'échelle** : poser les secrets de lecture quand le recoupement multi-user est
      matériel. Aujourd'hui ~0 gain (1 user réel) ⇒ on **construit maintenant** (calme,
      réversible), on **bascule plus tard**.

### Leviers egress restants (optionnels)
- [ ] Élargir l'allowlist images à **tout https** si exposer le host fournisseur est acceptable
      (+~5% d'egress images), ou proxifier le reste via **Cloudflare** (egress hors Supabase).
- [ ] Refactor play-from-grid → fetch détail ⇒ permet selects parcimonieux (−53% payload liste).
- [ ] Cache EPG **partagé persistant** (table/KV) — relief compute/ingress (pas egress).

---

## 🔁 Reprise rapide (commandes)

```sql
-- mesurer le multiplicateur de dédup (monte avec le nb d'users/provider)
select * from public.catalog_dedup_report();
-- (re)peupler les tables globales depuis le per-user
select public.backfill_catalog_from_cloud();
-- taille DB + part du quota free
select pg_size_pretty(pg_database_size(current_database())),
       round(100.0*pg_database_size(current_database())/(512*1024*1024)) as pct_quota;
-- état super8k (en pause)
select id, sync_status, config_hint->>'paused' from cloud_sources;
```

## ↩️ Réversibilité
Tout est additif : `drop table catalog_media_items, catalog_title_variants,
catalog_live_logical_channels, catalog_live_variants cascade;` + drop des 2 fonctions annule
la Phase 2 sans toucher au per-user (qui reste la source de vérité tant que les flags sont OFF).
La purge super8k est rejouable (ré-import via le sync resumable). Le fix images se révoque en
retirant `DIRECT_IMAGE_CDN` de `cloudApi.js`.
