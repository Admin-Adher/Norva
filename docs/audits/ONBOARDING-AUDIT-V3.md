# Norva — Audit onboarding & tunnel de conversion **V3** (post-rail de paiement)

> Suite de `ONBOARDING-CONVERSION-AUDIT.md` (V1) et `ONBOARDING-AUDIT-V2.md` (V2). Le verdict V2
> tenait en une phrase : *« tout le reste est prêt ou construit ; le seul verrou est le rail de
> paiement »*. **Ce verrou a sauté.** Ce V3 (1) journalise le lot « paiements & checkout » livré
> depuis V2, (2) refait l'audit complet — web / Android TV / mobile Android, de la découverte à la
> rétention, tunnels principaux ET secondaires, settings & gestion d'abonnement, scénarios
> multi-appareils, benchmark mondial — et (3) livre des recommandations priorisées et actionnables.
>
> **Date : 2026-07-03 (soir).** Ancré dans le code déployé sur `main` et dans les validations
> **réelles en navigateur** (essai `trialing` posé en base, débit token USD `response 00`).

---

## Partie A — Journal : ce qui a changé depuis V2 (PR #79 → #90)

Le lot « paiements » a été conçu, construit, **testé de bout en bout dans un vrai navigateur**,
corrigé (6 bugs réels trouvés au test) et déployé. Détail complet : `docs/PAYMENTS-STATUS.md` §11.

| # | Chantier | État | Réfs |
|---|----------|------|------|
| 1 | **Rail de paiement web Stancer** : checkout hébergé → tokenisation carte → essai 7 j → prélèvement auto à J+7 + renouvellements (cron), reçus | 🟢 **Live en mode test**, validé E2E navigateur | PR #79/#80, `norva-stancer*`, jobid 82 |
| 2 | **Essai 7 j À CARTE** (Option B) : empreinte **0,50 € libérée, jamais débitée** (`capture:false`) → le mur de fin d'essai du mode legacy disparaît au profit d'une vraie conversion | 🟢 Live (test) | `norva-stancer/checkout` |
| 3 | **`/confirm` sans webhook** : la page de retour confirme le paiement elle-même (re-fetch server-side, user-authé) → rail auto-suffisant | 🟢 Validé en réel | PR #80, §10 PAYMENTS-STATUS |
| 4 | **Devise USD** pour les prélèvements (4,99 $ / 8,99 $ ; annuel 41,99 $ / 75,99 $), **prix en $** sur landing/index/subscribe ; empreinte de validation en **EUR** (contournement : l'autorisation seule USD n'est pas activée côté compte Stancer — action support en cours) | 🟢 Live | PR #81/#85 |
| 5 | **Réassurance checkout** : encart « No charge today — released right away and never debited » (chemin web uniquement) | 🟢 Live | PR #81 |
| 6 | **Checkout activé** : `billing-config.stancer.enabled=true` — le CTA « Subscribe » web aboutit réellement | 🟢 Live | PR #81 |
| 7 | **Vrais états d'abonnement affichés** : Settings « Norva Access » (Free trial / Active / Payment due / Ending soon / Expired + dates) et `subscription.html` (fini le « Full access » générique masquant l'état réel) | 🟢 Live | PR #86/#87 |
| 8 | **`returnTo` de bout en bout** : après paiement, « Back » ramène à l'origine (ex. Settings) — validé same-site (anti open-redirect) | 🟢 Live | PR #88 |
| 9 | **Moyen de paiement affiché** : « Payment method — •••• 0077 · exp 12/30 » sur subscription.html (+ route `GET /profile`) | 🟢 Live | PR #89 |
| 10 | **Checkout premium embarqué** : `checkout.html` 100 % Norva (récap plan, « Today: $0.00 », réassurance) avec le **formulaire carte Stancer en iframe** — l'utilisateur ne quitte plus norva.tv ; PCI SAQ-A conservé ; pont `checkout-done.html` → `/confirm` → succès inline | 🟢 Live | PR #90 |
| 11 | **Page légale en anglais** (dernière page FR d'un produit full-english) | 🟢 Live | PR #81 |
| 12 | Corrections trouvées au test réel : CORS preflight (`apikey`), fausse piste `auth:true` (422), diagnostic devise USD auth-only, double fichier app (`app/index.html` servi vs `app.html`) | 🟢 | PR #82–#88 |

**Preuve de bout en bout (mode test, en base)** : checkout → `status=trialing · provider=stancer ·
plan_code=plus · trial_ends_at=J+7 · card_token stocké` ; débit token **USD** → `response 00`,
`to_capture`.

**Ce qui reste gaté côté owner (secrets edge)** : `NORVA_LIFECYCLE_BILLING_LIVE` (J-2/dunning/
win-back), bascule prod `sprod_`/`live`, sortie du mode `legacy` + enforcement `enforce`,
activation OAuth, portail d'annulation. → repris dans les priorités (Partie E).

---

## Partie B — État des lieux par support (post-lot paiements)

> Constats ancrés dans le code sur `main` au 2026-07-03 soir. Réalité runtime vérifiée en live :
> `NORVA_ENTITLEMENTS_MODE=observe` (rien n'est bloqué), `NORVA_BILLING_MODE=legacy` (essai
> auto sans carte pour les nouveaux), clé Stancer **test** (`stest_`), crons **enregistrés et
> actifs** (lifecycle jobid 81 · billing Stancer jobid 82 — les commentaires du code disant
> « à enregistrer » sont en retard sur la réalité).

### B.1 Web — le support de référence

**Atterrissage** (`index.html`, `/landing*` → 301) : hero « Your catalog. Every screen. One
experience. », piliers de confiance avant le prix (annulation, EU/RGPD, chiffrement, paiement
sécurisé, opérateur RCS + médiateur), prix **en $** avec toggle annuel −30 %, fine print essai
honnête. **Frictions** : les CTA des cartes de prix ne portent **ni le plan ni la période**
choisis (tous → `/account.html?returnTo=/app#home`) ; le picker `/subscribe.html` n'est **jamais
lié depuis le marketing** ; témoignages commentés (aucune preuve sociale chiffrée) ; le toggle
annuel est purement cosmétique (le choix est perdu à l'inscription).

**Inscription / connexion** (`account.html`) : e-mail+mdp (min 6), reset, vérification OTP
on-site, gestion `returnTo` sûre. **OAuth Google/Apple câblé mais désactivé**
(`OAUTH_PROVIDERS=[]`). **Mur de confirmation e-mail** : si la confirmation Supabase est active,
pas de session à l'inscription → l'utilisateur ne peut pas atteindre le checkout avant d'avoir
confirmé puis re-signé (friction à mesurer).

**Choix d'offre** (`subscribe.html`) : cartes claires, CTA « Start 7-day free trial » (relabellé
« Subscribe » si essai consommé), encart réassurance **0,50 € jamais débité** (gated web-Stancer),
bannière « already subscribed » + lien gestion, messages soft-wall contextualisés
(`norva-entitlement-denied`). **Frictions** : « Restore purchases » **affiché mais cassé sur web**
(échoue toujours `not_configured`) ; bannières dormantes en observe.

**Checkout embarqué** (`checkout.html` + pont `checkout-done.html`) — **la grande nouveauté** :
récap plan/prix (« Today: $0.00 »), formulaire carte Stancer **en iframe** (l'utilisateur ne
quitte plus norva.tv), 3DS géré, succès inline, `returnTo` respecté, fallback nouvel onglet,
retry, gate de session. Niveau **best-in-class** pour un rail hébergé. **Frictions** : mix
**$ affiché / empreinte 0,50 €** (contournement USD auth-only, cf. PAYMENTS-STATUS §11.2) ;
aucun état persisté si l'onglet ferme (abandon = repartir de zéro) ; si `/confirm` reste
`pending` après 5 essais, l'écran de succès adouci n'offre ni retry ni contact support.

**Statut & gestion** (`subscription.html`, Settings « Norva Access ») : tous les états réels
rendus (Free trial + jours restants, Active + date, Ending, Payment due, Retrying, Expired) ;
« Payment method — •••• 0077 · exp 12/30 » ; Resume/Resubscribe/Change plan selon l'état.
**Friction majeure** 🔴 : `webCustomerPortalUrl=''` → **aucun bouton « Manage / cancel » ni
« Update payment » sur le web**, alors que la page dit « You can manage or cancel your
subscription anytime » et que le marketing promet « cancel in a click ». Copy ≠ capacité.

**Soft-walls in-app** : deux destinations **incohérentes** — refus au boot → `paywall.html`
(interstitiel **sans CTA « See plans »** ; le refusé est envoyé vers `account.html`) ; refus
402 playback/capacité → `subscribe.html` (correct). Bandeaux essai (« N days left ») et incident
de paiement existent mais **uniquement si `enforced===true`** → invisibles aujourd'hui (observe).
Un seul signal premium (`auto_refresh_background`).

### B.2 Android TV (3.8.0, `tv.norva.tv`)

- **Sign-in par QR opérationnel** (`cloud-pair.html` : code + QR + polling 2,5 s + redirection
  auto) — au standard Netflix/YouTube. Fallback code manuel. ✅
- **Vente on-device** : bridge RevenueCat v8 complet (`purchase`/`restore`/`billingLogin`) mais
  **clé absente** → tout achat TV répond *« Billing is not available on this platform yet »*.
  Le rail Stancer/checkout web est **correctement exclu du natif** (gating `!hasNativeBilling()`)
  — conforme à la politique Google Play. **Aucun signpost** « abonnez-vous sur norva.tv » (à
  formuler prudemment : la policy Play autorise l'info « compte requis » sans lien de paiement).
- La TV **consomme** l'entitlement du compte (achat web ⇒ accès TV immédiat). ✅
- Pas de push TV ; cibles D-pad de subscribe durcies (`html.tv`) mais `checkout.html` n'a pas de
  mode TV (non critique : le natif ne l'atteint jamais).

### B.3 Android mobile (1.2.0, `tv.norva.phone`)

- Coquille WebView → hérite de **tout** le tunnel web (piliers, activation, états, checkout
  serait accessible… mais exclu par le gating natif, comme sur TV : Play Billing inerte ⇒ même
  message « Billing is not available »).
- **Push FCM implémenté** (canal, token → `/push-token`) mais consommé **uniquement** par les
  notifications d'import de catalogue. Infra **réutilisable telle quelle pour le billing**.
- **App Links** : `assetlinks.json` encore en **placeholder SHA-256** (dépendance circulaire Play
  App Signing) ; pas de handler dédié pour les liens de confirmation e-mail.
- **Publication Play Store** : AAB signés et buildés ✅, console obtenue ✅ ; reste création des
  fiches + upload internal testing + Data Safety + assets. Le natif ne monétisera qu'après
  (clé RevenueCat + produits Play).

### B.4 Backend — moteur, cycle de vie, et les trous structurels

- **Source de vérité unique** `cloud_entitlement_projection` lue partout ✅ ; décision riche
  (status/plan/limites/messages), fail-open borné, hard-block (fraude/refund) même en observe. ✅
- **Rail Stancer** : checkout (empreinte 0,50 € `capture:false`), `/confirm` sans webhook,
  `/profile`, cron de débit USD (essai→1ʳᵉ facture, renouvellements, idempotence `unique_id`),
  reçus envoyés au débit. **Validé en réel.** ✅
- **E-mails de cycle** : bienvenue **live** ; J-2 / dunning (3 paliers/24 h) / win-back
  **construits, gatés** `NORVA_LIFECYCLE_BILLING_LIVE`. ⚠️ **Deux systèmes parallèles** : les
  anciens triggers DB (bienvenue à la confirmation, essai **J-3**, past_due, changements de
  statut) coexistent avec `norva-lifecycle` → **risque de double bienvenue** et de doublons J-3/J-2
  dès que la clé Resend Vault est posée. À déprogrammer.
- 🔴 **Aucune annulation côté serveur pour Stancer** : rien ne pose `cancelled_at_period_end`
  (seul le webhook RevenueCat l'écrit). Un abonné web ne peut pas annuler — ni en UI ni en API.
- 🔴 **`past_due` éternel** : le dunning s'arrête au palier 3 et le statut reste `past_due` pour
  toujours ; aucun passage en `expired` ⇒ le **win-back ne se déclenche jamais** pour un abonné
  Stancer en échec.
- 🔴 **Trou de logique « re-trial »** : `/checkout` ne vérifie pas `hasConsumedTrial` et
  `/confirm` pose **inconditionnellement** `trialing + trial_ends_at = now+7 j` sur un paiement
  de setup validé. Conséquence : un abonné **actif** qui refait un checkout (« Change plan »)
  obtient **7 jours gratuits supplémentaires** — rejouable à l'infini. Fuite de revenu + abus
  possible. (Le CTA se relabelle « Subscribe » côté UI, mais rien ne bloque côté serveur.)
- 🟠 **Pas de mise à jour de carte** : les e-mails de dunning disent « Update payment method » →
  `subscription.html` → **aucun bouton** (portail vide) ; seul un re-checkout (nouvelle empreinte)
  remplace le token — flux non exposé. Boucle morte pour récupérer un paiement échoué.
- 🟠 **Pas de changement de plan self-serve** (ni upgrade/downgrade prorata) ; « Change plan »
  repasse par le checkout complet (et déclenche le bug re-trial ci-dessus).
- 🟠 **Aucune relance d'abandon de checkout** : les intents `require_payment_method` sont
  journalisés dans `cloud_stancer_payments` mais jamais scannés (ni e-mail, ni purge).
- 🟠 **Billing 100 % e-mail** : l'infra push FCM + le feed in-app `content-events` existent mais
  ne portent aucun message de facturation (J-2, échec, win-back).
- Webhook RevenueCat prêt (idempotent, fail-closed) — inerte sans secret ; `TRANSFER` non géré.

---

## Partie C — Tunnels : revue exhaustive des points d'entrée demandés

| Point d'entrée / parcours | État | Verdict |
|---|---|---|
| Inscription / création de compte | E-mail+mdp, OTP on-site, OAuth dormant, mur de confirmation possible | 🟢 solide / 🟠 OAuth off, friction confirmation |
| Connexion | Simple, reset propre, `returnTo` sûr | 🟢 |
| Choix d'offre | `subscribe.html` clair, toggle, éligibilité essai | 🟢 / 🟠 non lié depuis la landing |
| Écrans d'essai gratuit | CTA, encart 0,50 €, confirmation post-checkout, compte à rebours (Settings/subscription) | 🟢 (bandeau in-app gated enforce) |
| Page de paiement | **Checkout embarqué premium** (iframe, $0.00 today, sécurité) | 🟢 best-in-class |
| Tunnel checkout complet | account → subscribe → checkout → 3DS → confirm → succès, `returnTo` bout en bout | 🟢 validé en réel |
| Confirmation de paiement | Succès inline + e-mail reçu (au débit) | 🟢 |
| Activation post-paiement | `/confirm` → `trialing` immédiat, tous supports via projection | 🟢 |
| Paiement refusé / incomplet | `past_due` + dunning 3 paliers (gated) ; **pas de MAJ carte, pas d'expired final** | 🔴 boucle morte |
| Relances après abandon checkout | **Inexistantes** (intents journalisés, jamais exploités) | 🔴 |
| Fin d'essai gratuit | Rappel J-2 construit (gated) ; conversion auto par cron ✅ | 🟠 à allumer |
| E-mails / push / in-app paiement | E-mails complets ; **push/in-app billing : rien** ; doublons legacy à déprogrammer | 🟠 |
| Upgrade / downgrade / changement d'offre | « Change plan » → re-checkout ; **pas de prorata, bug re-trial** | 🔴 |
| Réactivation après expiration/annulation | UI Resume/Resubscribe ✅ ; win-back e-mail construit ; **jamais déclenché pour Stancer** (pas d'expired) | 🟠 |
| Gestion d'abonnement (settings) | États réels + dates + carte ✅ ; **pas d'annulation web, pas de factures** | 🔴 annulation |
| CTA « s'abonner / payer / gérer / reprendre » | Tous aboutissent à la bonne surface, sauf `paywall.html` (refus boot → account.html, pas de « See plans ») | 🟠 |

### C.bis Scénarios multi-appareils

| Scénario | Réalité actuelle | Verdict |
|---|---|---|
| Inscription mobile → paiement web → usage TV | Projection unique : l'achat web ouvre tout ; TV via QR-pair | 🟢 |
| Achat web → connexion TV | QR + token device, statut immédiat | 🟢 |
| Tentative d'abonnement depuis la TV | « Billing is not available on this platform yet », sans guidance | 🔴 cul-de-sac (signpost « account required » à ajouter, policy-safe) |
| Tentative d'abonnement mobile natif | Idem TV (Play Billing inerte) | 🔴 idem |
| Redirection QR TV→mobile pour s'abonner | N'existe pas (le QR ne sert qu'au sign-in) | 🟠 opportunité |
| Synchro du statut entre appareils | Projection + `/confirm` + re-fetch : cohérente | 🟢 |
| Erreur / reprise de parcours interrompu | Checkout web : fermeture = tout perdre ; 3DS hors iframe : rattrapé par le pont ; confirm en retard : rattrapé par cron/visite suivante | 🟠 |

---

## Partie D — Benchmark mondial & focus essai 7 jours

### D.1 Benchmark (leaders streaming/SaaS/gaming/edtech/fitness, data RevenueCat)

| Pratique best-in-class | Référence | Norva V2 | **Norva V3** |
|---|---|---|---|
| Essai à carte + conversion auto | Netflix (historique), Calm, tous | ❌ legacy sans carte | 🟢 **live (test)** |
| Checkout on-site sans redirection | Stripe Checkout embarqué, Spotify | ❌ | 🟢 **iframe embarqué** |
| « Aucun débit aujourd'hui » explicite | Calm, Headspace ($0.00 today) | ❌ | 🟢 « Today: $0.00 » + 0,50 € expliqué |
| Rappel avant prélèvement (J-2) | Calm (réf.), exigence Apple/Google | 🟠 construit | 🟠 construit, **gated** |
| État d'abonnement lisible partout | Netflix (« Membership ») | ❌ « Full access » | 🟢 états réels + dates + carte |
| **Annulation en 1 clic** | Netflix (légal US/EU) | ❌ | 🔴 **toujours absent** |
| **MAJ moyen de paiement** | Netflix/Spotify (self-serve) | ❌ | 🔴 absent |
| Dunning intelligent (récup. 20-40 %) | Spotify, Netflix | 🟠 gated | 🟠 gated + **impasse carte** |
| Relance abandon checkout (récup. 10-30 %) | Amazon, SaaS | ❌ | 🔴 absent |
| Win-back déclenché | Netflix | 🟠 | 🟠 gated + **jamais tiré (Stancer)** |
| Changement de plan avec prorata | Spotify, Disney+ | ❌ | 🔴 absent (re-checkout + bug re-trial) |
| Push/in-app billing | Duolingo, Calm | ❌ | 🟠 infra prête, non branchée |
| Preuve sociale chiffrée | Tous | ❌ | ❌ (piliers ok, témoignages vides) |
| Login social 1-tap | Tous | 🟡 dormant | 🟡 dormant |
| Sign-in TV QR | Netflix/YouTube | 🟢 | 🟢 |
| Multi-device entitlement | Apple One, Spotify | 🟢 | 🟢 |

**Lecture** : V3 rattrape les leaders sur **l'avant-paiement** (checkout, clarté, réassurance,
états). L'écart restant est concentré sur **l'après-paiement** : annuler, changer de carte,
changer de plan, relancer — exactement les leviers churn/LTV des leaders.

### D.2 Focus — essai 7 jours → paiement automatique

| Critère | État V3 | Verdict |
|---|---|---|
| **Clarté** (durée, date de débit, prix après, conditions) | « 7 days free », « Today: $0.00 », « renews {date} unless cancelled », prix après essai affiché au checkout, Settings/subscription datés | 🟢 |
| **Fluidité** | account → subscribe → checkout embarqué → succès : 3 écrans, session-gated, `returnTo` | 🟢 |
| **Réassurance** | 0,50 € « released right away, never debited », « Norva never sees your card number », médiateur/RCS, cancel anytime | 🟢 sur le papier / 🔴 **« cancel anytime » sans bouton d'annulation = promesse à risque (UE/DGCCRF, chargebacks)** |
| **Rappels avant prélèvement** | J-2 construit (e-mail) — **gated** ; pas de push/in-app | 🟠 allumer + multiplier les canaux |
| **Conversion optimisée** | Conversion auto par cron validée ; bandeau compte à rebours in-app gated enforce | 🟠 |
| **Limite annulations/frustration** | Anti-surprise OK ; MAIS annulation impossible → frustration/chargeback ; échec de paiement sans issue (pas de MAJ carte) | 🔴 |

---

## Partie E — Synthèse stratégique & recommandations priorisées

### E.1 Forces / Faiblesses / Risques / Opportunités

- **Forces** : entitlement unifié multi-device ; checkout embarqué premium validé en réel ;
  essai à carte fonctionnel ; états d'abonnement enfin lisibles ; e-mails de cycle complets ;
  QR TV ; marge web sans taxe store.
- **Faiblesses** : aucune annulation/MAJ carte/changement de plan self-serve ; relances abandon
  inexistantes ; bandeaux in-app gated ; OAuth off ; témoignages vides ; landing sans deep-link
  d'offre ; natif non monétisable (clé RC absente, store non publié).
- **Risques** : 🔴 promesse « cancel anytime » non tenable (litiges, chargebacks, conformité
  UE) ; 🔴 bug re-trial = fuite de revenu ; 🔴 `past_due` sans issue = churn irrécupérable ;
  🟠 double e-mails legacy ; 🟠 clé test visible publiquement pendant la fenêtre de bascule.
- **Opportunités** : allumer l'existant (J-2/dunning/win-back = un flag) ; push billing sur infra
  FCM déjà posée ; relance abandon (10-30 % de récup. typique) ; QR « subscribe » sur TV ;
  annual par défaut post-essai ; publication Play = 2ᵉ moteur de revenu.

### E.2 Recommandations priorisées

**P0 — avant la bascule prod (`sprod_` + enforce)** *(bloquants légaux/revenu)*
1. **Annulation self-serve web** : endpoint `POST /cancel` (Stancer rail → `cancelled_at_period_end`,
   le cron cesse de débiter, l'accès court jusqu'à la fin de période) + bouton « Cancel plan » sur
   `subscription.html`. → tient la promesse, réduit chargebacks. *(KPI : churn « dur », litiges)*
2. **Corriger le trou re-trial** : `/checkout`+`/confirm` vérifient `trial_consumed_at` → si
   consommé, le setup devient « resubscribe » (activation immédiate + 1ᵉʳ débit au jour 0, pas de
   nouveau trial). *(KPI : revenu protégé)*
3. **MAJ de carte** : flux « Update payment method » = re-checkout étiqueté (nouvelle empreinte
   0,50 €, token remplacé, **sans toucher au statut/périodes**) + bouton sur `subscription.html`
   pour `past_due`/actifs. Ferme la boucle dunning. *(KPI : récupération paiements échoués)*
4. **Déprogrammer les triggers e-mail legacy** (bienvenue/J-3/past_due/status) → un seul système
   (`norva-lifecycle`). *(KPI : délivrabilité, confiance)*
5. **Bascule contrôlée** (ordre) : correctifs 1-3 → `NORVA_LIFECYCLE_BILLING_LIVE=true` →
   `sprod_`+`live` → sortie `legacy` + `enforce` **en dernier** (sinon TV/mobile = cul-de-sac
   d'achat). Fenêtre clé-test courte.

**P1 — conversion & rétention (semaines suivantes)**
6. `past_due` → `expired` après le palier 3 (+7 j) → le win-back se déclenche enfin. *(churn→réactivation)*
7. **Relance abandon checkout** : cron sur `cloud_stancer_payments` `require_payment_method` >2 h
   → e-mail « finish setting up your trial » (+J+1). *(complétion checkout, +10-30 % récup.)*
8. **Landing → intention préservée** : CTA des cartes → `/subscribe.html?plan=…&period=…`
   (signed-out : via `returnTo` post-signup). *(taux démarrage essai)*
9. `paywall.html` : ajouter CTA « See plans » sur l'état refusé. *(réactivation)*
10. **Bandeau compte à rebours d'essai** visible dès `status=trialing` réel (même en observe). *(conversion essai)*
11. **Natif** : clé RevenueCat + produits Play + publication (assetlinks post-upload) ; en
    attendant, message TV/mobile policy-safe « Norva subscription required — manage it from your
    account on the web » (sans lien de paiement). *(monétisation TV/mobile)*
12. **Push billing** sur l'infra FCM existante : J-2, échec de paiement, win-back. *(conversion+récup.)*
13. Activer **OAuth** ; remplir **témoignages réels**. *(création de compte, confiance)*
14. Support Stancer : activer **autorisations USD** → empreinte 0,50 $ (fin du mix $/€) ; confirmer
    le framing en prod. *(clarté checkout)*

**P2 — polish**
15. Masquer « Restore purchases » sur web ; 16. persister l'état de checkout (reprendre après
fermeture) ; 17. bouton « factures » (journal `cloud_stancer_payments` → liste des reçus) ;
18. changement de plan avec prorata (après P0-2) ; 19. Settings « Manage plan » → subscription.html
dès qu'un abonnement réel existe (même observe) ; 20. purge des intents abandonnés ; 21. e-mail
confirmation : OTP inline ou confirmation différée post-checkout ; 22. D-pad `checkout.html` (si
un jour atteint par TV) ; 23. dédoublonner `app.html`/`app/index.html` ; 24. UA TV `3.1`→version
réelle ; 25. démo/valeur avant compte (réduire la friction du compte d'emblée).

### E.3 Impact attendu par KPI

| KPI | Leviers (n° reco) |
|---|---|
| Création de compte | 8, 13 (OAuth, témoignages), 25 |
| Activation | déjà solide (gate + momentum V2) ; 21 |
| Démarrage d'essai | 8, 10, 11, 14 |
| Conversion essai→payant | 5 (J-2 on), 10, 12 ; protégée par 2 |
| Complétion checkout | 7, 14, 16 |
| Réduction annulations pendant l'essai | 1 (annulation saine > chargeback), 5, 10 |
| Churn | 3 + 6 (boucle dunning fermée), 12 |
| Réactivation | 6 (win-back enfin tiré), 9, 12 |
| Cohérence multi-device | 11 (natif), signpost TV |
| Confiance / compréhension | 1, 4, 14, 17 |
| LTV | 18 (upgrade prorata), annual par défaut post-essai, 11 |

### E.4 Scorecard V2 → V3

| Surface | V2 | **V3** |
|---|---|---|
| **Web — avant-paiement** | monétisation à zéro | 🟢 tunnel complet validé en réel, checkout embarqué premium |
| **Web — après-paiement** | n/a | 🔴 annulation/MAJ carte/factures absents |
| **Mobile** | hérite du web, natif inerte | idem + push infra prête ; publication Play imminente |
| **TV** | QR ✅, consume ✅ | idem ; achat on-device toujours cul-de-sac |
| **Backend** | legacy/observe, 0 paiement | 🟢 rail live (test) + cycle e-mail ; 🔴 trous cancel/re-trial/past_due |
| **Verrou n°1** | rail de paiement | **la gestion post-paiement (P0 1-3) + la bascule des secrets** |

---

*Documents liés : `PAYMENTS-STATUS.md` (rail + journal go-live §11), `STANCER-BILLING.md`
(architecture), `ONBOARDING-AUDIT-V2.md` / `ONBOARDING-CONVERSION-AUDIT.md` (états antérieurs).*
