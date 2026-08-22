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
| Handler edge + moitié Pages | `norva-signup/index.ts`, `functions/api/signup*.ts` | 26 |

Les 26 tests du handler sont **comportementaux**, pas textuels. Une version
précédente vérifiait que `recordDecision` apparaissait avant `fetch` dans le
source : cela démontre la mise en page d'un fichier, et cesse d'être vrai dès que
quelqu'un déplace un appel dans une fonction auxiliaire. Le faux client Postgres
et le faux upstream écrivent maintenant dans **une seule timeline**, et les
assertions lisent des index dedans — dont `gotrueCallCount === 0` sur rejeu.

Le handler est exporté comme `handleSignup(request, deps)` ; `Deno.serve` ne fait
que câbler les vraies dépendances en bas du fichier. Ce n'est pas de la coquetterie :
un contrat qui porte sur un ordre n'est prouvable qu'en regardant les appels partir.

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
api.norva.tv/functions/v1/…/token  route edge     — Kong voit et limite ceci
```

Kong est derrière `api.norva.tv`. Une requête vers `norva.tv/api/*` ne traverse ni
Caddy ni Kong. Donc :

- ce que Kong borne, c'est la **moitié coûteuse** (l'invocation edge) ;
- borner l'URL publique elle-même demande une **règle de rate limiting
  Cloudflare**, et rien d'autre ne peut le faire.

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

## Déroulé du branchement

Pas de bascule à 100 % :

```
tests internes
  → quelques signups réels contrôlés
  → nouvel endpoint pour le web
  → 24 à 72 h d'observation
  → comparaison legacy / nouveau pipeline
```

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
