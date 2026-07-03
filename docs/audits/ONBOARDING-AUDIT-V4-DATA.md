# Norva — Audit **V4 « DATA »** : nos pratiques confrontées aux vrais chiffres du marché

> Suite de `ONBOARDING-AUDIT-V3.md`. Le V3 était ancré dans le **code** (ce qui est construit, ce
> qui manque). Ce V4 est ancré dans les **données publiées** : chaque pratique Norva — essai 7 j à
> carte, empreinte 0,50 €, checkout embarqué, relances, annulation, push, multi-appareils, TV,
> pricing, stratégie Play Store — est **notée contre les chiffres réels du marché**, avec un
> verdict « ✅ conforme / 🟡 sous-optimal / 🔴 manquant » sourcé, et des recommandations
> **quantifiées** (impact attendu en points de conversion / churn).
>
> **Méthode.** 3 recherches parallèles sur sources publiées 2023-2026 : (A) benchmarks
> d'abonnement mobile/M&E (RevenueCat *State of Subscription Apps* 2024/25/26, Adapty 2025/26,
> Antenna, Recurly Research), (B) checkout / dunning / win-back (Baymard Institute, Stripe,
> Recurly, Churnkey, Klaviyo, Worldpay), (C) onboarding / push / CTV / politique Play
> (Auth0-Okta, Airship, Braze, GetResponse, Amplitude, Userpilot, docs officielles Google &
> Netflix). Règle stricte : **uniquement des chiffres publiés avec source nommée** ; quand la
> donnée n'existe pas publiquement, c'est écrit. Les sources à confiance faible sont marquées ⚠️.
>
> **Date : 2026-07-03.** État Norva de référence : `main` post-PR #95 (rail Stancer complet,
> P0 + P1 de l'audit V3 livrés, mode test).

---

## Partie A — Scorecard : chaque pratique Norva vs le benchmark

| # | Pratique Norva | Benchmark marché (source) | Verdict |
|---|----------------|---------------------------|---------|
| 1 | **Essai 7 j AVEC carte** (opt-out) | Essais opt-out ≈ **48,8 %** de conversion vs opt-in ≈ **18,2 %** (⚠️ FirstPageSage ; ordre de grandeur 2,5-3× confirmé par le consensus sectoriel) | ✅ Le bon choix structurel |
| 2 | **Durée 7 jours** | Essais 5-9 j : ≈ **45 %** trial→paid ; le meilleur segment (17-32 j) ne fait que 45,7 % (RevenueCat SOSA 2025) | ✅ Dans la zone optimale |
| 3 | **Empreinte 0,50 € « released, never debited » + encart réassurance** | Raison n°1 d'abandon checkout : **coûts inattendus, 39 %** (Baymard 2025) ; la « sécurité perçue » est visuelle avant d'être technique (Baymard) | ✅ Traite la cause n°1 |
| 4 | **Checkout embarqué (iframe) 100 % Norva** | 19 % abandonnent par **méfiance à confier leur carte** ; proxy : Stripe Payment Element intégré = **+10,5 % de revenu** vs formulaire basique (Stripe 2024) | ✅ |
| 5 | **Checkout court** (plan récap + carte seule, email déjà connu) | Checkout idéal : **7-8 champs** ; moyenne constatée 14,88 (Baymard) ; **60 % abandonnent au-delà de ~2 min** (Stripe) | ✅ |
| 6 | **Rappel J-2 avant prélèvement** (email + push, construit, gaté) | Blinkist : *annoncer* le rappel = **+23 % de démarrages d'essai**, réclamations **−55 %** ; Apple n'envoie PAS de rappel fiable ; mandat Visa : rappel ≥7 j avant débit pour les essais **> 7 j** (le nôtre, exactement 7 j, est à la limite — le rappel J-2 nous couvre) | ✅ + opportunité copy (§C-3) |
| 7 | **Relance abandon checkout** (email + push, fenêtre 2-48 h) | Emails panier abandonné : **50,5 % d'ouverture, 3,33 % de conversion** (Klaviyo 2024) ; envoi optimal ≈ **1 h** après abandon, la conversion **chute de moitié après 24 h** (SaleCycle) | 🟡 Fenêtre à resserrer vers 1 h |
| 8 | **Dunning 3 emails × 24 h + push + self-serve card update** | Churn involontaire = **20-40 % du churn total** (Churnkey ~40 %, Recurly ~26 %) ; ~**13 %** des paiements récurrents déclinent ; les leaders récupèrent **> 50 %** (Recurly) ; **~70 %** du churn involontaire est récupérable, surtout par *smart retries* (≈ 28 points) plus que par email (≈ 8 points) | 🟡 Emails OK, mais retry fixe (cron horaire) sans smart retries ni card updater |
| 9 | **Annulation : dialogue de confirmation simple** | Un vrai *cancel flow* avec contre-offre sauve **20-22 %** des annulations B2C (Churnkey 2024) ; acceptation : remise **53,9 %**, pause **19,2 %** | 🔴 Aucune contre-offre = ~1 annulation sur 5 perdue pour rien |
| 10 | **Win-back J+7 après expiration** (email + push, gaté) | ~**30 %** des churnés sont récupérables ; emails win-back ≈ **29 %** d'ouverture ; SVOD : les **re-abonnés = 34 % des recrutements bruts** et ~4 churnés sur 10 reviennent sous 12 mois (Antenna 2024) | 🟡 Existe, mais sans offre incitative ni séquence |
| 11 | **Paiement par carte uniquement** | +1 moyen de paiement pertinent = **+7,4 %** de conversion ; Apple Pay = **+22,3 %** (A/B Stripe 2024) ; **13,4 %** abandonnent si leur moyen préféré manque (Worldpay) | 🔴 Le plus gros levier checkout restant |
| 12 | **Prix 4,99 $/mois (Plus)** | Prix modal du marché : **9,99 $/mois** ; les apps « chères » convertissent **9,8 % vs 4,3 %** (install→paid) et font une LTV an-1 de **55 $ vs 8 $** (RevenueCat) | 🟡 Choix assumé, mais on laisse de la LTV sur la table |
| 13 | **Plans annuels proposés (41,99 $ / 75,99 $)** | Rétention an-1 : plans annuels **44,1 %** vs mensuels **17 %** (RevenueCat) | ✅ + à pousser davantage (§D-4) |
| 14 | **Mode `observe` (pas d'enforcement)** | Paywall dur : **12,11 %** download→paid vs freemium **2,18 %** (≈ 5×) ; LTV **+21 %** (Adapty) ; en contrepartie un paywall souple génère ~50 % de démarrages d'essai en plus | 🟡 Transitoire assumé — l'enforce est la dernière étape du go-live |
| 15 | **Social login câblé mais dormant** (OAuth non configuré) | Social login = **25 % des MAU** ; Google = **75 %** des logins sociaux (Auth0/Okta) ; les murs de vérification email coûtent **~20-30 %** des inscriptions | 🔴 Friction d'inscription évitable |
| 16 | **Push : demande de permission** (Android 13+) | L'opt-in Android a **chuté depuis Android 13** (permission runtime) ; le *soft prompt* en contexte est la parade documentée ; un push d'onboarding bien placé = **+71 %** de rétention à 2 mois, **+130 %** combiné à un 2ᵉ canal (Braze) ; push transactionnel ≈ **69 %** d'ouverture | 🟡 Pas de soft prompt en contexte |
| 17 | **Welcome email always-on** | Welcome emails : **83,63 % d'ouverture, 16,6 % de CTR** — ~2× / ~5× la moyenne de tout autre email (GetResponse 2024) | ✅ Le canal le plus lu — à charger en activation (§C-2) |
| 18 | **TV : code/QR d'appairage, paiement sur web** | Standard Netflix/Google (device-code RFC 8628) ; les achats initiés à la TV se **terminent sur téléphone à 56 %** vs 29 % sur TV (LG Ads 2024) ; 93 % des viewers ont un 2ᵉ écran en main | ✅ Conforme au pattern leader |
| 19 | **APK Android TV « login only », paiement hors app** | Politique Play (officielle, en vigueur) : les apps **« consumption-only » sont explicitement autorisées** (modèle Netflix) ; et depuis le **30 juin 2026** (US/UK/EEE) : liens de paiement externes autorisés, barème **10 % + 10 %** abonnements auto-renouvelés | ✅ Conforme + fenêtre stratégique ouverte (§E-5) |
| 20 | **Activation avant paiement** (BYOC : ajouter une source avant de payer) | 55,4 % des annulations d'essai ont lieu **le jour 0** (Adapty) : un essai démarré sans valeur perçue est un essai mort ; corrélation vitesse-de-valeur ↔ rétention **0,69** (Amplitude) ; **> 98 %** des users churment sous 2 semaines s'ils n'atteignent pas la valeur | 🟡 Le produit le permet, le funnel ne l'orchestre pas (§D-1) |

**Lecture d'ensemble.** Sur 20 pratiques : **9 ✅ conformes aux leaders, 7 🟡 sous-optimales,
4 🔴 manquantes.** Les fondations (essai à carte, durée, réassurance, checkout embarqué, TV,
conformité Play) sont **validées par les données** — on a construit les bonnes choses. Les trous
restants sont concentrés sur **trois moments** : l'entrée (social login, moyens de paiement), la
sortie (cancel flow sans contre-offre) et la récupération (smart retries, win-back sans offre).

---

## Partie B — Le funnel chiffré, étape par étape

### B-1. Découverte → inscription

- **Benchmark.** Social login représente ~**14 % des logins et 25 % des MAU** des apps grand
  public, et **Google concentre 75 %** des logins sociaux (Auth0/Okta). Les formulaires courts
  gagnent : passer de 4 à 3 champs a montré ~**+50 %** de complétion (⚠️ HubSpot, donnée ancienne
  mais jamais contredite). Un mur de confirmation d'email (double opt-in bloquant) coûte
  **20-30 %** des inscriptions.
- **Norva.** Inscription email+mot de passe, 2 champs, pas de mur bloquant avant l'app — bien.
  Mais le bouton Google est **absent** (OAuth non configuré côté dashboard) alors que le code est
  prêt. Sur un produit dont la cible passe par mobile/TV, on ampute le canal qui pèse un quart
  des MAU du marché.
- **Verdict : 🔴 #15.** Une action de configuration (owner, ~30 min) débloque un levier mesuré.

### B-2. Activation (la variable cachée de TOUT le funnel)

- **Benchmark.** Taux d'activation moyen tous SaaS/apps : **37,5 %** (Userpilot 2024). Amplitude
  mesure une corrélation de **0,69** entre vitesse d'atteinte de la valeur et rétention, et
  **> 98 %** des utilisateurs qui ne rencontrent pas la valeur churment sous 2 semaines. En
  médias, la rétention à 3 mois médiane est **2,5 %** vs **13,4 %** pour le décile supérieur —
  l'écart se joue presque entièrement dans les premières sessions.
- **Norva.** Particularité structurelle : Norva est **BYOC** — sans source ajoutée, l'app est
  vide. La valeur ne peut PAS précéder l'ajout d'une source. Or notre funnel pousse au checkout
  (paywall, landing CTAs) sans garantir qu'une source existe. Combiné au chiffre Adapty —
  **55,4 % des annulations d'essai ont lieu le jour 0** — le risque est précis : un utilisateur
  qui paie l'empreinte, ouvre une app vide et annule dans l'heure.
- **Verdict : 🟡 #20.** Le tunnel doit **séquencer** : source ajoutée → premier contenu lu →
  ALORS proposition d'essai. C'est la reco n°1 de ce V4 (§G, P0-1).

### B-3. Démarrage d'essai

- **Benchmark.** Médiane download→trial : **6,2 %** (toutes catégories) ; M&E ≈ **4 %**
  (RevenueCat). Paywall dur = **12,11 %** download→paid vs **2,18 %** freemium (Adapty, ≈ 5×),
  avec **+21 % de LTV** ; le paywall souple produit ~50 % de démarrages d'essai en plus mais
  les convertit moins. Blinkist : afficher « *on vous préviendra avant la fin de l'essai* » sur
  l'écran d'essai = **+23 % de démarrages** et **−55 % de plaintes**.
- **Norva.** L'essai à carte est en place, la durée est bonne, l'encart 0,50 € traite l'angoisse
  du débit surprise. Deux améliorations directes : (1) le mode `observe` actuel est un paywall
  « fantôme » — ni la conversion du dur, ni le volume du souple ; l'**enforce** (déjà planifié
  comme dernière étape go-live) est validé par le ×5 d'Adapty ; (2) la promesse de rappel
  (« We'll email you 2 days before your trial ends ») n'est **pas affichée** sur subscribe.html /
  checkout.html alors que le rappel J-2 existe réellement — c'est +23 % de démarrages selon le
  cas Blinkist, pour une ligne de copy.
- **Verdict : ✅ #1 #2 #3 #6, 🟡 #14.**

### B-4. Checkout

- **Benchmark.** Abandon moyen : **70,22 %** (Baymard, méta-analyse 2025). Causes : coûts
  inattendus **39 %**, création de compte forcée **19 %**, méfiance carte **19 %**, processus
  trop long **18 %**, moyens de paiement insuffisants **10 %**. Un checkout retravaillé vaut en
  moyenne **+35,26 %** de conversion (Baymard). **60 %** abandonnent si ça dépasse ~2 minutes
  (Stripe). Moyens de paiement : **+7,4 %** par méthode pertinente ajoutée, **+22,3 %** pour
  Apple Pay seul (A/B Stripe 2024) ; **13,4 %** partent si leur méthode préférée manque
  (Worldpay).
- **Norva.** Notre checkout coche presque tout : embarqué (méfiance ✔), « Today: $0.00 » +
  encart 0,50 € (coûts inattendus ✔), user déjà connecté (compte forcé ✔), carte seule à saisir
  (< 2 min ✔). Le seul trou est **carte uniquement** : ni Apple Pay, ni Google Pay, ni PayPal.
  Sur mobile web — notre trafic dominant — taper un PAN à 16 chiffres est exactement la friction
  que Apple Pay/Google Pay suppriment. Stancer supporte Apple Pay et Google Pay sur sa page de
  paiement (à activer côté compte, comme l'autorisation USD).
- **Verdict : ✅ #3 #4 #5, 🔴 #11.** Levier checkout restant le plus rentable : **+7 à +22 %**
  de conversion checkout pour une activation côté PSP.

### B-5. Essai → payant

- **Benchmark.** Conversion trial→paid médiane : **37,3 %** (mobile toutes catégories),
  **43,8 %** en Media & Entertainment ; dispersion énorme (p25-p75 : 11,5-69,5 %) (RevenueCat
  SOSA 2025). **55,4 %** des annulations d'essai : jour 0 ; les annulations mensuelles se jouent
  aussi tôt (~30-35 % le premier mois pour l'annuel).
- **Norva.** Cible à retenir pour nos dashboards : **> 43,8 %** (médiane M&E) puisque notre
  essai est opt-out — les cohortes opt-out publiées tournent autour de 48 % (⚠️). Sous 35 %,
  chercher le problème dans l'activation (B-2), pas dans le checkout.
- **Verdict : instrumentation.** Aucun de ces ratios n'est encore mesuré chez nous (pas
  d'analytics funnel) — voir §E-4.

### B-6. Renouvellement & churn involontaire

- **Benchmark.** Churn mensuel médias numériques ≈ **6,5 %** (Recurly) ; SVOD premium **4,6 %**
  (Antenna). Le churn **involontaire** (carte expirée, déclin) = **20-40 %** du churn total ;
  ~**13 %** des paiements récurrents échouent ; **~70 %** de ce churn est récupérable — les
  *smart retries* (retenter au bon moment : jour de paie, heure locale, réseau) récupèrent
  ~28 points, les emails de dunning ~8 points ; les meilleurs programmes dépassent **50 %** de
  récupération (Recurly). Un *card updater* réseau protège ≈ **7 %** du revenu mensuel. Sur
  Google Play, les annulations pour problème de facturation sont passées de 28,2 à **31 %** des
  annulations — même les stores n'y échappent pas.
- **Norva.** Le cron de facturation retente **toutes les heures, mécaniquement**, et le dunning
  envoie 3 emails espacés de 24 h + push + lien card-update self-serve. C'est au-dessus de la
  moyenne du marché (beaucoup d'apps n'ont RIEN), mais sous l'état de l'art : pas de smart
  retries (fenêtres intelligentes), pas de card updater (à vérifier côté Stancer), pas d'offre
  de « grâce » (ex. +3 jours d'accès pendant la mise à jour de carte — on a déjà `grace` dans
  notre modèle d'états !).
- **Verdict : 🟡 #8.** À notre échelle de lancement c'est suffisant ; à > 1 000 abonnés, les
  smart retries deviennent le levier churn n°1 (30-40 % du churn est involontaire).

### B-7. Annulation — le trou le plus net du dispositif

- **Benchmark.** Un cancel flow avec contre-offres sauve **20-22 %** des annulations B2C
  (Churnkey, données produit 2024). Taux d'acceptation par type d'offre : **remise 53,9 %**,
  **pause 19,2 %**. À l'inverse, le dark pattern (cacher le bouton) est mesurablement
  contre-productif (plaintes, chargebacks, et interdictions réglementaires type FTC
  click-to-cancel).
- **Norva.** Notre flow : bouton Cancel visible → dialogue de confirmation → annulation
  effective fin de période, avec resume en un clic. Propre, honnête, conforme… et **muet** : il
  ne demande pas la raison, ne propose ni pause, ni passage au plan annuel/inférieur, ni remise.
  Chaque cinquième annulation environ est statistiquement récupérable à cet endroit précis.
- **Verdict : 🔴 #9.** Reco P0-3 (§G) : écran intermédiaire raison + 1 contre-offre contextuelle
  (pause 1 mois si « pas le temps », downgrade si « trop cher », lien support si « bug »).
  Impact attendu : **−20 % de churn volontaire** au point d'annulation.

### B-8. Win-back & re-souscription

- **Benchmark.** ~**30 %** des churnés sont récupérables ; emails win-back ≈ **29 %**
  d'ouverture. Antenna (SVOD US) : les **re-abonnés représentent 34 % des recrutements bruts**,
  ~**4 churnés sur 10 reviennent sous 12 mois**, et les « serial churners » = 23 % des abonnés.
  Mobile : **20 %** des mensuels annulés se réabonnent sous un an, vs **5 %** des annuels
  (RevenueCat).
- **Norva.** Win-back J+7 (email + push) construit et la re-souscription est réellement
  **self-serve en un clic** (kind `resubscribe`, re-facturation dans l'heure) — beaucoup d'apps
  n'ont pas ça. Manque : la **séquence** (un seul envoi à J+7, alors que 4/10 reviennent sur
  12 mois → toucher J+30, J+90 avec des angles différents) et l'**offre** (le win-back sans
  incitation convertit surtout les partants involontaires).
- **Verdict : 🟡 #10.** P1 : étendre à une séquence 3 touches ; ajouter une offre simple
  (ex. 50 % le premier mois de retour) quand le volume le justifiera.

### B-9. Emails & push — les chiffres par canal

| Canal | Benchmark | Norva | Verdict |
|-------|-----------|-------|---------|
| Welcome email | **83,6 % open / 16,6 % CTR** (GetResponse) — l'email le plus lu du cycle de vie | Envoyé always-on, contenu générique « bienvenue » | ✅ existe / 🟡 sous-exploité : c'est LE créneau pour pousser « ajoutez votre première source » (activation, B-2) |
| Rappel fin d'essai | Blinkist +23 % trials ; Visa exige un rappel pour essais > 7 j | J-2 email + push, construit, gaté | ✅ |
| Abandon checkout | 50,5 % open / 3,33 % conv ; **optimal ~1 h**, −50 % après 24 h | Fenêtre 2-48 h (cron 15 min) | 🟡 passer la borne basse à ~1 h |
| Dunning | Recovery leaders > 50 % | 3×24 h + push + self-serve | 🟡 (retry intelligent manquant) |
| Win-back | ~29 % open ; 4/10 reviennent sous 12 mois | 1 touche J+7 | 🟡 (séquence) |
| Push opt-in | Chute post-Android 13 ; soft prompt en contexte = parade ; +71 % rétention 2 mois si bien utilisé (Braze) | Permission demandée sans mise en scène | 🟡 soft prompt à placer après le 1er contenu lu |

### B-10. Multi-appareils & TV

- **Benchmark.** Le standard leader (Netflix, YouTube, Disney+) est l'appairage par
  code/QR (device-code, RFC 8628) : on ne tape **jamais** un mot de passe ou une carte à la
  télécommande. LG Ads 2024 : les achats initiés sur TV se terminent **à 56 % sur téléphone**,
  29 % seulement sur la TV ; 93 % des viewers ont un second écran en main.
- **Norva.** Appairage par code court ✅ ; paiement uniquement sur le web ✅ (c'est le pattern
  gagnant, pas un pis-aller) ; états d'abonnement affichés partout depuis P0/P1 ✅. Manque un
  détail actionnable : quand la TV affiche un état nécessitant une action de paiement
  (past_due, expiré), afficher un **QR code** qui ouvre directement
  `checkout.html?intent=update_card` (ou subscribe) sur le téléphone — au lieu d'un texte
  « go to norva.tv ». C'est la traduction directe du 56 %-sur-téléphone.
- **Verdict : ✅ #18 + amélioration P2.**

### B-11. Pricing

- **Benchmark.** Prix modal du marché : **9,99 $/mois**. RevenueCat : les apps du quartile de
  prix supérieur convertissent MIEUX install→paid (**9,8 % vs 4,3 %**) et font **55 $ vs 8 $**
  de LTV an-1 — le prix bas n'achète pas la conversion. Rétention an-1 : annuel **44,1 %** vs
  mensuel **17 %**.
- **Norva.** 4,99 $/8,99 $ nous place nettement sous le marché. C'est défendable en lancement
  (BYOC = pas de coût de contenu, argument « moins cher qu'un café »), mais les données disent
  deux choses : (1) on pourra monter les prix des NOUVELLES cohortes sans casser la conversion ;
  (2) il faut pousser l'**annuel** beaucoup plus fort (badge « 2 months free », pré-sélection de
  l'annuel par défaut sur subscribe.html) — c'est le levier rétention le plus documenté du
  marché (44,1 % vs 17 %).
- **Verdict : 🟡 #12, ✅→🟡 #13.**

### B-12. Play Store — le paysage a changé (30 juin 2026)

- **Faits (officiels, pages Google Play).** (1) Les apps **consumption-only** restent
  explicitement autorisées : login pour consommer un contenu payé ailleurs, sans achat in-app
  ni lien de souscription — le modèle Netflix, exactement notre APK TV actuel. (2) Depuis le
  **30 juin 2026**, aux **US/UK/EEE** : Google autorise la facturation alternative ET les liens
  externes de paiement dans les apps, avec un barème réduit (**10 %** sur le premier million,
  **10 %** sur les abonnements auto-renouvelés via facturation alternative — vs 15/30 % avant) ;
  le user-choice billing historique donnait −4 points. Le Media Experience Program (barème
  réduit pour apps média) continue par ailleurs.
- **Conséquence pour Norva.** Notre plan actuel (APK login-only + paiement 100 % web) reste
  **le plus simple et 0 % de commission** — validé. Mais quand la publication Play viendra
  (délibérément différée), on aura une option qui n'existait pas au moment du V3 : un bouton
  « Subscribe » **dans l'app Android** qui ouvre notre checkout web (lien externe autorisé
  US/UK/EEE), coût ~10 % — à comparer au cas Dipsea : forcer le web-only depuis l'app coupe
  ~**⅓ des démarrages d'essai** (27 %→18,1 %) mais le revenu net par user est ≈ équivalent
  après commissions (2,09 $ IAP vs 1,96 $ web). Autrement dit : le lien externe in-app
  récupère le volume perdu du web-only en gardant l'économie du web.
- **Verdict : ✅ #19 aujourd'hui + décision à prendre au moment de la publication (§E-5).**

---

## Partie C — Ce que les données VALIDENT (ne pas y retoucher)

1. **L'essai 7 j à carte avec empreinte 0,50 €.** Opt-out ≈ 2,5-3× la conversion de l'opt-in ;
   7 j dans la meilleure bande de durée ; la réassurance « No charge today » traite la cause
   d'abandon n°1 (39 %). L'architecture choisie est celle des leaders.
2. **Le welcome email always-on.** 83,6 % d'ouverture — aucun autre canal n'approche ça. (Le
   charger en activation est un upgrade, pas une correction.)
3. **Le rappel J-2.** Conforme à la logique Visa, et le cas Blinkist transforme cette obligation
   en argument marketing : *afficher* la promesse du rappel sur l'écran d'essai = +23 % de
   démarrages. Une ligne de copy à ajouter.
4. **Le checkout embarqué court.** Méfiance, longueur, compte forcé : neutralisés. Le +35 %
   d'uplift Baymard « checkout retravaillé », on l'a déjà largement capté.
5. **Le modèle TV code + paiement web.** C'est LE pattern leader (56 % des achats TV finissent
   sur téléphone), pas une limitation.
6. **La conformité Play du APK login-only.** Explicitement couverte par la politique
   consumption-only en vigueur.
7. **Cancel/resume/re-subscribe self-serve en un clic.** La re-souscription à 1 clic avec
   re-facturation dans l'heure est au-dessus du standard du marché.

## Partie D — Ce que les données jugent SOUS-OPTIMAL (à ajuster)

1. **L'ordre du funnel ignore l'activation** (B-2). BYOC = valeur impossible avant l'ajout d'une
   source ; 55,4 % des annulations d'essai au jour 0 ; > 98 % de churn sans valeur perçue.
   → Séquencer : source d'abord, essai ensuite (P0-1).
2. **Relance abandon : borne basse 2 h, optimum 1 h** (Klaviyo/SaleCycle : −50 % après 24 h).
   → Abaisser la fenêtre à 1 h (le cron tourne déjà toutes les 15 min) (P1-2).
3. **Dunning sans smart retries ni card updater** — les 2/3 du potentiel de récupération sont
   dans le retry intelligent, pas dans l'email. → Vérifier ce que Stancer offre (retry
   scheduling, account updater) ; sinon, moduler nous-mêmes les heures de retry (P1-3).
4. **L'annuel n'est pas poussé.** 44,1 % vs 17 % de rétention an-1 : le toggle Yearly existe
   mais Monthly est l'état par défaut. → Pré-sélectionner Yearly avec badge d'économie (P1-4).
5. **Push demandé sans mise en scène** (opt-in Android 13 en chute libre sur le marché).
   → Soft prompt après le premier contenu lu : « Get notified when new episodes arrive » (P2).
6. **Win-back mono-touche sans offre** alors que 4 churnés sur 10 reviennent sous 12 mois.
   → Séquence 3 touches + offre de retour quand le volume le justifie (P2).

## Partie E — Ce qui MANQUE (absent, mesurablement coûteux)

1. **Contre-offre à l'annulation** — 20-22 % des annulations sauvables (remise 53,9 % / pause
   19,2 % d'acceptation). Le plus gros trou du dispositif actuel. (P0-3)
2. **Apple Pay / Google Pay** — +7,4 % par méthode, +22,3 % Apple Pay, 13,4 % d'abandons
   « méthode manquante ». Activation côté compte Stancer (comme l'auth USD). (P0-2)
3. **Social login (Google)** — 25 % des MAU du marché passent par là ; le code est prêt, seule
   la config OAuth manque. (P0-4, action owner)
4. **Instrumentation funnel** — AUCUN des ratios de cet audit (download→trial 6,2 %,
   trial→paid 43,8 %, day-0 cancels 55,4 %…) n'est mesurable chez nous aujourd'hui. Sans
   compteurs (events : `signup`, `source_added`, `first_play`, `checkout_open`, `trial_start`,
   `trial_convert`, `cancel`, `winback_return`), on pilote à l'aveugle et on ne saura jamais si
   les recos marchent. (P0-5)
5. **Décision « lien externe in-app » à la publication Play** — nouvelle option depuis le
   30 juin 2026 (US/UK/EEE, ~10 %) ; le cas Dipsea chiffre l'alternative. À trancher au moment
   de publier, pas avant. (P2)

---

## Partie F — SWOT ancré données

| | |
|---|---|
| **Forces** (validées par les chiffres) | Essai opt-out 7 j = la config qui convertit 2,5-3× mieux ; checkout embarqué court traitant les 3 causes d'abandon majeures (39/19/19 %) ; annulation/résurrection self-serve ; TV conforme au pattern à 56 % ; 0 % de commission sur 100 % du revenu actuel ; welcome email sur le canal à 83,6 % d'ouverture |
| **Faiblesses** (mesurées) | Cancel flow muet (~20 % d'annulations sauvables perdues) ; carte-only (jusqu'à −22 % de conversion checkout vs Apple Pay) ; funnel qui n'orchestre pas l'activation (risque day-0 = 55,4 % des cancels) ; aucun analytics funnel ; annuel non poussé (44,1 vs 17 % de rétention) |
| **Opportunités** (chiffrées) | Enforce = ×5 sur download→paid (Adapty) ; social login = canal à 25 % des MAU ; prix sous le marché → marge de hausse sur nouvelles cohortes (LTV ×7 chez les apps chères) ; Play 30-06-2026 = lien externe in-app à ~10 % ; re-abonnés = 34 % des recrutements SVOD → le win-back est un canal d'acquisition |
| **Menaces** (documentées) | Churn involontaire 20-40 % du churn si le dunning reste basique ; serial churners = 23 % des abonnés SVOD (le BYOC atténue : pas de cycle de contenu à binger) ; réglementation cancel-flow (FTC click-to-cancel) interdit toute friction de sortie — notre flow propre est un atout, le rester |

---

## Partie G — Recommandations priorisées, chiffrées, mappées KPI

> Impact = estimation dérivée des benchmarks cités (pas une promesse) ; à valider par la mesure
> (P0-5 conditionne tout le reste).

### P0 — avant/pendant le go-live paiements

| # | Action | Donnée d'appui | KPI cible | Impact attendu |
|---|--------|----------------|-----------|----------------|
| P0-1 | **Orchestrer l'activation avant l'essai** : sur premier login sans source, guider « Add your first source » AVANT tout CTA d'abonnement ; welcome email recentré sur ce geste ; ne proposer l'essai qu'après le premier contenu affiché | 55,4 % des cancels d'essai au J0 ; corrélation TTV↔rétention 0,69 ; welcome 83,6 % open | Annulations J0, trial→paid | Le levier n°1 : chaque point de day-0 cancel évité est ~1 point de trial→paid |
| P0-2 | **Activer Apple Pay + Google Pay** sur la page Stancer (demande support, comme l'auth USD) | +22,3 % (Apple Pay, Stripe A/B) ; 13,4 % d'abandons méthode-manquante | Complétion checkout | **+7 à +22 %** de conversion checkout |
| P0-3 | **Cancel flow avec raison + 1 contre-offre** (pause 1 mois / downgrade / support selon la raison) — en restant 1-clic-pour-vraiment-annuler (conformité FTC) | Saves B2C 20-22 % ; acceptation remise 53,9 %, pause 19,2 % | Churn volontaire | **−20 %** d'annulations au point de sortie |
| P0-4 | **Configurer Google OAuth** (owner, dashboard Supabase — le code est prêt) | Social = 25 % MAU, Google = 75 % du social | Création de compte | Friction d'entrée −1 étape pour ~¼ des visiteurs |
| P0-5 | **Instrumenter le funnel** (8 événements clés + un dashboard) — sans ça, aucune reco n'est vérifiable | Toutes les médianes de cet audit | Tous | Condition de pilotage |

### P1 — dans le mois suivant le go-live

| # | Action | Donnée d'appui | KPI | Impact |
|---|--------|----------------|-----|--------|
| P1-1 | **Afficher la promesse de rappel** sur subscribe/checkout : « We'll remind you 2 days before your trial ends » (le rappel existe déjà) | Blinkist : +23 % trial starts, −55 % plaintes | Démarrages d'essai | +double-digit potentiel pour 1 ligne de copy |
| P1-2 | **Resserrer la relance abandon à ~1 h** (borne basse de la fenêtre 2 h→1 h) | Optimal 1 h ; −50 % de conversion après 24 h | Récupération d'abandons | Récupération ~×1,5-2 vs relance tardive |
| P1-3 | **Smart retries / card updater** : audit des capacités Stancer, sinon retry aux heures à fort taux de succès | 70 % du churn involontaire récupérable, retries ≈ 28 pts vs emails 8 pts | Churn involontaire | Jusqu'à −25-30 % du churn involontaire résiduel |
| P1-4 | **Pré-sélectionner Yearly** avec badge « 2 months free » sur subscribe.html | Rétention an-1 : 44,1 % annuel vs 17 % mensuel | Mix annuel, LTV | Chaque point de mix annuel ≈ +2,6× de rétention an-1 sur ce point |
| P1-5 | **Passer en `enforce`** (déjà planifié en dernière étape go-live) | Paywall dur ×5 download→paid, +21 % LTV | Trial starts, conversion | ×3-5 sur download→paid (au prix de moins d'essais gratuits de fait) |

### P2 — trimestre suivant

| # | Action | Donnée d'appui | KPI |
|---|--------|----------------|-----|
| P2-1 | Soft prompt push en contexte (après 1er contenu lu) | Opt-in Android 13 en chute ; push onboarding +71 % rétention 2 mois | Opt-in push, rétention |
| P2-2 | Séquence win-back 3 touches (J+7/J+30/J+90) + offre de retour | 4/10 reviennent sous 12 mois ; re-abonnés = 34 % des recrutements | Réactivation |
| P2-3 | QR code sur les écrans TV past_due/expired → deep-link checkout téléphone | 56 % des achats TV finissent sur téléphone | Récupération multi-device |
| P2-4 | Test de prix sur nouvelles cohortes (6,99 $ ?) | Apps chères : conversion 9,8 vs 4,3 %, LTV 55 vs 8 $ | ARPU, LTV |
| P2-5 | À la publication Play : trancher lien-externe-in-app (~10 %) vs login-only (0 %) | Dipsea : web-only = −⅓ de trials, revenu net ≈ égal ; Play 30-06-2026 | Volume natif |

---

## Annexe — Sources

- **RevenueCat, State of Subscription Apps 2024/2025/2026** : trial→paid 37,3 % / M&E 43,8 % ;
  durées d'essai ; download→trial 6,2 % ; rétention annuel/mensuel 44,1/17 % ; prix & LTV
  (9,8/4,3 % ; 55/8 $) ; win-back mensuel 20 % vs annuel 5 % ; web billing (Dipsea).
- **Adapty 2025/2026** : paywall dur 12,11 % vs freemium 2,18 %, +21 % LTV ; day-0 cancels 55,4 %.
- **Antenna (SVOD US) 2024** : churn 4,6 %/mois ; re-abonnés 34 % des recrutements ; 4/10
  reviennent < 12 mois ; serial churners 23 %.
- **Recurly Research** : churn médias ~6,5 %/mois ; churn involontaire ~26 % ; recovery > 50 %.
- **Baymard Institute 2025** : abandon 70,22 % ; causes 39/19/19/18/10 % ; 7-8 champs vs 14,88 ;
  +35,26 % d'uplift potentiel.
- **Stripe 2023-2024** : Payment Element +10,5 % ; +7,4 %/méthode ; Apple Pay +22,3 % ; 60 %
  abandon > 2 min ; déclin ~13 %.
- **Churnkey 2024** : churn involontaire ~40 % ; saves B2C 20-22 % ; acceptation remise 53,9 %,
  pause 19,2 %.
- **Klaviyo 2024 / SaleCycle** : abandon email 50,5 % open, 3,33 % conv ; timing optimal ~1 h.
- **Worldpay** : 13,4 % d'abandon méthode-manquante.
- **Auth0/Okta** : social login 14 % des logins / 25 % MAU ; Google 75 % du social.
- **GetResponse 2024** : welcome 83,63 % open / 16,6 % CTR.
- **Braze / Airship 2025** : push onboarding +71 % rétention 2 mois (+130 % bi-canal) ; opt-in
  Android 13.
- **Amplitude / Userpilot** : corrélation TTV↔rétention 0,69 ; activation moyenne 37,5 % ;
  rétention médias 3 mois 2,5 % vs top 13,4 %.
- **LG Ads 2024** : achats TV finis sur téléphone 56 % vs TV 29 % ; 93 % second écran.
- **Google Play (pages officielles, 2026)** : politique consumption-only ; facturation
  alternative & liens externes US/UK/EEE au 30-06-2026, barème 10 % + 10 %.
- **Blinkist (étude de cas publiée)** : +23 % trials, −55 % plaintes, opt-in push 6→74 %.
- ⚠️ Confiance faible mais directionnel : FirstPageSage (opt-out 48,8 % vs opt-in 18,2 %),
  HubSpot (champs de formulaire, donnée ancienne).
