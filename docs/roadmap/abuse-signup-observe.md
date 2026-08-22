# Signup anti-abuse — observe mode

État au 2026-08-22. Ce fichier existe pour qu'on n'ait rien à redécouvrir : ce qui
est construit, ce qui reste, les secrets contre la configuration, et la matrice de
tests qui conditionne le premier trafic réel.

## Ce qui est construit

| Brique | Fichier | Tests |
|---|---|---|
| Canonicalisation des sujets | `_shared/risk-subject-canonical.ts` | 14 vecteurs d'équivalence |
| Store de vélocité | `_shared/risk-velocity-store.ts` + migration `…_abuse_velocity_store` | 13 |
| Moteur de score | `_shared/signup-risk-engine.ts` | 17 scénarios nommés |
| Token de formulaire | `_shared/signup-form-token.ts` | inclus dans les 19 ci-dessous |
| Idempotence | `_shared/signup-idempotency.ts` + migration `…_abuse_signup_idempotency` | 19 |
| Journal de décisions | `_shared/signup-decision-log.ts` + migration `…_abuse_signup_decisions` | 16 |
| Frontière Cloudflare → edge | `_shared/edge-ingress.ts` + migration `…_abuse_ingress_request_ids` | 15 |
| Handler edge + moitié Pages | `norva-signup/index.ts`, `functions/api/signup*.ts` | 31 |
| Déjà-inscrit + IP vérifiée vers Kong | migration `…_abuse_signup_already_registered` | inclus ci-dessus |
| Canary web | `public/js/authApi.js` (`signUp`, inchangé pour l'appelant) | 11 |

Les 26 tests du handler sont **comportementaux**, pas textuels. Une version
précédente vérifiait que `recordDecision` apparaissait avant `fetch` dans le
source : cela démontre la mise en page d'un fichier, et cesse d'être vrai dès que
quelqu'un déplace un appel dans une fonction auxiliaire. Le faux client Postgres
et le faux upstream écrivent maintenant dans **une seule timeline**, et les
assertions lisent des index dedans — dont `gotrueCallCount === 0` sur rejeu.

Le handler est exporté comme `handleSignup(request, deps)` ; `Deno.serve` ne fait
que câbler les vraies dépendances en bas du fichier. Ce n'est pas de la coquetterie :
un contrat qui porte sur un ordre n'est prouvable qu'en regardant les appels partir.

## État du déploiement au 2026-08-22

Le signup public **n'est pas branché** : le navigateur va toujours directement à
GoTrue. Tout ce qui suit est en place sans qu'un seul utilisateur emprunte le
nouveau chemin.

| Étape | État | Preuve |
|---|---|---|
| 4 migrations | ✅ | 9 RPC, `service_role` seul, 5 invariants bloquants verts |
| 4 secrets sur l'edge | ✅ | empreintes identiques sur les deux runtimes |
| `norva-signup` déployé | ✅ | `/health` → `{"ok":true}` ; POST non signé → 401 |
| Pages Functions | ✅ | déployées, inertes en 503 sans le secret |
| `EDGE_INGRESS_SECRET_CURRENT` sur Pages | ✅ | `secret_text`, 5 → 6 variables, aucune perdue |
| Redéploiement Pages | ✅ | déploiement créé après la pose du secret |
| E2E `/api/signup-token` | ✅ | `200` + token signé, nonce 32 hex, aucun compte créé |
| E2E signup contrôlé | ✅ | 3 décisions réelles, contrat non négociable vérifié en base et en logs |
| Canary web | à faire | après le plancher volumétrique — voir backlog point 0 |

## Jalon `observe` fermé le 2026-08-22

Trois signups réels via le nouveau pipeline, tous `enforcement_enabled = false` :

| test | `rawScore` | `riskLevel` | `wouldHaveDecision` | `actualDecision` |
|---|---|---|---|---|
| propre | 0 | SAFE | ALLOW | ALLOW |
| rejeu exact (même `formToken`) | 40 | MEDIUM | RESTRICT | ALLOW |
| honeypot + soumission rapide + UA headless | 102 | CRITICAL | BLOCK | ALLOW |

Le rejeu produit sa **propre** ligne de décision — `idempotent_retry_first`, famille
`behaviour` — c'est voulu : chaque tentative est observée, y compris un second
clic, mais `auth.users` ne contient qu'une ligne par adresse et GoTrue n'est
jamais rappelé. Preuve à deux niveaux : même `user_id` renvoyé par l'API sur le
rejeu, et `attempt_count = 2` avec un seul compte réel en base.

Le score 102 se reconstruit intégralement depuis les `signalCodes` journalisés,
sans accès à la base :

```
honeypot_filled            45
submission_under_3000ms    12
client_headless_ua         30
velocity_ip_3_per_1h       15
────────────────────────────
                           102  →  plafonné à 100, CRITICAL
```

Trois familles indépendantes (`behaviour`, `client`, `velocity`) ont contribué
sans concertation — la vélocité a émergé naturellement parce que les deux tests
partaient de la même IP en quelques secondes, pas d'un scénario forcé.
`repeated_strong_evidence = true` uniquement sur cette ligne.

Vérifié en toutes lettres, logs de production à l'appui : ni e-mail, ni mot de
passe, ni `formToken`, ni corps de requête dans les trois lignes de log. Le
premier grep de vérification portait sur le mot `password` seul et aurait
échoué à tort — `"authMethod":"password"` est une valeur légitime de
l'énumération. Corrigé en cherchant la forme `"password":"`, qui n'apparaît
dans aucune valeur légitime.

Et une propriété structurelle vérifiée par lecture du repo entier : rien, nulle
part, ne lit `signup_decisions` ou `observed_risk_level` en dehors du module qui
les écrit. `actual_decision = ALLOW` en mode observe n'est donc pas seulement ce
que dit la table — c'est aussi la garantie qu'aucun autre composant de Norva ne
peut agir sur le niveau observé, puisqu'aucun ne le lit.

Ce qui est certifié à ce stade : ingress Cloudflare → edge, token signé, nonce
unique, idempotence, store de vélocité, scoring, caps/floors, pseudonymisation,
snapshot append-only, HIGH/CRITICAL passifs, absence de données sensibles dans
les logs, enforcement réellement désactivé. Plus aucun poids ni seuil ne bouge
avant d'avoir des distributions réelles.

### La chaîne, prouvée le 2026-08-22

```
POST norva.tv/api/signup-token  →  200  {"token":"1.eyJ…"}
```

Ce qu'un seul appel établit : Pages porte `EDGE_INGRESS_SECRET_CURRENT` (sans
lui, 503 avant signature) ; l'enveloppe HMAC est acceptée par l'edge (sans quoi,
401) ; Kong route `/functions/v1/norva-signup/token` ; le token est signé par
`NORVA_SIGNUP_TOKEN_SECRET`. Deux appels successifs rendent des nonces
différents, donc le jeton est frappé à la demande et non mis en cache. Aucun
compte créé, aucune ligne en base — la route `/token` ne touche pas Postgres.

### Le défaut qui a coûté deux tours : signer un chemin réécrit en transit

Le premier essai a répondu 401, et le log a nommé la raison :
`ingress_route_mismatch`. Le proxy signait `/functions/v1/norva-signup/token`,
mais la route Kong `functions-v1` porte `strip_path: true` — l'amont reçoit
`/norva-signup/token`. La signature était liée à une valeur qu'une passerelle
réécrit.

Le champ signé est désormais la **route relative à la fonction** (`"/"` ou
`"/token"`), que les deux côtés dérivent indépendamment et qu'aucun proxy ne peut
réécrire. Renommé `path` → `route` : un champ nommé `path` contenant une route
est un mensonge qui finit par coûter un débogage.

Leçon à garder : lier une signature à une valeur d'URL suppose que rien ne la
réécrit entre le signataire et le vérificateur. Sur cette stack, Caddy puis Kong
la réécrivent tous les deux.

`enforcement_enabled = false` partout : à ce stade le moteur ne peut refuser
aucun signup, quel que soit le score.

### Poser le secret Pages sans que personne ne le voie

Trois voies existaient. `wrangler` est hors jeu — la box n'a ni node ni npm.
Restaient le dashboard, qui demande d'afficher la valeur et de la copier, et
l'API, qui ne demande rien de tel mais dont la sémantique du PATCH sur
`env_vars` était inconnue : une fusion est sans risque, un remplacement
effacerait `NORVA_REFERRAL_EDGE_HMAC_SECRET`, dont l'API ne renvoie pas la
valeur et qui serait donc irrécupérable.

`--cf-probe-merge` a mesuré la réponse au lieu de la supposer, sur
l'environnement **preview** — aucun trafic, une seule variable `plain_text`
donc lisible et restaurable. Verdict : fusion. `--cf-put-ingress` a ensuite posé
le secret par API, la valeur ne quittant jamais la box, et a vérifié que les
cinq noms préexistants avaient survécu.

## Préalable, fermé le 2026-08-22 : rotation de `JWT_SECRET`

Le déploiement anti-abus a été suspendu le temps de fermer un incident sans
rapport avec lui mais bloquant : un JWT `service_role` avait été exposé, et il
restait exploitable.

Ce qui rendait l'exposition grave n'était pas le vol du credential Kong mais
`kong-entrypoint.sh`, qui transmet **tout `Authorization` ne commençant pas par
`Bearer sb_`** tel quel à l'amont. Avec la clé `sb_publishable_` — publique par
conception, en dur dans `public/js/authApi.js` — le porteur du jeton atteignait
l'administration des utilisateurs GoTrue : il n'existe pas de route
`/auth/v1/admin` dédiée, elle est derrière la route générique qui admet `anon`.
Mesuré : sans Bearer 401, avec le jeton exposé 200.

Retirer le credential du consumer Kong n'aurait rien révoqué — l'attaque ne le
présente jamais en `apikey`. La rotation de `JWT_SECRET` était la seule
remédiation n'exigeant aucune preuve d'exhaustivité, via
`ops/hetzner/scripts/rotate-jwt-secret.sh`. Coût réel : huit sessions actives
ont pris un 401 puis se sont rétablies par refresh, les 88 refresh tokens étant
des lignes opaques que la rotation n'invalide pas.

Preuves de fermeture : ancien jeton 401 sur PostgREST (signature refusée) et 403
sur GoTrue admin avec le contrôle à 200 sur la requête identique ; nouveaux
jetons et clé publiable à 200.

Reste en hygiène, hors incident : `app.settings.jwt_secret` porte encore
l'ancien secret — mort, mais à retirer après un audit exhaustif des lecteurs
(pas seulement `pg_proc` : policies RLS, vues, défauts de colonne, expressions
d'index).

## Secrets contre configuration

La distinction n'est pas cosmétique : elle décide de qui peut modifier quoi, et
elle évite qu'un environnement de staging accumule des variables dont personne ne
sait plus lesquelles sont sensibles.

**Secrets** — valeur aléatoire, jamais affichée, jamais dans git, rotation prévue :

```
NORVA_ABUSE_HASH_KEY               clé HMAC des sujets de vélocité
NORVA_SIGNUP_TOKEN_SECRET          signature du token de formulaire
NORVA_SIGNUP_IDEMPOTENCY_SECRET    empreinte d'intention + liaison du credential
EDGE_INGRESS_SECRET_CURRENT        signature de l'enveloppe Cloudflare → edge
EDGE_INGRESS_SECRET_PREVIOUS       accepté pendant une fenêtre de rotation
```

`EDGE_INGRESS_SECRET_CURRENT` est le seul à devoir exister **des deux côtés** :
Cloudflare Pages pour signer, edge pour vérifier.

**Configuration** — non sensible, mais à protéger contre la modification
accidentelle :

```
NORVA_ABUSE_POLICY_VERSION         nom de la politique en vigueur
EDGE_INGRESS_KEY_VERSION           version qui signe actuellement
EDGE_INGRESS_PREVIOUS_KEY_VERSION  version encore acceptée
SIGNUP_ENDPOINT_VERSION            segmentation legacy / nouveau pipeline
NORVA_ABUSE_ENFORCEMENT_ENABLED    false jusqu'à lecture des distributions
```

Le `policy_config_hash` enregistré avec chaque décision rend `POLICY_VERSION`
purement descriptif : même si personne ne pense à le bumper, une modification de
seuil produit un hash différent et reste traçable.

## Le mot de passe, et sa trajectoire élargie

Avant, le navigateur appelait GoTrue directement. Désormais :

```
Browser → norva.tv/api/signup (Cloudflare) → edge → GoTrue
```

La Pages Function reçoit donc nécessairement le mot de passe en clair pendant le
traitement. C'est normal pour un proxy applicatif, mais la frontière de confiance
s'élargit d'un maillon, donc la règle est absolue et sans exception :

```
JAMAIS logger request.body
JAMAIS logger rawBody
JAMAIS logger le payload parsé
JAMAIS envoyer le corps à une télémétrie d'erreur
JAMAIS inclure le corps dans un contexte d'exception
```

`body_hash` suffit à l'intégrité. Une stacktrace ne doit jamais embarquer l'objet
qui contient `email`, `password` ou `formToken` — ce qui veut dire ne jamais
attraper une exception en y joignant le payload, même « pour déboguer ».

L'e-mail peut être manipulé là où il est nécessaire, jamais injecté dans un log
technique.

### La liaison du credential

L'empreinte d'idempotence lie le mot de passe **cryptographiquement** sans le
stocker :

```
credential_binding = HMAC(IDEMPOTENCY_SECRET, "credential:v1:" + password)
request_fingerprint = HMAC(IDEMPOTENCY_SECRET, version|nonce|email|surface|method|binding)
```

Sans cela, même nonce + même e-mail + **autre mot de passe** aurait reçu le
résultat de la première requête, ce qui n'est pas une reprise mais une autre
intention. La liaison est dérivée, pliée dans l'empreinte, puis abandonnée : ni
colonne, ni valeur de retour, ni log.

Propriété résiduelle, énoncée plutôt qu'escamotée : l'empreinte est stockée, donc
quelqu'un détenant le secret serveur, la ligne et l'adresse pourrait tester des
mots de passe hors ligne. Ce qui la borne est la durée de vie de la ligne —
quinze minutes par défaut. Un hash nu du mot de passe aurait été bien pire :
aucun secret requis.

## L'émission du token de formulaire

Le navigateur ne doit jamais pouvoir fabriquer un token signé, donc il faut un
endpoint serveur qui l'émet — nonce, `issued_at`, version, HMAC.

### Où il est réellement protégé

Une version antérieure de ce document affirmait que Kong pose un plancher sur
`/api/signup-token`. C'est faux sur la topologie, et il faut le dire au lieu de le
corriger en silence :

```
norva.tv/api/signup-token          Pages Function — Kong ne voit JAMAIS ceci
api.norva.tv/functions/v1/…/token  route edge     — Kong voit ceci, sans le limiter
```

Kong est derrière `api.norva.tv`. Une requête vers `norva.tv/api/*` ne traverse ni
Caddy ni Kong.

### Correction : Kong ne borne rien du tout ici

Ce document affirmait ensuite que Kong bornait au moins « la moitié coûteuse »,
c'est-à-dire l'invocation edge. C'est faux, et ça a été affirmé sans vérifier.
Mesuré dans `kong.yml` :

```
service functions-v1  →  plugins : cors  (et rien d'autre)
plugins globaux       →  aucun
rate-limiting         →  seulement auth-v1-{signup,recover,otp,resend}
                         et les 7 routes partners
```

Donc `/functions/v1/*` n'est ni authentifié ni compté au niveau de la
passerelle. **Aucune couche ne limite le débit du chemin signup aujourd'hui.**

Ce n'est pas une régression apportée par ce chemin — c'est la condition de
toutes les 19 edge functions — mais le plancher volumétrique reste dû, et il est
à poser **avant le canary public**. Deux options, à choisir plus tard :

- un service + route Kong pour `/functions/v1/norva-signup`, sur le patron déjà
  éprouvé par `auth-v1-signup` (10/min, 40/h) ;
- une règle de rate limiting Cloudflare pour l'URL publique, seule chose capable
  de borner la moitié publique.

Ce qui reste vrai : la route `/token` de l'edge ne touche pas la base, donc un
flood y coûte des invocations edge et non des écritures Postgres. Les
invocations ne sont pas gratuites pour autant — le routeur d'edge-runtime est un
isolate V8 monothread qui plafonne vers 95 req/s par conteneur.

### Modèle retenu : émission côté edge

Deux modèles étaient possibles. L'émission dans la Pages Function (A) est
marginalement moins chère ; l'émission côté edge via l'enveloppe signée (B) garde
`NORVA_SIGNUP_TOKEN_SECRET` dans **un seul endroit**.

B est retenu pour cette raison seule : A mettrait le secret de signature des deux
côtés de la frontière et doublerait la surface de rotation, pour économiser
quelques millisecondes.

Le piège que A cherchait à éviter — « le bot arrête de spammer `/signup` et spamme
`/signup-token` » — est traité autrement : la route `/token` de l'edge **ne touche
pas la base du tout**. Pas de compteur, pas de décision, et son `request_id`
d'enveloppe n'est même pas consommé, puisqu'un token de plus n'est pas un gain
pour l'attaquant. C'est du HMAC pur. Sinon inonder cette route voudrait dire
inonder Postgres, c'est-à-dire exactement le problème que le token existe pour
réduire.

## `/health`

Liveness publique uniquement : `{"ok": true}`, rien d'autre. Une sonde qui liste
les secrets présents décrit l'état interne du système à qui le demande. La
readiness détaillée — quelles clés sont posées, quelle version signe, si
l'enforcement est actif — reste interne et authentifiée.

## Matrice de lancement

À passer intégralement avant d'envoyer un seul utilisateur réel.

Colonne « auto » : couvert par `tests/norva-signup-handler.test.js`, donc vérifié à
chaque push. Les autres lignes demandent la vraie infrastructure et restent à
passer à la main.

| Test | Attendu | auto |
|---|---|---|
| Signup normal | compte créé, `ALLOW` | ✅ |
| Double-clic | `gotrueCallCount === 0` sur le second | ✅ |
| Même nonce, autre e-mail | intent mismatch, jamais le résultat précédent | ✅ |
| Même nonce, autre mot de passe | empreintes différentes → intent mismatch | ✅ |
| Corps modifié après signature | rejet ingress, **zéro** appel base | ✅ |
| Signature invalide | rejet avant tout scoring, zéro appel base | ✅ |
| Enveloppe signée pour une autre route | rejet | ✅ |
| `request_id` rejoué | rejet après le seul `consume` | ✅ |
| Timeout GoTrue ambigu | `UNKNOWN`, appelé une fois, aucun retry | ✅ |
| Refus déterministe GoTrue | `FAILED_FINAL` | ✅ |
| Store de vélocité en panne | compte créé quand même | ✅ |
| Snapshot de décision perdu | compte créé quand même | ✅ |
| Score maximal, enforcement off | `actual_decision = ALLOW`, 1 appel GoTrue | ✅ |
| Réponse identique score bas / score 100 | octet pour octet | ✅ |
| `/health` | `{"ok": true}` et rien de plus | ✅ |
| `/token` | aucun appel base du tout | ✅ |
| Aucun log ne porte e-mail, mot de passe, token | vérifié sur les logs émis | ✅ |
| Timestamp expiré | rejet ingress | — |
| Appel direct de l'edge sans passer par Pages | rejet | — |
| Recherche en base **et** dans les logs de prod | aucun secret, aucun corps brut | — |

### La ligne la plus importante

Score artificiel à 100, niveau `CRITICAL`, `would_have_decision = BLOCK`,
enforcement à `false`. Ce qui doit être vrai :

```
compte créé                     ✔
e-mail de confirmation envoyé   ✔
aucune mise en quarantaine      ✔
aucune restriction d'essai      ✔
aucun endpoint ralenti          ✔
exactement un appel GoTrue      ✔
actual_decision = ALLOW         ✔
```

C'est tout le contrat du mode observe : le produit se comporte comme si le moteur
n'existait pas. Le test automatisé va plus loin que la liste — il vérifie qu'**aucun
autre appel** n'a eu lieu, en filtrant la timeline sur ce qui n'est ni un RPC
`abuse_*` ni GoTrue et en exigeant que le reste soit vide.

## Le canary, mis en pause quelques heures après son câblage — 2026-08-22

Trois défauts trouvés en relisant `d6d00101`/`4b543d7b` à froid, avant que le
1 % n'ait eu le temps de produire un vrai signup humain.

**Régression de parité, le plus sérieux.** `edgeSignup({ email, password })` ne
transportait ni `displayName`, ni `signupContext` (l'attribution), ni
`redirectTo` — alors que `legacySignUp` les envoie tous les trois à GoTrue
depuis toujours. Un utilisateur du canary aurait perdu son nom affiché, son
attribution marketing et sa redirection de confirmation, en silence. Corrigé
sur les deux côtés : `edgeSignup` les transmet, `readPayload` les accepte
(bornées — `signupContext` en particulier n'est PAS soumis à une liste
blanche de clés : c'est un passe-plat vers `data` de GoTrue, exactement comme
en direct, et une liste blanche aurait fini par diverger silencieusement le
jour où une quatrième clé d'attribution serait ajoutée côté marketing), et
l'appel GoTrue reconstruit `redirect_to` + `data.display_name` +
`data.{...context}` à l'identique du legacy.

**L'empreinte d'idempotence ne couvrait pas ces trois champs.** Même nonce,
même e-mail, même mot de passe mais un `displayName` différent n'est pas «
le même envoi rejoué » — c'est une intention différente, au même titre qu'un
mot de passe différent l'était déjà. `FINGERPRINT_VERSION` passe à 2 (rien à
migrer : aucun trafic réel n'a encore utilisé ce pipeline), et
`signupRequestFingerprint` couvre désormais `displayName`, `redirectTo` et
`signupContext` — canonicalisé par tri de clés, pour que l'ordre d'un littéral
objet ne produise pas deux empreintes pour une seule intention. Volontairement
exclus : `userAgent` et `acceptLanguage`, qui peuvent varier entre une
soumission et sa relance sans que l'intention change.

**Le tirage du bucket n'était pas uniforme.** `65536` n'est pas multiple de
`10000` : un `% 10000` nu donne sept représentations aux buckets `0–5535` et
six aux autres, donc le 1 % annoncé (`0–99`, tous dans la plage à sept)
valait en réalité `700/65536 ≈ 1,068 %` — environ 6,8 % de trafic en plus que
prévu. Corrigé en retirant tout tirage `≥ 60000` (le plus grand multiple de
10000 tenant sur 16 bits) avant le modulo : chaque bucket a alors exactement
six représentations.

**Correction sur ma propre affirmation.** J'avais écrit qu'un navigateur déjà
bucketé « ne change pas de chemin » quand le seuil augmente. C'est le bucket
qui est stable, pas le traitement : un bucket à 250 est legacy à 1 % et bascule
légitimement sur le nouveau pipeline dès que le seuil dépasse 250 — c'est la
forme cumulative voulue du rollout, pas un défaut.

**Le canary est en pause, séparément du pourcentage.** `SIGNUP_PIPELINE_ENABLED
= false` est un interrupteur à part, pas `SIGNUP_PIPELINE_CANARY_THRESHOLD =
0` — les deux questions (« est-ce actif » et « à quelle proportion, une fois
actif ») ne doivent pas se confondre dans une seule constante. Un bucket
continue d'être tiré et stocké même pendant la pause, pour que réactiver le
switch plus tard tire sa population de buckets déjà répartis dans le temps,
pas décidés en une seule salve. Pour un test manuel sur un seul onglet sans
toucher au switch ni au `localStorage` : `window.__NORVA_FORCE_SIGNUP_PIPELINE__
= true` (ou `false`) depuis les devtools.

Ce qui manquait pour que la pause soit réelle et pas seulement déclarée : le
`git push` met à jour Cloudflare Pages tout seul, **pas** la box Hetzner. Le
edge continue de tourner sur l'ancien code (sans le correctif
`already_registered`, sans la nouvelle colonne) tant qu'un `git pull` +
recréation des conteneurs n'a pas été fait — et tant que la migration
`20260822130000` n'a pas été appliquée, `abuse_signup_attempt_settle`
n'existe pas dans sa nouvelle forme à 8 arguments et tout signup passant par le
pipeline échoue au moment du settle. Voir la séquence de redéploiement
ci-dessous avant de rouvrir le canary.

## Le canary web, câblé le 2026-08-22

`public/js/authApi.js` route désormais `NorvaAuth.signUp()` entre les deux
chemins. Rien ne change pour l'appelant — `account.html` n'a pas été touché —
parce que la réponse du nouveau pipeline est reformée pour ressembler
exactement à ce que GoTrue renvoie déjà en direct (voir plus bas).

**Le bucket.** `crypto.getRandomValues()` tire un entier `0–9999` une seule
fois par navigateur, conservé dans `localStorage`. Le pipeline observe est
actif si `bucket < 100` (1 %). Monter le seuil plus tard n'ajoute que des
navigateurs neufs au canary — personne déjà assigné ne change de chemin,
puisque le bucket ne change jamais une fois écrit.

Piège trouvé en écrivant le test qui générait un bucket sans en avoir un en
stock : `localStorage.getItem` renvoie `null` pour une clé absente, et
`Number(null)` vaut `0` — un entier qui a l'air parfaitement valide. Sans
vérification explicite du `null`, **chaque nouveau visiteur atterrissait dans
le canary**, silencieusement, l'entier fantôme n'étant jamais écrit ni donc
jamais stabilisé. Corrigé avant toute mise en production.

**Le fallback, volontairement asymétrique.** Un échec de `/api/signup-token`
(réseau, timeout, 503 tant que le secret n'est pas posé) n'a **rien** envoyé :
retomber sur l'appel GoTrue direct est aussi sûr que n'avoir jamais tenté le
nouveau chemin. Mais dès qu'un `POST /api/signup` est parti, plus aucun
fallback : GoTrue a peut-être déjà commencé à traiter la requête, et un repli
créerait potentiellement un second compte — exactement ce que l'idempotence
existe pour empêcher. Un `202 pending` est retenté avec le **même**
`formToken` (jusqu'à deux fois, avec un court délai), pour profiter du
mécanisme déjà certifié plutôt que d'en inventer un côté client. Un `4xx` est
définitif et remonte tel quel — une future règle d'enforcement doit rester
visible, jamais absorbée en silence par un repli automatique.

**Le gap trouvé en câblant le client, pas avant.** GoTrue a sa propre défense
anti-énumération : réinscrire un e-mail déjà utilisé répond `200` avec un
utilisateur obfusqué et un tableau `identities` vide, sans envoyer d'e-mail —
et `account.html` s'appuie déjà là-dessus pour afficher « Ce compte existe
déjà » plutôt qu'un « vérifiez vos e-mails » qui ne mènerait nulle part.
`norva-signup` ne capturait que `body.id` et renvoyait un `created: true`
plat, sans distinction. Câbler le client sans corriger aurait cassé ce message
en silence pour chaque utilisateur du canary retentant une adresse existante.
Migration `20260822130000` : une colonne typée `result_already_registered`,
additive, sur le même modèle que les trois colonnes existantes plutôt qu'un
retour au blob jsonb. Le shim client reforme la réponse du nouveau pipeline
dans la forme exacte que le code existant sait déjà lire — aucune ligne de
`account.html` n'a changé.

Testé en comportemental, pas en lecture de source : quel chemin un bucket
prend réellement, que le bucket se génère une fois et se réutilise, les deux
branches du fallback, la retentative sur 202 avec le nonce identique, et la
forme de réponse pour un compte neuf comme pour un compte déjà existant.

## Déroulé du branchement

Pas de bascule à 100 %, et le plancher volumétrique (backlog point 0) précède
toute ouverture au trafic public — le E2E a tourné à trois requêtes, pas à
l'échelle d'un canary.

```
Phase 0   plancher volumétrique posé (Kong ou Cloudflare)
Phase 1   trafic interne / contrôlé              — fait, ce document
Phase 2   petit pourcentage du signup web réel    → observe uniquement
Phase 3   100 % du signup web                     → observe uniquement
Phase 4   collecte suffisante                      → calibration des poids
Phase 5   seulement alors, discussion de l'enforcement
```

L'ordre est déterminant : les phases 2 à 4 ne changent **aucune** ligne du
moteur, seulement le volume de trafic réel qui l'alimente. Le contrat vérifié
plus haut — `actual_decision = ALLOW` toujours quand `enforcement_enabled =
false` — reste la seule garantie qui compte tant que la phase 5 n'est pas
ouverte.

## Ce qu'on regardera, et ce qu'on ne touchera pas

Aucun poids ne bouge avant d'avoir des distributions. Ce qu'il faudra lire :

- répartition SAFE / LOW / MEDIUM / HIGH / CRITICAL ;
- quels signaux expliquent les MEDIUM et les HIGH ;
- combien reposent sur une **seule** famille (`families_involved`) ;
- desktop contre mobile ;
- Gmail contre autres domaines ;
- IPv4 contre IPv6 ;
- résidentiel contre datacenter ;
- proportion d'`IDEMPOTENT_RETRY` et de `NONCE_INTENT_MISMATCH` ;
- famille de navigateur (`ua_family`) ;
- combien d'utilisateurs à score élevé poursuivent réellement l'onboarding, et
  leur conversion en aval par niveau de risque — la question à laquelle
  `signup_decision_outcomes` existe pour répondre ;
- cohortes en aval (`signup_decision_outcomes`).

La segmentation par `signup_endpoint_version` n'est pas optionnelle : tout client
antérieur au nouveau pipeline rapportera `TOKEN_MISSING`, et lire la population
en bloc déplacerait la distribution entière.

Propriété résiduelle découverte en écrivant les tests, énoncée plutôt
qu'escamotée : **sans token de formulaire, il n'y a pas de nonce, donc pas
d'idempotence**. Un client trop ancien pour envoyer un token n'a que l'unicité de
GoTrue sur l'adresse pour le protéger d'un double-clic. Ce n'est pas une
régression — c'est le comportement de l'ancien chemin — mais c'est une deuxième
raison de lire les distributions par version d'endpoint plutôt qu'en bloc.

## Backlog avant `enforce`

0. **Plancher volumétrique sur le chemin signup — pour partie corrigé.** L'appel
   `norva-signup → GoTrue` passe par `http://kong:8000/auth/v1/signup`, donc par
   le service Kong `auth-v1-signup` (10/min, 40/h par IP) déjà en place. Mais cet
   appel part du réseau Docker interne, et sans `X-Forwarded-For` Kong voyait
   l'adresse du **conteneur edge**, pas celle de l'appelant — le plancher se
   comptait par conteneur, pas par utilisateur. Corrigé le 2026-08-22 : la
   valeur signée (`facts.clientIp`) est transmise, jamais un en-tête que l'edge
   aurait reçu lui-même. Toujours ouvert : la route d'entrée
   `/functions/v1/norva-signup` (ingress + token) ne porte elle-même que `cors`
   à Kong — sans conséquence à 1-5 %, à fermer avant 100 %.

1. Indépendance des familles dans la règle de décision — un score au-dessus du
   seuil ne suffira pas, il faudra deux familles indépendantes ou une preuve
   répétée. Honeypot plus double-clic fait 85 et reste une seule famille.
2. Fenêtre de recouvrement pour la rotation de la clé de vélocité
   (`previous_hash_version`), sinon les compteurs repartent de zéro le jour d'une
   rotation.
3. `trial_abuse_score` distinct de `signup_risk_score`. Le même historique se lit
   à l'envers selon la question : un appareil portant un ancien compte sain
   rassure sur « est-ce un humain », et inquiète légèrement sur « mérite-t-il un
   second essai gratuit ». `trusted_device_history` réduit le premier et ne doit
   jamais réduire le second.
4. `risk_flag_retention` (72 h, pour l'analyse) distinct de
   `restriction_duration`, beaucoup plus court et décroissant sur comportement
   sain — sinon un faux positif OAuth perd son essai trois jours sans comprendre.
