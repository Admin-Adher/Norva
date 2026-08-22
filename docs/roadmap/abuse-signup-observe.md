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

Reste à écrire : la Pages Function `functions/api/signup`, le handler edge
`norva-signup`, et l'endpoint d'émission du token.

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

Piège à éviter : déplacer le problème de « bot qui spamme `/signup` » vers « bot
qui spamme `/signup-token` ». L'émission doit rester très légère et porter son
propre plancher volumétrique.

## Matrice de lancement

À passer intégralement avant d'envoyer un seul utilisateur réel.

| Test | Attendu |
|---|---|
| Signup normal | compte créé, `ALLOW` |
| Double-clic | **un seul** appel GoTrue |
| Même nonce, autre e-mail | intent mismatch, jamais le résultat précédent |
| Même nonce, autre mot de passe | intent mismatch |
| Corps modifié après signature | rejet ingress |
| Signature invalide | rejet **avant** tout scoring |
| `request_id` rejoué | rejet ingress |
| Timestamp expiré | rejet ingress |
| Appel direct de l'edge sans Pages | rejet |
| Timeout GoTrue ambigu | `UNKNOWN`, aucun retry aveugle |
| Score HIGH simulé | **`actual_decision = ALLOW`** |
| Score CRITICAL simulé | **`actual_decision = ALLOW`** |
| Recherche en base et dans les logs | aucun mot de passe, token ni corps brut |

Les deux lignes HIGH et CRITICAL sont les plus importantes du lancement : c'est
tout le contrat du mode observe.

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
