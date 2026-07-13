# Session 2026-07-13 (2) — nav TV catalogue, profils plein écran, modèle d'abonnement & lifecycle

**Statut : commits livrés sur `main` (front auto-Cloudflare ; edge redéployé sur Hetzner). Le mode `limits` (#10) a été REVERTÉ le jour même — voir §10.**

Suite du log `2026-07-13-session-log.md` (nav Live + synchro cloud). Cette session couvre : la nav D-pad des pages **Movies/Séries**, la refonte **plein écran des profils** sur TV, un **audit « pubs vs réel »** des abonnements, la bascule du **différenciateur de plan** (profils, plus flux), le **verrouillage des profils** au downgrade, et le **découpage du flag lifecycle** billing. ⚠️ Un 10ᵉ point (mode `limits`) a été ajouté **puis reverté** après avoir constaté que le paiement Revolut est déjà en prod (cf. §10).

| # | Sujet | Commit `main` | Fichiers clés |
|---|---|---|---|
| 1 | Nav D-pad Movies/Séries (workflow) | `7f0fb5f` | `tvNavigation.js` (v17), `main.css` (v78) |
| 2 | Profils TV plein écran, auto-scale, zéro scroll (workflow) | `362607a` | `profiles.js` (v9→ voir #5) |
| 3 | Audit pubs vs réel (workflow) | `d09ce43` | `docs/roadmap/2026-07-13-plans-vs-features-audit.md` |
| 4 | Plan = **profils (2/5)**, plus flux + 3 sur-promesses corrigées | `0fe8549` | `entitlements.ts`, `subscribe/landing/index.html` |
| 5 | Verrouillage non destructif des profils au downgrade + upsell | `fcdaca0` | `norva-cloud/index.ts`, `profiles.js` (v9) |
| 6 | Restauration du copy rappel J‑2 (crons DB live) | `5d6c180` | `subscribe/landing/index.html` |
| 7 | Pépites landing : sous-titres IA, Cast, self-healing | `f120db4` | `landing.html`, `index.html` |
| 8 | Lifecycle : flags par-flux + correctifs des bloqueurs | `57fd2f3` | `norva-lifecycle/index.ts`, `lifecycle-email.ts` |
| 9 | Lifecycle : claim atomique dunning + câblage des flags edge | `c90afbc` | `norva-lifecycle/index.ts`, `docker-compose.supabase.yml`, `.env.hetzner.example` |
| 10 | ~~Mode entitlements `limits`~~ **REVERTÉ** (`72a541d`) — prémisse fausse, cf. §10 | `311a4e9` → `72a541d` | `entitlements.ts`, `norva-cloud/index.ts`, `norva-playback/index.ts`, `.env.hetzner.example` |

Méthode : 4 workflows multi-agents (nav Movies/Séries, fit profils TV, audit features, flag-readiness lifecycle), chacun avec vérification adverse ; harnais headless Playwright pour la nav + le fit + le verrouillage.

---

## 0. Rappels d'infra (à relire avant de toucher)

- **TV = WebView ~853×480 px** (1920/2.25 × 1080/2.25). Le CSS TV doit **rétrécir**, pas grossir.
- **Front** = Cloudflare Pages auto sur push `main`. **Edge** = box Hetzner : `ssh adrien@norva-db` (déjà dessus) → `git pull` → `ops/hetzner/scripts/04-deploy-edge-functions.sh`. ⚠️ **Ne pas** préfixer `ssh adrien@norva-db &&` (tu es déjà sur la box → le `&&` casse le `git pull`).
- **`04-deploy-edge-functions.sh` fait un `restart`** → recharge le CODE, mais **pas** les nouvelles variables d'env du compose. Pour de nouvelles vars : `docker compose --env-file .env -f ops/hetzner/docker-compose.supabase.yml up -d functions` (recréer).
- **`deno.lock`** est gitignoré (artefact de `deno check`, hors build edge).

---

## 1. Nav D-pad Movies & Séries (`7f0fb5f`) — `tvNavigation.js` v17

Le moteur n'avait **aucune garde** pour ces pages (seul `page-live` l'était). Corrigé, tout scopé `.tv-mode`, **26/26** au harnais + suites Live intactes :
- **Grille** : le ♥ favori (opacity:1) et le badge « N versions » de chaque carte étaient des **cibles D-pad** → Haut/Bas/Droite atterrissaient sur le coin de la carte. Retirés des candidats.
- **`navScope()`** : confine le D-pad à un **panneau multi-select** ou une **fiche** ouverte (comme un modal). BACK/Escape ferme via `closeTransient()`.
- **Fiche** : focus à l'ouverture sur Play/Reprendre (même si « Loading… » puis activé) ; retour = carte d'origine ; Back matériel sur fiche **film** revient à la grille (avant : sortait vers l'accueil).
- **Bord de grille/continue** : flèche gauche → rail (au lieu de dériver vers un filtre). **Entrée** de page → 1ʳᵉ carte (façon Netflix).
- **CSS** : la barre de contrôles (source/catégories/recherche/favoris) restait en grille mobile 1fr/1fr/44px à 853 px → override tv-mode en ligne flex.

## 2. Profils TV plein écran (`362607a`) — puis v9

Tous les écrans profils **scrollaient** sur 480 px (559–848 px de haut). Refonte hybride (**7/7** harnais) :
- **Base CSS compacte** `html.tv` : avatars 112 px, titre `clamp(24px,4.4vh,34px)` (la police suit la hauteur d'écran), 12 avatars sur **une** ligne, 6 cartes sur **une** ligne.
- **`fitPanel()`** : après rendu, scale le panneau pour tenir l'écran (`transform:scale`, snap à 1 si ≥0.985, plancher 0.5) ; re-calcul au resize/font. Overlay `overflow:hidden` → **ne peut plus scroller**.
- Corrige un **bug de spécificité** (l'aperçu `np-avatar np-avatar-lg` ballonait à 200 px), **supprime le `window.confirm`** natif au profit de NorvaModal sur TV, **pas de clavier auto**, **noms longs** en ellipsis.

## 3. Audit « pubs vs réel » (`d09ce43`) — doc dédiée

Workflow : **52 promesses** de copy vs **172 fonctionnalités réelles** (22/26 vérifiées). Détail complet dans **`2026-07-13-plans-vs-features-audit.md`**. Têtes d'affiche : un **étage IA sous-titres** (Whisper + Argos + OCR), Cast, self-healing, jamais vendus ; et des sur-promesses (export RGPD inexistant, offline « app Android » only, etc.).

## 4. Plan = profils (2 vs 5), pas flux (`0fe8549`)

**Subtilité produit** : le nombre de **flux simultanés dépend du fournisseur IPTV**, pas de Norva → on ne le vend plus. `entitlements.ts` :
- **`plus.profiles 5→2`, `family` reste 5** ← seul différenciateur.
- `concurrent_streams` → **10 identique** (trial/plus/family) : garde-fou backend silencieux, jamais annoncé.
- Copy corrigé (subscribe/landing/index) : profils au lieu de flux ; mot **« export »** retiré (RGPD) ; **offline** qualifié « Android app » ; message d'erreur de capacité neutralisé.

## 5. Verrouillage des profils au downgrade (`fcdaca0`) — `profiles.js` v9

Un Family (5 profils) → Plus (2) **garde tout**, mais les profils en trop passent **verrouillés** (non destructif, façon Netflix/SaaS) :
- **Ensemble actif figé & non-permutable** : principal + les plus **anciens** (`created_at` immuable, pas `sort_order`). Déblocage = upgrade **ou** supprimer un profil actif. **Pas de swap libre** (sinon la limite ne sert à rien).
- **Serveur** (`norva-cloud`) : `activeProfileIdSet()` ; `listProfiles` renvoie `locked` ; `resolveProfileId` **refuse** un profil verrouillé même si le client force l'en-tête (retombe sur le défaut).
- **Client** : cartes verrouillées grisées + cadenas ; clic = **upsell contextuel** (web/mobile → `/subscribe.html` ; **TV** → modale « upgrade depuis ton téléphone/le web », car **pas d'achat sur TV**) ; re-affiche le picker si le profil actif devient verrouillé.

## 6. Copy rappel J‑2 restauré (`5d6c180`)

Le workflow lifecycle a révélé que le rappel J‑2 est **déjà envoyé** par **2 crons DB** (`norva-trial-ending-3d`/`-1d`, migration `20260708120000`), **indépendants du flag** — d'où les emails reçus en test. La promesse est donc **tenue** → copy restauré (mon adoucissement précédent était basé sur le mauvais chemin de code).

## 7. Pépites landing (`f120db4`)

3 cartes ajoutées (Skip Intro exclu — inopérant sur IPTV) : **« AI subtitles, in your language »** (génération+traduction+OCR), **« Cast to your TV »**, **« Self-healing playback »**.

## 8–9. Lifecycle : flags par-flux + bloqueurs (`57fd2f3`, `c90afbc`)

Workflow flag-readiness → **verdict : ne PAS flipper le flag unique** (il activait 5 flux, dont 4 dangereux). Refonte :
- **Flag maître + 5 flags par-flux** (`NORVA_LC_TRIAL/DUNNING/EXPIRE/WINBACK/ABANDONED`, tous **OFF** par défaut). `NORVA_LIFECYCLE_BILLING_LIVE=true` seul **n'active plus rien**.
- **Dunning + trial** → `provider='revolut'` (les past_due Play/Apple sont gérés par le store).
- **Trial** reste OFF (les crons DB sont le vrai chemin → sinon double envoi).
- **Expire** : UPDATE gardé `status='past_due'` (ne pas expirer quelqu'un qui a payé entre-temps).
- **Doublons** : CAS atomique `claimMarker()` sur welcome/trial/winback **et** dunning (claim `dunning_last_at` avant envoi, rollback si échec).
- **Légal** : header `List-Unsubscribe` + lien de désinscription + adresse postale (`NORVA_POSTAL_ADDRESS`) en pied. Winback/abandoned restent OFF (consentement + one-click unsubscribe requis ; abandoned lit encore la table **Stancer retirée** → repointer sur `cloud_revolut_orders`).
- **Câblage** : les vars `NORVA_LC_*` + `NORVA_POSTAL_ADDRESS` **n'étaient pas passées** au conteneur `functions` → ajoutées au compose (défaut false). Revue adverse du diff → **SAFE**.

Revue adverse (agent) du diff lifecycle : aucun bloqueur — CAS, gating, provider-scope, garde expire tous corrects.

## 10. Mode entitlements `limits` — AJOUTÉ PUIS REVERTÉ (`311a4e9` → `72a541d`)

> **Compte-rendu d'incident (mineur, 0 utilisateur impacté).** À garder pour ne pas refaire l'erreur.

**Ce qui s'est passé.** J'ai codé un 3ᵉ mode d'entitlements `limits` (appliquer les caps de plan **sans** le mur d'accès facturation), sur la **prémisse fausse** que le paiement n'était pas prêt et que l'`enforce` trouvé sur la box était un défaut accidentel. J'ai même basculé la box `enforce` → `limits`.

**La réalité (que je n'avais pas lue).** `docs/BILLING-REVOLUT-MIGRATION.md` **Phase 6** : le **paiement Revolut est en PRODUCTION depuis le 2026-07-11**, validé **vraie carte Mastercard**. L'état de prod **délibéré et validé** est **`NORVA_ENTITLEMENTS_MODE=enforce` + `NORVA_BILLING_MODE=revenuecat`** (+ front `billing-config.js` `revolut.enabled:true`/`mode:prod`, git `d45ffb1`/`c2b0f9d`/`38496eb`). L'`enforce` de la box **n'était donc pas un accident** — c'était le paywall soft voulu (non-abonné → palier `free`, browse sans lecture, s'abonne via Revolut ; bypass admin).

**Pourquoi 0 dégât.** `billingMode` était **`revenuecat`** en permanence. Dans ce mode, un soft-denial passe par `freeBrowseDecision` (`allowed:true`, `concurrent_streams:0`), que `limits` laissait passer tel quel → **le paywall a tenu**. Seule fuite théorique de `limits` vs `enforce` en revenuecat : un `past_due` toutes grâces expirées (`billing_unverified`, `allowed:false`) serait ouvert au lieu d'être bloqué — **aucun** des 5 comptes test n'était dans ce cas. Fenêtre ~1 h, aucun paiement raté.

**Remédiation** (cette session) :
- Box **remise en `enforce`** — health vérifié : `entitlementsMode:"enforce"` + `entitlementsEnforced:true` + `billingMode:"revenuecat"`.
- Commit `311a4e9` **reverté** (`72a541d`) : le mode `limits` est retiré du code (footgun : un `limits` mal posé affaiblit le paywall — inutile puisque le paiement est live).
- `.env.hetzner.example` : commentaire corrigé (2 modes ; **prod = `enforce`+`revenuecat`, Revolut live** ; `observe` = rollback d'urgence uniquement).

**Leçon** : lire `BILLING-REVOLUT-MIGRATION.md` **avant** de toucher à `NORVA_ENTITLEMENTS_MODE`/`NORVA_BILLING_MODE`. L'état de prod est `enforce`+`revenuecat` — pas à « décider », déjà validé.

---

## ⚠️ À NE PAS OUBLIER (ops)

1. ✅ **Edge redéployé** (#5 `norva-cloud`, #8/#9 `norva-lifecycle`) — fait cette session via `git pull` + recréation du conteneur `functions`. Tout lifecycle reste OFF. ⚠️ **Le revert `72a541d` du mode `limits` n'est pas encore sur la box** — à récupérer au prochain `git pull` + `up -d functions` (sans effet de comportement : la box est en `enforce`, qui n'utilise pas la branche `limits`). Rappel : `restart` recharge le **code** mais pas les **nouvelles vars d'env** → pour tout `NORVA_LC_*`/`NORVA_ENTITLEMENTS_MODE`, il faut `docker compose --env-file ops/hetzner/.env -f ops/hetzner/docker-compose.supabase.yml up -d functions` (recréer).
2. 🔒 **`NORVA_ENTITLEMENTS_MODE=enforce` + `NORVA_BILLING_MODE=revenuecat` = état de PROD validé** (paiement Revolut live depuis le 2026-07-11 — cf. §10 + `BILLING-REVOLUT-MIGRATION.md`). **NE PAS** repasser en `observe` (ni `limits`, retiré) sauf **rollback d'urgence** : ça réouvre tout et affaiblit le paywall. Vérif : `curl -s https://api.norva.tv/functions/v1/norva-cloud/health | grep -o 'entitlementsMode\|billingMode'` → doit rester `enforce`/`revenuecat`.
3. **Activer le lifecycle plus tard** : jamais `EXPIRE` sans `DUNNING` (couperait sans avertir). Combo `NORVA_LIFECYCLE_BILLING_LIVE=true` + `NORVA_LC_DUNNING=true` (+ `NORVA_LC_EXPIRE=true`), puis **recréer** le conteneur (`up -d functions`, pas restart). Prérequis : cron `norva-lifecycle` enregistré, `RESEND_API_KEY` + expéditeur `norva.tv` vérifié.

## Versions d'assets finales
`tvNavigation.js` v17 · `main.css` v78 · `profiles.js` v9 · (`api.js` v70, `cloudApi.js` v47, `ChannelList.js` v43, `LiveGuideFusion.js` v27, `WatchPage.js` v117 inchangés depuis le log précédent).

## Harnais headless (scratchpad de session, non versionnés)
`ms-nav-harness.html` + `ms-nav-test.js` (26/26 nav Movies/Séries), `prof-harness.html` + `prof-measure.js` (7/7 no-scroll) + `prof-lock-test.js` (7/7 verrouillage). Chromium `/opt/pw-browsers/chromium-1194`, Playwright `/opt/node22/lib/node_modules/playwright`.
