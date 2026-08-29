# Etats et contrats

| Etat prototype | Action utilisateur | Contrat Norva reel | Statut migration |
|---|---|---|---|
| Welcome, slide 1/2 | Get started | navigation locale vers l'auth | Pret visuellement |
| Email | Continue | choix de methode sans exposer l'existence du compte | Decision serveur necessaire pour un tunnel totalement unifie |
| Existing account | recevoir un acces securise | `NorvaAuth.signInWithOtp(createUser: false)` envoie un lien | Contrat existant, visuel a adapter |
| New account | recevoir un acces securise | `NorvaAuth.signInWithOtp(createUser: true)` ou `signUp` | Contrat existant mais l'intention doit rester explicite cote serveur |
| Code 4 chiffres | saisir/verifier | aucun helper email+code public dans `authApi.js` | Bloque tant qu'un vrai contrat OTP n'est pas ajoute |
| Password fallback | mot de passe | `NorvaAuth.signIn` | Pret, doit rester secondaire |
| Google | OAuth / ID token | `signInWithOAuth` web, `signInWithIdToken` Android | Pret, conserver les controles de disponibilite |
| Recovery | envoyer lien | `NorvaAuth.recover` | Pret, renderer manquant dans le candidat final |
| Profile loading | attendre/reessayer | `NorvaCloud.profiles.list` | Pret, garder retry et message sanitise |
| First profile setup | nom + avatar | `profiles.update(... setupCompleted: true)` | Pret |
| Chooser | selectionner | `profiles.setActiveId` + cache/session rules | Pret |
| Manage | ouvrir edition/ajout | etat local `profiles.js` | Pret |
| Add profile | creer | `profiles.create` | Pret, respecter `canCreate` et limite du plan |
| Edit profile | enregistrer | `profiles.update` | Pret |
| Delete profile | confirmer | `profiles.remove` apres confirmation fail-closed | Pret, confirmation a conserver |
| Avatar library | choisir 1/12 | `avatar-01` a `avatar-12` | Pret |
| Profile ready | entrer dans l'app | `finishSetup` puis route courante | Pret |

## Invariants non negociables

- Ne jamais brancher l'UI sur une detection cliente `email connu/inconnu` qui permettrait l'enumeration de comptes.
- Ne jamais valider un code uniquement dans le navigateur.
- Ne jamais mettre un token, code, email ou identifiant dans l'URL de capture QA ou les evenements analytics.
- Ne jamais creer un profil Kids : Norva ne propose pas ce modele.
- Ne jamais supprimer un profil sans confirmation accessible et fail-closed.
- Ne jamais perdre les retours `returnTo`, OAuth, pairing TV ou gestion de compte existants.
- Ne jamais casser le pont Google natif ni supposer qu'un redirect OAuth web se termine dans une WebView.
- Ne jamais rendre une action inaccessible pour tenir artificiellement le `no scroll` sous IME ou grand texte.
