# Décommission du Supabase managé (`oupsceccxsonaalhueff`) — checklist

> **But** : retirer proprement le projet Supabase managé après la bascule
> self-host (Hetzner, `api.norva.tv`). Tâche #41. Rien d'irréversible tant que
> la **Phase C** n'est pas lancée — la fenêtre dormante est notre filet de
> rollback.
>
> **État au 2026-07-11** : le managé ne sert **plus aucun client** (voir §1).
> On entre dans la fenêtre d'observation de 1–2 semaines avant de downgrader.

---

## 1. Pré-conditions — déjà validées ✅

- **Trafic managé ≈ 0.** Dashboard managé → Database → Roles : `authenticated`,
  `anon`, `service_role` = **0 connexion**. Ce sont les 3 rôles empruntés par
  tous les vrais clients (app, web, edge). Zéro sur ces trois = zéro trafic
  utilisateur réel. Le résiduel (~10 req/h API Gateway) est tracé
  *dashboard-admin* = nous qui regardons le dashboard.
- **Audit clients complet** — tous les points d'entrée résolvent vers le
  self-host :
  | Client | Backend réel |
  |---|---|
  | Web `norva.tv` (Cloudflare Pages) | `api.norva.tv` |
  | Android téléphone / TV (WebView) | `norva.tv/app.html` → self-host |
  | mobile-pwa (Vercel) | `vercel.json` redirige tout → `norva.tv` → self-host |
  | Samsung Tizen | URL serveur LAN saisie manuellement |
- **Derniers refs managés en code runtime nettoyés** :
  - `clients/mobile-pwa/authApi.js` + `cloudApi.js` → self-host (commit `9390ec8`).
  - `server/routes/cloud.js` + `server/services/cloudBridge.js`
    (`DEFAULT_CLOUD_API_URL`) → self-host (ce lot). C'étaient des **défauts**
    surchargés par `link.apiUrl` / `NORVA_CLOUD_API_URL`, mais ils ne doivent
    plus référencer un projet qu'on supprime.

---

## 2. Phase A — Observer (fenêtre dormante, ~1–2 semaines)

Objectif : confirmer le zéro trafic sur une vraie durée, pas un instantané.

- [ ] Dashboard managé → **élargir la fenêtre à 24 h puis 7 j** (Reports /
      Database / API) et re-confirmer : `authenticated`/`anon`/`service_role`
      restent à 0, aucun pic API hors dashboard-admin.
- [ ] Vérifier **Edge Functions → Invocations** : ~0 (les invocations résiduelles
      = éventuels crawlers/health, pas de trafic applicatif).
- [ ] **Ne rien supprimer** pendant cette phase. Le managé reste le filet de
      rollback : DB à jour (via `backup-db-to-r2.yml`, cf. §3) + functions
      redéployables à la demande (cf. §3).

## 3. Phase B — Couper les « alimentations » du managé

Ce qui écrivait encore vers le managé après la bascule :

- [x] **`.github/workflows/deploy-supabase-functions.yml`** — redéployait
      *toutes* les edge functions vers le managé à chaque push sur `main`.
      **Auto-déploiement coupé** (ce lot) : le trigger `push` est retiré, il
      reste `workflow_dispatch` **uniquement** (bouton *Run workflow* conservé
      comme escape hatch de rollback pendant la fenêtre dormante).
- [x] **`.github/workflows/backup-db-to-r2.yml`** — `schedule` **retiré**
      (workflow_dispatch conservé). ⚠️ Découverte du 2026-07-11 : ce workflow
      était **inerte depuis toujours** — ses secrets repo (`SUPABASE_DB_URL`,
      `R2_*`) n'ont **jamais** été configurés, donc **chaque** run nightly
      échouait (`exit 1 : Set SUPABASE_DB_URL`). Il n'a jamais produit une seule
      sauvegarde ; ce n'était **pas** un filet de rollback. Superseded par les
      backups **self-host** (dump nightly + WAL PITR via timers systemd sur la
      box, restore-testés — `ops/hetzner/backup/`), qui eux tournent avec une
      config rendue sur la box (pas des secrets GitHub) → c'est pour ça qu'ils
      marchent alors que ce workflow échouait.

> Note secrets : ce workflow *déclarait* des secrets `R2_*` / `SUPABASE_DB_URL`
> mais ils n'ont jamais été posés côté repo — il n'y a donc rien à retirer pour
> lui. Les backups self-host utilisent une config **locale à la box**, pas ces
> secrets GitHub.

## 4. Phase C — Décommission (irréversible-ish — après la fenêtre)

À lancer seulement quand la Phase A confirme le zéro sur 7 j **et** que la
refonte Revolut a passé au moins un cycle de facturation complet.

- [ ] Désactiver le `schedule:` de `backup-db-to-r2.yml` (cf. §3).
- [ ] Prendre un **dernier dump managé** manuel et le vérifier (Actions → Run
      workflow sur `backup-db-to-r2.yml`, ou dump local) → archive R2 étiquetée
      `final-managed-YYYYMMDD`. C'est le snapshot d'archive définitif.
- [ ] **Downgrader** le projet managé au plan **Free** (ou le **Pause** via
      Dashboard → Settings → General → Pause project). Pause = arrêt compute,
      données conservées, réveil possible → **préférer Pause** à une suppression
      tant qu'on garde un doute.
- [ ] **Ne PAS supprimer** le projet (`Delete project`) avant ~1 mois de
      Pause sans incident. La suppression est définitive et efface la DB managée.
- [ ] Révoquer / retirer les secrets GitHub devenus inutiles :
      `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_URL`. **Garder** les `R2_*` (utilisés
      par les backups self-host).
- [ ] Supprimer les workflows morts une fois le projet retiré :
      `deploy-supabase-functions.yml` (et, si plus aucun rôle,
      `backup-db-to-r2.yml`).

## 5. Rollback (si un problème surgit pendant la fenêtre)

Tant qu'on est en Phase A/B, le retour au managé est rapide :

1. **Functions** : Actions → `Deploy Supabase Edge Functions` → *Run workflow*
   (redéploie l'état courant sur le managé).
2. **DB** : la dernière archive `backup-db-to-r2.yml` (nightly) est la source de
   vérité managée ; le managé lui-même n'a jamais été éteint en Phase A.
3. **Clients** : re-pointer les défauts front vers le managé — inverse des
   commits `9390ec8` (mobile-pwa) et de ce lot (`server/`), plus le
   cache-buster `?v=` du web. En pratique on ne rollback que si le self-host
   tombe durablement ; sinon on corrige sur le self-host.

## 6. Hors périmètre de cette tâche (à traiter séparément)

- **Retrait de Stancer** (`norva-stancer-*` functions + tables) — après un cycle
  de facturation Revolut complet. Code gardé pour rollback ; `stancer.enabled`
  déjà `false`. Suivi côté #40.
- **Refs managés résiduels non-runtime** (inoffensifs, à laisser) :
  `supabase/config.toml` (`project_id`, config CLI), commentaires de setup cron
  dans les edge functions (`norva-lifecycle`, `norva-import-notify`,
  `norva-stancer-*`), migrations historiques et docs. Aucun n'appelle le managé
  à l'exécution.

---

### Journal
- **2026-07-11** — Phase B : auto-déploiement des edge functions vers le managé
  coupé (`workflow_dispatch` seul) ; derniers défauts runtime `server/`
  re-pointés sur le self-host.
- **2026-07-11** — Phase C lancée à la demande explicite (fenêtre dormante
  écourtée, décision assumée). Constat : `backup-db-to-r2.yml` inerte depuis
  toujours (secrets jamais posés) → `schedule` retiré. Données managées
  préservées par ailleurs (dump de cutover + backups self-host prouvés + backups
  natifs Supabase + la Pause conserve les données). **Pause du projet managé**
  effectuée via l'API Supabase (réversible via `restore`). Restent des actions
  dashboard côté utilisateur : retirer les secrets GitHub devenus inutiles et,
  après ~1 mois de Pause sans incident, décider du `Delete` définitif.
