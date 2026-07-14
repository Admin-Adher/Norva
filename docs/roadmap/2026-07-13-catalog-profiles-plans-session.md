# Session 2026-07-13 (2) — nav TV catalogue, profils plein écran, modèle d'abonnement & lifecycle

**Statut : commits livrés sur `main` (front auto-Cloudflare ; edge redéployé sur Hetzner). Le mode `limits` (#10) a été REVERTÉ le jour même — voir §10.**

Suite du log `2026-07-13-session-log.md` (nav Live + synchro cloud). Cette session couvre : la nav D-pad des pages **Movies/Séries**, la refonte **plein écran des profils** sur TV, un **audit « pubs vs réel »** des abonnements, la bascule du **différenciateur de plan** (profils, plus flux), le **verrouillage des profils** au downgrade, et le **découpage du flag lifecycle** billing. ⚠️ Un 10ᵉ point (mode `limits`) a été ajouté **puis reverté** après avoir constaté que le paiement Revolut est déjà en prod (cf. §10). Enfin, un **diagnostic ops** (santé des 49 crons, complétude du catalogue, fix sous-titres IA) est consigné en §11 avec ses requêtes SQL réutilisables.

| # | Sujet | Commit `main` | Fichiers clés |
|---|---|---|---|
| 1 | Nav D-pad Movies/Séries (workflow) | `7f0fb5f` | `tvNavigation.js` (v17), `main.css` (v78) |
| 2 | Profils TV plein écran, auto-scale, zéro scroll (workflow) | `362607a` | `profiles.js` (v9→ voir #5) |
| 3 | Audit pubs vs réel (workflow) | `d09ce43` | `docs/roadmap/2026-07-13-plans-vs-features-audit.md` |
| 4 | Plan = **profils (2/5)**, plus flux + 3 sur-promesses corrigées | `0fe8549` | `entitlements.ts`, `subscribe/landing/index.html` |
| 5 | Verrouillage non destructif des profils au downgrade + upsell | `fcdaca0` | `norva-cloud/index.ts`, `profiles.js` (v9) |
| 6 | Restauration du copy rappel J‑2 (crons DB live) | `5d6c180` | `subscribe/landing/index.html` |
| 7 | Pépites landing : sous-titres IA, Cast, self-healing | `f120db4` | `landing.html`, `index.html` |
| 8 | Lifecycle : flags par-flux + correctifs des bloqueurs | `57fd2f3` | `norva-lifecycle/index.ts`, `lifecycle-email.ts` |
| 9 | Lifecycle : claim atomique dunning + câblage des flags edge | `c90afbc` | `norva-lifecycle/index.ts`, `docker-compose.supabase.yml`, `.env.hetzner.example` |
| 10 | ~~Mode entitlements `limits`~~ **REVERTÉ** (`72a541d`) — prémisse fausse, cf. §10 | `311a4e9` → `72a541d` | `entitlements.ts`, `norva-cloud/index.ts`, `norva-playback/index.ts`, `.env.hetzner.example` |
| 11 | Fix sous-titres IA : jamais de traduction vers une cible « non-langue » (und/mul/zxx/mis) | `23cc117` | `norva-playback/index.ts` |

Méthode : 4 workflows multi-agents (nav Movies/Séries, fit profils TV, audit features, flag-readiness lifecycle), chacun avec vérification adverse ; harnais headless Playwright pour la nav + le fit + le verrouillage.

---

## 0. Rappels d'infra (à relire avant de toucher)

- **TV = WebView ~853×480 px** (1920/2.25 × 1080/2.25). Le CSS TV doit **rétrécir**, pas grossir.
- **Front** = Cloudflare Pages auto sur push `main`. **Edge** = box Hetzner : `ssh adrien@norva-db` (déjà dessus) → `git pull` → `ops/hetzner/scripts/04-deploy-edge-functions.sh`. ⚠️ **Ne pas** préfixer `ssh adrien@norva-db &&` (tu es déjà sur la box → le `&&` casse le `git pull`).
- **`04-deploy-edge-functions.sh` fait un `restart`** → recharge le CODE, mais **pas** les nouvelles variables d'env du compose. Pour de nouvelles vars : `docker compose --env-file .env -f ops/hetzner/docker-compose.supabase.yml up -d functions` (recréer).
- **`deno.lock`** est gitignoré (artefact de `deno check`, hors build edge).

---

## 1. Nav D-pad Movies & Séries (`7f0fb5f`) — `tvNavigation.js` v17

Le moteur n'avait **aucune garde** pour ces pages (seul `page-live` l'était). Corrigé, tout scopé `.tv-mode`, **26/26** au harnais + suites Live intactes :
- **Grille** : le ♥ favori (opacity:1) et le badge « N versions » de chaque carte étaient des **cibles D-pad** → Haut/Bas/Droite atterrissaient sur le coin de la carte. Retirés des candidats.
- **`navScope()`** : confine le D-pad à un **panneau multi-select** ou une **fiche** ouverte (comme un modal). BACK/Escape ferme via `closeTransient()`.
- **Fiche** : focus à l'ouverture sur Play/Reprendre (même si « Loading… » puis activé) ; retour = carte d'origine ; Back matériel sur fiche **film** revient à la grille (avant : sortait vers l'accueil).
- **Bord de grille/continue** : flèche gauche → rail (au lieu de dériver vers un filtre). **Entrée** de page → 1ʳᵉ carte (façon Netflix).
- **CSS** : la barre de contrôles (source/catégories/recherche/favoris) restait en grille mobile 1fr/1fr/44px à 853 px → override tv-mode en ligne flex.

## 2. Profils TV plein écran (`362607a`) — puis v9

Tous les écrans profils **scrollaient** sur 480 px (559–848 px de haut). Refonte hybride (**7/7** harnais) :
- **Base CSS compacte** `html.tv` : avatars 112 px, titre `clamp(24px,4.4vh,34px)` (la police suit la hauteur d'écran), 12 avatars sur **une** ligne, 6 cartes sur **une** ligne.
- **`fitPanel()`** : après rendu, scale le panneau pour tenir l'écran (`transform:scale`, snap à 1 si ≥0.985, plancher 0.5) ; re-calcul au resize/font. Overlay `overflow:hidden` → **ne peut plus scroller**.
- Corrige un **bug de spécificité** (l'aperçu `np-avatar np-avatar-lg` ballonait à 200 px), **supprime le `window.confirm`** natif au profit de NorvaModal sur TV, **pas de clavier auto**, **noms longs** en ellipsis.

## 3. Audit « pubs vs réel » (`d09ce43`) — doc dédiée

Workflow : **52 promesses** de copy vs **172 fonctionnalités réelles** (22/26 vérifiées). Détail complet dans **`2026-07-13-plans-vs-features-audit.md`**. Têtes d'affiche : un **étage IA sous-titres** (Whisper + Argos + OCR), Cast, self-healing, jamais vendus ; et des sur-promesses (export RGPD inexistant, offline « app Android » only, etc.).

## 4. Plan = profils (2 vs 5), pas flux (`0fe8549`)

**Subtilité produit** : le nombre de **flux simultanés dépend du fournisseur IPTV**, pas de Norva → on ne le vend plus. `entitlements.ts` :
- **`plus.profiles 5→2`, `family` reste 5** ← seul différenciateur.
- `concurrent_streams` → **10 identique** (trial/plus/family) : garde-fou backend silencieux, jamais annoncé.
- Copy corrigé (subscribe/landing/index) : profils au lieu de flux ; mot **« export »** retiré (RGPD) ; **offline** qualifié « Android app » ; message d'erreur de capacité neutralisé.

## 5. Verrouillage des profils au downgrade (`fcdaca0`) — `profiles.js` v9

Un Family (5 profils) → Plus (2) **garde tout**, mais les profils en trop passent **verrouillés** (non destructif, façon Netflix/SaaS) :
- **Ensemble actif figé & non-permutable** : principal + les plus **anciens** (`created_at` immuable, pas `sort_order`). Déblocage = upgrade **ou** supprimer un profil actif. **Pas de swap libre** (sinon la limite ne sert à rien).
- **Serveur** (`norva-cloud`) : `activeProfileIdSet()` ; `listProfiles` renvoie `locked` ; `resolveProfileId` **refuse** un profil verrouillé même si le client force l'en-tête (retombe sur le défaut).
- **Client** : cartes verrouillées grisées + cadenas ; clic = **upsell contextuel** (web/mobile → `/subscribe.html` ; **TV** → modale « upgrade depuis ton téléphone/le web », car **pas d'achat sur TV**) ; re-affiche le picker si le profil actif devient verrouillé.

## 6. Copy rappel J‑2 restauré (`5d6c180`)

Le workflow lifecycle a révélé que le rappel J‑2 est **déjà envoyé** par **2 crons DB** (`norva-trial-ending-3d`/`-1d`, migration `20260708120000`), **indépendants du flag** — d'où les emails reçus en test. La promesse est donc **tenue** → copy restauré (mon adoucissement précédent était basé sur le mauvais chemin de code).

## 7. Pépites landing (`f120db4`)

3 cartes ajoutées (Skip Intro exclu — inopérant sur IPTV) : **« AI subtitles, in your language »** (génération+traduction+OCR), **« Cast to your TV »**, **« Self-healing playback »**.

## 8–9. Lifecycle : flags par-flux + bloqueurs (`57fd2f3`, `c90afbc`)

Workflow flag-readiness → **verdict : ne PAS flipper le flag unique** (il activait 5 flux, dont 4 dangereux). Refonte :
- **Flag maître + 5 flags par-flux** (`NORVA_LC_TRIAL/DUNNING/EXPIRE/WINBACK/ABANDONED`, tous **OFF** par défaut). `NORVA_LIFECYCLE_BILLING_LIVE=true` seul **n'active plus rien**.
- **Dunning + trial** → `provider='revolut'` (les past_due Play/Apple sont gérés par le store).
- **Trial** reste OFF (les crons DB sont le vrai chemin → sinon double envoi).
- **Expire** : UPDATE gardé `status='past_due'` (ne pas expirer quelqu'un qui a payé entre-temps).
- **Doublons** : CAS atomique `claimMarker()` sur welcome/trial/winback **et** dunning (claim `dunning_last_at` avant envoi, rollback si échec).
- **Légal** : header `List-Unsubscribe` + lien de désinscription + adresse postale (`NORVA_POSTAL_ADDRESS`) en pied. Winback/abandoned restent OFF (consentement + one-click unsubscribe requis ; abandoned lit encore la table **Stancer retirée** → repointer sur `cloud_revolut_orders`).
- **Câblage** : les vars `NORVA_LC_*` + `NORVA_POSTAL_ADDRESS` **n'étaient pas passées** au conteneur `functions` → ajoutées au compose (défaut false). Revue adverse du diff → **SAFE**.

Revue adverse (agent) du diff lifecycle : aucun bloqueur — CAS, gating, provider-scope, garde expire tous corrects.

## 10. Mode entitlements `limits` — AJOUTÉ PUIS REVERTÉ (`311a4e9` → `72a541d`)

> **Compte-rendu d'incident (mineur, 0 utilisateur impacté).** À garder pour ne pas refaire l'erreur.

**Ce qui s'est passé.** J'ai codé un 3ᵉ mode d'entitlements `limits` (appliquer les caps de plan **sans** le mur d'accès facturation), sur la **prémisse fausse** que le paiement n'était pas prêt et que l'`enforce` trouvé sur la box était un défaut accidentel. J'ai même basculé la box `enforce` → `limits`.

**La réalité (que je n'avais pas lue).** `docs/BILLING-REVOLUT-MIGRATION.md` **Phase 6** : le **paiement Revolut est en PRODUCTION depuis le 2026-07-11**, validé **vraie carte Mastercard**. L'état de prod **délibéré et validé** est **`NORVA_ENTITLEMENTS_MODE=enforce` + `NORVA_BILLING_MODE=revenuecat`** (+ front `billing-config.js` `revolut.enabled:true`/`mode:prod`, git `d45ffb1`/`c2b0f9d`/`38496eb`). L'`enforce` de la box **n'était donc pas un accident** — c'était le paywall soft voulu (non-abonné → palier `free`, browse sans lecture, s'abonne via Revolut ; bypass admin).

**Pourquoi 0 dégât.** `billingMode` était **`revenuecat`** en permanence. Dans ce mode, un soft-denial passe par `freeBrowseDecision` (`allowed:true`, `concurrent_streams:0`), que `limits` laissait passer tel quel → **le paywall a tenu**. Seule fuite théorique de `limits` vs `enforce` en revenuecat : un `past_due` toutes grâces expirées (`billing_unverified`, `allowed:false`) serait ouvert au lieu d'être bloqué — **aucun** des 5 comptes test n'était dans ce cas. Fenêtre ~1 h, aucun paiement raté.

**Remédiation** (cette session) :
- Box **remise en `enforce`** — health vérifié : `entitlementsMode:"enforce"` + `entitlementsEnforced:true` + `billingMode:"revenuecat"`.
- Commit `311a4e9` **reverté** (`72a541d`) : le mode `limits` est retiré du code (footgun : un `limits` mal posé affaiblit le paywall — inutile puisque le paiement est live).
- `.env.hetzner.example` : commentaire corrigé (2 modes ; **prod = `enforce`+`revenuecat`, Revolut live** ; `observe` = rollback d'urgence uniquement).

**Leçon** : lire `BILLING-REVOLUT-MIGRATION.md` **avant** de toucher à `NORVA_ENTITLEMENTS_MODE`/`NORVA_BILLING_MODE`. L'état de prod est `enforce`+`revenuecat` — pas à « décider », déjà validé.

## 11. Diagnostic ops — crons, complétude catalogue & fix sous-titres (`23cc117`)

Revue de santé du serveur (box `norva-db`, pg_cron) + audit de l'avancement du catalogue.

**Santé des crons** : **49 crons, tous actifs, 0 échec sur 48 h.** Les crons « lourds » (whisper/sous-titres/audio/reconcile) sont **gatés sur la nuit** (`0-5 * * *` / `1-4 * * *`) → à l'arrêt en journée **par design** (fix post-incident Live 458, §67 du log précédent), pas un blocage. Facturation OK : `norva-revolut-billing` (renouvellements horaires), `norva-trial-ending-3d/-1d` (rappels essai 9h), `norva-lifecycle` (15 min, flags OFF).

**Complétude catalogue** (≈395 K titres browsables, `cloud_titles` par-utilisateur) :
- **Matching TMDB : ~99,5 % traité** — 57 % `provider_verified`, 42 % `unmatched` (résidu IPTV non-matchable, **pas** un backlog), 0,5 % non traités.
- **Année de sortie : 84 %** · **Revalidation / Whisper LID : quasi finis** (2,1 K / 1,2 K restants).
- **Backlogs lents (nuit)** : **langues audio 37 %** (~251 K restants), **sous-titres sondés 44 %** (~220 K), **langue originale 43 %** (~72 K, cache global `catalog_titles`, bridé API TMDB). Ils avancent, 0 échec.

**Sous-titres IA : fonctionnels** (57 jobs `ready`). Les 12 `failed` étaient **100 % côté fournisseur** (extraction du flux) : `401/400` auth panel, `4XX` super8k, fichiers tronqués/timeout, codec exotique. **4 permanents purgés** (`DELETE … WHERE status='failed' AND error LIKE …`), 8 transitoires laissés (auto-retry après cooldown 24 h). Un job `failed` a un **cooldown 24 h** puis se ré-essaie à la demande.

**Fix (`23cc117`)** : un des 12 était un `translate gateway 422` — la validation cible `/^[a-z]{2,3}$/` laissait passer les codes ISO « non-langue » (`und`/`mul`/`zxx`/`mis`) → job de traduction voué au 422. Garde-fou `NON_TRANSLATABLE_LANGS` sur **les 2 voies d'enfilage** (`translateEnqueue` direct → renvoie `unsupported-target` ; boucle callback `resolvePendingTranslations` → `failPending`). Vraies langues intactes, `deno check` propre, déployé.

### Requêtes SQL réutilisables (box : `docker exec -i norva-db psql -U supabase_admin -d postgres`)
- **État des crons** : `SELECT jobname, schedule, active, <dernière exéc via cron.job_run_details> …` (3 vues : inventaire+dernier run, santé 24 h, échecs 48 h — cf. historique de session).
- **Complétude catalogue** : `count(*) FILTER (WHERE …)` sur `cloud_titles WHERE variant_count>0` — prédicats « restant » par pipeline : search-match `match_status='unmatched'` · année `release_year IS NULL AND provider_tmdb_id IS NOT NULL` · audio `audio_languages='{}'` · whisper `audio_tracks @> '[{"lang":null}]'` · sous-titres `subtitle_probed_at IS NULL` ; origlang sur `catalog_titles` (`original_language IS NULL`).
- **Sous-titres failed** : `SELECT provider_key, kind, lang, error, updated_at, (updated_at < now()-interval '24h') AS retriable FROM catalog_generated_subtitles WHERE status='failed'`.

---

## 12. Regroupement des films multi-langues (`4315891`, `760f227`, `5854b8c`)

**Symptôme** : un même film apparaissait en plusieurs fiches — « Lilo & Stitch » regroupait 24 versions mais les variantes Polish/English/Español faisaient bande à part. La recherche montrait le film deux fois, avec des comptes « N versions » faux.

**Deux bugs indépendants, un par étage :**

**(1) Client — `groupItems` (`mediaUtils.js` v13→v14, `4315891`)** : la fonction ne lisait que `item.tmdb_id`, mais la grille Films sérialise l'id TMDB matché sous `provider_tmdb_id`/`providerTmdbId` (seuls recherche + rails d'accueil hoistent un `tmdb_id` plat). → la branche forte `t:` était **morte sur la grille**, chaque variante localisée retombait sur un slug de nom et fragmentait. Correctif : lire tous les alias (`tmdb_id` > `provider_tmdb_id` > `providerTmdbId` > `tmdb.id`), garde sur les sentinelles no-match `'0'`/`'tt0'`. **8/8 headless** (Node/vm). Déjà **live** sur norva.tv.

**(2) Serveur — re-key + merge (`760f227`, reload PostgREST `5854b8c`)** : `cronSearchMatch` (norva-source-sync) stampe un `provider_tmdb_id` sur les titres autrefois `unmatched` **sans re-clé** l'`identity_key` → une copie localisée matchée garde sa clé `norm:<slug>` et cohabite avec la ligne canonique `tmdb:<id>` au lieu de fusionner. La dédup one-shot de juin (`20260623220000`) n'avait tourné **qu'une fois** ; chaque match depuis refragmentait. Correctif :
- Nouvelle fonction `public.dedupe_cloud_titles_by_tmdb(p_user uuid default null)` (SECURITY DEFINER, `grant … to service_role`) : généralise la fusion de juin (remplir les trous canoniques, re-pointer les variantes, supprimer les doublons, recalculer les rollups) + **lone-row promote** (re-clé un match unique `norm:`→`tmdb:<id>` pour que la variante suivante se replie), garde `NOT EXISTS` contre la contrainte unique. **Idempotente**. `NOTIFY pgrst` en fin pour que `db.rpc()` la voie sans redémarrer `rest`.
- `cronSearchMatch` l'appelle **scopée par compte** après chaque batch → auto-guérison en continu.

**Réparation globale (à l'apply, box)** : **54 298 titres en double repliés + 21 367 re-clés** vers `tmdb:<id>`. La fragmentation touchait des dizaines de milliers de fiches accumulées depuis juin.

**Vérif** : Postgres 16 jetable + le vrai trigger de rollup, tous les cas assertés (fusion localisée, non-matché tmdb null → séparé, sentinelle, collision unique bloquée, isolation `p_user`, 2ᵉ run `(0,0)`, aucune variante perdue). `deno check` propre.

### Réutilisable (box : `docker exec -i norva-db psql -U postgres -d postgres`)
- **Nettoyage global à la demande** : `SELECT public.dedupe_cloud_titles_by_tmdb();` (idempotent, no-op si propre).
- **Un seul compte** : `SELECT public.dedupe_cloud_titles_by_tmdb('<user_uuid>');`.
- **Appliquer une migration SQL** (host sans psql) : `docker exec -i norva-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/<fichier>.sql`.

---

## 13. ⚠️ CORRECTIF du §12 — la grille Movies lit une AUTRE couche (trace vérifiée)

Le §12 laissait entendre que le fix (2) répare la grille Films. **FAUX.** Trace complète (workflow `wy6f7xbf7`, 3 traceurs client/serveur/asset) :

**Il y a DEUX couches de dédup indépendantes :**
| Couche | Table lue | Clé de dédup | Alimentée par |
|---|---|---|---|
| **Recherche / rails / accueil** | `cloud_titles` (projection) | `identity_key` | `titleRailItem` — **c'est ça que le fix (2) répare** |
| **Grille Movies/Series** | `cloud_media_items` (**BRUT**) | `is_dedup_primary` + `dedup_key` (colonnes sur la ligne brute) | `norva_reconcile_catalog` → `norva_backfill_media_identity` |

- La grille appelle `norva-catalog/media-items` → RPC `list_media_items_deduped` → lit `cloud_media_items WHERE is_dedup_primary` (fast-path `20260704271000`), **jamais `cloud_titles`**. L'id TMDB brut vit sous `metadata.providerTmdbId` ; groupItems v14 le regroupe côté client sur la vue source-filtrée, mais la vue par défaut ne renvoie qu'**une ligne `is_dedup_primary` par groupe** → c'est le flag serveur qui compte.
- Le flag brut est propagé depuis `cloud_titles` par **`norva_backfill_media_identity`** (`dedup_key = ct.identity_key`), lui-même appelé par **`norva_reconcile_catalog`** (= `norva_canonicalize_titles_for_user` [merge, **doublonne mon `dedupe_cloud_titles_by_tmdb`**] + backfill + posters). Cron **`norva-catalog-reconcile`** `3-59/20 0-6 * * *` (actif) → **la grille se répare seule chaque nuit**.

**Conséquence de mon merge global fix (2)** : re-clé de 54 K `identity_key` → périme les `dedup_key` des lignes brutes correspondantes sur **tous** les comptes → grosse **dette de reconcile** (ex. compte `c5be5ac4` : **82 507** lignes périmées / 275 477 items). Drainé manuellement en ~17 passages `norva_reconcile_catalog(user)` (batch 5000, plafond 120 s) ; le reste (global) éponge sur 1–3 nuits via le cron. **`ambiguous_items=0`** vérifié → convergence garantie, pas d'oscillation.

**Leçon** : pour la grille, le levier n'est PAS `cloud_titles` mais la couche brute — et le pipeline `norva_reconcile_catalog` existait déjà. Mon fix (2) a accéléré le côté `cloud_titles` (search/rails, réel) mais a **réinventé** l'étape `canonicalize` + créé une dette grille. Le fix (1) client v14 reste utile. **Décision : option A** — ne rien rajouter, laisser le reconcile nocturne converger ; `dedupe_cloud_titles_by_tmdb` reste dormant comme outil de merge manuel.

### Réutilisable — couche grille (box)
- **Propager `cloud_titles`→grille pour un compte** : `SELECT norva_reconcile_catalog('<user>');` (renvoie `{titles_merged, posters_refreshed, media_rows_reconciled}` ; `media_rows_reconciled=5000` = plafond atteint, relancer).
- **Mesurer le retard** : `SELECT count(*) FROM cloud_media_items mi JOIN cloud_title_variants v ON v.media_item_id=mi.id JOIN cloud_titles ct ON ct.id=v.title_id WHERE mi.user_id='<user>' AND mi.dedup_key IS DISTINCT FROM ct.identity_key;`
- **Re-enrich TMDB ciblé d'un compte** : `POST $FUNCTIONS_BASE_URL/norva-source-sync/cron/search-match?user=<uuid>&limit=1500&conc=15` (Bearer `$SERVICE_ROLE_KEY`).

---

## ⚠️ À NE PAS OUBLIER (ops)

1. ✅ **Edge redéployé** (#5 `norva-cloud`, #8/#9 `norva-lifecycle`) — fait cette session via `git pull` + recréation du conteneur `functions`. Tout lifecycle reste OFF. ⚠️ **Le revert `72a541d` du mode `limits` n'est pas encore sur la box** — à récupérer au prochain `git pull` + `up -d functions` (sans effet de comportement : la box est en `enforce`, qui n'utilise pas la branche `limits`). Rappel : `restart` recharge le **code** mais pas les **nouvelles vars d'env** → pour tout `NORVA_LC_*`/`NORVA_ENTITLEMENTS_MODE`, il faut `docker compose --env-file ops/hetzner/.env -f ops/hetzner/docker-compose.supabase.yml up -d functions` (recréer).
2. 🔒 **`NORVA_ENTITLEMENTS_MODE=enforce` + `NORVA_BILLING_MODE=revenuecat` = état de PROD validé** (paiement Revolut live depuis le 2026-07-11 — cf. §10 + `BILLING-REVOLUT-MIGRATION.md`). **NE PAS** repasser en `observe` (ni `limits`, retiré) sauf **rollback d'urgence** : ça réouvre tout et affaiblit le paywall. Vérif : `curl -s https://api.norva.tv/functions/v1/norva-cloud/health | grep -o 'entitlementsMode\|billingMode'` → doit rester `enforce`/`revenuecat`.
3. **Activer le lifecycle plus tard** : jamais `EXPIRE` sans `DUNNING` (couperait sans avertir). Combo `NORVA_LIFECYCLE_BILLING_LIVE=true` + `NORVA_LC_DUNNING=true` (+ `NORVA_LC_EXPIRE=true`), puis **recréer** le conteneur (`up -d functions`, pas restart). Prérequis : cron `norva-lifecycle` enregistré, `RESEND_API_KEY` + expéditeur `norva.tv` vérifié.

## Versions d'assets finales
`tvNavigation.js` v17 · `main.css` v78 · `profiles.js` v9 · `mediaUtils.js` **v14** (regroupement TMDB, §12) · (`api.js` v70, `cloudApi.js` v47, `ChannelList.js` v43, `LiveGuideFusion.js` v27, `WatchPage.js` v117 inchangés depuis le log précédent).

## Harnais headless (scratchpad de session, non versionnés)
`ms-nav-harness.html` + `ms-nav-test.js` (26/26 nav Movies/Séries), `prof-harness.html` + `prof-measure.js` (7/7 no-scroll) + `prof-lock-test.js` (7/7 verrouillage). Chromium `/opt/pw-browsers/chromium-1194`, Playwright `/opt/node22/lib/node_modules/playwright`.
