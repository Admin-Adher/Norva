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
- Les réponses et logs n'exposent ni JWT, e-mail, UUID utilisateur/compte, code
  affilié, claim, référence KYC, document, IBAN, payload provider ou erreur SQL.

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
- route existante parmi `/bootstrap`, `/applications`, `/activate`, `/links`,
  `/dashboard`, `/kyc/sessions`, `/referral/claim`, `/payout-profile` et
  `/tv-relays/consume` ;
- origine présente et autorisée.

Les clients Android natifs sans header `Origin` restent autorisés. Dès qu'un
header `Origin` est présent, il doit appartenir à l'allowlist.

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
      "USD": 5000
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

### `POST /referral/claim`

Consomme après authentification un claim serveur opaque, avec idempotence et
protections contre l'auto-attribution, l'expiration et une attribution
préexistante. Sur le Web, la route Pages `/r/{code}` résout le lien côté serveur,
pose un cookie `__Host-norva_referral` `HttpOnly; Secure; SameSite=Lax`, puis
`POST /api/partners/claim` transmet le claim sans l'exposer au JavaScript.

### `GET|PUT /payout-profile`

Lit ou enregistre uniquement une référence bénéficiaire tokenisée par un
provider de versement ainsi qu'un libellé déjà masqué. Aucun IBAN, numéro de
compte ou donnée fiscale brute n'entre dans une réponse publique. Sous
`revolut_manual`, le token opaque est proposé par l'Edge depuis le registre
Finance, lié par une attestation HMAC serveur versionnée, puis activé uniquement
après contrôle d'un second acteur Finance/AAL2. Le client et le read model ne
reçoivent que l'état et la destination masquée ; ni UUID bénéficiaire interne,
ni empreinte HMAC ne sont publics.

### `POST /tv-relays/consume`

Consomme, côté compte authentifié, un relais TV éphémère signé afin d'ouvrir le
parcours Partners sur téléphone/Web. L'API appareil séparée
`norva-partners-device` implémente `GET /availability`, `POST /relays` et
`POST /relays/status` avec une identité TV de confiance ; elle ne peut ni
inscrire un partenaire, ni lancer un KYC, ni accéder aux finances.

Les mutations répondent avec l'enveloppe exacte suivante :

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
| 413 | `payload_too_large` | body supérieur à 4 Kio |
| 415 | `invalid_content_type` | mutation sans JSON |
| 422 | `business_accounts_not_supported` | compte entreprise non disponible |
| 422 | `partners_action_not_allowed` | transition refusée par l'autorité serveur |
| 428 | `idempotency_key_required` | mutation sans clé d'idempotence valide |
| 503 | `partners_temporarily_unavailable` | RPC indisponible ou contrat DB invalide |

Codes métier non émis par `/bootstrap` :

- `business_accounts_not_supported` : le P0 refuse une personne morale, sans
  créer de payload KYB ; l'UI passe à l'état `business_waitlist` ;
- `kyc_billing_unavailable` : le circuit KYC est ouvert pour incident réel de
  facturation/provider, jamais pour le simple passage du quota gratuit 500→501 ;
- `idempotency_key_reused` : même clé avec une requête différente ;
- `request_in_progress` : première exécution non terminée.

## 6. Dépendances externes restant fail-closed

Les routes ci-dessus existent dans le dépôt, mais ne constituent pas à elles
seules une activation production :

| Dépendance | État fail-closed |
|---|---|
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

`GET /bootstrap`, `GET /dashboard`, `GET /payout-profile` et
`GET /availability` ne créent aucun effet et n'utilisent pas de clé
d'idempotence.

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

## 8. Machines d'états P0

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
