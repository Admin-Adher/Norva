# Android TV — blocage sur « Preparing your cinema » (deadlock splash ↔ sélecteur de profil)

**Statut : corrigé** (branche `claude/vod-live-tv-error-c7xasm`, commit `6a652ba`).
Web-only : nécessite un **déploiement de `public/` sur norva.tv** + rechargement du
shell côté TV pour prendre effet.

---

## 1. Symptôme

Les Android TV appairées restent **indéfiniment** sur le splash de lancement
`app.html` :

> **Preparing your cinema** — *Checking this screen and loading your synced experience.*

Le compte ne s'ouvre jamais. **Uniquement les Android TV** : les navigateurs et le
web fonctionnent normalement. Apparu après la migration self-host (Hetzner /
`api.norva.tv`).

## 2. Ce qui est innocenté (backend 100 % sain)

Tests + logs Kong/GoTrue pendant le blocage :

- `SUPABASE_PUBLISHABLE_KEY` (46 car.) = clé embarquée `sb_publishable_…` → **match**.
- `/auth/v1/health` → **200** (GoTrue v2.189.0) ; `/functions/v1/norva-cloud/health`
  → **200** (`version:21`, `entitlementsMode:"enforce"`).
- Le navigateur (referer `norva.tv`) poll `/functions/v1/norva-cloud/sources` +
  `/auth/v1/user` → **200** en boucle, sans souci.

## 3. Preuve décisive (logs Kong pendant qu'une TV est bloquée)

UA `…NorvaTV-AndroidTV/3.1` (MiTV-MOOQ0) :

```
21:16:08  GET /functions/v1/norva-cloud/device/entitlements → 200
21:16:12  GET /functions/v1/norva-cloud/device/sources      → 200
21:16:12  GET /functions/v1/norva-cloud/device/profiles     → 200 (403 o)
          ↳ GET /rest/v1/cloud_account_profiles?select=…,setup_completed,… → 200 (638 o)  ← PLUSIEURS profils
21:16:15..31  device/sources → 200, 200, 200…  (poll ~3 s, AUCUNE progression)
```

La TV atteint le backend, **tous les endpoints device répondent 200**, récupère ses
profils (638 o = compte **multi-profils**), **puis se fige**. Aucune erreur réseau.
Le blocage est **côté client**.

## 4. Cause racine — deadlock de z-index

Chaîne de boot dans `public/js/app.js` (`init()`) : le splash n'est retiré
(`finishTvLaunchScreen()`) qu'**après** `checkAuth()` → `checkCloudAccess()` →
**`NorvaProfiles.ensureSelected()`**.

`ensureSelected()` (`public/js/profiles.js:663`) retourne une **Promise qui ne se
résout que sur clic** dans l'overlay quand il y a **plusieurs profils**
(« Who's watching? », `:695`) ou un profil **non configuré** (`:670`).

Or les z-index se recouvrent :

| Élément | z-index | Source |
|---|---|---|
| Splash `.tv-launch-screen` (mode TV uniquement, classe `tv-launching`) | **2 147 483 000** | `public/css/main.css:16198` |
| Sélecteur de profil `.np-overlay` | **10 000** | `public/js/profiles.js:76` |

Sur TV, le splash (z-index quasi-max) **recouvre** le sélecteur → l'utilisateur ne
voit rien, ne peut pas cliquer → la Promise ne se résout jamais →
`finishTvLaunchScreen()` n'est jamais appelé → **splash à vie**.

**Pourquoi TV-only :** la classe `tv-launching` (et donc le splash) n'est ajoutée que
pour l'UA Android TV (`public/app.html:29-30`). En navigateur, pas de splash → le
picker s'affiche → aucun blocage.

**Pourquoi « soudainement » :** `pickedThisSession()` lit `sessionStorage`
(`profiles.js:62`) — une nouvelle session WebView réaffiche systématiquement le
« Who's watching? » pour tout compte multi-profils, exposant le deadlock à chaque
lancement.

## 5. Correctif (commit `6a652ba`) — 3 couches

1. **`public/js/app.js`** — appeler `finishTvLaunchScreen()` **avant** l'étape profil,
   pour que le picker soit toujours visible/cliquable. (`finishTvLaunchScreen()`
   programme son propre fondu de 420  ms et retourne immédiatement, donc le picker
   s'affiche pendant l'`await`.)
2. **`public/css/main.css`** — `html.tv-launching .np-overlay { z-index: 2147483001; }`
   : garantit structurellement que le picker passe **au-dessus** du splash, indépendamment
   de l'ordonnancement JS (la spécificité plus élevée l'emporte quel que soit l'ordre CSS).
3. **`public/js/app.js`** — **failsafe 12 s** : `setTimeout(() => finishTvLaunchScreen(), 12000)`
   en tête d'`init()`. Si un appel cloud (auth/droits/profils) ou une étape interactive
   se fige, le splash tombe quand même. Filet de sécurité pour **toute** panne future
   (`finishTvLaunchScreen()` est idempotent → chemin normal inchangé).

## 6. Débloquer une TV avant redéploiement

1. **Sur la TV** : appuyer sur **OK/Sélection** de la télécommande (au besoin flèche →
   puis OK). Le focus est probablement déjà sur le 1ᵉʳ profil caché → le sélectionner
   résout la Promise et le splash disparaît. Coût nul, à tenter en premier.
2. **Depuis le navigateur** (fonctionnel) : réduire temporairement le compte à **un seul
   profil configuré** → la TV auto-sélectionne (`list.length <= 1`, `profiles.js:681`) et
   boote. Réajouter les profils après le déploiement.

## 7. Déploiement

Le correctif est **web** (`public/js/app.js` + `public/css/main.css`), servi depuis
**norva.tv**. Déployer `public/` sur norva.tv, puis la TV recharge le shell (le
cache-bust du shell force le nouveau `app.js`/`main.css` ; sinon « Vider les données »
de l'app TV force le rechargement).

## 8. Suivi / durcissement possible

- [ ] Déployer `public/` sur norva.tv + valider sur une TV multi-profils.
- [ ] Envisager un timeout/abort explicite sur les appels device de boot
      (`entitlements.device()` / `loadProfiles()`) pour ne pas dépendre que du
      failsafe de 12 s.
- [ ] Audit z-index : le splash à `2147483000` est un « aimant » — tout futur overlay
      interactif au boot doit vivre au-dessus, ou le splash doit tomber avant.
