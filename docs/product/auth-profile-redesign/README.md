# Norva auth + profile redesign

Ce dossier fige le travail de conception realise avant sa migration vers la production. Il est volontairement stocke dans le worktree differe `Norva-post-provider-rollout-batch` afin de ne pas modifier l'observation Provider Access active.

## Ce qui est ici

- `prototype-archive/` : archive complete des variantes A a L, sources, assets, captures et QA.
- `MIGRATION_TO_PRODUCTION.md` : plan d'integration dans l'architecture Norva.
- `STATE_AND_CONTRACT_MAP.md` : correspondance entre chaque ecran et les contrats reels existants ou manquants.
- `RELEASE_AND_QA_CHECKLIST.md` : gates a satisfaire avant toute activation.
- `VALIDATION_REPORT.md` : preuves locales du bundle archive.
- `migration-manifest.json` : inventaire lisible par un humain ou un outil.
- `tools/validate-bundle.mjs` : verification statique reproductible du bundle.

## Candidat de reference

- Parcours principal : `prototype-archive/l-premium-continuity.html`
- Tableau responsive : `prototype-archive/qa-l.html`
- Entonnoirs profils : `prototype-archive/profile-funnels.html`
- Rapport QA : `prototype-archive/design-qa.md`

Les variantes A a K sont conservees comme historique de decision. Elles ne sont pas des alternatives a fusionner entre elles au moment de l'implementation.

## Decisions produit deja prises

- Une seule porte d'entree `Get started`; pas de doublon `Sign in` sur le welcome.
- L'email vient avant la distinction connexion/creation.
- La methode sans mot de passe est prioritaire; le mot de passe reste un recours facultatif pour les comptes qui en veulent un.
- Deux scenes poster coherentes, trois colonnes animees du bas vers le haut, sans chevauchement ni trou.
- Aucun scroll dans les ecrans onboarding cibles; les etats IME et grand texte doivent toutefois rester operables lors de l'integration reelle.
- Le logo Norva reste visible sans repeter `Norva` dans le titre.
- Les profils reutilisent les douze avatars Norva et ne proposent aucun mode Kids.
- Un seul profil configure est selectionne automatiquement; plusieurs profils declenchent le chooser selon les regles de session existantes.

## Limite de securite essentielle

Le code a quatre chiffres du prototype n'est pas encore implemente cote serveur. Le flux actuel de `public/account.html` envoie un lien securise par email et echange un `token_hash`. Le candidat ne doit donc pas etre relie tel quel a la production. Voir `STATE_AND_CONTRACT_MAP.md` pour les options compatibles.

## Validation rapide

Depuis la racine du worktree :

```powershell
node docs/product/auth-profile-redesign/tools/validate-bundle.mjs
```

Le resultat attendu est `auth-profile bundle: PASS`.
