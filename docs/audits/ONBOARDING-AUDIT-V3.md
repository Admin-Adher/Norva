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

*(Parties B–E : état des lieux par support, tunnels & settings, multi-device, benchmark, focus
essai 7 j, recommandations priorisées — rédigées ci-dessous.)*
