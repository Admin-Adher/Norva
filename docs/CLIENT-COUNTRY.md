# Pays client — capture, backfill, surfaces admin

> Livré le 2026-07-17 (branche `claude/client-location-revolut-playstore-p9nf74`,
> migration `20260717120000_customer_country_vat.sql`). Compagnon TVA : [`TVA-OSS.md`](./TVA-OSS.md).

## Sources de vérité (décision produit 2026-07-17)

| Rail | Source | Confiance | Champ amont |
|---|---|---|---|
| Play / App Store (RevenueCat) | Pays du **storefront** | Haute | `event.country_code` (racine de l'événement webhook RC) |
| Web (Revolut Merchant) | Pays d'**émission de la carte** (BIN) | ~95 % (expats, néobanques) | `card_country_code` dans les payment details de l'order |
| IP-géoloc | — | — | **Hors périmètre** (add-on futur possible pour les comptes gratuits) |

Côté TVA, le pays BIN fourni par Revolut est l'élément de preuve « item c » de
l'art. 24f du règl. 282/2011 (voir `TVA-OSS.md` §5).

## Modèle de données

- `cloud_entitlement_projection.country_code` + `country_source` (`store`|`card`) —
  le pays **courant** du client, dernier événement gagne (une MAJ de carte peut le
  déplacer — voulu). CHECK `^[A-Z]{2}$`.
- `cloud_revolut_customers.card_country` — pays de la carte sauvegardée ; copié par
  le cron de renouvellement sur chaque ligne de ledger.
- `cloud_billing_ledger.country_code` — le pays **au moment de la transaction**
  (immuable, base des déclarations TVA/OSS — ne jamais le « corriger » vers le pays
  courant). ⚠️ La vue de compat `cloud_stancer_payments` (`select *` figé) ne porte
  **pas** cette colonne — lire la table.

## Écriture (capture live)

| Où | Quoi |
|---|---|
| `norva-billing-webhook` | `projectionPatch` → `country_code/source='store'` ; `journalRcPayment` → ledger `country_code` |
| `norva-revolut` `/confirm` | extraction sur l'order fetché (`cardCountryFromOrder`) → `cloud_revolut_customers.card_country` + projection (`source='card'`) ; upsert trial_setup porte le pays |
| `norva-revolut` `/profile` | capture paresseuse : si `method_details` de la carte porte un pays, persiste + stamp projection |
| `norva-revolut-webhook` | même extraction sur l'order re-fetché → `projectionPatch` (filet pour les conversions sans `/confirm`) |
| `norva-revolut-billing` | chaque charge journalisée porte `country_code = card_country` du mapping |

`cardCountryFromOrder` : chemin **confirmé sur données live** (étape 0, 2026-07-17) =
`payments[].payment_method.card.card_country` — testé en premier ; les anciens
candidats (`card_country_code` sous ses variantes) restent en fallback pour une
autre génération d'API. Un événement sans payment details ne **null-ifie jamais**
un pays déjà connu. NB : `billing_address.country_code` apparaît parfois (parcours
hosted) — non utilisé, décision produit « pays carte seul ».

## Backfill (dans la migration, idempotent — `where … is null` partout)

1. RC → projection : dernier `payload->>'country_code'` par user (`provider='revenuecat'`).
2. Revolut → projection + `card_country` : mêmes chemins jsonb que l'edge, via
   `jsonb_path_query_first` sur `payload->'order'`.
3. Ledger RC : match transaction-précis `pi_id = 'rc_' || transaction_id`.
4. Ledger Revolut : match `order_id` depuis `payload->'order'->>'id'`, puis fallback
   par client via `card_country`.

### ✅ Étape 0 — FAITE le 2026-07-17 sur données live

Verdict : le champ réel est `payments[].payment_method.card.card_country` (les
chemins `card_country_code` de la migration 20260717120000 ne matchaient pas →
ses backfills Revolut ont rendu `UPDATE 0`). Corrigé par la migration de
rattrapage `20260717140000_revolut_card_country_backfill_fix.sql` (à exécuter en
`supabase_admin` — `postgres` n'est pas owner de `cloud_revolut_customers` ; pas
de reload PostgREST nécessaire, aucune signature ne change) + les fonctions
`norva-revolut` / `norva-revolut-webhook` à redéployer. Rail RC confirmé du
premier coup (`payload->>'country_code'`).

Requêtes de contrôle (réutilisables après tout changement d'API Revolut) :

```sql
-- Le pays carte est-il bien dans l'order stocké par le webhook ?
select created_at, payload->'order'->'payments' as payments
from cloud_entitlement_events where provider = 'revolut'
order by created_at desc limit 3;

-- Champ RC (attendu : code alpha-2 en racine)
select created_at, payload->>'country_code' as cc
from cloud_entitlement_events where provider = 'revenuecat'
order by created_at desc limit 3;

-- Taux de couverture après backfill
select country_source, count(*) from cloud_entitlement_projection
where country_code is not null group by 1;
```

Si un futur changement d'API déplace le champ, le backfill rend 0 ligne (sans
erreur) et seule la capture live via `/confirm` couvre le rail — ajuster les
chemins dans une migration de rattrapage ET dans les fonctions edge Revolut
(pattern : 20260717140000).

### Couverture attendue (structurel, pas un bug)

- Conversions Revolut passées **uniquement** par `/confirm` : aucune ligne
  d'événement → pas de backfill possible (capture live désormais).
- Comptes gratuits : pas de rail de paiement → pays inconnu (« — » dans l'UI).
- Le bucket **« Inconnu »** (Finance, filtre Clients `'??'`) est la jauge de
  couverture — jamais masqué.

## Lecture (surfaces admin)

| Surface | Quoi | RPC |
|---|---|---|
| Clients | colonne Pays, **filtre pays** (facette serveur + « Inconnu » `'??'`), CSV (`pays`, `source_pays`) | `admin_users_page(+p_country)` / `admin_users_export(+p_country)` — **signatures étendues, anciennes DROPpées** |
| Fiche + sidebar ticket | ligne Pays avec provenance (« storefront » vs « pays d'émission carte ») | `admin_user_billing` |
| Finance | bloc 🌍 (barres MRR par pays), table pays×rail, colonne Pays des 50 derniers paiements + CSV | `admin_finance` (`by_country`, `by_country_rail`, `recent_payments.country_code`) |
| Finance | panneau 🇪🇺 TVA : base trimestrielle par pays, jauges 10 000 € UE et 37 500/41 250 € FR, alerte UK, **corrections OSS** (remboursements de trimestres antérieurs, routés vers leur période d'origine), export CSV | `admin_vat_report(p_year, p_quarter)` — périmètre **rail web uniquement** (Play = fournisseur présumé) |

Remboursements : la ligne `refund` du ledger hérite du pays de la vente d'origine
(écrit par norva-admin `/refund` ; en lecture, `admin_vat_report` re-joint aussi la
vente via `order_id` pour l'historique). Même trimestre → netting de la base ;
trimestre antérieur → clé `corrections` (rubrique dédiée de la déclaration OSS).
**Limites connues** : les litiges/chargebacks ne sont journalisés par aucun rail,
et un remboursement fait directement depuis le dashboard Revolut n'atterrit pas
dans le ledger — toujours rembourser via la fiche admin.
| Cockpit | carte Top pays (cache, cron 10 min) | `refresh_admin_dashboard` → `overview.billing_countries/-_n/-_unknown_n` |

Front : helper `AdminPage.flag(cc)` (drapeau emoji + code). Conversion EUR du
panneau TVA = taux **indicatif** codé en dur (`EUR_PER_USD` dans `_renderVatPanel`)
— la déclaration réelle utilise le taux BCE du dernier jour du trimestre.

Tous les agrégats appliquent le prédicat canonique d'exclusion
`admin_internal_accounts`.

## Déploiement

⚠️ **Toujours `psql -U supabase_admin`** (pas `postgres`) : le dump Hetzner a laissé
`postgres` non-owner de certaines tables (`cloud_revolut_customers`…), donc une
migration lancée en `postgres` échoue à mi-chemin sous `ON_ERROR_STOP`.
⚠️ **`NOTIFY pgrst, 'reload schema'`** après toute migration qui **change une
signature** ou **crée une fonction** (sinon PostgREST renvoie 404 `PGRST202`).

**Statut : tout est déployé et vérifié sur la box (2026-07-17).** Séquence de
référence (migrations dans l'ordre, en `supabase_admin`) :

1. **Pays (socle + fix + logiques)** — puis redéploiement edge :
   ```
   for m in 20260717120000_customer_country_vat \
            20260717140000_revolut_card_country_backfill_fix \
            20260717150000_vat_refund_country_corrections; do
     docker exec -i norva-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
       < supabase/migrations/${m}.sql; done
   ops/hetzner/scripts/04-deploy-edge-functions.sh
   ```
   (edge : norva-revolut, norva-revolut-webhook, norva-billing-webhook,
   norva-revolut-billing, norva-admin.)
2. **Cockpit TVA (niveaux 3, registre, profil, alertes, certificats)** :
   ```
   for m in 20260717160000_vat_rates_fx_server_calc \
            20260717170000_vat_transactions_rpc \
            20260717180000_vat_business_profile \
            20260717190000_vat_alert_signals \
            20260717200000_vat_certificates_storage; do
     docker exec -i norva-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
       < supabase/migrations/${m}.sql; done
   docker exec -i norva-db psql -U supabase_admin -d postgres -c "NOTIFY pgrst, 'reload schema';"
   ```
   (190000 ré-émet `refresh_admin_dashboard` → redéployer aussi norva-admin pour le
   sweep d'alertes.)
3. **Web** : merge sur `main` → GitHub Actions → Cloudflare Pages
   (`AdminPage.js` bumpé `?v=66` dans `app.js` — le `?v=` est **manuel**).
4. **Recette** : un client RC et un client Revolut confirmés affichent leur pays
   partout ; `by_country` n'inclut aucun compte interne ; onglet 🇪🇺 : profil qui
   persiste après F5 (serveur), journal des dépôts, bucket `vat-certificates` privé.

## Hors périmètre (pistes actées, non construites)

Drill-down Finance→Clients par pays (modèle `data-billing`), conversion essai→payant
par pays, ligne pays du digest Telegram, badge « pays divergent » multi-rail,
ops-alert afflux pays (anti card-testing), historique/sparklines par pays,
IP-géoloc pour les comptes gratuits, emails lifecycle localisés (décision produit
« English-only » à inverser d'abord).
