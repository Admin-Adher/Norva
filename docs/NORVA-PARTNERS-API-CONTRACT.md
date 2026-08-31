# Norva Partners — contrat API P0

**Version de contrat :** `2026-07-29`
**Statut :** contrat P0 implémenté dans le dépôt ; activation production
conditionnée aux migrations, secrets, providers et release gates décrits plus bas
**Type de compte P0 :** `individual` uniquement

Ce document fige la frontière entre les clients Norva et le domaine Partners.
Il complète `NORVA-PARTNERS-P0.md`. Une route marquée **future** n'est ni
déployée ni autorisée par la fonction actuelle.

## 1. Invariants de sécurité

- L'API utilisateur accepte uniquement un JWT Supabase `authenticated`.
- L'identité vient exclusivement du sujet vérifié du JWT. Aucun body, header ou
  paramètre `userId`/`user_id` n'est accepté.
- Le JWT est prévalidé dans la fonction avec `verifyUserJwtLocally`, puis
  confirmé auprès de GoTrue avec `auth.getUser()` sur chaque requête. Une
  session révoquée, supprimée ou devenue invalide ne passe jamais sur la seule
  foi d'une signature locale.
- Un token appareil TV, une clé `anon`, une clé de service ou un code de
  parrainage ne sont jamais des identités utilisateur.
- La fonction utilise la `service_role` uniquement après authentification, pour
  appeler une RPC service-only. Les tables privées ne sont pas exposées.
- Les logs n'exposent ni JWT, e-mail, UUID utilisateur/compte, code affilié,
  claim, référence KYC, document, IBAN, payload provider ou erreur SQL. Les
  réponses n'exposent jamais d'adresse e-mail complète ; la seule donnée
  dérivée autorisée est le champ `masked_email` strictement masqué de la
  liste privée des affiliations.

`verify_jwt=false` dans `supabase/config.toml` ne rend pas l'API anonyme. Cette
configuration permet au handler de traiter `OPTIONS` et d'appliquer lui-même la
vérification décrite ci-dessus à toute autre méthode.

## 2. Enveloppe et transport

Toute réponse JSON utilise :

```json
{
  "version": "2026-07-29",
  "correlationId": "prt_opaque_random_value",
  "data": {}
}
```

Une erreur utilise :

```json
{
  "version": "2026-07-29",
  "correlationId": "prt_opaque_random_value",
  "error": {
    "code": "invalid_query",
    "message": "The request parameters are invalid."
  }
}
```

Les clients se branchent sur `error.code`, jamais sur `message`. Le message est
sanitisé et peut être localisé dans une version ultérieure. Toutes les réponses
sont `no-store`, possèdent `X-Correlation-Id` et ne contiennent pas de donnée
personnelle dans ce dernier.

## 3. CORS

Les origines sont comparées exactement, sans wildcard, suffixe ni règle
implicite localhost. La liste de production par défaut est :

```text
https://norva.tv
https://www.norva.tv
https://app.norva.tv
https://norva-web.pages.dev
```

`NORVA_PARTNERS_ALLOWED_ORIGINS` peut remplacer cette liste par des origines
HTTP(S) exactes séparées par des virgules. Une valeur `*`, une URL avec chemin
ou une entrée invalide fait échouer la configuration. Un environnement local
doit déclarer explicitement ses origines ; aucune origine localhost n'est
implicite en production.

Le preflight accepte seulement :

- méthode demandée autorisée pour la route (`GET` ou `POST`) ;
- headers `authorization`, `apikey`, `content-type`, `idempotency-key`,
  `x-client-info` ;
- route existante parmi `/bootstrap`, `/access-request`, `/applications`,
  `/activate`, `/activation/reconcile`, `/links`, `/dashboard`, `/referrals`, `/kyc/sessions`,
  `/kyc/certification`, `/kyc/certification/resume`, `/referral/claim`,
  `/fiscal-profile`, `/payout-onboarding`, `/payout-profile` et
  `/tv-relays/consume` ;
- origine présente et autorisée.

Les clients Android natifs sans header `Origin` restent autorisés. Dès qu'un
header `Origin` est présent, il doit appartenir à l'allowlist.
`Retry-After` et `X-Correlation-Id` sont exposés par CORS afin que le client Web
puisse respecter le délai serveur sans interpréter le texte d'erreur.

## 4. Routes implémentées

### `GET /bootstrap`

Lecture de la disponibilité du programme, de l'éligibilité de la juridiction et
de l'état minimal du compte partenaire de l'utilisateur connecté.

```http
GET /functions/v1/norva-partners/bootstrap?countryCode=US&subdivisionCode=US-CA
Authorization: Bearer <user JWT>
```

Paramètres :

| Paramètre | Requis | Validation |
|---|---:|---|
| `countryCode` | non | normalisé en majuscules, exactement deux lettres ISO 3166-1 |
| `subdivisionCode` | non | normalisé en majuscules, 1 à 12 caractères alphanumériques séparés par `-` |

Si une subdivision préfixée par un pays est envoyée, ce préfixe doit correspondre
à `countryCode`. Un paramètre inconnu, vide, dupliqué ou nommé `userId` est
rejeté. Sans pays, la réponse métier reste fail-closed avec
`eligibility.reason = "country_required"`. Une subdivision exacte est prioritaire
sur la politique nationale ; la RPC peut retourner la politique nationale en
fallback avec `policy.subdivision_code = null`.
Pour un compte partenaire existant, la juridiction déjà vérifiée et stockée
reste autoritative ; un pays transmis comme simple contexte client ne peut pas
la remplacer.

Réponse `data` :

```json
{
  "schema_version": 1,
  "flags": {
    "partners_enabled": true,
    "partners_invite_only": true,
    "partners_shadow_mode": true,
    "partners_payouts_live": false,
    "partners_tv_relay_enabled": false
  },
  "visibility": {
    "visible": true,
    "reason": "available"
  },
  "eligibility": {
    "eligible": true,
    "reason": "eligible"
  },
  "program": {
    "version_key": "p0-2026-07",
    "commission_rate_bps": 2000,
    "attribution_window_days": 30,
    "maturation_days": 45,
    "payout_thresholds": {
      "USD": 1000
    },
    "effective_from": "2026-07-29T00:00:00Z",
    "effective_until": null
  },
  "policy": {
    "country_code": "US",
    "subdivision_code": null,
    "individual_available": true,
    "minimum_age": 18,
    "capacity_required": true,
    "kyc_level": "identity_age_country_capacity",
    "payout_currencies": ["USD"],
    "terms_version": "partners-us-v1",
    "disclosure_version": "partners-us-v1"
  },
  "allowlist": {
    "required": true,
    "included": true
  },
  "account": {
    "exists": false,
    "status": null,
    "account_type": null,
    "verification_status": null,
    "contract_status": null,
    "link_status": null
  }
}
```

`payout_thresholds.USD = 1000` exprime le seuil mondial de référence de
10,00 USD. L'objet reste indexé par devise de règlement, car le ledger ne
convertit jamais implicitement une commission. Lorsqu'une policy autorise une
autre devise, la version de programme doit aussi fournir son seuil exact,
préalablement figé et documenté par Finance. Les clients affichent la devise
retournée par le serveur ; ils ne calculent pas eux-mêmes un équivalent FX.

Cet exemple illustre seulement la forme globale du contrat. Il ne constitue
aucune activation de marché : aucune juridiction, y compris les États-Unis,
n'est seedée ou ouverte par défaut. Une politique pays/subdivision doit être
validée puis activée explicitement côté serveur.

La fonction valide une allowlist exacte de clés, types et enums. Un champ
inconnu, absent ou incohérent venant de la RPC produit
`partners_temporarily_unavailable`; il n'est jamais propagé au client.
Le P0 contractuel est également verrouillé à `commission_rate_bps=2000`,
`attribution_window_days=30` et `maturation_days=45`. Une dérive de ces trois
valeurs exige une nouvelle version de contrat et échoue donc fermement ici.

Enums :

- `visibility.reason` : `disabled`, `invite_only`, `available`,
  `existing_account` ;
- `eligibility.reason` : `disabled`, `country_required`,
  `country_not_supported`, `subdivision_not_supported`, `not_allowlisted`,
  `account_blocked`, `account_attention_required`, `eligible` ;
- `account.status` : `invited`, `pending_verification`, `active`, `held`,
  `suspended`, `closed` ;
- `account.account_type` : `individual` uniquement ;
- `account.verification_status` : `not_started`, `pending`, `verified`,
  `failed`, `expired` ;
- `account.contract_status` : `not_accepted`, `accepted`, `expired` ;
- `account.link_status` : `none`, `active`, `revoked`.

Quand `account.exists=false`, les cinq autres champs du compte sont
obligatoirement `null`.

`allowlist.included` signifie uniquement qu'une invitation pilote active existe
pour le compte. Le scope pays/subdivision de cette invitation n'est jamais
exposé : seul `eligibility.reason` indique si la juridiction fournie permet de
continuer. `allowlist.required` doit toujours être identique au flag
`partners_invite_only`.

`existing_account`, `account_blocked` et `account_attention_required` sont
réservés à un compte existant. `account_attention_required` couvre notamment
une expiration naturelle du programme/de la policy ou une preuve
KYC/contractuelle devenue non conforme : le snapshot reste sanitisé, mais toute
action reste fermée. Un lien `active` n'est cohérent qu'avec un compte
`active`, une vérification `verified` et un contrat `accepted`.
`visibility.reason=available` exige enfin `partners_enabled=true`. Toute
combinaison contraire rend le contrat invalide.

### `GET|POST /access-request`

Cette route porte la demande d'accès au pilote, distincte de l'adhésion
`POST /applications`. L'entrée de découverte **Norva Partners** est visible à
tout compte Cloud utilisateur authentifié sur Web et Android mobile, y compris
à un compte qui possède aussi un rôle Admin. Cette visibilité de navigation ne
dépend ni de `visibility.visible`, ni de `partners_enabled`, ni des autres
flags, release gates, policies ou allowlists. L'entrée Admin opérationnelle
reste une surface séparée. Les identités appareil et les sessions TV ne sont
pas éligibles à cette route.

`GET /access-request` n'accepte aucun paramètre et retourne exactement :

```json
{
  "schema_version": 1,
  "program_preview": {
    "commission_rate_bps": 2000,
    "attribution_window_days": 30,
    "maturation_days": 45,
    "payout_thresholds": {
      "USD": 1000
    }
  },
  "request": {
    "exists": false,
    "status": null,
    "country_code": null,
    "subdivision_code": null,
    "requested_at": null,
    "reviewed_at": null
  }
}
```

Dans les réponses GET et POST, `program_preview` peut être `null` lorsqu'aucune
version P0 `draft|active` compatible n'existe. Lorsqu'il est présent, il ne
constitue ni une offre ouverte ni une promesse de disponibilité : ses clés sont
exactes et ses seuils sont servis par la version de programme autoritative.
Pour une demande existante, `request.status` appartient à
`requested|approved|declined`, `country_code` contient deux lettres ISO 3166-1,
`subdivision_code` est nullable, `requested_at` est renseigné et
`reviewed_at` reste `null` uniquement pour `requested`.

`GET /access-request` reste lisible quel que soit
`NORVA_PARTNERS_ACCESS_REQUESTS_ENABLED`, y compris pendant une pause de la
collecte. `POST /access-request` exige que cette variable soit explicitement
égale à `true`, ainsi qu'un e-mail confirmé, une clé `Idempotency-Key` et le
body exact suivant, limité à 4 Kio. Une variable absente, vide ou différente de
`true` ferme uniquement le POST avec
`503 partners_access_requests_disabled` :

```json
{
  "countryCode": "FR",
  "subdivisionCode": "FR-IDF"
}
```

`subdivisionCode` peut être omis ou valoir `null`. La réponse `201` contient
exactement :

```json
{
  "schema_version": 1,
  "action": "access_requested",
  "replayed": false,
  "program_preview": {
    "commission_rate_bps": 2000,
    "attribution_window_days": 30,
    "maturation_days": 45,
    "payout_thresholds": {
      "USD": 1000
    }
  },
  "request": {
    "exists": true,
    "status": "requested",
    "country_code": "FR",
    "subdivision_code": "FR-IDF",
    "requested_at": "2026-08-02T12:00:00Z",
    "reviewed_at": null
  },
  "next_action": "await_review"
}
```

`next_action` est déterminé uniquement par l'état persistant :
`requested → await_review`, `approved → access_approved` et
`declined → contact_support`. Tant que l'état reste `requested`, une nouvelle
clé peut corriger la juridiction ; après une décision, l'état est terminal et
la route ne le réouvre pas. `replayed=true` signifie qu'aucune nouvelle
mutation persistante n'a été produite, notamment lors du replay exact d'une clé
ou lorsque l'état demandé était déjà enregistré.

Lorsque `NORVA_PARTNERS_ACCESS_REQUESTS_ENABLED=true`, cette mutation reste
disponible même si tous les flags et gates opérationnels du programme sont
fermés. Le kill switch de collecte est indépendant de `partners_enabled`,
`partners_invite_only`, Didit, la finance et les release gates. Elle crée ou met
à jour uniquement
`affiliate_access_requests`, son enregistrement d'idempotence et son événement
d'audit sanitisé. Elle ne crée jamais de compte partenaire, candidature
`/applications`, session KYC/KYB, lien, attribution, fait financier, écriture de
ledger, profil de versement ou paiement.

Les garde-fous anti-abus s'appliquent sous le verrou transactionnel propre à
l'utilisateur, après la recherche d'un replay exact :

- même clé et même body : replay immédiat, sans consommer un nouveau quota ;
- nouvelle clé : délai minimal de 60 secondes depuis la dernière clé
  `access_request` enregistrée pour cet utilisateur ;
- au maximum 8 nouvelles clés enregistrées sur toute fenêtre glissante de
  24 heures par utilisateur, même si le body ou la juridiction changent ;
- violation du cooldown ou de la limite : `429 rate_limited` avec
  `Retry-After: 60` ; après huit clés, un retry 60 secondes plus tard peut rester
  limité jusqu'à la sortie de la fenêtre de 24 heures ;
- les enregistrements d'idempotence `access_request` âgés de plus de 30 jours
  sont éligibles à une purge opportuniste bornée à 200 lignes par nouvelle
  mutation. Cette rétention ne supprime ni la demande, ni son état, ni les
  événements d'audit.

La file Admin est exposée par
`admin_partners_access_requests(p_limit,p_offset,p_status,p_search)`. Une
capacité **Support ou Risk** permet la lecture paginée et sanitisée ; elle
retourne seulement `request_id`, un `subject_key` opaque, l'e-mail masqué,
l'état, la juridiction et les horodatages. La décision passe exclusivement par
`admin_partners_access_request_decide(...)`, exige la capacité **Risk** et une
session **AAL2**, puis accepte `approve|decline` avec justification auditée.
`approve` ajoute uniquement l'utilisateur à l'allowlist pilote dans la
juridiction demandée, avec une expiration optionnelle. Cette décision ne
modifie aucun flag, gate, programme, policy ou corridor et ne crée aucun compte
partenaire ; l'adhésion `/applications` reste bloquée tant que ses propres
préconditions ne sont pas ouvertes.

La lecture Admin retourne exactement l'enveloppe RPC suivante, avec
`p_status=all|requested|approved|declined`, `p_limit=1..100` et pagination par
offset :

```json
{
  "schema_version": 1,
  "total": 1,
  "limit": 50,
  "offset": 0,
  "items": [
    {
      "request_id": "0f35e8ea-49c2-4e9d-a574-cddf56415b23",
      "subject_key": "7af64e2196b3",
      "email_masked": "a***@example.com",
      "status": "requested",
      "country_code": "FR",
      "subdivision_code": "FR-IDF",
      "requested_at": "2026-08-02T12:00:00Z",
      "reviewed_at": null
    }
  ]
}
```

La décision Admin retourne exactement :

```json
{
  "schema_version": 1,
  "action": "access_request_decided",
  "status": "approved",
  "changed": true,
  "allowlist_included": true
}
```

Un replay de la même décision retourne `changed=false`. La recherche Admin est
exécutée côté serveur ; le client ne reçoit toujours qu'un e-mail masqué et un
sujet opaque.

### `POST /applications`

Crée ou reprend atomiquement une demande individuelle dans la juridiction
explicitement choisie. Le body est exact et limité à 4 Kio :

```json
{
  "accountType": "individual",
  "countryCode": "FR",
  "subdivisionCode": "FR-IDF"
}
```

`subdivisionCode` peut être omis ou valoir `null`. Une demande
`accountType=business` est refusée avec
`business_accounts_not_supported` et `nextState=business_waitlist` ; aucun
payload KYB n'est créé.

### `POST /activate`

Enregistre l'acceptation des versions autoritatives des conditions et de la
divulgation :

```json
{
  "termsVersion": "partners-fr-v1",
  "disclosureVersion": "partners-fr-v1"
}
```

Le nom de route est conservé pour la compatibilité du client, mais le navigateur
ne peut jamais forcer une activation. La RPC n'active le compte que si le KYC
stocké côté serveur est déjà `verified`, l'e-mail est confirmé, la politique et
le programme sont actifs, et les gates/allowlists sont satisfaites.

### `POST /activation/reconcile`

Relance l'évaluation serveur après un KYC asynchrone lorsque le webhook a
enregistré `verified` pendant qu'une gate, l'allowlist ou une version de contrat
était indisponible. Le body exact est `{}`. Cette route n'utilise volontairement
pas `Idempotency-Key` : elle verrouille le compte et ne réalise que la transition
conditionnelle `pending_verification → active`. Un retry est donc un no-op et ne
peut émettre qu'un seul événement `account_activated`.

```json
{
  "schema_version": 1,
  "action": "activation_reconciled",
  "changed": false,
  "account": {
    "exists": true,
    "status": "pending_verification",
    "verification_status": "verified",
    "contract_status": "accepted",
    "link_status": "none"
  },
  "next_action": "activate_account"
}
```

Chaque appel relit le programme P0 `20 % / 30 jours / J+45`, la politique et ses
dates, le provider/résultat KYC, les versions de conditions/divulgation, la
confirmation e-mail, les release gates et l'allowlist. `changed=false` est un
état normal si une condition reste fermée ou si le compte était déjà actif. Un
drift de version retourne `next_action=accept_terms`; une activation réussie
retourne `changed=true`, `status=active` et `next_action=share_link`. Les clients
doivent piloter l'état depuis `next_action`, y compris `start_verification` si le
provider ou la capacité exigée par la politique a changé, sans déduire une
activation du seul statut KYC.
Un compte déjà actif est relu comme un no-op `share_link` uniquement si son
programme, sa politique, ses preuves et son e-mail restent cohérents. Une
incohérence active échoue fermée vers le support ; fermer une launch gate seule
ne suspend toutefois pas rétroactivement un compte valide.

### `POST /links`

Crée le premier lien ou effectue une rotation atomique. Le body exact est `{}`.
L'ancien lien est révoqué avant l'activation du nouveau. Seule une URL canonique
`https://norva.tv/r/{code opaque de 32 caractères}` est retournée.

### `GET /dashboard`

Retourne le compte, le lien actif et un historique pseudonymisé :

```http
GET /functions/v1/norva-partners/dashboard?limit=25&status=all&cursor=<opaque>
```

`limit` est borné ; `status` appartient à
`all|pending|available|held|paid|reversed`. `clicks` et `referrals` sont des
entiers non négatifs, y compris avant la première commission. Avec une seule
devise financière, `reporting.available=true`, `reason=available`, la devise et
les trois soldes agrégés sont retournés. Sans activité financière ou avec
plusieurs devises, `reporting.available=false`,
`reason=no_financial_activity|multiple_currencies`, et seuls les montants ainsi
que la devise sont `null`. L'historique expose uniquement des événements
pseudonymisés `commission_pending|commission_available|commission_held|
commission_paid|commission_reversed`, jamais un montant, un identifiant ledger
ou un payload provider.

### `GET /referrals`

Retourne la liste pseudonymisee des comptes attribues au partenaire, par pages
stables et sans limiter le produit aux seuls comptes les plus recents :

```http
GET /functions/v1/norva-partners/referrals?limit=20&cursor=<opaque>
```

`limit` est compris entre 1 et 50 ; il s'agit uniquement de la taille d'une
page. Le client peut charger toutes les pages jusqu'a `next_cursor=null` et
affiche en permanence la progression `items affiches / total`. Le curseur
`referral_{20 chiffres}` est opaque pour le client et exclusif, ce qui evite
les doublons entre deux pages. Chaque item contient uniquement une cle opaque,
un numero d'affichage stable pour ce partenaire, un statut public borne, des
dates utiles au suivi et `masked_email`. Cette derniere valeur est soit `null`,
soit un indice de reconnaissance strictement masque produit cote serveur (par
exemple `he••••54@ca••••ey.com`). L'adresse complete ne quitte jamais le
perimetre Auth prive. Aucun UUID utilisateur, identifiant de paiement, montant,
payload provider ou adresse e-mail complete n'est retourne. Le client ne propose
ni copie de l'indice ni annuaire de contacts.

### `POST /kyc/sessions`

Réserve atomiquement une tentative KYC individuelle puis crée une session
hébergée Didit. Le navigateur transmet uniquement le consentement, l'attestation
de capacité et la langue ; l'identité du compte, la juridiction et la clé
`vendor_data` opaque viennent du serveur. Une même réservation inachevée est
réutilisée lors d'un retry. Le client reçoit uniquement l'URL hébergée, le
statut sanitisé et l'expiration.

Le webhook `norva-partners-kyc-webhook` vérifie la signature Didit sur le corps
brut, refuse les événements non autorisés et persiste l'observation exacte. Une
session inconnue répond `404 webhook_resource_unknown` afin que le provider
puisse retenter après une éventuelle course entre création et persistance.

### `POST /kyc/certification`

Voie opérateur pré-gate, séparée du parcours membre. Elle est fermée tant que
`NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED` n'est pas exactement `true` et
exige un Admin live avec capacité Risk, TOTP vérifié, JWT AAL2 frais, approbation
Privacy et tous les chemins Partners live désactivés. Le body exact est :

```json
{
  "language": "fr",
  "consentVersion": "partners-didit-certification-v1",
  "consentGranted": true,
  "capacityConfirmed": true,
  "confirmation": "CERTIFIER DIDIT",
  "justification": "Certification live supervisée du workflow publié."
}
```

`Idempotency-Key` est obligatoire. La réponse expose seulement le provider,
un état public borné, l'URL hébergée HTTPS Didit et l'expiration locale : aucun
UUID, identifiant de session/workflow, token, document, pays, âge ou résultat
biométrique. La réservation locale expire au plus tard après deux heures. Après
l'appel distant, la RPC service revalide Privacy, la gate KYC et les quatre
chemins live avant de lier la session provider ; une transition concurrente
laisse donc seulement une réservation locale non liée et expirante.

Un résultat réseau inconnu ne condamne pas l'opérateur à attendre l'expiration.
Tant que l'état autoritatif est `reserved|pending`, l'Admin expose
`POST /kyc/certification/resume` avec le body exact `{}`. Cette reprise relit
le même opérateur côté serveur, réapplique Admin+Risk, TOTP, AAL2, fraîcheur du
JWT et tous les verrous pré-gate, puis reconstruit la même clé opaque depuis la
réservation. Elle ne demande pas au navigateur de conserver la justification,
un identifiant provider ou une URL Didit.

Chaque création ou reprise interroge d'abord la liste Didit avec les filtres
exacts `vendor_data`, `workflow_id`, `session_kind=user` et `limit=2`, puis
borne le corps à 32 Kio. En `pending`, l'Edge n'émet jamais de `POST` : il exige
une unique session KYC active et fait comparer son identifiant brut au hash
privé déjà lié par une RPC `service_role` sans oracle public.

En `reserved`, une unique session KYC active est liée directement à la
réservation après acquisition du claim SQL ; elle n'est jamais recréée, même
si elle devient terminale juste après la lecture. Si la liste est exactement
vide, le claim durable `provider_create_dispatched_at` passe une seule fois de
`NULL` à un timestamp sous verrou de ligne : seul le replica ayant obtenu
`claimed=true` peut émettre l'unique `POST`. Un replica perdant sur liste vide,
une réponse ambiguë, KYB ou terminale échoue en `409 request_in_progress` et
attend le webhook signé ou la réconciliation. Le webhook signé reste
autoritaire et met en quarantaine toute divergence de workflow, version,
environnement ou fingerprint.

L'API de liste pouvant omettre `workflow_id` et `workflow_version`, le premier
est hérité du filtre exact de la requête lorsqu'il est absent et toute valeur
présente divergente est rejetée. La certification pré-gate est épinglée à la
version attendue `1`; le webhook signé apporte ensuite la version autoritaire
et met en quarantaine toute divergence.

Cette séquence garantit au plus un débit de crédit Didit même avec plusieurs
replicas, une réponse réseau inconnue ou une cohérence éventuelle de la liste.
Le payload de liste, riche en données personnelles, n'est jamais journalisé,
persisté ni renvoyé ; seule l'URL hébergée validée est rendue au même opérateur.
`in_review` et les états terminaux ne sont jamais repris.

La session utilise un registre cross-purpose commun : un identifiant provider
déjà lié au KYC membre est mis en quarantaine. Le webhook essaie d'abord le
réducteur membre et ne tombe sur le réducteur certification que pour son signal
explicite `P0006` « session inconnue ». Une décision sandbox, tardive,
incomplète ou liée à un environnement, workflow, version ou fingerprint
différent reste non autoritaire. Aucune observation, y compris approuvée, ne
modifie un compte, un lien, une commission, un paiement, un flag ou une gate.

L'Admin lit ensuite directement la RPC JWT-scoped
`admin_partners_kyc_certification_status()`. Cette lecture exige toujours
l'Admin live et la capacité Risk, mais reste disponible après fermeture du kill
switch ou évolution des gates. Son enveloppe fermée `schema_version=2` contient
`certification=null` ou uniquement : `status`, `verified`, `environment`,
`expires_at`, `observed_at` et une `reason` nullable choisie dans l'enum public
borné. Elle ajoute un objet `technical_history` strictement agrégé :
`sessions_total`, `sessions_with_events`, `sessions_without_events`,
`verified_live_sessions`, `quarantined_sessions` et
`last_event_observed_at`. Une session n'est comptée « sans événement » que si
elle possède déjà une liaison Didit hashée ; une simple réservation locale
jamais envoyée ne crée donc pas de faux incident.

Cet historique ne contient aucun identifiant provider, compte ou utilisateur,
aucune donnée documentaire et aucun résultat d'identité. Il sert uniquement à
rendre visible un écart historique de livraison. Il ne peut ni créer ni mettre
à jour un KYC cash membre, activer un compte, ouvrir un paiement ou satisfaire
une gate. Les trois machines d'état restent indépendantes : activation du
compte, KYC cash du membre et certification technique Didit.

L'Admin poll pendant au plus 60 secondes au retour de Didit et n'affiche jamais
les identifiants provider ni les résultats documentaires détaillés. Après un
résultat réseau inconnu, ce polling continue pendant toute la fenêtre même si
la première lecture retourne `certification=null`; le bouton de création reste
masqué jusqu'à la fin de la réconciliation.

### `POST /referral/claim`

Consomme après authentification un claim serveur opaque, avec idempotence et
protections contre l'auto-attribution, l'expiration et une attribution
préexistante. Sur le Web, la route Pages `/r/{code}` résout le lien côté serveur,
pose un cookie `__Host-norva_referral` `HttpOnly; Secure; SameSite=Lax`, puis
`POST /api/partners/claim` transmet le claim sans l'exposer au JavaScript.

### `GET|POST /fiscal-profile`

Cette route ne collecte aucun identifiant fiscal, formulaire brut ou champ
libre. `GET` retourne toujours un objet stable. Sans profil :

```json
{
  "schema_version": 1,
  "action": "fiscal_profile_loaded",
  "fiscal_profile": {
    "exists": false,
    "status": "missing",
    "country_code": null,
    "declaration_version": null,
    "submitted_at": null,
    "reviewed_at": null
  }
}
```

`POST` exige `Idempotency-Key` et le body exact :

```json
{
  "countryCode": "FR",
  "declarationAccepted": true,
  "declarationVersion": "partners-tax-self-certification-v1"
}
```

Le pays doit être strictement celui du compte actif, KYC vérifié et contrat
accepté. La déclaration et sa version sont figées par le serveur. La mutation
peut uniquement créer ou remettre le profil en `pending`; elle ne peut jamais
produire `verified`. La revue autoritative reste
`admin_partners_fiscal_review_by_public_id(p_account_public_id,p_status,p_provider,p_reference_hash,p_tax_form_type,p_justification)`,
protégée par les capacités Support et Finance ainsi que par une session AAL2.
La file paginée
`admin_partners_fiscal_profiles(p_limit,p_offset,p_status,p_search)` expose
uniquement `partner_key`, pays, statut et horodatages de soumission/revue. Elle
ne renvoie ni UUID de compte, ni e-mail, ni référence provider, ni valeur
fiscale. Les anciens points d'entrée Admin basés sur l'UUID ne sont plus
exécutables par `authenticated`.

Lors de la migration, tout ancien état `verified|pending|rejected` dépourvu de
preuve d'auto-attestation est placé en `expired`, sans inventer de déclaration
ni d'horodatage. Cet unique état de récupération peut donc être retourné avec
`declaration_version=null` et `submitted_at=null`; un nouveau `POST` explicite
le remet en `pending`. `pending` et `verified` exigent toujours la déclaration
v1 et `self_attested_at`. L'ancien RPC service de résultat fiscal ne peut plus
créer de profil ni écrire `verified`.

Le replay exact est évalué avant le quota. Une nouvelle clé est limitée à une
tentative par 60 secondes et huit sur 24 heures, avec `429 rate_limited` et
`Retry-After: 60`. Les clés d'idempotence âgées de plus de 30 jours sont
purgeables par lots bornés ; le profil fiscal et son audit ne sont pas purgés.

### `GET|POST /payout-onboarding`

Cette route ouvre une demande de contact pour le rail manuel sans accepter de
provider client, IBAN, token bénéficiaire, destination masquée, nom, e-mail ou
champ libre. `POST` exige `Idempotency-Key` et exactement :

```json
{
  "currency": "USD",
  "contactConsent": true
}
```

`revolut_manual` est implicite côté serveur. Le compte doit être actif, KYC
vérifié et contractuellement accepté. Son profil fiscal doit déjà être
`verified`, porter la déclaration figée v1, la preuve d'auto-attestation, la
revue horodatée et la provenance tokenisée de cette revue, dans le même pays
que le compte. La route pays/devise, la devise et la policy doivent toutes être
actives et cohérentes. `GET` retourne l'état le plus récent et
`allowed_currencies`, calculé uniquement à partir de ces corridors.
Sans demande, l'état vaut :

```json
{
  "exists": false,
  "status": "not_started",
  "currency": null,
  "execution_adapter": "revolut_manual",
  "reconfiguration_required": false,
  "requested_at": null,
  "updated_at": null,
  "reason_code": null
}
```

Les états persistants sont `pending|in_progress|rejected|completed`. Les
transitions Admin sont append-only et auditables. Une nouvelle révision peut
être créée après rejet, ou après `completed` si le binding/profil a depuis été
révoqué ou désactivé ; une seule révision peut rester ouverte par compte.
Une ligne `rejected` ne peut jamais revenir à `pending` : la resoumission crée
obligatoirement une nouvelle révision immuable. Le même quota 60 secondes,
huit nouvelles clés par 24 heures et la même rétention d'idempotence de 30
jours s'appliquent à cette mutation, après vérification du replay exact.

`reconfiguration_required` est toujours présent. Il vaut `true` uniquement
pour un état historique `completed` dont le profil ou le binding Revolut actif
n'est plus valable. Le client doit alors relire l'état autoritatif, afficher la
reconfiguration et autoriser un nouveau `POST`, lequel crée `revision + 1` en
`pending`. Pour `not_started|pending|in_progress|rejected`, et pour un
`completed` encore prêt, il vaut `false`. Une réponse idempotente reste
immuable ; après toute réponse `replayed=true`, le client effectue donc un GET
avant de rendre l'état courant.

La file Finance est exposée par
`admin_partners_payout_onboarding_requests(p_limit,p_offset,p_status,p_search)`
et la décision par
`admin_partners_payout_onboarding_request_decide(p_request_key,p_action,p_reason_code,p_justification)`.
Les deux exigent Admin + capacité Finance + AAL2 dans la RPC. Les actions sont
`start|reject|complete`; `complete` exige un profil Revolut actif relié au
binding actif du registre maker-checker existant. Immédiatement avant chaque
completion, y compris un retry déjà `completed`, la base reverrouille et
revalide : compte actif, KYC et contrat courants, programme P0 et policy encore
effectifs, versions de conditions acceptées, profil fiscal `verified` avec
attestation v1 et provenance, devise active, puis corridor Revolut
`revolut_manual` actif. Un compte held, une policy expirée, un profil fiscal
expiré, une route désactivée ou `revolut_api` ferment donc la completion. La
file expose uniquement la
clé publique `por_…`, la clé partenaire `prt_…`, pays, devise, révision, états,
horodatages et indicateurs de disponibilité du binding/profil. Pour ouvrir la
fiche sans UUID interne, l'Admin utilise
`admin_partners_detail_by_public_id(p_account_public_id)`.

Après `start`, la proposition du bénéficiaire passe par l'Edge
`POST /manual/beneficiaries/propose` avec `request_key` et jamais avec
`account_id` ou `currency` fournis par le navigateur. La RPC
`admin_partners_revolut_beneficiary_binding_authorize_by_request(...)` résout
ces deux valeurs, exige la dernière révision `in_progress`, le consentement de
contact, l'éligibilité courante et le corridor manuel exact. Le payload signé
utilise la clé publique `por_…` et ne contient pas l'UUID du compte.

Le contact opérationnel est audité par
`admin_partners_payout_onboarding_contact(p_request_key,p_template_key,p_idempotency_key)`.
Il réutilise `cloud_support_tickets`, `cloud_support_messages` et l'outbox e-mail
existante, en résolvant l'adresse confirmée uniquement côté serveur. Les seuls
modèles sont `secure_setup_invitation`, `setup_follow_up` et
`reconfiguration_required`; aucun texte libre n'est accepté. Tous rappellent
de ne jamais transmettre par e-mail des coordonnées bancaires/fiscales, des
documents d'identité, un mot de passe ou un code MFA. Le replay est idempotent,
la cadence est bornée à un envoi par minute et trois par 24 heures et la réponse
ne contient ni e-mail ni UUID utilisateur/compte.

### `GET /payout-profile`

Cette surface membre est strictement en lecture seule. Elle retourne seulement
l'état et la destination déjà masquée. Le navigateur ne peut transmettre ni
provider, ni token bénéficiaire, ni libellé masqué, ni IBAN, ni numéro de compte,
ni donnée fiscale. Sous `revolut_manual`, le token opaque est proposé uniquement
par l'Edge Finance depuis le registre serveur, lié par une attestation HMAC
versionnée, puis activé après contrôle d'un second acteur Finance/AAL2. Ni UUID
bénéficiaire interne ni empreinte HMAC ne sont publics.
L'ancien setter public
`partners_service_payout_profile_set(uuid,text,text,text,text,text)` n'est plus
exécutable par `service_role`; seul le registre Finance maker-checker peut
préparer la destination.

### `POST /tv-relays/consume`

Consomme, côté compte authentifié, un relais TV éphémère signé afin d'ouvrir le
parcours Partners sur téléphone/Web. L'API appareil séparée
`norva-partners-device` implémente `GET /availability`, `POST /relays` et
`POST /relays/status` avec une identité TV de confiance ; elle ne peut ni
inscrire un partenaire, ni lancer un KYC, ni accéder aux finances.

Les mutations d'adhésion `/applications`, `/activate` et `/links` répondent avec
l'enveloppe exacte suivante ; `/access-request` utilise le contrat distinct
décrit plus haut :

```json
{
  "schema_version": 1,
  "action": "application_submitted",
  "replayed": false,
  "account": {
    "exists": true,
    "status": "pending_verification",
    "verification_status": "not_started",
    "contract_status": "not_accepted",
    "link_status": "none"
  },
  "next_action": "start_verification"
}
```

`next_action` appartient à
`start_verification|await_verification|accept_terms|activate_account|share_link|contact_support|none`.

## 5. Codes publics

| HTTP | Code | Usage |
|---:|---|---|
| 400 | `invalid_query` | paramètre inconnu, dupliqué ou invalide |
| 401 | `authentication_required` | bearer absent |
| 401 | `invalid_access_token` | JWT invalide, expiré ou utilisateur supprimé |
| 403 | `cors_origin_denied` | origine non autorisée |
| 403 | `cors_preflight_denied` | méthode/header de preflight non autorisé |
| 404 | `route_not_found` | route inexistante |
| 405 | `method_not_allowed` | méthode incompatible avec la route |
| 409 | `idempotency_key_reused` | clé rejouée avec une requête différente |
| 409 | `request_in_progress` | première exécution toujours en cours |
| 429 | `rate_limited` | cooldown de 60 s ou plafond de 8 nouvelles clés sur 24 h atteint ; `Retry-After: 60` |
| 413 | `payload_too_large` | body supérieur à 4 Kio |
| 415 | `invalid_content_type` | mutation sans JSON |
| 422 | `business_accounts_not_supported` | compte entreprise non disponible |
| 422 | `partners_action_not_allowed` | transition refusée par l'autorité serveur |
| 428 | `idempotency_key_required` | mutation sans clé d'idempotence valide |
| 503 | `partners_access_requests_disabled` | collecte des demandes en pause ; GET reste disponible |
| 503 | `partners_temporarily_unavailable` | RPC indisponible ou contrat DB invalide |

Codes métier non émis par `/bootstrap` :

- `business_accounts_not_supported` : le P0 refuse une personne morale, sans
  créer de payload KYB ; l'UI passe à l'état `business_waitlist` ;
- `kyc_billing_unavailable` : le circuit KYC est ouvert pour incident réel de
  facturation/provider, jamais pour le simple passage du quota gratuit 500→501 ;
- `idempotency_key_reused` : même clé avec une requête différente ;
- `request_in_progress` : première exécution non terminée.
- `rate_limited` : nouvelle clé trop proche de la précédente ou neuvième clé
  sur la fenêtre glissante de 24 heures ; le client lit `Retry-After` ;
- `partners_access_requests_disabled` : kill switch de collecte fermé ; le
  client conserve la consultation GET et ne transforme pas cette erreur en
  indisponibilité générale du programme.

## 6. Dépendances externes restant fail-closed

Les routes ci-dessus existent dans le dépôt, mais ne constituent pas à elles
seules une activation production :

| Dépendance | État fail-closed |
|---|---|
| Collecte pré-pilote | `NORVA_PARTNERS_ACCESS_REQUESTS_ENABLED=false` bloque seulement `POST /access-request` avec un 503 sanitisé ; `GET /access-request` et la file Admin restent lisibles |
| Didit | `/kyc/sessions` renvoie `provider_not_configured` sans workflow, clés et webhook configurés |
| Referral Web | `/r/{code}` et la consommation refusent de fonctionner sans secrets HMAC/cookie distincts |
| Relais TV | les créations/consommations restent indisponibles sans secret relais et flag actif |
| Payout provider | registre Finance/HMAC `revolut_manual` requis, binding maker-checker et destination masquée ; aucune coordonnée bancaire brute côté client |
| Exécution payout | `partners_payouts_live=false` bloque préparation et nouveaux leases Norva, mais n'annule jamais un virement déjà saisi ; le relevé et les incidents restent traitables |

Le parcours entreprise ne réutilisera aucune de ces mutations P0. Une demande
`accountType=business` devra répondre :

```json
{
  "error": {
    "code": "business_accounts_not_supported",
    "message": "Business accounts are not supported in this release.",
    "nextState": "business_waitlist"
  }
}
```

`business_waitlist` est un état d'orientation produit, pas une activation, une
preuve d'éligibilité ni un début de KYB.

## 7. Idempotence

`GET /bootstrap`, `GET /access-request`, `GET /dashboard`, `GET /referrals`,
`GET /payout-profile` et `GET /availability` ne créent aucun effet et
n'utilisent pas de clé d'idempotence.

Toute mutation implémentée ou future exige `Idempotency-Key` :

- 16 à 128 caractères ASCII `[A-Za-z0-9._:-]` ;
- scope serveur `(JWT subject, méthode, route, clé)` ;
- hash du body JSON canonique conservé avec le résultat ;
- même clé + même hash : replay du même statut et de la même réponse ;
- même clé + hash différent : `409 idempotency_key_reused` ;
- exécution encore en cours : `409 request_in_progress` avec `Retry-After` ;
- aucune clé client ne remplace les clés financières autoritatives
  `accrual:{ledger_payment_id}`, `reversal:{ledger_refund_id}` et
  `payout:{period}:{affiliate_account_id}`.

La RPC, et pas uniquement le code Edge, doit porter l'atomicité et
l'idempotence métier.

Pour `POST /access-request`, l'ordre est contractuel : verrou utilisateur,
replay exact, puis seulement cooldown/quota pour une nouvelle clé. Une même clé
avec un hash différent reste un `409 idempotency_key_reused` et ne devient pas
un `429`. Les nouvelles clés réussies ont une fenêtre de rétention de 30 jours
pour le replay et sont comptées sur une fenêtre glissante de 24 heures ;
au-delà, leur purge opportuniste bornée ne modifie jamais la machine d'état
`requested|approved|declined`.

## 8. Machines d'états P0

### Demande d'accès au pilote

```text
aucune → requested → approved
                    └→ declined
```

`approved` et `declined` sont terminaux. L'approbation est une inclusion dans
l'allowlist, pas une adhésion, une vérification KYC ni une activation du
programme. La machine de compte ci-dessous ne commence qu'avec
`POST /applications`, après satisfaction indépendante de toutes ses portes.

### Compte et vérification

```text
aucun → invited → pending_verification → active
                         ├→ held → active | suspended
                         └→ closed
active → held | suspended | closed
```

```text
not_started → pending → verified
                    ├→ failed → pending
                    └→ expired → pending
verified → expired → pending
```

`active` exige une vérification `verified`, un contrat `accepted`, une politique
individuelle active et l'absence de blocage. Le webhook KYC signé est
autoritatif ; le navigateur ne peut pas déclarer `verified`.

### Lien

```text
none → active → revoked → active
```

Une rotation révoque l'ancien code avant d'activer le nouveau et reste
auditable. Un code public n'est jamais une preuve financière.

### Commission

```text
calculation_pending → pending → available → allocated → paid
pending | available → held
held → pending | available | reversed
pending | available | paid → reversed
```

### Versement

Les cycles passent par
`draft → review → approved → submitted → settled|failed|cancelled`.
La transition `DRY → LIVE` promeut atomiquement le même cycle en le replaçant
en `draft` avec un snapshot reconstruit ; elle n'envoie jamais de versement et
exige ensuite un second acteur pour l'approbation.
Le P0 interdit la préparation d'un nouveau lot et la prise d'un nouveau lease
tant que `partners_payouts_live=false` ou qu'aucune route manuelle active ne
couvre le pays/la devise. Une fois un virement saisi dans Revolut, fermer ce
flag ne peut pas l'annuler : Norva doit continuer l'import du relevé, le
rapprochement et la résolution des incidents. L'état `submitted` signifie que
l'opérateur a déclaré `entered_in_revolut=YES`, pas que le paiement est réglé ;
seule la preuve du relevé suivie du contrôle Finance crée le settlement. Les
cycles `DRY` servent à la réconciliation shadow et ne constituent jamais un
versement.

## 9. Trois frontières qui ne se mélangent pas

### Utilisateur

`norva-partners` reçoit le JWT utilisateur, appelle uniquement les RPC
utilisateur/service prévues et peut afficher ses propres états/agrégats.
La découverte et `GET|POST /access-request` restent accessibles à tout compte
Cloud utilisateur Web/mobile, Admin inclus, même quand le programme est fermé.
Cette demande pré-pilote est isolée de l'adhésion, du KYC, des liens et de la
finance.
Une vérification KYC asynchrone se termine par un refresh puis, pour un compte
`pending_verification + verified`, par `POST /activation/reconcile`. Le client
rend ensuite strictement le `next_action` sanitisé ; il ne considère jamais le
webhook ou le retour navigateur Didit comme une activation.

### Referral Web

La résolution publique `/r/{code}` appartient à une fonction Pages distincte.
Elle contacte l'Edge Function avec une signature serveur courte durée, crée un
claim opaque à usage unique et pose un cookie `__Host-norva_referral` HttpOnly.
Elle ne retourne jamais l'identité du partenaire.

### Appareil TV

L'API `norva-partners-device` accepte uniquement l'identité appareil et des
relais éphémères TV→téléphone. Elle ne peut appeler aucune RPC financière, KYC,
contractuelle ou de profil. TV n'inscrit pas un partenaire et ne crée pas
d'attribution.

## 10. Observabilité et compatibilité

Les logs Edge contiennent seulement :

- un correlation ID aléatoire ;
- la route normalisée ;
- un code public sanitisé (`ok` inclus).

La requête complète, les query strings, l'identité, les données RPC et les
erreurs brutes ne sont jamais journalisées. Une évolution additive exige une
nouvelle `version` de contrat ou une extension explicitement tolérée par les
clients ; le sanitizer P0 refuse par défaut les champs inconnus.

Références Supabase vérifiées lors de l'implémentation :

- <https://supabase.com/docs/guides/auth/jwts>
- <https://supabase.com/docs/guides/functions/auth>
- <https://supabase.com/docs/guides/functions/function-configuration>
