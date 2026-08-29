# Validation locale du bundle

Date : 2026-08-29. Cette validation est le baseline local du candidat autorise. Elle ne devient une preuve de production qu'apres CI, deploiements, verification live et publication Android documentes separement.

## Inventaire

- Archive : 100 fichiers, 8 189 622 octets.
- Candidat principal : `prototype-archive/l-premium-continuity.html`.
- Etats structuraux verifies : 14.
- Avatars Norva locaux verifies : 12.
- Aucun appel `fetch`, `XMLHttpRequest`, `NorvaAuth` ou `NorvaCloud` dans le JavaScript du prototype.
- Aucun controle ou libelle de profil Kids dans le candidat final.

## Rendu Playwright

Onze etats ont ete rendus a 390 x 844 et 844 x 390, soit 22 combinaisons : welcome, email, code, mot de passe, chooser, manage, setup, edit, avatars, created et arrival.

Resultat :

- 22/22 sans debordement horizontal ;
- 22/22 sans scroll nominal vertical ;
- aucune cible visible sous 44 CSS px ;
- aucune erreur console ;
- animation des colonnes poster desactivee sous `prefers-reduced-motion: reduce` ;
- planche `profile-funnels.html` inspectee a 1440 x 900.

L'animation poster est un mouvement decoratif continu demande pour le welcome uniquement. Elle reste lente, hors des etats de saisie, masquee par les couches de lisibilite et totalement neutralisee en reduced motion. Ce choix devra etre revalide sur appareil bas de gamme avant production.

## Tests de contrats existants

Commande :

```powershell
node --test tests/auth-onboarding-responsive.test.js tests/auth-email-self-hosted-wiring.test.js tests/mobile-account-profile-accessibility-contract.test.js tests/modal-concurrency-contract.test.js tests/product-funnel-analytics.test.js
```

Resultat : 34 tests passes, 0 echec, 0 ignore.

Le validateur du bundle renvoie egalement :

```text
auth-profile bundle: PASS
validated states=14 avatars=12 inert=true
```

## Limites et gates restants

- Le clavier Android reel, TalkBack, le font scale 1,3 et le D-pad TV doivent etre rejoues apres integration dans les composants de production.
- Les posters generes doivent recevoir une validation juridique et commerciale avant diffusion publique.
- Les captures historiques a quatre chiffres restent des artefacts de conception. Le code de production est le code GoTrue a six chiffres et ne doit jamais etre valide cote client.
- Le `no scroll` est une cible nominale ; IME et grand texte doivent conserver un reflow ou un scroll interne accessible.
- Le deploiement groupe doit redemarrer atomiquement une nouvelle observation Provider Access 20 % apres disponibilite reelle.
