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

## 4. Phase C — Décommission (dashboard-only — action utilisateur)

> ⚠️ **La Pause n'est PAS possible ici.** Supabase ne met en Pause que les
> projets **Free**, et le downgrade-vers-Free exige de rentrer sous 500 Mo. La
> DB managée fait **5,3 Go** (906k `cloud_media_items`) → downgrade refusé /
> projet restreint. La seule vraie façon d'arrêter le compute **et la
> facturation** est donc le **Delete** (définitif). Aucun outil MCP n'expose ni
> le downgrade ni le delete → **tout se fait dans le dashboard** par
> l'utilisateur.

État managé confirmé le 2026-07-11 21:20 UTC : **0 trafic client**
(`authenticated`/`anon`/`service_role` = 0), **0 job cron actif** (les 49 jobs
ont été désactivés ; dernier run 09:05 UTC, plus rien depuis) → **vraiment
idle**. Données préservées (dump de cutover + backups self-host prouvés + backups
natifs Supabase).

- [x] **Delete du projet managé** — fait le 2026-07-11 via le dashboard
      (l'utilisateur a choisi le Delete immédiat plutôt que garder dormant).
      `list_projects` renvoie désormais `[]`. **Définitif**, données préservées
      sur le self-host (restore-testé) + dump de cutover + backups natifs.
- [x] Supprimer les workflows morts (leur cible n'existe plus) :
      `deploy-supabase-functions.yml` et `backup-db-to-r2.yml` — `git rm`.
- [x] **Downgrader l'ORG à Free** — fait le 2026-07-11. L'org « Norva » est
      passée **PRO → Free** (Organization → Billing → Change subscription plan).
      Facturation coupée : Free Plan, spend cap actif, dernière facture 0,00 $.
      (Rappel : supprimer le *projet* seul ne downgrade pas l'abonnement de
      l'org — c'est cette étape qui arrête réellement le coût.)
- [ ] Retirer le secret GitHub `SUPABASE_ACCESS_TOKEN` (settings du repo) — il
      servait au deploy workflow supprimé. `SUPABASE_DB_URL` / `R2_*` de
      `backup-db-to-r2.yml` n'avaient jamais été posés → rien à retirer là.

## 5. Rollback — **n'existe plus** (projet managé supprimé)

Le projet managé ayant été **Delete** le 2026-07-11, le rollback-vers-managé
n'est plus possible : le self-host (`api.norva.tv`) est **le seul backend**, avec
ses propres backups (dump nightly + WAL PITR, restore-testés — voir
`ops/hetzner/backup/`). La résilience repose désormais entièrement dessus.

> Si un jour il fallait reconstruire un backend managé de zéro : recréer un
> projet Supabase, restaurer depuis un backup self-host, redéployer les edge
> functions (le workflow supprimé est récupérable dans l'historique git), et
> re-pointer les clients. Ce n'est plus un « rollback » mais une reconstruction.

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
  toujours (secrets jamais posés) → `schedule` retiré. **Pause tentée via l'API
  Supabase → REFUSÉE** : « Project is not free-tier », et la DB (5,3 Go) est
  10× au-dessus de la limite Free → downgrade-vers-Free non viable, donc **Pause
  impossible**. Il n'existe pas d'outil MCP de downgrade/delete → l'arrêt du
  projet (= Delete, définitif) est une **action dashboard** côté utilisateur.
  Managé confirmé **idle** (0 trafic client, 0 cron actif, dernier run 09:05
  UTC). Données préservées (dump cutover + backups self-host + backups natifs).
  Décision Delete-now-vs-garder-dormant laissée à l'utilisateur (cf. §4).
- **2026-07-11** — **Projet managé SUPPRIMÉ** par l'utilisateur (dashboard,
  définitif). `list_projects` → `[]`. Workflows morts retirés (`git rm` de
  `deploy-supabase-functions.yml` + `backup-db-to-r2.yml`). Le self-host devient
  le seul backend. Le rollback-vers-managé n'existe plus.
- **2026-07-11** — **Org downgradée PRO → Free** → facturation coupée (Free Plan,
  spend cap actif, dernière facture 0,00 $). **#41 clôturée.** Seul reliquat
  d'hygiène : retirer le secret GitHub `SUPABASE_ACCESS_TOKEN` (aucun impact
  facturation).
