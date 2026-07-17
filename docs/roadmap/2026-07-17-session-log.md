# Session 2026-07-17 — pays client (Play + Revolut) & préparation TVA/OSS

**Statut : 3 commits livrés sur la branche `claude/client-location-revolut-playstore-p9nf74` (PAS encore mergée sur `main`) — 1 migration SQL + 4 edge functions + AdminPage.js (`?v=58`) + 2 docs. Rien n'est déployé sur la box : migration + edge + merge à faire (checklist dans `docs/CLIENT-COUNTRY.md` §Déploiement).**

Chantier double : (1) donner au CRM la **dimension pays** de chaque client — décision produit : `country_code` RevenueCat (storefront, haute confiance) pour le rail Play, **pays d'émission de la carte** (proxy ~95 %) pour le rail web Revolut, IP-géoloc hors périmètre ; (2) préparer les **futures obligations TVA UE** (déclarations OSS) — recherche approfondie vérifiée contradictoirement sur sources officielles (14 agents, état du droit au 17/07/2026), synthétisée en runbook.

| # | Sujet | Commit | Fichiers |
|---|---|---|---|
| 1 | Socle pays + TVA : colonnes, backfill, ré-émissions RPC, `admin_vat_report`, capture live, UI complète | `7b5cae0` | `20260717120000_customer_country_vat.sql`, `norva-revolut/index.ts`, `norva-revolut-webhook/index.ts`, `norva-billing-webhook/index.ts`, `norva-revolut-billing/index.ts`, `AdminPage.js` |
| 2 | Runbook TVA + panneau Finance aligné sur la recherche (jauge franchise FR, alerte UK, notes BCE/TEDB/DES) | `6918294` | `docs/TVA-OSS.md`, `AdminPage.js` |
| 3 | Docs pays + journal de session + bump `?v=58` (oubli du commit 1) | `8640002` | `docs/CLIENT-COUNTRY.md`, ce fichier, `README.md` (index), `app.js` |
| 4 | Fallback pré-migration PGRST202 (liste Clients vivante avant la migration) | `5153abd` | `AdminPage.js` (`?v=59`), `app.js` |
| 5 | Fix chemin réel `card.card_country` (étape 0 live) + backfill de rattrapage | `b3d06d1` | `20260717140000_revolut_card_country_backfill_fix.sql`, `norva-revolut`, `norva-revolut-webhook`, docs |
| 6 | Remboursements pays-corrects + corrections OSS inter-trimestres (audit « toutes les logiques ? ») | `ec18f06` | `20260717150000_vat_refund_country_corrections.sql`, `norva-admin/index.ts`, `AdminPage.js` (`?v=60`), docs |
| 7 | Cockpit TVA niveau 2 : calcul TVA due par pays + total à reverser + couche de confiance | *(ce commit)* | `AdminPage.js` (`?v=61`), `app.js` |

## Cockpit TVA — échelle d'accompagnement (brainstorm UX)

Cible = **niveau 3** (assistant de saisie guidé + couche de confiance), construit en 2 temps :
- **Niveau 2 — FAIT (commit 7, front)** : table des taux TVA standard 2026 des 27 États (constante JS, source TEDB), chaîne `net USD → base EUR (fx indicatif 0,92) → TVA due (taux du pays)` pour les pays **UE hors France**, ligne de total « à reverser via l'OSS », couche de confiance (total marqué **incomplet** si des transactions n'ont pas de pays), CSV enrichi (base_eur, taux, tva_due). fx EUR reste **indicatif** et clairement labellisé.
- **Niveau 3 — À FAIRE (phase serveur)** : (a) déplacer la table des taux + le **taux BCE réel figé par trimestre** côté SQL (nouvelles tables `eu_vat_standard_rates` + `oss_fx_rates`, ré-émission `admin_vat_report` pour calculer base EUR + TVA côté serveur, dispo dans le CSV/exports) ; (b) **assistant de dépôt** champ par champ dans l'ordre du portail OSS ; (c) couche de confiance complète (résolution obligatoire du bucket Inconnu avant génération, preuve par ligne). Maquette de référence : cockpit `🧾` (2 états démarrage/activité).
- **Niveau 4 (dépôt auto) : exclu volontairement** — pas d'API de dépôt tiers, et une déclaration engage la responsabilité du dirigeant (validation humaine obligatoire).

---

## Ce qui a été construit (résumé — détail dans `docs/CLIENT-COUNTRY.md`)

- **Données** : `country_code`/`country_source` sur la projection ; `card_country` sur `cloud_revolut_customers` ; `country_code` sur `cloud_billing_ledger` (pays **au moment de la transaction** — base TVA, immuable). Backfill idempotent depuis `cloud_entitlement_events.payload`.
- **Capture live** : les 2 webhooks + `/confirm` + `/profile` + le cron de renouvellement.
- **RPC ré-émis** (verbatim dernière version + éditions chirurgicales, diffées mécaniquement avant commit) : `admin_users_page`/`admin_users_export` (**+`p_country` ⇒ anciennes signatures DROPpées**, sinon surcharge ambiguë PostgREST), `admin_user_billing`, `admin_finance` (`by_country`, `by_country_rail`, `recent_payments.country_code`), `refresh_admin_dashboard` (`billing_countries` top 5). Nouveau : `admin_vat_report(p_year, p_quarter)`.
- **UI admin** : colonne + filtre pays (Clients, avec facette serveur et bucket `'??'` Inconnu), ligne Pays avec provenance (fiche + sidebar ticket), bloc 🌍 + table pays×rail + colonne Pays des paiements (Finance), carte Top pays (Cockpit), panneau **🇪🇺 TVA — préparation OSS** (base trimestrielle par pays, jauges 10 000 € UE et 37 500/41 250 € franchise FR, alerte UK, export CSV).

## Contexte fiscal (résumé — détail sourcé dans `docs/TVA-OSS.md`)

- **Google Play = fournisseur présumé (art. 9a règl. 282/2011)** : Google reverse la TVA consommateur UE ; le rail Play n'entre **jamais** dans l'OSS ni dans le seuil 10 k€ ni dans la franchise FR. MAIS : prestation B2B à Google Irlande ⇒ **n° TVA intracom + DES mensuelle** (10ᵉ jour ouvrable, douane.gouv.fr) — démarches à faire.
- **Seuil 10 000 €** = uniquement ventes web B2C aux consommateurs des **autres** pays UE (année N et N-1). Au-delà : OSS (trimestriel, taux BCE du dernier jour du trimestre, art. 369h) ou régime PME UE (n° EX, plafond 100 k€).
- **Franchise FR 2026** : 37 500 € / majoré 41 250 € (le seuil unique 25 k€ de la LF 2025 a été abrogé, jamais appliqué). **Plafond micro 2026 : 83 600 €** (77 700 € obsolète).
- **UK : seuil d'immatriculation NUL** — TVA UK due dès la 1ʳᵉ vente web B2C à un client britannique. Décision à prendre (bloquer UK au checkout ou s'immatriculer HMRC) ; le panneau TVA alerte si des ventes GB apparaissent.
- Registres 10 ans (art. 63c), pays BIN = preuve « item c » (art. 24f), corrections OSS ±3 ans dans une déclaration ultérieure.

---

## ⚠️ À NE PAS OUBLIER (avant/pendant le déploiement)

1. ~~Étape 0 non faite~~ → **FAITE le 2026-07-17 sur données live** : champ réel = `payments[].payment_method.card.card_country` (pas `card_country_code` → backfills Revolut de 20260717120000 en `UPDATE 0`). Rattrapage : migration `20260717140000_revolut_card_country_backfill_fix.sql` (en `supabase_admin`) + redéploiement `norva-revolut`/`norva-revolut-webhook`. Rail RC validé du premier coup. Autres découvertes du déploiement : `postgres` n'est **pas owner** de `cloud_revolut_customers` (dump Hetzner) → **toujours migrer en `supabase_admin`** ; et un changement de **signature** RPC exige `NOTIFY pgrst, 'reload schema'` (sinon 404 PGRST202 même après migration).
2. **Ordre strict** : migration SQL **avant** le déploiement des 4 edge functions (elles écrivent les nouvelles colonnes).
3. La migration **DROP + recrée** `admin_users_page` et `admin_users_export` avec un argument de plus — le front déployé (ancien comme nouveau) reste compatible (appels par arguments nommés + défaut null), mais tout script perso appelant l'ancienne signature positionnelle casserait.
4. Le `?v=58` d'`AdminPage.js` est dans `app.js` (commit 3) — sans lui, les navigateurs servent l'ancien admin en cache.
5. `refresh_admin_dashboard` lit toujours l'argent via `cloud_stancer_customers`/`projection.mrr_cents` (pattern existant, non touché) ; les nouvelles clés pays suivent la même formule que `billing_mrr_cents`.
6. **Conversion EUR indicative** du panneau TVA : constante `EUR_PER_USD` dans `_renderVatPanel` (AdminPage.js) — à rafraîchir de temps en temps ; la vraie conversion (déclaration) est le taux BCE du dernier jour du trimestre.
7. **Démarches non techniques dès maintenant** : n° TVA intracom (SIE, gratuit, ne fait pas perdre la franchise) + DES mensuelle dès le premier versement Google (750 € par DES manquante). Points ouverts pour l'expert-comptable : `TVA-OSS.md` §6 (Play brut vs net, entité Google exacte, Play dans les 100 k€ EX…).

## Pistes actées, non construites (backlog pays)

Drill-down Finance→Clients par pays · conversion essai→payant par pays · ligne pays du digest Telegram · badge « pays divergent » (carte ≠ Play) · ops-alert afflux pays (anti card-testing) · sparklines par pays (`snapshot_admin_metrics`) · IP-géoloc comptes gratuits · emails lifecycle FR (décision produit « English-only » à inverser d'abord).
