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

### Mirror-verify + lecture playback flag-gated — construit + testé (live, flag OFF)
- [x] **`catalog_media_mirror_diff(p_source_id)`** — le gate avant bascule : prouve que le global
      est un miroir fidèle du per-user. Migration `20260627190000`. **Vérifié sur apdxes (40 585
      comparés)** : `cloud_only=0`, `mismatch_playback_hint=0`, `mismatch_metadata=0`,
      `global_weaker_*=0` ⇒ **miroir 100% fidèle**, gate VERT pour la bascule playback.
- [x] **Lecture playback flag-gated** : `resolvePlaybackTarget` (`norva-playback`) lit
      `playback_hint`/`metadata` depuis `catalog_media_items` (global, par `server_host`) avec
      **fallback per-user** (un miss global ne casse jamais la lecture), derrière
      `NORVA_CATALOG_MEDIA_READ_SOURCE` (défaut OFF). `deno check` OK ; déployé (défaut OFF =
      lecture per-user inchangée). Comme le mirror-verify prouve `playback_hint` identique,
      flag-ON est **prouvé équivalent**.

### Lecture grille flag-gated + amincissement — construits + testés (live, flag OFF)
- [x] **Lecture grille flag-gated** : `listMediaItems` (`norva-catalog`) **superpose** poster/
      backdrop/subtitle/metadata/playback_hint depuis `catalog_media_items` (`applyMediaCatalogOverlay`,
      par `server_host`) quand `NORVA_CATALOG_MEDIA_READ_SOURCE=catalog_media_items`. La requête
      per-user garde membership/tri/pagination ; l'overlay ne remplit que si le global a une valeur
      (miss/flag-off/global vide ⇒ données per-user inchangées). `deno check` OK, **déployé** (défaut
      OFF). _Approche overlay (comme Phase 1) plutôt que réécrire la requête = sûr sur ce chemin._
- [x] **Amincissement per-user** : `thin_source_media_items(p_source_id)` vide poster/backdrop/
      subtitle/metadata/playback_hint des lignes `cloud_media_items` **uniquement là où le global les
      détient** (l'overlay refill toujours) ; garde title + colonnes de tri + membership. **Validé en
      transaction rollback** : 40 585 lignes, **100% des champs récupérables du global** (meta 40585/
      40585, playback_hint 40585/40585), per-user lourd **282 B → ~10 B/ligne**, puis ROLLBACK (rien
      persisté). Migration `20260627200000`. **GATÉ SUR L'ÉCHELLE — pas exécuté à 1 user** (à 1 owner,
      global + per-user aminci coûte PLUS qu'une ligne per-user pleine ; le gain n'apparaît qu'à 2+
      users même provider). Un-thin = refill depuis le global (SQL ci-dessous).

```sql
-- un-thin (réversibilité) : refill les champs amincis depuis le global
update cloud_media_items m set
  poster_url = coalesce(nullif(m.poster_url,''), g.poster_url),
  backdrop_url = coalesce(nullif(m.backdrop_url,''), g.backdrop_url),
  metadata = case when m.metadata='{}'::jsonb then g.metadata else m.metadata end,
  playback_hint = case when m.playback_hint='{}'::jsonb then g.playback_hint else m.playback_hint end
from catalog_media_items g
where g.server_host=(select config_hint->>'serverHost' from cloud_sources where id=m.source_id)
  and g.item_type=m.item_type and g.external_id=m.external_id and m.source_id='<source>';
```

---

## ⏳ RESTE À FAIRE (Phase 2, multi-session, additif + réversible)

Ordre conseillé. Tout reste **derrière un flag par défaut OFF** ⇒ zéro impact tant que non basculé.
- [ ] **Lecture live flag-gated** : rails/grille live lisent `catalog_live_*` (même overlay), état per-user.
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
