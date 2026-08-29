# Checklist release et QA

## Gate avant code de production

- [ ] Le candidat L est encore la version approuvee.
- [x] Code GoTrue natif a six chiffres signe, avec lien securise de repli.
- [ ] Les assets poster sont juridiquement et commercialement reutilisables.
- [ ] Les textes finaux sont valides en anglais et en francais.
- [ ] Le comportement compte connu/inconnu respecte l'anti-enumeration.

## Tests web et WebView

- [ ] 320, 375, 390, 414, 768, 844 et 1024 CSS px.
- [ ] Portrait et 844 x 390 paysage.
- [ ] Font scale 1,0 et 1,3.
- [ ] Clavier ouvert, ferme et navigation trois boutons.
- [ ] `prefers-reduced-motion: reduce` sans mouvement de posters.
- [ ] Aucun trou, chevauchement ou flash noir dans les trois colonnes.
- [ ] Aucun scroll nominal; fallback operable avec IME/grand texte.
- [ ] Cibles tactiles >= 44 CSS px; Android natif >= 48 dp.
- [ ] Focus visible, ordre logique, labels et live regions.
- [ ] Back ferme d'abord aide, erreur, confirmation, avatar/editor, puis navigue.
- [ ] Offline, timeout, 429, 5xx, code/lien expire, resend et annulation Google.
- [ ] Messages utilisateurs sanitises, sans payload fournisseur.

## Tests auth

- [ ] Email existant via methode sans mot de passe.
- [ ] Email inconnu sans fuite d'existence.
- [ ] Creation de compte et confirmation.
- [ ] Google web et Google Android natif.
- [ ] Mot de passe facultatif et erreur de credentials.
- [ ] Recovery et changement de mot de passe.
- [ ] Retour OAuth, `returnTo`, pairing TV et `manage=1`.
- [ ] Attribution signup non bloquante et sans PII analytics.
- [ ] Session reprise apres background/foreground et rotation.

## Tests profils

- [ ] Zero profil / profil auto-provisionne non configure.
- [ ] Un profil configure : auto-selection.
- [ ] Plusieurs profils : chooser une fois par session.
- [ ] Profil verrouille apres downgrade.
- [ ] Limite de creation atteinte.
- [ ] Creation, edition, choix avatar, annulation et retry.
- [ ] Suppression du profil actif et d'un profil non actif.
- [ ] Echec reseau sans perte de donnees.
- [ ] Aucun texte ni controle Kids.
- [ ] Invalidation correcte des caches apres selection.

## Commandes minimales

```powershell
node docs/product/auth-profile-redesign/tools/validate-bundle.mjs
node --test tests/auth-onboarding-responsive.test.js
node --test tests/auth-email-self-hosted-wiring.test.js
node --test tests/mobile-account-profile-accessibility-contract.test.js
node --test tests/modal-concurrency-contract.test.js
node --test tests/product-funnel-analytics.test.js
```

Ajouter ensuite les suites Android ciblees et un replay physique sur telephone et TV avant toute publication.

## Gate production

- [ ] Rebase sur le dernier `origin/main`.
- [ ] Diff relu lot par lot; staging explicite seulement.
- [ ] CI complete verte.
- [ ] Validation emulation phone + TV et appareil physique.
- [x] Autorisation explicite pour migration/deploiement/Google Play recue le 2026-08-29.
- [ ] Invariants Provider Access verts.
- [ ] Procedure de changement materiel et nouvelle fenetre d'observation confirmee.
- [ ] Preuve finale horodatee et hashee.
