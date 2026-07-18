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
| `c9a1691` | Sélecteur d'événement v2 — dépliant maison + événement nommé (« Autre… ») |
| `1330d86` | Finance ré-architecturée en onglets (Vue d'ensemble + 4 onglets d'action) |
| `ede908d` | Relances de prélèvement auto J+3/J+5 + bandeau in-app non bloquant |
| `35f9799` | Upload visuel pleine qualité (optimisation navigateur, plafond 10 Mo) |
| `3df0546` | % + économie affichés partout (Omnibus), landing page alignée sur les promos |
| `75938bd` | Compte à rebours réel jusqu'à la fin de promo (page de vente) |
| *(ce commit)* | Promos « N premières périodes » — `promo_cycles` bout en bout (voir section dédiée) |

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

### Finance ré-architecturée en onglets (demande UX)

Principe acté : **la Vue d'ensemble MONTRE, les onglets AGISSENT** (`?v=76`).
5 onglets, tous deep-linkables sur le modèle de la TVA
(`#admin/finance[/promos|/paiements|/analyse|/vat]`, restaurés au F5) :

| Onglet | Contenu |
|---|---|
| 💶 Vue d'ensemble | Résumé financier, revenu par rail, répartition par pays, risque revenu, état des abonnés + MRR par plan — lecture pure |
| 🏷️ Promotions | Tarifs web + promos + visuel de campagne (la carte « 💵 ») |
| 🧾 Paiements | 50 derniers paiements + export CSV |
| 📊 Analyse | Funnel de conversion + annulations & rétention |
| 🇪🇺 TVA & conformité | Inchangé (cockpit TVA complet) |

Routage : `validRoute` étendu + dispatch générique `finance/<sub>` ; l'état
interne des onglets (trimestre TVA, saisies promo) survit aux bascules
(conteneurs montrés/cachés, jamais re-rendus).

### Anti-churn involontaire : relances auto J+3/J+5 + bandeau in-app

Question d'Adrien (« que se passe-t-il quand un renouvellement échoue ? ») →
constat : le rail web ne re-tentait JAMAIS la même carte (récupération 100 %
dépendante du client), alors que ~2/3 des échecs sont transitoires. Construit :

- **Relances automatiques** (migration `20260718235900` : colonne
  `billing_retry_count` sur la projection — ⚠ NOTIFY pgrst, colonne lue via
  REST) : le cron re-tente **J+3 puis J+5** après l'échéance, avant l'expiration
  du dunning (~J+10). Essai consommé AVANT le débit (claim CAS
  `status=past_due AND retry_count=n-1` — un crash ou deux runs concurrents ne
  rejouent jamais un débit) ; référence d'ordre suffixée `-t1/-t2` (pas de
  collision avec l'échec initial) ; succès → réactivation ancrée sur l'échéance
  d'origine + Telegram « 💚 Paiement récupéré » ; échec → past_due inchangé,
  la **grâce de 72 h ne se ré-étend pas** et pas de re-ping (le J0 a déjà pingé).
- **Bandeau in-app non bloquant** (`app.js ?v=46`, `_maybeShowBillingAlert`) :
  à l'ouverture de Norva pendant la grâce (`billing_grace`/past_due/grace),
  bandeau ambre en tête d'app — « Your last payment didn't go through… » — CTA
  par rail (web → gestion d'abonnement ; Play → Google Play, politique Play
  oblige ; TV → texte seul, le paiement se règle sur téléphone/web). Fermable
  par session, revient à la prochaine ouverture tant que non réglé. Le mur
  souple existant reste le second étage après la grâce.

Chronologie complète d'un échec (rail web) : J0 échec + Telegram + grâce 72 h +
emails J0/J+1/J+2 → **relance auto J+3** → coupure d'accès J+3 (mur souple) →
**relance auto J+5** → expiration ~J+10 (21 j max) → win-back.

```bash
cd ~/norva && git pull origin main
docker exec -i norva-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/20260718235900_billing_auto_retry.sql
docker exec -i norva-db psql -U supabase_admin -d postgres -c "NOTIFY pgrst, 'reload schema';"
ops/hetzner/scripts/04-deploy-edge-functions.sh
```

### Visuel de campagne : upload pleine qualité + optimisation navigateur

Recette : un PNG IA de > 2 Mo était rejeté (« Image trop lourde »). Réponse
premium : **on ne bride plus l'admin, on optimise pour le visiteur** (`?v=77`).
L'admin accepte jusqu'à ~25 Mo ; l'image est recadrée à **2560 px max** et
ré-encodée **WebP qualité 0.85 dans le navigateur** avant l'envoi (typiquement
÷10-20 en poids, qualité visuelle intacte pour un fond sous dégradé) ; l'UI
affiche « 8,4 Mo → 320 Ko ». Repli : si l'optimisation n'apporte rien ou échoue
(image exotique), l'original part tel quel sous un plafond bucket porté à
**10 Mo** (migration `20260719001000`, pas de NOTIFY — config bucket).

### Promos : % + économie affichés & landing page alignée (recette)

Deux manques relevés par Adrien :

- **Réduction chiffrée** (plus vendeur + conformité) : la page de vente affiche
  désormais, en plus du prix de référence barré (l'exigence **Omnibus**
  art. L112-1-1 C. conso — l'ancien prix visible), une **pastille « −40 % »**
  aux couleurs de l'événement et une ligne verte **« You save $1.99/mo »** ;
  le récap checkout porte « was $4.99/mo · −40 % (save $1.99) ». Le pourcentage
  est calculé, jamais saisi (aucun risque d'écart prix/annonce).
- **Landing page** (`landing.js ?v=16`) : les cartes tarifs de norva.tv
  n'affichaient QUE les prix statiques — une promo en cours était invisible sur
  la vitrine. La landing consomme désormais le même catalogue live `/prices` :
  prix effectifs, badge événement + « −X % », prix barré, badge « Save X% » du
  toggle recalculé, et **les mentions légales sous les cartes portent le prix
  réellement facturé** (« 7 days free, then US$3.00/month… »). Repli statique si
  l'API est injoignable. NB : le JSON-LD SEO garde les prix de base (les promos
  sont temporaires — choix assumé).

### Compte à rebours de promo (page de vente)

Urgence RÉELLE, jamais simulée : « ⏳ Winter Sale ends in 2d 04:12:37 » entre le
toggle et les cartes, branché sur la `promo_ends_at` la plus proche parmi les
promos actives — l'instant exact où le serveur auto-désactive la promo. Coral +
pulsation sous 1 h ; à zéro, la page **revient d'elle-même aux prix de base**
devant le visiteur (badges/barrés/économies retirés) — le timer qui se
réinitialise est un dark pattern sanctionné (DGCCRF/Omnibus), le nôtre ne peut
pas mentir par construction. Promo sans échéance = pas de compte à rebours.
Chiffres tabulaires (pas de tremblement), compact sur écran court.

### Landing : cards pricing refondues + compte à rebours ; chrono de vente en chip (recette)

Trois constats d'Adrien sur captures : le compte à rebours n'existait pas sur la
landing, les cards pricing de la landing n'étaient « vraiment pas optimales »
(badge promo étiré sur toute la largeur AU-DESSUS du titre, prix barré géant sur
sa propre ligne, gros trou, CTA désalignés entre les deux cards), et le chrono de
la page de vente se noyait dans le visuel de campagne.

**Cause racine du badge cassé** : `.pricing-grid article` est une grid à `order`
explicites par type d'enfant — les éléments injectés par landing.js
(`.promo-flag`) n'avaient pas de slot → `order: 0` (avant le titre) +
étirement grid par défaut. Le prix barré (`.5em` de 52 px = 26 px) débordait et
passait à la ligne.

**Refonte (landing.css v37, landing.js v18, index.html)** :

- **Alignement subgrid** : les deux cards partagent désormais les mêmes rangées
  (`grid-template-rows: subgrid`, 9 slots explicites par type d'enfant, rangées
  3 et 5 réservées à la promo). Prix, CTA, mentions et features restent alignés
  au pixel entre les deux cards MÊME quand une seule est en promo — la card
  sans promo laisse le slot vide à la même hauteur. Repli : navigateurs sans
  subgrid = même layout par card, seul l'alignement croisé se dégrade.
  Piège documenté : le `row-gap` parent est hérité par les subgrids → passé à
  0 sur `.pricing-grid` (l'espacement inter-cards en 1 colonne est rendu par
  une marge dans la media query 820 px).
- **Rangée promo façon page de vente** : pastille événement nommée + pastille
  « −40 % » séparée (mêmes dégradés thématiques), prix barré INLINE à côté du
  prix (15 px, Inter), ligne verte « You save US$1.99/mo for your first
  3 months ». `Most popular` ajouté sur la card Family (l'em existait en CSS,
  jamais posé dans le HTML).
- **Compte à rebours sur la landing** : même logique que la page de vente
  (échéance la plus proche parmi les promos actives, urgence corail < 1 h, à
  zéro la vitrine revient d'elle-même aux prix de base : datasets, mentions
  légales — restaurées depuis une copie d'origine `data-*-terms-orig` —, badge
  « Save X% » du toggle recalculé). Jamais de faux timer.
- **Chip chrono (les deux pages)** : le chrono est maintenant un chip en verre
  fumé (fond `rgba(8,11,20,.74)` + backdrop-blur) → lisible sur N'IMPORTE quel
  visuel de campagne ; pastille événement colorée + gros chrono tabulaire
  16,5 px ; bordure et halo aux couleurs de l'événement.
- Recette simulée (jsdom, 24 assertions vertes) : rendu promo mensuel, bascule
  annuel sans fuite de promo, expiration en direct (chip retiré, prix et
  mentions restaurés).

**v2 sur maquette d'Adrien** (« pour la landing page je veux ça ») — refonte
alignée pixel sur sa maquette (landing.css v38, landing.js v19) :

- Card promo habillée aux couleurs de l'événement : badge unique
  « ⚡ FLASH SALE − 40 % » en tête, ligne « You save US$1.99/mo… » au-dessus
  du titre, prix de référence barré sur sa propre ligne AU-DESSUS du gros prix,
  gros prix teinté à l'encre de l'événement, bordure + halo de card thémés,
  CTA outline thémé, coches encerclées assorties. Thémage via `--promo-ink`
  posé par JS + `article.has-promo` (15 encres, une par événement, + pictos
  emoji par événement sur badge et chrono).
- Card Family : « ★ MOST POPULAR » en flux en tête de card (l'em absolu
  d'angle est passé statique), gros prix en dégradé bleu (background-clip),
  coches cercles pleins bleus à coche blanche.
- Layout : flex column, l'espace flexible est absorbé AU-DESSUS du bloc prix
  (`margin-top: auto` sur `.promo-was`/`.price`) → CTA/mentions/features
  ancrés en bas des deux cards, le prix flotte dans l'espace restant, comme
  sur la maquette (le subgrid strict de la v1 imposait des rangées partagées
  que la maquette ne suit pas). Grille élargie à 880 px, cards 34/32.
- Toggle : état actif en dégradé accent (plus lisible), badge « SAVE 30% »
  vert sur fond vert sombre. Chrono landing épuré SANS boîte (fond propre de
  la landing) : pastille événement + gros chrono ; la page de vente garde le
  chip verre fumé (nécessaire sur visuel de campagne).
- Bandeau de réassurance sous les cards (3 items + séparateurs) + « Taxes may
  apply based on your location. ». ⚠ Le « Trusted by millions » de la maquette
  est une allégation chiffrée invérifiable (pratique commerciale trompeuse,
  L121-2) → remplacé par « 7-day free trial / Try before you pay » (vrai, même
  poids marketing) — à re-challenger avec Adrien s'il y tient.
- Simulations jsdom re-déroulées (28 assertions vertes, rendu + bascule +
  expiration).

**v3 — polish premium 12 points** (revue design détaillée d'Adrien, valeurs
chiffrées reprises telles quelles ; landing.css v39, landing.js v20) :

- **Profondeur des cards** : dégradé vertical `#1e223d → #191d34`, bordure
  `rgba(255,255,255,.08)`, ombres empilées `0 25px 60px rgba(0,0,0,.45)` +
  glow bleu `0 0 40px rgba(90,110,255,.12)` — les cards « flottent ».
- **Family = star** : fond plus clair (`#262c50 → #1e2442`), contour
  `rgba(100,120,255,.45)`, glow large `0 0 60px rgba(96,123,255,.25)`.
- **Prix énormes** : 72 px / weight 800 / letter-spacing −3 px (62 px ≤ 820,
  52 px ≤ 520) ; glow du prix en `filter: drop-shadow` (PAS text-shadow, qui
  transparaîtrait à travers les glyphes en background-clip:text) — bleu sur la
  Family, encre de l'événement sur la card promo.
- **CTA relief** : dégradé `#4d7bff → #6b3eff` + double glow
  (`0 8px 30px rgba(82,105,255,.35)` + `0 0 30px rgba(90,110,255,.3)`), hover
  `translateY(-2px) scale(1.01)` ; CTA promo outline avec glow à l'encre.
- **Badges** : padding élargi, ombre portée + glow thémé (inline JS).
- **Respiration** : padding cards 40/34, +2-4 px entre chaque bloc, ul gap 14.
- **Coches** : disque teinté doux (`rgba(98,111,255,.15)` + glow ; encre
  événement via `color-mix` sur la card promo ; disque dégradé plein sur la
  Family) + coche blanche en mask — deux pseudo-éléments (::before disque,
  ::after coche).
- **Fond** : halo radial `rgba(75,95,255,.12)` derrière la grille
  (`.pricing-section::before`, z-index −1).
- **Toggle** : capsule coulissante animée (`.toggle-thumb` posé par JS,
  `positionThumb()` sur apply/resize/load ; si la géométrie n'est pas
  mesurable, `has-thumb` saute et le bouton actif reprend le dégradé — repli
  vérifié en jsdom) ; conteneur plus épais, SAVE 30% vert avec glow.
- **Hiérarchie typo 3 niveaux** : blanc (décision) / `#c7cbe3` (description,
  features) / `#8c91b4` (mentions, période, note) .
- **Séparateurs réassurance** : `rgba(255,255,255,.08)`, padding 34 px.
- Simulations : 24 assertions vertes (+ thumb, repli has-thumb, glow badge).

### Toggle page de vente lisible + fix « Save X% » sur prix de base (recette)

Deux points sur capture (page de vente sur fond de campagne Flash Sale) :

- **Toggle invisible** : l'état actif était `rgba(255,255,255,.1)` sur conteneur
  `rgba(255,255,255,.04)` — noyé dans le visuel de campagne. Passé en **verre
  sombre** (`rgba(10,13,20,.72)` + backdrop-blur, toujours lisible quelle que
  soit l'image) avec **état actif en dégradé accent** `#4d7bff→#6b3eff` + glow.
  Badge « Save » harmonisé (vert translucide, comme la landing).
- **« Save 3% » absurde** : le badge d'économie annuelle se calculait sur les
  prix **effectifs** (donc le prix promo mensuel — ex. 3 $/mois pendant 3 mois).
  Une promo mensuelle temporaire faussait complètement la comparaison
  annuel/mensuel. Corrigé sur **page de vente ET landing** : calcul sur les
  **prix de base** (`promos[plan][period].base_cents` sinon prix effectif) →
  la réduction structurelle annuelle réelle (~30 %), stable pendant les promos.
  Prouvé (cas piège promo sur les 2 plans : ancien 10 % faux → corrigé 30 %).

### « SAVE 30% » vs « −40% » — analyse de l'incohérence (recette)

Capture d'Adrien : toggle « SAVE 30% » ET cards « −40 % » côte à côte. Analyse :

- Ce sont **deux réductions différentes** qui peuvent légitimement coexister :
  le badge du toggle = réduction **structurelle** de la facturation annuelle vs
  mensuelle (prix de base) ; le −40 % des cards = réduction **événementielle**
  (Flash Sale) sur le prix de base de la période affichée.
- MAIS la config de recette (annuel base = 60 $ = 12 × 5 $ mensuel, pareil
  Family avec 108 = 12 × 9) n'a **aucune** réduction structurelle annuelle →
  le « Save 30% » affiché n'était PAS un calcul : c'était le **texte statique
  par défaut du HTML**, jamais écrasé car le code ne mettait à jour le badge
  que si `best > 1 %` — sans jamais le masquer sinon. Allégation fausse.
- **Correctifs** (vente + landing) : badge **masqué** quand la réduction
  structurelle réelle est ≤ 1 % ; réaffiché avec le vrai chiffre sinon.
  Table de vérité vérifiée : config capture → masqué ; config prod
  (4.99/41.99, 8.99/75.99) → « Save 30% », avec ou sans promo.
- **save-hint** (upsell annuel sur la card du souscripteur mensuel) : même
  faille — calculait `12×mensuel − annuel` sur les prix **effectifs** (donc
  faussé en promo, voire négatif) → recalculé sur les prix de **base** et
  supprimé si l'économie est ≤ 0,50 $.
- Bonus cosmétique : « That's about 3.00/mo » sans symbole → « $3.00/mo »
  (JS + valeurs statiques par défaut).
- À savoir pour la recette : si Adrien veut une vraie réduction annuelle, la
  base annuelle doit être < 12 × base mensuelle (ex. 41.99 vs 59.88 ≈ 30 %) ;
  avec annuel = 12 × mensuel, le badge du toggle disparaît (comportement
  voulu et honnête).

### Périmètre des visuels par surface (question de recette)

| Surface | Prix live + badge + fond de campagne ? | Pourquoi |
|---|---|---|
| Navigateur web (desktop + mobile) | ✅ | Rail Revolut |
| App Android téléphone (webview + Play Billing natif) | ❌ volontaire | Google est marchand — les prix affichés restent alignés Play Console ; promos mobiles dans la Play Console |
| App Android TV (webview, `hasNativeBilling()=false`) | ✅ | La TV vend via le rail web (QR → checkout Revolut sur téléphone) — les promos web s'y appliquent réellement |
| Future app App Store | ❌ (même gating) | Apple marchand — même logique que Play |

### Promos « N premières périodes » (décision produit) — migration `20260719020000`

Question posée : les réductions d'événement sont-elles à vie ? Réponse historique :
oui (grandfathering intégral — le prix promo restait le prix de renouvellement pour
toujours). Décision d'Adrien : **modèle SaaS standard « N premières périodes »** —
typiquement 3 mois en mensuel, la 1ʳᵉ année en annuel — coût de promo borné et
calculable, LTV protégée, promos réutilisables à chaque événement. Le « à vie »
reste possible (champ durée vide = ∞) mais réservé aux gestes stratégiques
(early-bird, membres fondateurs).

**Mécanique bout en bout :**

- `billing_prices.promo_cycles` (1..24, NULL = à vie) — saisi dans la carte admin
  (champ 🔁 à côté de l'échéance, pré-rempli 3 en mensuel / 1 en annuel quand on
  crée une promo, placeholder ∞ ; récap de sauvegarde « N période(s) puis prix de
  base » ou « à vie »).
- À l'engagement (checkout `/confirm` payé OU webhook `ORDER_COMPLETED`, selon qui
  arrive premier — les deux idempotents), le mapping client reçoit
  `amount_cents = prix promo`, `base_amount_cents = prix de base mémorisé`,
  `promo_cycles_left = N`. Les valeurs voyagent **stampées dans les metadata de
  l'ordre** (`base_amount_cents`, `promo_cycles`) — même garantie d'équité que le
  prix : c'est l'offre affichée au moment du clic qui fait foi, pas l'état de la
  table au moment du paiement.
- Le cron (`norva-revolut-billing`) décrémente `promo_cycles_left` **après chaque
  encaissement réussi** ; à épuisement, `amount_cents` rebascule sur
  `base_amount_cents` (nettoyé à NULL) — le cycle suivant est facturé plein tarif.
  L'essai gratuit ne décompte rien (pas d'encaissement) : les N périodes sont bien
  N périodes **payées**.
- Transparence légale (« then $X ») partout : page de vente « You save $1.99/mo
  for your first 3 months, then $4.99/mo », checkout « promo price for your first
  3 months, then $4.99/mo », landing (Terms) « US$3.00/month for your first
  3 months, then US$4.99/month until canceled ».

**Points d'attention :**

- `admin_billing_promo_set` gagne `p_cycles` → **signature étendue** ⇒ DROP de
  l'ancienne 6-args ⇒ **⚠ NOTIFY pgrst obligatoire** (+ nouvelles colonnes
  `base_amount_cents`/`promo_cycles_left` lues via REST par le cron).
- Les abonnés promo **existants** (engagés avant cette migration) restent « à
  vie » : leur mapping n'a pas de `promo_cycles_left`, aucun contrat en cours
  n'est modifié — c'est voulu (on ne change pas les termes après coup).
- Le décompte est côté Revolut uniquement ; sur le rail Play, les offres
  limitées dans le temps se configurent dans la Play Console (mêmes règles que
  le reste des promos — voir tableau des surfaces ci-dessus).

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
