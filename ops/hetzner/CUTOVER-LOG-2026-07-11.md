# Journal de bascule DB → self-host Hetzner — 2026-07-11

> 🏁 **BASCULE EFFECTUÉE le 11/07/2026** : l'app (norva.tv) tourne sur le self-host
> (`api.norva.tv` → Caddy/TLS → Kong), login + catalogue + grilles **validés en prod**,
> **crons : 47 actifs self-host / 0 actif managé** (runs `succeeded` vérifiés).
> Le **managé reste en place, endormi** (données intactes, crons désactivés via
> `cron.alter_job`) = rollback complet possible. Voir §9 pour l'état final + le reste à faire.
>
> ⚠️ **TODO sécurité** (post-bascule, non bloquants) :
> 1. Clé privée FCM (`firebase-adminsdk-fbsvc@norva-ecosystem`, key id
>    `2ec8956985f298a9397ed1530682efd471578d93`) a transité **en clair** → régénérer
>    (Firebase → Service accounts → Keys) et re-poser dans `.env`.
> 2. Un mot de passe personnel a été tapé en clair dans le terminal/chat pendant la nuit →
>    le changer partout où il sert.

---

## 0. Résumé exécutif (où on en est)

| Bloc | État |
|---|---|
| Stack PG17 self-host (10 services) | ✅ **UP & healthy** |
| Schéma `public` (71 tables) | ✅ restauré, **parité parfaite** |
| Data (`cloud_media_items` = 906 087, etc.) | ✅ **identique au managé** |
| Comptes `auth` (6 users + 6 identities) | ✅ migrés |
| `storage` (1 bucket ; fichiers déférés) | ✅ métadonnées |
| GUCs (timeouts rôles) + dual-write dormant | ✅ appliqués |
| 3 secrets vault (backfill/cron/resend) | ✅ transférés (vault + `.env`) |
| Crons | ✅ **49 recréés, 47 actifs self-host / 0 actif managé**, runs `succeeded` |
| Secrets fonctions (cœur) | 🟢 **OK** — TMDB posé, média/relay via DB, emails/cron faits |
| Secrets fonctions (optionnels) | 🟢 FCM posé (⚠️ **clé à re-générer**) · `NORVA_ENTITLEMENTS_MODE`=`observe` · Stancer zappé (refonte paiement post-migration) |
| Caddy/TLS `api.norva.tv` | ✅ Caddy 2.11 + Let's Encrypt → `127.0.0.1:8000` (Kong) |
| Repoint app + deploy Pages | ✅ commit `448878d`, déployé, **validé en prod** |
| Kong ↔ clé frontend | ✅ `SUPABASE_PUBLISHABLE_KEY` ajoutée au `.env` (voir §8bis) |

---

## 1. Reconstruction de la stack sur Postgres 17 (commit `0309f65`)

Cause racine des échecs précédents : on forçait `POSTGRES_USER=postgres` (écrasait le
bootstrap `supabase_admin` de l'image) **et** l'image était en PG15 alors que le managé
est en **PG17.6**. Corrigé en re-basant tout sur le `supabase/docker` officiel :

- `docker-compose.supabase.yml` : `supabase/postgres:17.6.1.136`, **`POSTGRES_USER` non défini**
  (défaut image = `supabase_admin`), **7 fichiers d'init** montés (realtime/webhooks/roles/jwt/
  _supabase/logs/pooler), volume nommé `db-config` (clé pgsodium), `config_file` = celui de
  l'image + tuning 64 Go en overrides `-c`. Ports bindés en `127.0.0.1`.
- `volumes/db/*.sql` : 7 scripts d'init officiels verbatim.
- `volumes/api/kong.yml` + `kong-entrypoint.sh` : Kong 3.9.1 déclaratif officiel.
- `supabase/functions/main/index.ts` : routeur edge-runtime (dispatch `/functions/v1/<name>`).
- Images bumpées aux versions officielles PG17 (gotrue 2.189, postgrest 14.12, realtime 2.102.3,
  storage 1.60.4, imgproxy 3.30.1, meta 0.96.6, edge-runtime 1.74.0, studio 2026.07.07).
- `.env.hetzner.example` : nouvelles vars (PG_META_CRYPTO_KEY, SECRET_KEY_BASE, JWT_EXPIRY,
  KONG_HTTP/HTTPS_PORT, API_EXTERNAL_URL, PGRST_DB_SCHEMAS, FUNCTIONS_VERIFY_JWT…).

### `.env` de la box — vars ajoutées cette session
- `PG_META_CRYPTO_KEY`, `SECRET_KEY_BASE` (générés sur la box), `API_EXTERNAL_URL=https://api.norva.tv`.
- Ligne `POSTGRES_USER=postgres` **commentée** (`#POSTGRES_USER=postgres`).
- 3 secrets fonctions remplis via transfert vault : `NORVA_BACKFILL_TOKEN`, `NORVA_CRON_SHARED_SECRET`,
  `RESEND_API_KEY`.

---

## 2. Validation de la stack à vide

- `up -d db` → healthy : logs montrent `connected to database ... as user "supabase_admin"`
  (le bug `role "supabase_admin" does not exist` est mort), init process complete.
- `up -d` → **10 services `(healthy)`** : db, kong, auth, rest, realtime, storage, imgproxy,
  meta, studio, functions.
- Chaîne API vérifiée avec les **clés JWT réutilisées** :
  - `GET /auth/v1/health` (+ apikey anon) → JSON GoTrue 200 ✅
  - `GET /rest/v1/` (+ service key) → 200 ✅
  - `GET /rest/v1/<table>` (+ anon) → PostgREST atteint la DB ✅
  - Rappel : `/rest/v1/` **exactement** = route `rest-v1-openapi` **admin-only** (anon → 403
    « You cannot consume this service »). C'est **voulu** par Supabase, pas un bug.

---

## 3. Migration data (dry-run managé → self-host) — VÉRIFIÉE

Aucun outil client Postgres n'est installé sur la box → **tout passe par l'image
`supabase/postgres:17.6.1.136`** (pg_dump/psql v17 garantis).

### Connexion au managé
- Endpoint **direct** (`db.oupsceccxsonaalhueff.supabase.co:5432`) → `Connection refused`
  (désactivé/instable). On utilise le **Session pooler** :
  - hôte : `aws-1-eu-central-1.pooler.supabase.com`
  - port : `5432` (mode **session** = compatible `pg_dump`)
  - user : `postgres.oupsceccxsonaalhueff`
  - mot de passe : **réinitialisé** par l'utilisateur (16 car.) ; présent dans `.env`
    (`MANAGED_DB_URL`) et dans la var shell `MPW` (éphémère).
- Projet managé : `oupsceccxsonaalhueff`, région `eu-central-1`, PG **17.6.1.141**,
  `ACTIVE_HEALTHY`.

### Dump (dans `ops/hetzner/dump/`, gitignoré — sert aussi de **backup**)
| Fichier | Taille | Contenu |
|---|---|---|
| `00-globals.sql` | 5.7K | rôles (`--no-role-passwords`) |
| `01-schema.sql` | 316K | schéma `public` |
| `02-data.sql` | 2.5G | data `public` (`--disable-triggers`) |
| `03-auth-data.sql` | 23K | schéma `auth` (data) |
| `04-storage-data.sql` | 9.1K | schéma `storage` (data) |
| `ref-cron-jobs.tsv` | 21K | 49 crons (contient des secrets → **ne pas** afficher) |
| `ref-extensions.txt` | 162 | extensions |

### Restore (en **`supabase_admin`** = superuser, requis pour `--disable-triggers`)
- Extensions créées idempotemment (ajouts : `http`, `pg_cron` ; déjà là : uuid-ossp, pgcrypto,
  pg_trgm, unaccent, pgstattuple, pg_stat_statements, **pg_net**, supabase_vault).
- Globals : erreurs `reserved role ... only superusers can modify` = **attendues/bénignes**
  (les rôles existent déjà ; `postgres` n'est pas superuser, `supabase_admin` l'est).
- Schéma public : **1 erreur bénigne** (`schema "public" already exists`).
- Data public : **1 min 27 s, 0 erreur**. `cloud_media_items = 906087` (= managé).
- Auth : **6 users + 6 identities**. Erreurs bénignes : `custom_oauth_providers` (feature non
  utilisée), `\restrict` (quirk pg_dump 17), `schema_migrations` (conflit attendu).
- Storage : 1 bucket, 0 object (fichiers déférés, régénérables).
- `vacuum analyze` OK.

### Parité — **les 71 tables `public` identiques** au chiffre près
`cloud_media_items` 906087 · `cloud_title_variants` 739069 · `cloud_titles` 542090 ·
`cloud_live_variants` 139276 · `catalog_file_tracks` 133715 · `cloud_live_logical_channels`
131326 · `catalog_titles` 111833 · … (tables volatiles aussi identiques : trafic nul cette nuit,
donc **aucun** import entre le dump et la vérif).

---

## 4. Config post-restore appliquée

- **GUCs** (en `supabase_admin`) : `alter role anon set statement_timeout='3s'`,
  `authenticated='8s'`, `alter database postgres set app.norva_catalog_dual_write='0'`.
- **Vault** : les 3 secrets (`norva_backfill_token`, `norva_cron_shared_secret`, `resend_api_key`)
  transférés **box→box** (managé `vault.decrypted_secrets` → self-host `vault.create_secret`),
  jamais affichés. Aussi copiés dans `.env` (mêmes valeurs, pour les fonctions).
- **Crons** : 47 rejoués via `cron.schedule(...)` avec l'URL réécrite
  `…supabase.co/functions/v1` → `https://api.norva.tv/functions/v1`, puis **désactivés**
  (`update cron.job set active=false`) jusqu'à ce que Caddy expose `api.norva.tv`.

### Découvertes clés
- **pg_net** crée toujours son schéma `net` → `net.http_post` **résout** sur le self-host
  (aucun correctif nécessaire). 36/47 crons l'utilisent + lisent le vault au runtime.
- **Secrets fonctions write-only** : le dashboard Supabase n'affiche que des **digests SHA256**,
  pas les valeurs → les ~13 secrets restants doivent être **repris à la source**.

---

## 5. Ce qui RESTE — phase cutover fonctionnel

1. **Secrets fonctions** — ✅ **cœur résolu** (analyse du code + `cloud_runtime_config`) :
   - **Via DB `cloud_runtime_config`** (déjà migrée) — les fonctions lisent l'env PUIS la DB en
     fallback → **laisser VIDES** dans `.env` (sinon un placeholder écrase la DB) :
     `NORVA_MEDIA_GATEWAY_URL` (→ Railway), `NORVA_MEDIA_GATEWAY_TOKEN`, `NORVA_RELAY_BASE_URL`
     (→ Cloudflare Worker), `RELAY_TOKEN_SECRET`, `NORVA_SOURCE_CONFIG_KEY`.
   - **Défauts code sûrs → laisser vides** : `ALLOWED_ORIGINS` (norva.tv/www/app),
     `AUTH_EMAIL_FROM` (`Norva <noreply@norva.tv>`), `NORVA_TMDB_VALIDATE_LIMIT` (120),
     `NORVA_CATALOG_READ_SOURCE` (`cloud_titles`).
   - **Posés** : `NORVA_BACKFILL_TOKEN`, `NORVA_CRON_SHARED_SECRET`, `RESEND_API_KEY` (vault),
     `SEND_EMAIL_HOOK_SECRET` (retrouvé), **`TMDB_API_KEY`** (v3, 32 car.),
     **`FCM_SERVICE_ACCOUNT`** (JSON `norva-ecosystem` — ⚠️ **clé à re-générer**, cf. TODO en tête),
     **`NORVA_ENTITLEMENTS_MODE=observe`** (accès ouvert pendant la transition ; `normalizeEntitlementsMode`
     reconnaît `observe`/`gate0`/`off`, tout le reste → `enforce`).
   - **Volontairement vides** : `STANCER_SECRET_KEY`, `STANCER_WEBHOOK_TOKEN`, `NORVA_STANCER_MODE`
     — Stancer sera **remplacé** par une autre passerelle après la migration ; le billing tourne en
     no-op sans casser le reste.
   - → **`.env` complet pour le cœur.** Reste juste Caddy/TLS + repoint (points 4-6 ci-dessous).
2. `docker compose --env-file .env -f docker-compose.supabase.yml up -d functions` (recharge l'env).
3. Vérifier la config playback : tables `media_gateways` / `cloud_runtime_config` (le média-gateway
   n'est PAS un secret fonction → probablement piloté par la DB, déjà migrée).
4. **Caddy/TLS** : `api.norva.tv:443` → `127.0.0.1:8000` (Kong). Ouvrir 80/443 (ufw), cert
   Let's Encrypt. DNS `api.norva.tv` pointe déjà sur `157.180.96.159`.
5. **Repoint app** : `public/js/cloudApi.js` (URLs `…oupsceccxsonaalhueff.supabase.co` →
   `api.norva.tv`) + redeploy Cloudflare Pages. Webhooks Stancer/billing à repointer aussi.
6. **Activer les crons** : `update cron.job set active=true` (les 47) une fois `api.norva.tv` live.
7. Garder le **managé en lecture seule** quelques jours (rollback rapide).

---

## 6. État de la box (faits, sans secrets)

- Hetzner **AX42** Helsinki, IPv4 `157.180.96.159`, repo `~/norva` (branche `main`).
- Stack : `~/norva/ops/hetzner/docker-compose.supabase.yml`, projet compose `norva`.
- Data PG : `/var/lib/norva/db` · Storage : `/var/lib/norva/storage` · Dump : `~/norva/ops/hetzner/dump/`.
- Vars shell **éphémères** (perdues à la fermeture du terminal) : `MPW` (mdp managé), `PW` (mdp
  self-host), `IMG`, fonction `dpsql`. À ré-établir à la reprise (cf. §7).

---

## 7. Reprise — ré-établir les helpers (box)

```bash
cd ~/norva/ops/hetzner
PW=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
IMG=supabase/postgres:17.6.1.136
# psql self-host (superuser) via conteneur, avec le repo monté sur /work :
dpsql() { docker run --rm -i --network host -e PGPASSWORD="$PW" -v "$PWD:/work" -w /work "$IMG" \
  psql -h 127.0.0.1 -U supabase_admin -d postgres "$@"; }

# Mot de passe managé (pour re-dumper/parité) — saisie masquée :
read -rs MPW; export MPW
# psql managé via pooler session :
mpsql() { docker run --rm -i --network host -e PGPASSWORD="$MPW" "$IMG" \
  psql -h aws-1-eu-central-1.pooler.supabase.com -U postgres.oupsceccxsonaalhueff -d postgres "$@"; }

# État rapide :
docker compose --env-file .env -f docker-compose.supabase.yml ps
dpsql -Atc "select count(*) from public.cloud_media_items;"          # 906087
dpsql -Atc "select count(*) total, count(*) filter (where active) actifs from cron.job;"
```

### Re-vérifier la parité (quand on refera le dump final, dans la vraie fenêtre)
Reprendre la requête `jsonb_object_agg(tablename, count)` sur `public` des deux côtés et differ.

---

## 8. Rollback (mis à jour post-bascule)

Rollback complet = 2 gestes, tous réversibles :
1. **App** : revert du commit `448878d` (repoint) + push → Pages redéploie vers le managé.
2. **Crons** : côté managé `select cron.alter_job(jobid, active => true) from cron.job;`
   (via MCP ou pooler) ; côté self-host `update cron.job set active=false;`.
Le managé n'a jamais été modifié en écriture (dump lecture seule) — ses données datent du
freeze de fait (trafic nul pendant la nuit de bascule) et divergeront à mesure que le
self-host vit : un rollback tardif perdra les écritures post-bascule.

---

## 8bis. Incident post-repoint : Kong rejetait la clé frontend (RÉSOLU)

Symptôme : login impossible sur norva.tv (« We couldn't sign you in with that password »)
alors que GoTrue acceptait le même login en direct (curl → `access_token`).
Cause : le frontend (authApi.js, app.js, AdminPage, maintenance-banner) envoie comme `apikey`
la **clé opaque `sb_publishable_…`** (nouvelle norme Supabase), pas le JWT anon legacy. Kong
self-host ne connaissait que le JWT anon → **401 avant GoTrue** ; le `catch (_)` d'account.html
maquillait ce 401 en « mauvais mot de passe ».
Fix : `SUPABASE_PUBLISHABLE_KEY=sb_publishable_…` ajouté au `.env` (clé PUBLIQUE par design) +
`docker compose up -d --force-recreate kong` — le kong.yml officiel la déclare comme 2ᵉ
credential du consumer `anon`. `SUPABASE_SECRET_KEY` reste VIDE (garde le mode legacy passthrough).
Séquelle UX observée : pages Movies/Series restées sur un état vide chargé pendant la panne —
un simple changement de filtre (re-fetch) a tout rétabli ; aucun item n'était réellement
« unavailable » (diagnostic : 0 broken via champ serveur, 0 via PlaybackHealth).

---

## 9. État final (11/07/2026) + reste à faire

### Fait et validé en prod
- Caddy 2.11.4 (`/etc/caddy/Caddyfile`) : `api.norva.tv` → `127.0.0.1:8000`, cert Let's Encrypt.
- App repointée (`448878d`) : `authApi/cloudApi/billing/admin/support/banner` → `api.norva.tv`.
- Login (compte email/password migré), catalogue Home, grilles Movies/Series, provider visible.
- `/boot` 98 ms · `/media-items` 107 ms · `/sources` 98 ms (depuis l'extérieur, TLS).
- Crons : managé **0 actif** (49 dormants, désactivés via `cron.alter_job` par l'API) ;
  self-host **47 actifs / 49** (recréés par pipe `format('select cron.schedule(…)')`
  managé→box avec réécriture d'URL ; les 2 `norva-audio-airo-ninja*` inactifs comme en prod).
  `cron.job_run_details` → runs `succeeded`.
- ⚠️ Découverte : `dump/ref-cron-jobs.tsv` (export `-At`) est **inexploitable** (commandes
  multi-lignes → 286 lignes pour 49 jobs). `01-dump-prod.sh` corrigé pour exporter aussi
  `ref-cron-jobs.sql` (statements `cron.schedule` quotés `%L`, rejouables).

### Reste à faire (post-bascule, aucun bloquant)
1. **Valider la lecture** (film + live) si pas déjà fait — dernier maillon
   (`norva-playback` → gateway Railway → relay), config lue depuis la DB migrée.
2. **Sécurité** : régénérer la clé FCM (voir TODO en tête) ; changer le mot de passe exposé.
3. **Backups du self-host** : pgBackRest/WAL-G → R2 + PITR testé (le backup R2 existant
   visait le managé). C'est LA priorité ops maintenant que la box est la prod.
4. **Monitoring** : Netdata/Prometheus (disque, RAM, connexions, réplication future).
5. **Storage** : re-synchroniser/régénérer les fichiers storyboards + sous-titres (metadonnées
   migrées, objets non copiés — régénérables).
6. **Managé** : garder dormant 1-2 semaines (rollback), puis downgrade/résiliation du plan Pro.
7. **Billing** : refonte passerelle de paiement (remplacement Stancer) puis
   `NORVA_ENTITLEMENTS_MODE=enforce`.
8. Durcir Studio (3001) : accessible uniquement en local — passer par un tunnel SSH pour l'admin.
