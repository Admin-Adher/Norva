# Norva — état de la publication Play Store (snapshot)

> Snapshot opérationnel daté. Le référentiel exhaustif est `clients/PLAY_STORE.md`.
> Ce fichier dit **où on en est** et **quoi faire ensuite**, pas à pas.
>
> **Dernière mise à jour : 2026-07-03.**

## Où on en est (résumé)

| Étape | État |
|---|---|
| 0. Compte Google Play Console developer | ✅ **obtenu** |
| 1. Keystore + secrets + build des AAB signés | ✅ **fait** (build run #3 vert) |
| 2. Créer les 2 apps + uploader les AAB (Test interne) | ⏳ à faire |
| 3. Récupérer le SHA-256 (clé de signature Google) → `assetlinks.json` | ⏳ à faire (bloqué par l'étape 2) |
| 4. Fiche magasin + Data Safety + assets | ⏳ à faire |

**Dépendance en boucle importante** : le SHA-256 nécessaire à `assetlinks.json` n'existe
qu'**après** avoir uploadé un premier AAB et activé Play App Signing. Ordre : **build → upload →
récupérer l'empreinte → commit assetlinks → fiche magasin**.

---

## 1. Signing / keystore — ✅ fait

- **Keystore d'upload** : `norva-upload.jks`, créé le ~1 juillet 2026. **L'owner en détient la
  copie d'origine** (sauvegardée hors-repo — password manager). Format **PKCS12** → le mot de
  passe du keystore et celui de la clé sont **identiques** (PKCS12 l'exige). Alias : `norva`.
- **NE JAMAIS écraser** les secrets GitHub avec un autre keystore une fois qu'un AAB a été
  uploadé : Google rejetterait tout AAB signé par une clé d'upload différente
  (« upload key mismatch »). Tant que rien n'est uploadé, changer de keystore reste sans risque.
- Un keystore de secours avait été généré en session le 3 juillet **puis jeté** (l'owner avait
  déjà l'original) — il n'a jamais servi. Ne pas le rechercher.
- Avec **Play App Signing** (recommandé/défaut), ce `.jks` n'est que la clé d'**upload** ; Google
  détient la clé de **signature** finale. Si la clé d'upload est un jour perdue, elle est
  réinitialisable via le support Google (ce qui n'est PAS le cas de la clé de signature).

### Secrets GitHub (repo → Settings → Secrets and variables → Actions) — tous posés

| Secret | Rôle | État |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | base64 du `norva-upload.jks` | ✅ |
| `ANDROID_KEYSTORE_PASSWORD` | mot de passe du keystore | ✅ |
| `ANDROID_KEY_PASSWORD` | = même valeur (PKCS12) | ✅ |
| `ANDROID_KEY_ALIAS` | `norva` | ✅ |
| `GOOGLE_SERVICES_JSON` | config Firebase (push FCM, app phone) | ✅ (push actif dans le build) |

---

## 2. Build des AAB — ✅ fait

- Workflow : `.github/workflows/android-release.yml` (« Android Release (AAB) »).
  Déclenchement : **Actions → Run workflow → branche `main`**, ou push d'un tag `v*`.
- Produit **2 App Bundles signés** (`.aab`, pas des APK — c'est le format Play).
- **Dernier build réussi** : **run #3** (`id 28666097435`), sur `main` (`8a88d36`), 2026-07-03,
  ~2 min, 2 jobs verts.

| Artéfact | Taille | Package | Version |
|---|---|---|---|
| `Norva-AndroidPhone-release-aab` | 9,3 Mo | `tv.norva.phone` | `1.2.0` (versionCode 3) |
| `Norva-AndroidTV-release-aab` | 19,9 Mo | `tv.norva.tv` | `3.8.0` (versionCode 13) |

> Les artéfacts expirent 14 j après le build. Pour re-générer : relancer le workflow (idempotent,
> tant que les secrets sont en place). Pensez à **bumper `versionCode`** dans
> `clients/android-*/app/build.gradle` pour tout nouvel upload à la Console (un versionCode ne
> peut jamais être réutilisé).

---

## 3. À FAIRE — Créer les apps + uploader (Play Console)

1. **Créer l'app phone** : Play Console → *Créer une application* → nom `Norva`, langue FR,
   Application, Gratuite → cocher les déclarations.
2. **Uploader l'AAB phone** : dans l'app → *Tests → Tests internes → Créer une release* →
   au 1er upload, **accepter Play App Signing** (« clé générée par Google ») → glisser
   `Norva-AndroidPhone-release-aab` (9,3 Mo, package `tv.norva.phone`) → Enregistrer.
3. **Créer l'app TV** (2ᵉ app, package `tv.norva.tv`) et uploader l'AAB TV (19,9 Mo) de la même
   façon.
4. Pas besoin de « publier » la release tout de suite : le simple **upload** suffit à faire
   générer la clé de signature Google (nécessaire à l'étape suivante).

---

## 4. À FAIRE — `assetlinks.json` (empreinte SHA-256)

- Fichier : `public/.well-known/assetlinks.json`. Ne liste **que** `tv.norva.phone` — c'est la
  seule app qui déclare des App Links https `norva.tv` (`autoVerify` sur `/app.html` et `/t/`).
  La TV utilise le schéma custom `norva://open` → **aucune entrée nécessaire** pour elle.
- Placeholder actuel à remplacer :
  `REPLACE_WITH_RELEASE_SIGNING_SHA256_FROM_PLAY_CONSOLE`.
- **La bonne empreinte** = la **clé de signature de l'application** générée par Google, pas la clé
  d'upload. Play Console (app **phone**) → *Test et publication → Configuration → Intégrité de
  l'application → Clé de signature de l'application → SHA-256*.
- ⚠️ Ne PAS utiliser le SHA-256 de la clé d'upload (celui que `keytool -list` affiche) — c'est un
  piège courant.
- Une fois collé + commit + push → déploiement Cloudflare Pages → les liens `norva.tv` ouvrent
  l'app sans confirmation Android.

---

## 5. À FAIRE — Fiche magasin & Data Safety

**URLs (pages déjà en ligne) :**
- Politique de confidentialité → `https://norva.tv/privacy.html`
- Suppression de compte → `https://norva.tv/delete-account.html`

**Data Safety (Contenu de l'app → Sécurité des données) — réponses :**
- Collecte de données ? **Oui** · Chiffré en transit ? **Oui** · Suppression possible ? **Oui**
  (+ URL suppression) · Données vendues ? **Non** · Pub tierce ? **Non**
- Types collectés (aucun « partagé » avec un tiers) :
  - Infos perso : **e-mail** (obligatoire), **nom d'affichage** → compte, fonctionnalité
  - Infos perso → Autres : **identifiants de source média** saisis → fonctionnalité
  - Activité dans l'app : **historique / progression / favoris / préférences** → fonctionnalité, perso
  - Infos & perfs : **logs de plantage / diagnostics** → fonctionnalité
  - Historique des achats : **statut d'abonnement** → compte (aucun n° de carte stocké)
  - Adresse IP : pas un type dédié chez Google ; si demandé → « ID d'appareil ou autres »,
    finalité Sécurité / prévention de la fraude.

**3 rappels qui font rejeter s'ils manquent :**
1. **App access** → fournir un **compte démo avec abonnement valide** pour la revue Google.
2. **Foreground Service** (app phone, téléchargements) → justifier « téléchargement média initié
   par l'utilisateur avec notification de progression visible ».
3. **Positionnement contenu/IP** → « lecteur sans aucun contenu, l'utilisateur connecte sa propre
   source autorisée ». **Jamais** les mots IPTV / chaînes / films gratuits / service tiers.

**Assets** : icône 512×512, feature graphic 1024×500, captures phone **et** bannière + captures
TV, descriptions courte/longue, questionnaire de classification, public cible.
(Détails §5–§11 de `clients/PLAY_STORE.md`.)

---

## Annexe — E-mail de support (fait, hors Play Store)

- **Réception** : Cloudflare Email Routing sur `norva.tv` → règle `support@norva.tv` → transfert
  vers `norva.support@gmail.com` (boîte dédiée). Adresse de destination **vérifiée**, règle
  **active**, catch-all désactivé.
- **Envoi « en tant que support@norva.tv »** : Gmail *Send mail as* via SMTP Resend
  (`smtp.resend.com:465`, user `resend`, password = clé API Resend). Identifiants **validés** par
  Gmail. Domaine `norva.tv` vérifié dans Resend (envoi sortant déjà OK, `noreply@norva.tv`).
- Pages légales à jour avec données KBIS réelles + médiateur **CM2C** (agréé jusqu'en 2029) :
  `privacy.html`, `terms.html`, `mentions-legales.html`. Contact affiché : `support@norva.tv`.
