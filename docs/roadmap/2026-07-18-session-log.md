# Session 2026-07-18 — audit upsell mensuel→annuel, tarifs dynamiques & promos

**Statut final : TOUT est livré ET déployé (box + Cloudflare Pages), vérifié en
recette. Trois chantiers dans la journée : (1) audit upsell mensuel→annuel →
5 lots de correctifs ; (2) plan courant + protection des grants manuels +
upsell annuel ; (3) tarifs web à source unique `billing_prices` + promos
événementielles (badge, thèmes, visuel de campagne plein écran) + page de
vente sans scroll. Migrations appliquées en `supabase_admin` : 20260718100000,
-150000, -170000, -190000, -210000 (cette dernière : si l'upload de visuel
marche, elle est passée — sinon l'appliquer, idempotente).**

Question d'origine : *« quelle est la logique quand un client paie en mensuel
3 mois puis passe en annuel ? »* — audit par workflow (26 agents : 5 lecteurs par
zone — checkout Revolut, cron de renouvellement, webhook RevenueCat, UI,
SQL finance — puis 21 vérifications adversariales sur pièces). 45 constats bruts,
21 confirmés, 5 lots de correctifs validés (« go tout »).

## La logique (telle que vérifiée, après correctifs)

- **Rail web (Revolut)** : pas de prorata, par design. Le passage en annuel ouvre
  un ordre de vérification carte 50¢ (capture MANUAL, annulé après). Rien n'est
  débité au moment du changement — le mois déjà payé court à son terme, puis le
  cron horaire `norva-revolut-billing` débite 41,99 $ (MIT) et pousse
  `current_period_end` de +1 an. La bascule réelle se fait donc **au
  renouvellement**, jamais au checkout.
- **Rail Play (RevenueCat)** : Google prorate lui-même le changement (mode de
  remplacement passé par l'app, voir lot 4). RC envoie `PRODUCT_CHANGE`
  (l'ancien produit dans `product_id`, le nouveau dans `new_product_id`), puis le
  cash annuel réel arrive au `RENEWAL` suivant.
- **TVA** : comptabilité d'encaissement — le montant annuel tombe entièrement dans
  le trimestre du débit, avec le pays carte du moment. Conforme au cockpit TVA.
- La charge d'upgrade web est un `kind='renewal'` → correctement **exclue** des
  stats de conversion essai→payant.

## Les 5 lots (commits)

| # | Lot | Commit | Fichiers |
|---|---|---|---|
| 1 | 🔴 Sécurité paiement : un plan_change abandonné armait un prélèvement annuel jamais validé (mapping écrit AVANT paiement, dès le chargement de la page ; aucun chemin de retour). Staging dans les metadata de l'ordre, commit au `/confirm` payé (+ filet webhook `ORDER_COMPLETED`) | `c04da1a` | `norva-revolut/index.ts`, `norva-revolut-webhook/index.ts` |
| 2 | 🔴 MRR ×12 : le cron ne stampait jamais `bill_period`, et cockpit/sparkline/MRR-par-pays ne joignaient que `cloud_stancer_customers` → un annuel lu 4199¢/mois (digest ARR ×12 par héritage). Cron corrigé + ré-émissions verbatim (diff scripté) avec le coalesce 3 sources d'`admin_finance` + rattrapage `bill_period` | `0056a21` | `norva-revolut-billing/index.ts`, `20260718100000_annual_upgrade_mrr_correctness.sql` |
| 3 | 🟠 Webhook RC : `PRODUCT_CHANGE` journalisé `first_charge` au prix catalogue plein (faux convert + faux montant) → `kind='plan_change'` exclu des agrégats ; plan/cadence dérivés du **nouveau** produit (`effectiveEvent()`) ; repli prix catalogue si l'événement est sans prix (sinon tarif mensuel figé jusqu'à 12 mois) | `34a8cf3` | `norva-billing-webhook/index.ts` |
| 4 | 🟠 Android : achat brut sans `oldProductId` (risque de double abonnement) → remplacement Play réel, `WITH_TIME_PRORATION` (seul mode valide dans les deux sens ; `CHARGE_PRORATED_PRICE` est refusé pour mensuel→annuel, prix/unité de temps en baisse). Compilé contre stubs RC v8 — à confirmer au 1ᵉʳ vrai build | `4d60c30` | `NorvaBilling.java` |
| 5 | 🟡 UI : promesse d'essai aux inéligibles (subscribe), « after your 7-day free trial » et « applies right away » en plan change (checkout), upgrade invisible après coup → ligne « Billing $XX / year » (subscription) | `06bbbfe` | `subscribe.html`, `checkout-revolut.html`, `subscription.html` |

## Lot 6 (recette du jour) — plan courant + protection des grants manuels

Trouvé par Adrien en recette : connecté avec un compte **à accès manuel**
(VIP family jusqu'en 2099, `trial_consumed_at` vide), la page tarifs reproposait
l'essai 7 jours ET laissait re-cliquer le plan family déjà actif. Deux causes :
l'éligibilité essai = « jamais consommé » (vrai pour un compte gifté), et la page
ne marquait jamais le plan courant (gap général, pas seulement VIP).

- **Serveur** (`norva-revolut`) : un compte avec un abonnement **vivant** ne reçoit
  plus jamais un ordre `trial_setup` (kind → `plan_change`, qui préserve
  statut/échéance) ; et verrou dans `/confirm` : une projection `active` à échéance
  future n'est **jamais** rétrogradée en essai 7 jours — protège les grants 2099
  même contre les vieux ordres `trial_setup` PENDING d'avant le fix.
- **`subscribe.html`** : machine d'état des CTA — plan+période courants = « Current
  plan » (désactivé, carte marquée), même plan autre période = « Switch to
  annual/monthly billing », autre plan = « Switch to this plan » ; plus aucun
  wording d'essai dès qu'un plan vivant existe (lead, note, réassurance) quelle que
  soit l'éligibilité brute. Période courante lue du profil Revolut (rail web).
- **`subscription.html` + `Settings.js` (`?v=42` dans app.html)** : un grant
  manuel/system affiche « Access until » / « accès inclus » au lieu de « Renews
  Jan 1, 2099 » (rien ne se renouvelle).
- **Upsell annuel honnête** (idée d'Adrien, validée) : sous le CTA « Current
  plan » d'un abonné mensuel (cadence connue, rail web), lien « save $17.89/31.89
  a year » qui bascule le toggle sur Annuel ; et ligne « Annual billing — Switch
  and save » sur la page abonnement (statut `active` seulement), qui mène droit
  au checkout plan_change. Économies calculées depuis les prix réels
  (`data-monthly/annual`, `billing-config.js`) — jamais codées en dur.

## Suite de la journée — commits (lots 6-9 + fixes de recette)

| Commit | Sujet |
|---|---|
| `e7ab042` | Checklist box : chemin réel `~/norva` (pas `/opt/norva`) + garde-fou |
| `d8d3a94` | Lot 6 — plan courant marqué + grants manuels inécrasables (kind jamais trial_setup si abonnement vivant, verrou /confirm) |
| `97847ed` | Upsell annuel honnête (hint carte + ligne « Switch and save » abonnement) |
| `e924c92` | Lot 7 — `billing_prices` source unique + `/prices` + carte « 💵 Tarifs web » |
| `a06514c` | Lot 8 — promos événementielles (base/promo/événement/échéance) + no-scroll v1 |
| `d55a576` | Lot 9 — avantages toujours visibles + thèmes visuels par événement |
| `209e4a4` | Fix upload visuel : policy SELECT `promo-assets` (migration 20260718210000) |
| `a7ad94f` | Visuel de campagne → fond plein écran de la page (plus dans la carte) |
| `43c322c` | Fix `kong:8000` : l'edge renvoie un chemin, le front construit l'URL |
| `8329765` | Voile de lisibilité allégé (16/50/90 %) |
| `b73f4a3` | Fond peint sur le canvas du document (`html.has-campaign`) + témoin console |
| `0cda48d` | Tolérance billing.js périmé + éviction du cache immutable (hash) |

## Nuances actées, non corrigées (volontaire)

- **Remise save-offer × annuel** : une remise de rétention en attente (50 % « sur
  le prochain prélèvement ») s'appliquerait au montant annuel plein si le client
  bascule ensuite en annuel. Chemin aujourd'hui mort (l'offre n'est proposée que
  dans le flux d'annulation) — à trancher si le cas devient réel : honorer (généreux)
  ou plafonner à l'équivalent mensuel.
- **Filet webhook limité à `ORDER_COMPLETED`** : un plan_change payé sur la page
  hébergée Revolut SANS retour `/confirm` et dont l'ordre reste `AUTHORISED` n'est
  pas commité → le client garde son ancien plan (échec **sûr** : jamais de
  prélèvement non validé ; le parcours normal repasse toujours par `/confirm`).
- **Historique MRR déjà écrit** : les snapshots quotidiens antérieurs surévalués ne
  sont pas réécrits (mesures datées) — la série redevient juste au prochain passage
  du cron de snapshot (07h07 UTC).
- **`mrr_cents` = montant remisé** pendant un cycle à remise save-offer (le cron
  stampe le montant réellement chargé) : sous-évaluation d'un seul cycle, hors
  périmètre de l'audit.

## Lot 8 — promos événementielles + page tarifs sans scroll

Suite produit du Lot 7 (« base + promo, badge d'événement, choix mondiaux ») :

- **Migration `20260718170000_billing_promos.sql`** : colonnes
  `promo_amount_cents` / `promo_event` / `promo_ends_at` sur `billing_prices` ;
  `admin_billing_promo_set` (promo NULL = retrait ; sinon événement du catalogue
  obligatoire, montant **strictement < base**, échéance future optionnelle) ;
  `admin_billing_prices` ré-émise avec les champs promo (+ `promo_active`
  calculé). ⚠ NOTIFY pgrst.
- **Prix effectif** : `_shared/prices.ts#getCatalog()` — promo PRIME quand
  remplie et non échue (`promo_ends_at` passé = auto-désactivation, TTL 60 s de
  latence max). `getPrices()` rend les effectifs → checkout/confirm/webhooks
  héritent des promos sans changement. `/prices` expose `{ prices, promos }`
  (base barrée + événement).
- **Catalogue d'événements** (clé → badge EN affiché) : black_friday,
  cyber_monday, winter_sale, summer_sale, christmas, new_year, lunar_new_year,
  eid, easter, halloween, valentines, back_to_school, birthday, flash, other.
- **Page de vente** : badge dégradé au-dessus du prix + base barrée à côté du
  prix promo (subscribe), note « 🏷 Black Friday — was $41.99/yr » au récap
  checkout. `billing.js ?v=13` (le helper résout `{prices, promos}`).
- **Carte admin** (`AdminPage ?v=71`) : chaque tarif = base + étage promo
  (montant, événement en FR, échéance datetime) ; bordure + chip PROMO quand
  actif ; garde-fou client et serveur promo < base.
- **Sans scroll** (demande UX) : sur desktop la page tarifs tient dans le
  viewport — deux paliers de densité (`max-height: 979px` resserre tout ;
  `max-height: 799px` masque lead + listes de features, déjà résumées par le
  bloc compare). Mobile garde son scroll naturel ; TV intacte.

## Lot 9 — avantages toujours visibles + identité visuelle des promos

Recette d'Adrien sur le Lot 8, deux corrections :

- **CRITIQUE — listes d'avantages** : le palier « écran court » (`max-height:
  799px`) masquait les `ul` des cartes — à 100 % de zoom sur son écran, les
  avantages disparaissaient. **Règle produit actée : les listes d'avantages ne
  se masquent JAMAIS** — ce qui s'efface sur écran court, c'est ce qui les
  répète (lead, bloc compare, note légale) + compression renforcée de tout le
  reste. La page tient toujours sans scroll desktop.
- **Identité visuelle des promos** (le badge dégradé de marque « pas assez
  marketing ») : chaque événement du catalogue a désormais son **thème** —
  badge à ses couleurs (Black Friday noir/or, Noël rouge/vert, Aïd
  émeraude/or, Nouvel An chinois rouge/or…) + fond de carte teinté (halo
  radial). `PROMO_THEMES` dans subscribe.html, badge assorti au checkout.
- **Visuel de campagne uploadable** (migration `20260718190000`) : bucket
  **public** `promo-assets` (lecture libre — la page de vente charge l'image
  sans auth ; écriture admin-only par RLS), table `billing_promo_campaign`
  (ligne unique) + RPCs `admin_promo_campaign(_set)`. ⚠ NOTIFY pgrst. Uploadé
  depuis la carte « 💵 Tarifs web » (guidage : ≈1200×1400 px, JPG/PNG/WebP,
  < 2 Mo) → remplace le thème par défaut en fond de la carte en promo, avec
  dégradé sombre par-dessus pour la lisibilité. `?v=72`, `billing.js` expose
  `campaign.bg_url` dans le catalogue.

## Déploiement box — Lots 7+8+9 : FAIT le 2026-07-18 (sorties propres)

Séquence de référence si rejeu nécessaire (idempotent) :

```bash
cd ~/norva && git pull origin main
for m in 20260718150000_billing_prices 20260718170000_billing_promos \
         20260718190000_promo_campaign_visual 20260718210000_promo_assets_select_policy; do
  docker exec -i norva-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
    < supabase/migrations/${m}.sql; done
docker exec -i norva-db psql -U supabase_admin -d postgres -c "NOTIFY pgrst, 'reload schema';"
ops/hetzner/scripts/04-deploy-edge-functions.sh
```

Recette : `curl -s $FUNCTIONS_BASE_URL/norva-revolut/prices` rend
`{prices, promos, campaign}` ; poser une promo Black Friday → badge noir/or +
halo doré sur la carte ; uploader une image de campagne → elle devient le fond
de la carte ; à 100 % de zoom les avantages des plans restent visibles, sans
scroll. (Lots 7+8 : migrations + NOTIFY + edge déjà appliqués, sortie propre.)

### Fix upload campagne (recette) — migration `20260718210000`

L'upload rendait `400` : le flux **x-upsert** de storage-api LIT l'objet avec le
rôle du JWT (test d'existence + retour de ligne), or le bucket n'avait que des
policies INSERT/UPDATE/DELETE → **policy SELECT admin ajoutée** (la lecture
publique `/object/public/…` n'est pas concernée, servie hors RLS). Côté front
(`?v=73`) : le message d'erreur affiche désormais la réponse du storage (un
« 400 » sec est indiagnosticable), et le type MIME est déduit de l'extension si
le navigateur n'en fournit pas un accepté par `allowed_mime_types`.

```bash
docker exec -i norva-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/20260718210000_promo_assets_select_policy.sql
```
(Pas de NOTIFY ni de redéploiement edge — policy storage seule.)

### Visuel de campagne v2 — fond PLEIN ÉCRAN (recette)

Deux constats d'Adrien après le fix d'upload : (1) l'image « ne s'affichait
pas » — elle était en réalité appliquée dans la carte sous un voile à 82-94 %,
donc écrasée ; (2) décision produit : l'image doit habiller **toute la page**,
pas une carte. Refonte (`?v=74`) : `#campaign-bg` fixe plein viewport derrière
tout (visible quand ≥ 1 promo active ET image uploadée), dégradé vertical
42 % → 96 % (artwork visible en haut, quasi opaque derrière les cartes) ; les
cartes gardent halo + badge aux couleurs de l'événement. Guidage d'upload
actualisé : **paysage 1920 × 1080 px+**, JPG/WebP, < 2 Mo. Le checkout reste
volontairement sobre (page de paiement sans distraction).

### Fix URL du visuel (recette) — `kong:8000`

L'image ne s'affichait pas sur la page de vente : l'edge construisait l'URL
publique depuis `SUPABASE_URL`… qui, vu par l'edge runtime de la box, est
l'hôte Docker INTERNE `http://kong:8000` — irrésolvable par un navigateur (et
mixed content en prime). **Règle actée : l'edge ne construit jamais d'URL
publique** — `/prices` renvoie `campaign.bg_path` (chemin bucket) et c'est
`billing.js` (`?v=14`) qui assemble l'URL depuis SA base publique (celle de
tous ses appels API). La carte admin n'était pas touchée (elle construit déjà
depuis `_sbUrl()`). Redéploiement edge requis (norva-revolut + _shared).

### Épilogue fond de campagne — la traque du cache (référence incident)

Le fond restait noir chez Adrien alors que TOUTE la chaîne serveur était prouvée
saine (simulation jsdom des fichiers servis + vraie API : calque créé ✓). Sa
console a fini par montrer `campaign={bg_path}` brut = **ancien billing.js en
exécution**, alors que le CDN servait le bon contenu sous la bonne URL hashée.
Cause : copie périmée **figée dans le cache HTTP navigateur** — les assets
hashés sont servis `immutable/max-age=1 an`, et le fetch interne du service
worker n'obéit PAS au « Disable cache » de DevTools : une copie logée pendant
la fenêtre d'un déploiement n'est plus jamais re-demandée. Leçons codées :

1. **Toute modification de `billing.js` évince tous les caches** (le hash de
   contenu change l'URL) — c'est le mécanisme d'éviction universel.
2. **La page tolère un billing.js périmé** : subscribe.html sait construire
   l'URL du visuel depuis le `bg_path` brut.
3. Réimplémentation du fond sur le **canvas du document** (`html.has-campaign`,
   body transparent) — zéro dépendance à l'ordre de peinture, contrairement au
   calque `z-index:-1` initial.
4. Témoin : `console.warn` si l'image ne charge pas — plus d'échec muet.

### Sélecteur d'événement v2 — dépliant maison + événement nommé (recette)

Le `<select>` natif rendait clair-sur-clair (« trop brut ») et « Autre » était
muet. Remplacé (`AdminPage ?v=75`) par un **dépliant maison** aux couleurs du
dashboard (panneau sombre, icônes par événement, état sélectionné en dégradé),
et « Autre… » révèle un champ **nom d'événement** (2-24 caractères) qui devient
le badge affiché tel quel sur la page de vente et le checkout (ex. « Norva
Days ») — construit en `textContent`, jamais en markup. Migration
`20260718230000_promo_custom_label.sql` : colonne `promo_label`,
`admin_billing_promo_set` **signature étendue** (`p_label`) ⇒ DROP ancienne ⇒
**⚠ NOTIFY pgrst requis** ; `admin_billing_prices` ré-émise avec le champ ;
`_shared/prices.ts` expose `label` dans les promos (thème visuel = celui de
l'événement « Autre »).

```bash
cd ~/norva && git pull origin main
docker exec -i norva-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/20260718230000_promo_custom_label.sql
docker exec -i norva-db psql -U supabase_admin -d postgres -c "NOTIFY pgrst, 'reload schema';"
ops/hetzner/scripts/04-deploy-edge-functions.sh
```

### Périmètre des visuels par surface (question de recette)

| Surface | Prix live + badge + fond de campagne ? | Pourquoi |
|---|---|---|
| Navigateur web (desktop + mobile) | ✅ | Rail Revolut |
| App Android téléphone (webview + Play Billing natif) | ❌ volontaire | Google est marchand — les prix affichés restent alignés Play Console ; promos mobiles dans la Play Console |
| App Android TV (webview, `hasNativeBilling()=false`) | ✅ | La TV vend via le rail web (QR → checkout Revolut sur téléphone) — les promos web s'y appliquent réellement |
| Future app App Store | ❌ (même gating) | Apple marchand — même logique que Play |

## Déploiement box — lots 1-5 (FAIT le 2026-07-18 ~12h06)

```bash
cd ~/norva && git pull origin main
docker exec -i norva-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/20260718100000_annual_upgrade_mrr_correctness.sql
ops/hetzner/scripts/04-deploy-edge-functions.sh
```

> ⚠️ La checkout de la box est `~/norva` (PAS `/opt/norva` — première version de
> cette checklist erronée : le `cd` avait échoué, donc pull et migration sautés et
> edge redéployées depuis l'ancien code — toujours vérifier que le `git pull` a
> réellement affiché les nouveaux commits avant d'enchaîner).

- Migration en **`supabase_admin`** (règle maison) ; **pas de NOTIFY pgrst**
  (aucune signature ne change — `create or replace` seulement).
- Edge concernées : `norva-revolut`, `norva-revolut-webhook`,
  `norva-revolut-billing`, `norva-billing-webhook` (le script les redéploie toutes).
- Web : push `main` → GitHub Actions → Cloudflare Pages. **Pas de bump `?v=`**
  (AdminPage.js non touché — pages HTML top-level seulement).
- Recette : ouvrir un passage en annuel depuis un compte actif mensuel, fermer la
  page sans payer → `cloud_revolut_customers` doit rester `monthly/499` ; le récap
  checkout d'un plan change ne mentionne plus l'essai ; carte cockpit MRR inchangée
  après un test de bascule (division /12 via le mapping).

## À ne pas oublier

- Le ledger porte désormais un 3ᵉ kind monétaire **`plan_change`** (rail RC
  uniquement) : volontairement **hors** agrégats revenus/conversions/TVA (ils
  filtrent `first_charge`/`renewal`) ; visible dans les 50 derniers paiements
  (label « changement plan » déjà présent dans `KIND_LABELS`).
- `effectiveEvent()` (webhook RC) réécrit `product_id` ← `new_product_id` pour
  `PRODUCT_CHANGE` **avant** toute dérivation — si un jour on lit d'autres champs
  produit sur cet événement, passer par ce helper.
- ~~Le prix catalogue est dupliqué dans 4 edge functions~~ → **résolu par le
  Lot 7** : source unique `billing_prices` (voir section dédiée). Les seuls
  prix « en dur » restants sont des **replis** : `DEFAULT_PRICES` dans
  `_shared/prices.ts` (si la table est inaccessible) et les valeurs statiques
  des pages/`billing-config.js` (si l'endpoint public est down) — ils n'ont
  pas besoin de suivre les promos, seulement les changements durables.

## Lot 7 — tarifs web dynamiques (source unique `billing_prices`)

Demande produit : promos (Black Friday, Noël, soldes) en changeant les prix à UN
endroit. Construit :

- **Migration `20260718150000_billing_prices.sql`** : table `billing_prices`
  (plan × period → cents, bornes 100..99999, RLS + lecture service_role only),
  seed des tarifs actuels, RPCs admin `admin_billing_prices` /
  `admin_billing_price_set` (gate `is_admin()`). ⚠ **NOTIFY pgrst requis**.
- **`_shared/prices.ts`** : `getPrices(db)` — cache 60 s par isolate + repli
  `DEFAULT_PRICES`. Branché dans `norva-revolut` (checkout/confirm),
  `norva-revolut-webhook` (commit hosted-page), `norva-billing-webhook`
  (repli MRR `PRODUCT_CHANGE`). `norva-revolut-billing` n'en a **pas** — voulu :
  le cron débite le prix **verrouillé** du mapping, jamais le catalogue.
- **Équité promo** : `/checkout` stampe `amount_cents` dans les metadata de
  l'ordre → `/confirm` (et le webhook) committent **le prix affiché au moment de
  l'ouverture**, même si la promo se termine pendant la saisie carte.
- **GET `norva-revolut/prices`** (public) + `NorvaBilling.revolutPrices()`
  (`billing.js ?v=12`, cache page) : `subscribe.html` (cartes, note « about
  X/mo », badge « Save X% » recalculé, hint d'économie), `checkout-revolut.html`
  (récap), `subscription.html` (upsell) — statiques en repli. **Gaté web-only** :
  sur natif, les prix affichés restent ceux de la Play Console (une promo web ne
  doit jamais annoncer un prix que Google ne facturera pas).
- **Carte « 💵 Tarifs web » (Finance, `AdminPage ?v=70`)** : 4 champs + confirm
  récapitulatif → `admin_billing_price_set`. Une promo = 2 clics ; retour au
  tarif normal = 2 clics. Effet nouveaux checkouts uniquement, ~1 min (cache).
