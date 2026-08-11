# Norva Partners — runbook pilote

**Version :** 4 août 2026
**Principe :** les couches sont indépendantes et restent fail-closed selon leur
risque propre. Un compte Norva confirmé peut adhérer, créer son lien, être
attribué et accumuler/maturer des commissions sans KYC ni pays de virement.
`partners_earnings_enabled` contrôle le calcul financier et
`partners_credit_redemptions_enabled` la conversion en accès Norva. Le pays,
Didit, la fiscalité, le corridor et la fenêtre Finance ne contrôlent que le
virement cash optionnel.

Ce runbook ne remplace ni une revue juridique/fiscale locale ni les procédures
d'incident des fournisseurs. Il décrit les contrôles techniques nécessaires
avant et pendant le pilote individuel Norva Partners.

Norva ne désigne pas officiellement de DPO par ce pilote. La gate
`membership_privacy_approved` protège l'adhésion publique avec une évaluation
documentée excluant Didit et la biométrie. La gate `privacy_approved` protège
uniquement le parcours cash Didit France ; elle repose sur l'auto-évaluation
RGPD et l'AIPD immuables décrites dans
`NORVA-PARTNERS-APPROVAL-EVIDENCE.md`. La cohorte cash est limitée à 50 comptes
allowlistés et cette décision ne vaut jamais autorisation d'ouverture publique
du cash. La généralisation du cash exige une revue Privacy distincte,
sans que cette revue constitue par elle-même une désignation officielle de DPO.

## 1. Portes de mise en service

Ne jamais ouvrir un flag uniquement parce que le code est déployé. Distinguer
les portes du programme sans KYC de celles du virement cash.

Pour l'adhésion, le lien, l'attribution, la maturation et le crédit d'accès,
conserver les preuves datées suivantes :

1. contrat et disclosure approuvés et publiés ;
2. programme individuel versionné (20 %, attribution 30 jours, maturation
   J+45) et données financières autoritatives ;
3. contrôles anti-abus, sauvegarde/restauration et workers validés ;
4. catalogue d'accès versionné et quote serveur pour lever
   `partners_credit_redemptions_enabled`.

Ces quatre portes ne demandent ni résultat Didit, ni pays de virement, ni
profil fiscal, ni corridor. Pour chaque pays/subdivision où un virement cash
est proposé, conserver en plus une preuve datée des portes payout :

1. KYC individuel Didit couvrant identité, âge, pays et capacité ;
2. traitement fiscal du partenaire individuel défini ;
3. rail de versement individuel, devise, seuil et retours testés ;
4. sources financières capables de fournir le montant final réellement payé,
   la taxe, la devise/exposant, le mouvement parent et l'état de remboursement.
   La remise séparée reste un contexte facultatif et ne doit pas être soustraite
   une seconde fois du montant Google Play déjà remisé.

L'activation initiale du virement cash est limitée à une allowlist nominative de
20 à 50 comptes. L'adhésion, le partage, les commissions et le crédit d'accès
restent publics et indépendants. Le KYB et les sociétés restent fermés ; les
versements réels ne s'ouvrent que dans une fenêtre Finance supervisée.

### Découverte publique et demandes d'accès au pilote cash

La découverte n'est pas une porte de mise en service. Tout compte Cloud
utilisateur authentifié voit l'entrée **Norva Partners** sur Web et Android
mobile, y compris un compte qui possède aussi un rôle Admin. Ne jamais masquer
cette entrée à cause de `partners_enabled=false`, d'une release gate fermée,
d'une policy absente, d'une juridiction non ouverte ou d'une allowlist vide.
L'entrée utilisateur et la surface `Admin > Partners` restent deux contextes
distincts. TV conserve son relais et ses contrôles appareil séparés.

`GET|POST /access-request` est un intake facultatif pour la cohorte cash ; il ne
contrôle jamais l'adhésion Partners :

- `GET` retourne `request.exists=false` ou l'état
  `requested|approved|declined`, sans effet de bord ;
- `POST` exige un compte confirmé, le pays, une subdivision facultative et une
  clé d'idempotence ; il reste disponible quand tous les flags et gates du
  programme sont fermés, à condition que son kill switch dédié
  `NORVA_PARTNERS_ACCESS_REQUESTS_ENABLED=true` ;
- seul un enregistrement `affiliate_access_requests`, son état d'idempotence et
  un événement d'audit sanitisé sont créés ou mis à jour ;
- aucun KYC/KYB, pays de payout, profil fiscal, profil de versement ou paiement
  n'est créé par cette demande ;
- une demande `requested` peut mettre à jour sa juridiction avec une nouvelle
  clé ; `approved` et `declined` sont terminaux côté utilisateur.

La file Admin suit la séparation de responsabilités suivante :

| Action | Autorité minimale | Effet autorisé |
|---|---|---|
| Lister, chercher et filtrer les demandes | Support **ou** Risk | lecture paginée de données sanitisées : sujet opaque, e-mail masqué, état, juridiction et horodatages |
| Approuver ou refuser | Risk **et** session AAL2 | décision auditée avec justification ; expiration future facultative pour une approbation |
| Approuver | Risk **et** session AAL2 | ajoute seulement l'utilisateur à l'allowlist du pilote cash pour la juridiction demandée |

Un compte confirmé rejoint publiquement par `POST /join`, sans
`/applications`, pays de virement ni Didit. Une approbation d'accès cash
n'enrôle pas automatiquement, ne crée pas le lien et ne démarre jamais Didit.
La policy payout et les corridors sont vérifiés seulement si ce membre
allowlisté choisit ultérieurement **Recevoir un virement cash**. Pour un compte
hors cohorte, `cash_readiness.reason=cash_pilot_not_allowed` et aucune donnée de
payout ne doit être demandée.

## 2. Configuration secrète

Configurer dans le gestionnaire de secrets de l'environnement, jamais dans Git :

```text
DIDIT_API_KEY
DIDIT_WORKFLOW_ID
DIDIT_APPLICATION_ID
DIDIT_ENVIRONMENT                 # live | sandbox
DIDIT_SESSION_EXPIRATION_SECONDS  # 3600..2419200 ; recommandé 604800
DIDIT_WEBHOOK_SECRET
DIDIT_CALLBACK_URL
DIDIT_ID_VERIFICATION_NODE_ID
DIDIT_LIVENESS_NODE_ID
DIDIT_FACE_MATCH_NODE_ID
NORVA_PARTNERS_DIDIT_PURGE_KEYS_JSON # objet version -> clé AES-256 base64url
NORVA_PARTNERS_DIDIT_PURGE_ACTIVE_KEY_VERSION
NORVA_PARTNERS_DIDIT_PURGE_BATCH      # 1..20, défaut 10
NORVA_PARTNERS_DIDIT_PURGE_MAX_BATCHES # 1..4, défaut 2
NORVA_PARTNERS_DIDIT_PURGE_LEASE_SECONDS # 60..300, défaut 120
NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED # non secret ; false hors fenêtre supervisée
NORVA_REFERRAL_EDGE_HMAC_SECRET
NORVA_REFERRAL_COOKIE_SECRET
NORVA_PARTNERS_ALLOWED_ORIGINS
NORVA_PARTNERS_ACCESS_REQUESTS_ENABLED # non secret ; false par défaut, ouvre seulement le POST
NORVA_PARTNERS_TV_RELAY_SECRET
NORVA_PARTNERS_TV_RELAY_HANDOFF_URL=https://norva.tv/app.html
NORVA_PARTNERS_TV_RELAY_TTL_SECONDS
NORVA_PARTNERS_DEVICE_ALLOWED_ORIGINS  # optionnel ; sinon allowlist Partners
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON      # JSON sur une ligne, secret Edge
GOOGLE_PLAY_PACKAGE_NAME              # tv.norva.phone
NORVA_REVENUECAT_WEBHOOK_AUTH         # défense Authorization existante
NORVA_REVENUECAT_WEBHOOK_HMAC_SECRET  # secret distinct de signature webhook
NORVA_REVENUECAT_SECRET_API_KEY       # lecture CustomerInfo serveur
NORVA_REVENUECAT_ALLOWED_APP_IDS       # app_id RevenueCat, séparés par virgules
NORVA_REVENUECAT_TRANSFER_WORKER_BATCH # 1..4, défaut 4
NORVA_REVENUECAT_TRANSFER_WORKER_MAX_BATCHES # forcé à 1
NORVA_REVENUECAT_TRANSFER_WORKER_LEASE_SECONDS # 120..300, défaut 120

# Rail de production initial : Revolut Business Basic, exécution manuelle.
NORVA_PARTNERS_REVOLUT_API_ENABLED     # kill switch Edge ; false sous Basic

# Registre bénéficiaire du rail manuel. Ces secrets serveur sont nécessaires
# au mode revolut_manual ; ils ne sont ni des identifiants Business API, ni des
# secrets Merchant API.
NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_KEYS_JSON
                                       # objet version -> clé aléatoire base64url
NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_ACTIVE_VERSION
                                       # version de signature choisie côté serveur

# Rail Revolut Business API dormant. Ces valeurs restent absentes en mode
# revolut_manual et ne sont jamais des secrets Merchant API.
NORVA_PARTNERS_REVOLUT_API_BATCH       # forcé à 1 (un seul lease financier)
NORVA_PARTNERS_REVOLUT_API_MAX_BATCHES # 1..4, défaut 2
NORVA_PARTNERS_REVOLUT_API_LEASE_SECONDS # 60..240, défaut 240
REVOLUT_BUSINESS_ENVIRONMENT           # choix explicite : sandbox | production
REVOLUT_BUSINESS_SANDBOX_SKIP_TRANSFER_FIELDS
                                       # smoke isolé uniquement ; jamais production/Edge
REVOLUT_BUSINESS_CLIENT_ID
REVOLUT_BUSINESS_ISSUER
REVOLUT_BUSINESS_PRIVATE_KEY_PEM
REVOLUT_BUSINESS_REFRESH_TOKEN
REVOLUT_BUSINESS_SOURCE_ACCOUNTS_JSON  # allowlist compte source par devise
REVOLUT_BUSINESS_MAX_FEE_MINOR_JSON    # plafond Finance en unités mineures/devise
REVOLUT_BUSINESS_TIMEOUT_MS
```

Configurer séparément sur Cloudflare Pages :

```text
NORVA_PARTNERS_REFERRAL_EDGE_URL   # URL complète terminée par /resolve
NORVA_REFERRAL_REDIRECT_URL
NORVA_REFERRAL_EDGE_HMAC_SECRET
NORVA_PARTNERS_API_URL
```

Toute modification de ces variables, y compris une rotation de secret, doit
être suivie d'un nouveau déploiement Pages : les déploiements existants
conservent leur instantané d'environnement.

`NORVA_REFERRAL_COOKIE_SECRET` reste exclusivement côté serveur : il ne doit
jamais être injecté dans Pages. Le worker financier réutilise le secret cron
Norva existant (`NORVA_CRON_SHARED_SECRET`, conservé dans Vault) et ne possède
pas de secret parallèle. Ses réglages optionnels sont bornés :
`NORVA_PARTNERS_WORKER_BATCH`, `NORVA_PARTNERS_WORKER_MAX_BATCHES`,
`NORVA_PARTNERS_WORKER_LEASE_SECONDS` et
`NORVA_PARTNERS_SHADOW_WINDOW_HOURS`.

### RevenueCat : activation HMAC sans interruption

Le nouveau receiver exige deux preuves indépendantes avant de parser le corps :
`Authorization` et la signature HMAC horodatée RevenueCat. Déployer le code
avant d'activer la signature couperait toutes les notifications avec un `503`
fail-closed. Respecter donc cet ordre non interrompant :

1. créer un secret HMAC RevenueCat distinct pour **sandbox** et un autre pour
   **production** ; ne jamais réutiliser le secret `Authorization` ;
2. stocker d'abord le secret de l'environnement ciblé dans le gestionnaire de
   secrets Edge sous `NORVA_REVENUECAT_WEBHOOK_HMAC_SECRET`, sans le journaliser
   ni le placer dans Git ;
3. activer la signature HMAC sur l'endpoint RevenueCat du même environnement et
   envoyer un événement test ; conserver la preuve que timestamp, corps brut et
   signature sont validés ;
4. déployer ensuite `norva-billing-webhook`, puis rejouer un événement test et
   vérifier un `2xx` ainsi que l'absence de doublon ;
5. déployer `norva-revenuecat-transfer-worker`, exécuter une fois
   `/cron/run`, puis seulement enregistrer
   `ops/hetzner/scripts/register-norva-revenuecat-transfer-cron.sql`.

Sandbox et production utilisent des endpoints/configurations RevenueCat et des
secrets HMAC séparés. `NORVA_RC_ACCEPT_SANDBOX=false` reste la valeur de
production ; un test sandbox ne doit jamais être routé vers l'endpoint
production. Une rotation suit la même séquence « nouveau secret stocké → secret
provider basculé → test signé → ancien secret révoqué ».

Quand le projet RevenueCat contient plusieurs applications,
`NORVA_REVENUECAT_ALLOWED_APP_IDS` est obligatoire : un `event.app_id` absent
ou hors allowlist échoue alors fermé. Le worker utilise un lot maximal de 4, un
seul lot, un timeout provider de 8 secondes, un budget global de 45 secondes et
un lease minimal de 120 secondes. Sur `429`/`503`, il respecte `Retry-After`,
diffère le reliquat et interrompt le batch.

`NORVA_PARTNERS_TV_RELAY_SECRET` contient 32 à 512 caractères. L'URL de handoff
doit être exactement `https://norva.tv/app.html` : `/app`, un sous-domaine, un
port explicite, une query ou un fragment rendent le relais `not_configured`.
Le fragment signé est ajouté uniquement à l'exécution et le TTL est compris
entre 120 et 600 secondes. Didit reçoit directement la `kyc.reservation_key` opaque
émise par la DB comme `vendor_data` : aucun second secret vendor n'est requis.

### Revolut Business Basic : production manuelle

`revolut_manual` est le rail réel du démarrage commercial, pas un dry-run.
Norva reste autoritaire pour le ledger append-only, la maturation J+45, les
contrôles, les lots et leur état. Un acteur Finance valide ensuite le lot et
saisit chaque virement dans Revolut Business Basic. Aucun appel Business API
n'est nécessaire pour ce parcours.

Le contrat initial est strict :

- la route active porte `provider=revolut` et
  `execution_adapter=revolut_manual` ;
- `partners_revolut_api_enabled=false` en DB et
  `NORVA_PARTNERS_REVOLUT_API_ENABLED=false` dans l'Edge ;
- chaque paiement possède une référence immuable et unique de forme
  `NORVA-[A-F0-9]{12}` ; elle est copiée sans modification dans Revolut ;
- référence, montant mineur et devise doivent tous correspondre exactement ;
- le TSV opérateur fige l'identifiant d'exécution, la destination masquée, le
  montant, la devise et la référence. Sa dernière colonne
  `entered_in_revolut` est vide dans l'original et accepte uniquement `YES`
  dans la copie de travail après saisie. Aucun identifiant ou hash de
  transaction Revolut n'est copié manuellement dans Norva ;
- le `beneficiary_token_ref` n'est jamais inventé au moment du lot. Il provient
  d'un registre Finance sécurisé, distinct du dépôt, qui relie cet UUID opaque
  au bénéficiaire Revolut réel. La destination masquée sert de second contrôle,
  pas de mécanisme de recherche autonome. Sans mapping vérifié et accessible
  aux opérateurs du jour, le profil reste `verification_required` et aucun lot
  de production ne doit être préparé ;
- la proposition du mapping passe uniquement par
  `/manual/beneficiaries/propose`. Le navigateur transmet la clé publique
  `request_key`, jamais l'UUID du compte ni la devise. Une autorisation
  Finance/AAL2 à usage unique résout ces valeurs côté serveur et
  fournit au runtime Edge deux payloads canoniques ; l'Edge calcule une
  empreinte stable et une attestation liée au ticket avec une clé HMAC
  versionnée. Ni la clé, ni les HMAC, ni l'UUID bénéficiaire ne sont renvoyés
  par le read model Admin. Un second opérateur Finance distinct vérifie ou
  rejette ensuite le binding ;
- l'exposant monétaire utilisé à l'import vient exclusivement du contexte SQL
  Finance autoritaire ; il n'est jamais accepté depuis le fichier, le
  navigateur ou un autre paramètre client ;
- le relevé brut est traité en mémoire. Seuls la référence Norva, l'identifiant
  de transaction opaque, le montant, la devise, la date de valeur et les
  empreintes SHA-256 sont persistés ;
- l'import Edge exige un ticket Finance/AAL2 aléatoire à usage unique, valable
  cinq minutes. Seule son empreinte est persistée ; sa consommation atomique le
  lie au hash du relevé et interdit sa réutilisation ;
- deux acteurs Finance distincts réalisent la revue puis la décision finale ;
  l'acteur qui a enregistré la soumission du virement concerné ne peut pas
  prendre la décision finale, même si un autre acteur a terminé le lot.

Ordre d'activation du rail manuel :

1. appliquer les migrations, attribuer la capacité Finance et vérifier AAL2 ;
2. configurer les corridors autorisés avec
   `admin_partners_payout_route_set`, `provider=revolut` et
   `execution_adapter=revolut_manual` ; le wrapper historique
   `admin_partners_payout_provider_set` sélectionne toujours le mode manuel et
   ne doit pas servir à préparer une future bascule API ;
3. générer hors du dépôt une clé HMAC aléatoire d'au moins 32 octets, la placer
   uniquement dans
   `NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_KEYS_JSON` avec une version entière,
   puis créer ou vérifier chaque bénéficiaire dans Revolut. Enregistrer son
   mapping UUID opaque dans le registre Finance sécurisé, contrôler la
   destination masquée et archiver le SHA-256 de la preuve hors du dépôt ;
4. depuis l'Admin, proposer le binding via l'Edge. Un second opérateur Finance,
   connecté en AAL2, contrôle le registre et appelle
   `admin_partners_revolut_beneficiary_binding_verify`. Seule cette seconde
   action active le profil. Un rejet n'active rien. Une révocation commence par
   `REQUEST-REVOKE:<binding>` et place immédiatement le profil en
   `verification_required`, puis un second opérateur confirme avec
   `CONFIRM-REVOKE:<revocation>` ;
   si le partenaire doit être contacté, utiliser uniquement
   `admin_partners_payout_onboarding_contact` avec l'un des modèles serveur
   `secure_setup_invitation|setup_follow_up|reconfiguration_required`. Le ticket
   Support et l'outbox e-mail sont créés idempotemment. Aucun texte libre ni
   collecte de coordonnées bancaires/fiscales par e-mail n'est autorisé ;
5. rejouer capture, maturation J+45 et réconciliation shadow sans écart ;
6. depuis le compte Revolut Business Basic réel et dans sa langue configurée,
   exporter un relevé, vérifier que le parseur reconnaît sans ambiguïté son
   séparateur (virgule, point-virgule ou tabulation) et ses en-têtes, puis
   archiver la preuve et son SHA-256 hors du dépôt. Tout changement de colonnes
   doit échouer fermé et bloque la gate ;
7. faire approuver la gate `manual_payout_workflow_verified` et conserver la
   route manuelle active, la gate adaptateur, le flag DB et le kill switch Edge
   API dans leur état fail-closed ;
8. ouvrir `partners_payouts_live=true` uniquement pour la fenêtre supervisée
   de préparation, puis appeler
   `admin_partners_revolut_manual_batch_prepare` ;
9. saisir `EXPORT:<batch>`, justifier l'action puis appeler une seule fois
   `admin_partners_revolut_manual_batch_export`. La transaction SQL construit
   le TSV canonique en CRLF, calcule son SHA-256, fige le lot et journalise
   l'export avant de renvoyer les octets exacts. L'Admin recalcule le SHA-256
   sur ces octets UTF-8 avant le téléchargement. Les anciens RPC de lecture du
   payload puis de marquage séparé sont révoqués ;
10. pour chaque ligne, résoudre d'abord l'UUID opaque dans le registre Finance,
    vérifier la destination masquée, puis rechercher la référence Norva exacte
    dans Revolut. Si une transaction existe déjà, ne jamais la recréer. Sinon,
    contrôler bénéficiaire masqué, montant, devise et référence, puis saisir un
    seul virement. Dans les deux cas, inscrire uniquement `YES` dans
    `entered_in_revolut` après constat de la saisie ; une référence refusée ou
    altérée interdit l'enregistrement de cette ligne ;
11. transmettre uniquement les objets `{reference}` des lignes marquées `YES`
    à `admin_partners_revolut_manual_batch_mark_submitted`. Le lot passe alors
    à `partially_submitted`. Aucun identifiant bancaire n'est accepté par ce
    RPC. Pour reprendre, saisir
    `ACCESS-EXPORT:<batch>` et justifier l'accès. Le serveur renvoie séparément
    le TSV canonique immuable et un rapport de progression sans jeton
    bénéficiaire, avec les colonnes `norva_reference`, `entered_in_revolut`,
    `statement_matched`, `state` et `reconciliation_status` ; chacun possède son
    propre SHA-256 audité. Ne jamais fusionner, normaliser ou réécrire ces deux
    artefacts dans l'Admin. Reporter seulement les `YES` déjà constatés dans une
    nouvelle copie de travail du TSV canonique, puis répéter jusqu'au statut
    `submitted` et refermer `partners_payouts_live=false` ;
12. exporter le relevé officiel Revolut couvrant exactement la période et la
    devise, puis l'importer uniquement par l'endpoint Edge
    `/manual/statements`. Celui-ci obtient les exposants depuis le contexte SQL
    autoritaire avant de normaliser le fichier en mémoire, émet alors un ticket
    à usage unique et le consomme dans la même opération d'import ;
13. un premier acteur appelle
    `admin_partners_revolut_reconciliation_review` et compare dans Revolut la
    référence, le montant, la devise et la destination masquée. Un second acteur,
    distinct du premier et de l’auteur de la soumission du virement, confirme ou met en
    quarantaine avec `admin_partners_revolut_reconciliation_decide`.
14. traiter tout écart depuis la file append-only
    `admin_partners_revolut_reconciliation_incidents`. Le premier acteur
    Finance/AAL2 choisit `settle_exact`, `remap_exact_and_settle`,
    `release_after_return` ou `quarantine` via
    `admin_partners_revolut_reconciliation_incident_review`, avec recherche
    Revolut fraîche et SHA-256 de preuve. Un second acteur Finance/AAL2 distinct
    refait une recherche plus récente avec une preuve différente, puis appelle
    `admin_partners_revolut_reconciliation_incident_decide`. Aucun ajustement
    partiel ou de change n'est autorisé. Une référence inconnue ne peut être
    remappée que vers une exécution exacte et non résolue.
15. `release_after_return` n'est proposé et accepté qu'après une observation
    terminale append-only indépendante (`FAILED`, `CANCELLED` ou `REVERTED`)
    portant la même référence, la même identité de transaction, le même montant
    et la même devise, puis après le délai de sûreté. Un simple délai écoulé
    n'autorise jamais une libération.
16. pour un état terminal `FAILED`, `CANCELLED` ou `REVERTED`, traiter la file
    `admin_partners_revolut_return_queue`. Un premier acteur qualifie la preuve
    avec `admin_partners_revolut_return_review`; un second acteur, distinct du
    reviewer et de l’auteur de la soumission du virement, appelle
    `admin_partners_revolut_return_decide`. Une décision confirmée libère le
    clearing avant règlement ou crée une contre-écriture après règlement. Une
    décision en quarantaine ne déplace aucune somme.
17. un lot jamais saisi ne peut être annulé, et les lignes jamais saisies d'un
    lot partiel ne peuvent être libérées, qu'après la fenêtre de sûreté de sept
    jours suivant l'export. Un premier opérateur recherche toutes les
    références exactes dans Revolut, conserve la preuve hors de Norva et
    transmet seulement son SHA-256 et l'horodatage. Un second opérateur Finance
    distinct refait une recherche plus récente avec une preuve différente,
    puis confirme depuis `admin_partners_revolut_manual_controls_queue`. Toute
    demande pendante gèle export et soumission du lot. Si une preuve de
    transaction rend la demande obsolète ou si son périmètre n'est plus sûr, le
    second opérateur la termine sans mouvement de fonds avec
    `REJECT-CONTROL:<control>` via
    `admin_partners_revolut_manual_control_reject` ;
18. si un `COMPLETED` est observé après une libération, ou si une seconde
    transaction `COMPLETED` apparaît pour la même réalité économique, traiter
    `admin_partners_revolut_late_completion_queue`. Tous les profils payout du
    compte restent gelés. Un premier opérateur appelle
    `admin_partners_revolut_late_completion_review`, puis un second opérateur,
    distinct du reviewer et du checker qui avait libéré les fonds, appelle
    `admin_partners_revolut_late_completion_decide`. Une confirmation crée une
    écriture append-only `payout_late_settlement`, débite d'abord le disponible
    puis porte le reliquat en `partner_recovery_due` ; aucune écriture passée
    n'est réécrite. La clôture du compte reste bloquée tant qu'un incident,
    une récupération, un lot ou un job financier n'est pas terminal.

Une ligne absente, dupliquée, d'une autre devise, d'un autre montant ou liée à
une référence inconnue reste en exception. Aucun règlement n'est inscrit dans
le ledger avant la décision `confirmed`. Le fichier bancaire brut, les lignes
sans référence Norva, l'IBAN, le nom du bénéficiaire et les libellés libres ne
sont ni journalisés ni conservés. Le hash du fichier, les compteurs et la
preuve de complétude sont archivés dans le journal de release.

### Matrice mondiale candidate sous Revolut Basic

USD est la devise commerciale et le seuil mondial de référence est de
`10,00 USD` (`1000` unités mineures). Ce choix ne remplace pas les devises
transactionnelles ou de règlement : EUR/SEPA reste nécessaire et les achats
Google Play restent dans leur devise autoritative. Pour une devise de règlement
autre que USD, Finance fige un seuil équivalent dans la version de programme ;
aucun lot ne calcule un taux FX à la volée.

Les statuts opérationnels sont stricts :

| Statut | Sens |
|---|---|
| `candidate_disabled` | Devise/destination documentée ou plausible, mais aucune promesse de disponibilité. Route fermée jusqu'à validation juridique/KYC/fiscale, contrôle dans le compte Revolut Norva et premier virement supervisé rapproché. |
| `unsupported_provider` | Destination explicitement refusée par Revolut ou devise de destination absente. Aucun bénéficiaire, profil ou lot ne doit être activé. |
| `active` | Autorisé uniquement après bénéficiaire réel validé, frais/charge bearer contrôlés, virement supervisé `COMPLETED`, relevé exact, rapprochement maker-checker et preuve de release. |

Tous les groupes ci-dessous commencent en `candidate_disabled`. La liste
officielle des devises d'envoi ne garantit pas qu'un couple pays/devise précis
sera proposé au compte Norva ; l'interface Revolut réelle reste l'autorité pour
le pilote manuel.

| Destination candidate | Devise(s) de règlement candidate(s) | Note de validation obligatoire |
|---|---|---|
| UE/EEE éligible SEPA | EUR | Conserver EUR/SEPA même si USD est la référence commerciale ; vérifier IBAN, éligibilité SEPA et frais dans le compte réel. |
| États-Unis | USD | Tester ACH et, si proposé, FedWire séparément ; ne pas confondre disponibilité de USD et rail domestique. |
| Canada | CAD | Vérifier champs bénéficiaire, rail et frais réels. |
| Royaume-Uni | GBP | Vérifier compte local ou transfert international selon le bénéficiaire. |
| Suisse | CHF | Vérifier rail local/international et charge bearer. |
| Australie / Nouvelle-Zélande | AUD / NZD | Un micro-virement supervisé distinct est requis par pays/devise. |
| Danemark / Norvège / Suède | DKK / NOK / SEK | Conserver EUR comme autre candidat uniquement si le bénéficiaire et Revolut le proposent explicitement. |
| Tchéquie / Hongrie / Pologne / Roumanie | CZK / HUF / PLN / RON | Ne pas substituer automatiquement EUR à la devise locale. |
| Japon | JPY | Exposant 0 à confirmer dans les métadonnées Finance avant tout lot. |
| Hong Kong / Singapour | HKD / SGD | Valider séparément destination, champs et frais. |
| Chine / Inde | CNY / INR | CNY uniquement vers la Chine et INR uniquement vers l'Inde selon la documentation Revolut ; contrôle réel obligatoire. |
| Indonésie / Corée du Sud / Sri Lanka / Malaisie / Népal / Philippines / Thaïlande / Vietnam | IDR / KRW / LKR / MYR / NPR / PHP / THB / VND | Chaque devise est limitée à sa destination documentée ; vérifier exposant, champs locaux et réception nette. |
| Brésil / Chili / Colombie / Mexique | BRL / CLP / COP / MXN | BRL, CLP et COP sont limités à leur pays documenté ; valider MXN et le rail réel séparément. |
| Émirats arabes unis / Israël / Arabie saoudite | AED / ILS / SAR | Contrôles sanctions, bénéficiaire, motif et charge bearer obligatoires. |
| Turquie / Afrique du Sud | TRY / ZAR | Vérifier disponibilité du corridor et frais dans le compte réel. |
| Maroc | USD ou EUR, uniquement si proposés au bénéficiaire réel | MAD n'est pas une devise d'envoi documentée. Le pays n'est pas présenté comme garanti ; aucun corridor avant quote et micro-virement réels. |

Les destinations suivantes sont marquées `unsupported_provider` tant qu'elles
figurent dans la liste de destinations non prises en charge par Revolut :
Afghanistan, Algérie, Angola, Biélorussie, Burkina Faso, Burundi, Cambodge,
République centrafricaine, Congo, République démocratique du Congo, Cuba, Côte
d'Ivoire, Égypte, Érythrée, Guinée, Guinée-Bissau, Guyana, Haïti, Iran, Irak,
Corée du Nord, Laos, Liban, Libye, Myanmar, Nigeria, Panama, Russie, Sierra Leone,
Somalie, Soudan du Sud, Soudan, Eswatini, Syrie, Tunisie, Trinité-et-Tobago,
Ouganda, Vanuatu, Venezuela, Yémen et Zimbabwe, ainsi que les territoires
palestiniens occupés et les régions ukrainiennes explicitement exclues par le
provider. Cette liste doit être relue avant chaque release ; une évolution
provider n'active jamais automatiquement une route.

Norva absorbe les frais de transfert facturés par le provider ou la banque
émettrice pour un corridor pris en charge. En manuel, Finance choisit `OUR` ou
l'équivalent débiteur lorsque disponible. Un transfert `SHA`, une retenue
intermédiaire ou un montant reçu inférieur à l'attendu reste non rapproché et ne
permet pas de promouvoir le corridor en `active` tant que Norva n'a pas corrigé
le versement.

Références officielles à revérifier au moment de l'activation :
[pays et devises pris en charge](https://help.revolut.com/fr-FR/business/help/receiving-payments/sending-money-to-an-external-bank-account/where-can-i-transfer-money/),
[frais des virements Business](https://help.revolut.com/fr-FR/help/receiving-payments/sending-money-to-an-external-bank-account/transfer-fee/business/),
[frais SWIFT et charge bearer](https://help.revolut.com/fr-FR/business/help/receiving-payments/sending-money-to-an-external-bank-account/question-fees-swift-transfers/) et
[grille Business Basic France](https://www.revolut.com/fr-FR/legal/business-basic-fees/).

### Revolut Business API : adaptateur dormant

`revolut_api` est implémenté pour une évolution ultérieure de plan, mais reste
impossible sous Basic. Il exige simultanément :

1. une route `provider=revolut`,
   `execution_adapter=revolut_api` ;
2. la gate DB `revolut_api_adapter_verified` ;
3. le flag DB `partners_revolut_api_enabled=true` ;
4. le kill switch Edge
   `NORVA_PARTNERS_REVOLUT_API_ENABLED=true` ;
5. les identifiants Business API dédiés et l'allowlist de comptes sources.

Le rail ne réutilise jamais `REVOLUT_SECRET_KEY`, un access token statique ni
les secrets de la Merchant API d'encaissement. L'authentification Business
utilise un JWT client RS256 et un refresh OAuth à la demande. Les secrets
`REVOLUT_BUSINESS_CLIENT_ID`, `REVOLUT_BUSINESS_ISSUER`,
`REVOLUT_BUSINESS_PRIVATE_KEY_PEM`, `REVOLUT_BUSINESS_REFRESH_TOKEN` et
`REVOLUT_BUSINESS_SOURCE_ACCOUNTS_JSON`, ainsi que le plafond
`REVOLUT_BUSINESS_MAX_FEE_MINOR_JSON`, restent absents en `revolut_manual`.
Avant toute activation future, le worker API doit quitter le runtime Edge
mutualisé : service dédié, secrets dédiés, sortie réseau limitée aux hôtes
Business Revolut officiels et politique IP validée dans Revolut. La présence
des secrets dans le runtime générique ne constitue jamais une preuve de gate et
reste interdite sous Basic.

Le worker ne prend qu'un paiement à la fois. Son lease d'item vaut 240 secondes
par défaut et le lease global fenced vaut 300 secondes ; ce dernier est
renouvelé avant et après chaque échange avec Revolut, puis avant
l'observation ou le retry SQL. `REVOLUT_BUSINESS_ENVIRONMENT` n'a aucun défaut
implicite dans le runtime : une activation sans `sandbox` ou `production`
explicite échoue fermée.

Le client API protège aussi le montant net : lorsqu'un corridor expose
`charge_bearer`, l'option `debtor` doit être disponible et est imposée au quote
comme au paiement ; sinon le corridor est refusé. Le quote doit attester le
montant, la devise, les frais et le total exacts. Finance doit définir
`REVOLUT_BUSINESS_MAX_FEE_MINOR_JSON` par devise avant d'approuver la gate
`revolut_api_adapter_verified` ; un plafond absent ou dépassé échoue fermé.
L'implémentation n'invente aucune valeur.

Une transaction `COMPLETED` reste sondée toutes les six heures, après les
paiements non terminaux, tant que son rapprochement Finance est en attente et
pendant au plus 90 jours après la première observation payée. Après
confirmation ou au terme de cette fenêtre, les imports périodiques du relevé
officiel deviennent l'autorité pour détecter un retour tardif `REVERTED`. Un
timeout, un dead-letter ou une indisponibilité provider ne libèrent jamais
automatiquement l'allocation : seule une preuve provider terminale et
rapprochée peut déclencher la libération ou la contre-écriture append-only.

Une future activation nécessite un change-control séparé et un upgrade
explicite du plan Revolut. Le sandbox valide l'authentification, l'idempotence,
le quote, la création, les observations canoniques et les transitions simulées
que Revolut y expose, mais ne constitue pas une preuve de paiement de bout en
bout : `/pay/fields` n'y est pas disponible et aucun argent réel n'est déplacé.
Le runner isolé `npm run partners:revolut:sandbox-smoke` peut contourner
uniquement cette absence avec
`REVOLUT_BUSINESS_SANDBOX_SKIP_TRANSFER_FIELDS=true`. Le chargeur refuse cette
valeur en production et Docker Compose ne la transmet pas aux fonctions Edge.
Les identifiants proviennent exclusivement du compte Sandbox séparé et le
runner ne publie que des empreintes tronquées.

Préparer d'abord le bootstrap à partir de
`ops/partners/revolut-business-sandbox-bootstrap.env.example`, dans un dossier
ACL protégé hors Git. Le code OAuth à durée de vie courte reste dans un fichier
séparé. `npm run partners:revolut:sandbox-bootstrap -- --config <fichier>`
échange ce code, sélectionne un compte Sandbox déterministe, crée ou retrouve
le bénéficiaire de test et produit atomiquement le fichier d'exécution protégé.
Ce fichier peut contenir un access token éphémère afin que le smoke test
s'exécute immédiatement sans second échange OAuth ; l'adaptateur de production
continue d'exiger son refresh token et ce mécanisme n'est jamais injecté dans
Docker Compose. Exécuter ensuite
`npm run partners:revolut:sandbox-smoke -- --config <fichier généré>`, puis
détruire ou archiver sous ACL les artefacts expirés. Ne jamais y copier les clés
Merchant API ni les identifiants du compte Revolut Business réel. Les actions
simulées autorisées sont `complete`, `revert`, `decline` et `fail` ; chaque
action est suivie d'une lecture canonique de la transaction et doit aboutir à
l'état attendu.

Avant la gate API, Finance réalise donc encore un micro-virement supervisé en
production, vérifie `/pay/fields`, le quote, la transaction canonique puis son
rapprochement exact. Activer un seul des deux verrous ne lance aucun job. Pour
un rollback, passer d'abord le kill switch Edge à `false`, puis le flag DB à
`false`, remettre les corridors en `revolut_manual` et traiter les jobs ambigus
en revue manuelle.

Sous Basic, aucun job `pg_cron` et aucun script d'enregistrement ne cible
`norva-partners-revolut-payout/cron/run`. Le contrôle de parité exige zéro job
nommé `norva-partners-revolut-api`. Le script de planification ne sera livré
que dans le change-control d'upgrade, après tests sandbox disponibles,
micro-virement production rapproché, plafond de frais, secrets Business API,
route dédiée, gate adaptateur, flag DB et kill switch Edge ; il ne doit pas
être préinstallé « inactif »
pendant le pilote manuel.

La gate API reste obligatoirement fausse tant que les dead letters ne disposent
pas d'une résolution Finance maker-checker qui libère ou remet en file le
clearing sans ambiguïté, et tant qu'une même réalité provider reçue par polling,
webhook puis relevé ne se regroupe pas en un incident sémantique unique tout en
conservant ses preuves sources append-only. Ces exigences n'affectent pas le
rail `revolut_manual` Basic, mais bloquent toute activation de `revolut_api`.

Le workflow Didit doit être un workflow KYC individuel. Aucun module KYB ne doit
être présent. Pour préserver le retour Web et Android App Link, configurer
exactement `DIDIT_CALLBACK_URL=https://norva.tv/partners-kyc-return`, sans query
string ni fragment. Didit ajoute ses paramètres de session et statut à cette
URL : la Pages Function dédiée les ignore sans les lire, journaliser, stocker
ou refléter, puis répond `303` vers `/app.html#partners` sur navigateur Web et
vers `/app.html?mobile=1#partners` uniquement pour le client Android Norva. La
réponse conserve `Cache-Control: private, no-store` et
`Referrer-Policy: no-referrer`. Le Service
Worker ne met jamais en cache cet endpoint ni une requête portant les
paramètres Didit sensibles. Le chargeur de configuration compare cette URL
canonique octet pour octet et reste `not_configured` pour toute autre valeur.
`DIDIT_SESSION_EXPIRATION_SECONDS` doit être un entier canonique compris entre
`3600` et `2419200` ; la valeur recommandée est `604800` (7 jours). Elle doit
être exactement égale au `session_expiration_time` du workflow Didit publié.
Cette durée fait partie du `config_fingerprint_sha256` : toute modification
requiert le même change-control que la version et les nœuds du workflow, avec
publication coordonnée du workflow et de la configuration runtime puis nouvelle
preuve de fingerprint. Un écart reste mis en quarantaine et n'active jamais un
compte.
Le webhook HTTPS lit le corps brut et vérifie la signature avant tout parsing ou
accès DB. Après toute rotation du secret webhook, un ancien secret doit devenir
invalide et un événement test signé doit être rejoué.
Didit renouvelle le timestamp de transport et la signature à chaque tentative :
l'idempotence conserve donc une empreinte canonique de tout le contenu signé
hors ce seul timestamp de transport. L'identifiant de session, l'application,
l'environnement, le workflow/version, `created_at`, le statut et la décision
restent inclus ; toute divergence sur l'un de ces champs demeure un conflit.
Avant `pilot_ready`, calculer et archiver le `config_fingerprint_sha256` de la
configuration Didit non secrète réellement déployée, ainsi que son
`workflow_version`. La preuve live doit contenir ces deux valeurs exactes. Une
troisième preuve, indépendante des runs sandbox et live, doit rejouer la
non-autorité d'une décision sandbox puis un mismatch
environnement/fingerprint et constater sa quarantaine. Le journal de release
ne doit contenir ni API key, ni secret webhook, ni identifiant de session.

Capturer d'abord le snapshot live de configuration sans ouvrir un flag ou une
gate. Créer hors Git un dossier `0700`, fournir l'identifiant immuable du
déploiement et exécuter :

```bash
PARTNERS_EVIDENCE_OUTPUT_DIR=/home/adrien/norva-release-evidence/partners/<release_key>/didit/live-config \
PARTNERS_DEPLOYMENT_ID='<deployment-id-immuable>' \
  bash ops/hetzner/scripts/capture-norva-partners-didit-live-config-evidence.sh
```

Le script utilise seulement `docker inspect`, `git` en lecture et le `GET`
Management API du workflow. Il exige deux Edge healthy et identiques, KYC
publié, KYB/AML désactivés, callback et expiration exacts, puis écrit un JSON
sanitisé `0600`. Il échoue avant l'écriture au moindre écart et ne journalise
aucune variable secrète. Après rapatriement dans le coffre local :

```bash
node scripts/validate-partners-didit-live-config-evidence.js \
  <artefact-prive.json> \
  --expected-commit-sha=<sha-git-40-caracteres>
```

La sortie conserve explicitement `gate_eligible=false` tant que les trois
preuves de session sandbox, décision live et isolation/quarantaine ne sont pas
archivées séparément. Ne jamais activer temporairement la production pour
fabriquer ce snapshot de configuration.

### Certification Didit live avant la gate KYC

La certification pré-gate est un parcours opérateur exceptionnel, isolé des
comptes Partners. Elle ne crée ni compte, ni lien, ni attribution, ni
commission, ni paiement et ne modifie aucun flag ou release gate. Le navigateur
n'envoie aucun UUID utilisateur : la RPC relit exclusivement `auth.uid()` et
exige simultanément un Admin live, la capacité Risk, un facteur TOTP vérifié,
un JWT AAL2 émis depuis moins de dix minutes, `privacy_approved=true`,
`individual_verification_coverage_confirmed=false` et tous les chemins live
Partners fermés.

Avant une fenêtre supervisée, conserver
`NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED=false`. Après validation du snapshot
de configuration live :

1. recréer successivement `functions`, vérifier sa santé, puis `functions2`
   avec le kill switch à `true` ;
2. ouvrir Admin Partners > Risque/KYC avec l'opérateur Risk prévu, élever la
   session à AAL2 et confirmer explicitement l'usage de sa propre identité et
   biométrie ;
3. terminer la session hébergée dans les deux heures ; la décision signée du
   webhook fait seule foi ;
4. vérifier dans la carte Admin dédiée l'environnement, l'état, l'horodatage et
   l'éventuelle raison bornée ; le retour poll automatiquement pendant au plus
   60 secondes et la lecture reste autorisée après fermeture du kill switch ;
   si le premier POST a un résultat réseau inconnu, utiliser « Reprendre sur
   Didit » : la reprise serveur AAL2 réutilise la réservation et la même clé
   opaque sans conserver la justification ni aucun identifiant provider dans
   le navigateur. Le polling continue même si la première lecture est vide et
   la création reste indisponible pendant cette réconciliation ;
5. archiver une preuve sanitisée contenant uniquement hashes, fingerprint,
   version, environnement, états bornés, booléens et timestamps ; aucun ID
   Didit, document, date de naissance, nom ou pays détaillé ;
6. remettre immédiatement le kill switch à `false` et recréer sainement les
   deux réplicas Edge.

Une réponse sandbox, un workflow/fingerprint/environnement divergent, un replay
conflictuel, une liaison cross-purpose ou une décision reçue après l'expiration
locale est non autoritaire et ne peut jamais satisfaire la gate. Même une
décision live approuvée reste une preuve à corréler : elle ne promeut jamais
automatiquement `individual_verification_coverage_confirmed`.

Avant toute création ou reprise, l'Edge lit la liste Didit filtrée par
`vendor_data`, `workflow_id` et `session_kind=user`, avec `limit=2` et un corps
strictement borné. En `pending`, il ne recrée jamais de session : une RPC
`service_role` compare l'identifiant de l'unique session KYC active au hash
privé déjà enregistré avant de rendre l'URL.

En `reserved`, une session active déjà visible est liée directement après le
claim SQL et ne déclenche aucun `POST`. Si la liste est exactement vide, le
claim irréversible `provider_create_dispatched_at` est acquis sous verrou de
ligne ; seul `claimed=true` autorise l'unique `POST`. Un replica perdant sur
liste vide, plusieurs résultats, un marqueur KYB ou un état terminal impose
`409 request_in_progress`. Le webhook signé reste la vérité autoritaire et
met en quarantaine tout mismatch. Ce protocole garantit au plus un débit de
crédit Didit entre replicas, y compris après un timeout réseau. Ne jamais
copier, journaliser ou archiver le payload de liste Didit : il est immédiatement
réduit à l'URL hébergée, l'état public et l'expiration locale.

La liste Didit peut omettre `workflow_id` et `workflow_version`. L'Edge hérite
uniquement du filtre `workflow_id` exact lorsque le champ est absent, rejette
toute valeur présente divergente et lie cette certification à la version
attendue `1`. Confirmer avant la fenêtre que la version publiée est bien `1` ;
le webhook signé met toute autre version en quarantaine.

### Suppression durable des sessions Didit

Tout résultat terminal KYC (`approved`, `declined`, `expired` ou mis en
quarantaine) crée dans la même transaction une demande de suppression privée.
L'identifiant Didit brut n'est jamais écrit en clair : l'Edge l'enveloppe en
AES-256-GCM avec une clé versionnée, liée par AAD à son hash SHA-256. La réponse
publique expose uniquement `purge_pending`, `purged` ou
`purge_dead_letter`; elle ne contient ni identifiant provider, ni enveloppe, ni
erreur brute. Un compte individuel ne devient jamais `active` tant que la
session exacte vérifiée n'est pas `purged` avec `provider_purged_at`.

Avant le premier webhook terminal, les deux replicas Edge doivent contenir le
même keyring `NORVA_PARTNERS_DIDIT_PURGE_KEYS_JSON` et la même version active.
Pour une rotation, ajouter d'abord la nouvelle version aux deux replicas,
basculer ensuite la version active, puis conserver toutes les anciennes clés
tant qu'une ligne `pending|retry|leased|dead_letter` porte leur enveloppe. Une
clé ne peut être retirée qu'après une preuve SQL de zéro enveloppe concernée et
une sauvegarde restaurable ; ne jamais imprimer le keyring ou une enveloppe.

Le worker `norva-partners-didit-purge-worker` réclame des lots bornés avec un
lease SQL. `DELETE` Didit `204` signifie supprimé et `404` signifie déjà absent :
les deux sont des succès idempotents, effacent immédiatement l'enveloppe et
horodatent `purged_at`. Les timeouts, erreurs réseau, `408`, `425`, `429` et
`5xx` sont rejoués avec backoff exponentiel borné et `Retry-After`; une erreur
d'authentification/configuration ou douze échecs passent en dead-letter. Une
dead-letter bloque la certification et l'activation : elle n'est jamais
transformée en succès par un opérateur.

Pour une ancienne source terminale `purge_pending` dépourvue d'outbox, le même
worker peut réparer uniquement la liaison manquante. Chaque cycle lit au plus
cinq hashes Norva et quatre pages Didit de 25 sessions au total, filtre le
workflow, le statut et `session_kind=user`, puis compare les hashes uniquement
en mémoire Edge. Une correspondance exacte est immédiatement enveloppée en
AES-256-GCM et repasse par l'enqueue autoritaire avant le `DELETE`; l'identifiant
brut, la réponse Didit et les données d'identité ne sont ni journalisés ni
persistés. Une absence, une ambiguïté ou une erreur laisse la source en attente
pour le prochain cycle et ne fabrique jamais une preuve de suppression.

Après déploiement sain des deux replicas et vérification du keyring, exécuter
une fois `/norva-partners-didit-purge-worker/cron/run`, contrôler un heartbeat
frais, puis enregistrer uniquement :

```text
ops/hetzner/scripts/register-norva-partners-didit-purge-cron.sql
```

Le job doit être unique, actif et exécuté chaque minute. Le préflight exige
zéro outbox en `pending|retry|leased`, zéro dead-letter, zéro source terminale
non supprimée et un heartbeat terminé depuis moins de cinq minutes. En incident,
fermer la création KYC et le cash sans modifier `partners_enabled`, corriger la
clé ou l'authentification Didit, puis faire traiter la file sous supervision.
Pour une ligne déjà en dead-letter, ouvrir un incident Privacy/Security et
établir la suppression chez Didit avant toute action de remédiation en base ;
ne jamais modifier directement les tables privées ni fabriquer `purged_at`.

Le compte de service Google Play est dédié au backend, limité à la lecture des
commandes du package Norva et absent de tout client Android/Web. Les deux
variables Google absentes laissent l'enrichissement inactif et les faits
`incomplete`. Une seule variable présente, un JSON invalide ou un échec OAuth
est une mauvaise configuration visible à corriger, jamais un motif pour
reconstruire la taxe depuis RevenueCat.

La clé doit être créée comme compte de service distinct, puis invitée dans
Google Play Console avec les droits nécessaires aux API de facturation. La
procédure Google actuelle exige **Voir les données financières, les commandes
et les réponses à l'enquête d'annulation** ainsi que **Gérer les commandes et
les abonnements** ([configuration officielle de l'API](https://developers.google.com/android-publisher/getting_started),
[permissions Play Console](https://support.google.com/googleplay/android-developer/answer/10019561)).
Norva n'appelle pourtant que [`orders.get`](https://developers.google.com/android-publisher/api-ref/rest/v3/orders/get) ;
aucune route de remboursement ou d'annulation n'est implémentée par le worker
Partners.

Ne jamais coller la clé dans un terminal, un ticket ou le dépôt. Après avoir
téléchargé le JSON dans un dossier local protégé, l'installer depuis Windows :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "C:\chemin\vers\Norva repo\ops\hetzner\scripts\install-norva-google-play-orders-key.ps1" `
  -CredentialPath "C:\chemin\protege\norva-play-orders.json"
```

Le script valide le JSON localement et sur le serveur, sauvegarde puis remplace
atomiquement `.env`, recrée les deux replicas Edge l'un après l'autre, vérifie
leur parité, obtient un jeton OAuth Android Publisher et exige un `404` sur une
commande factice bien formée. Un `401` ou `403` provoque un rollback complet :
la clé ou les permissions Play Console ne sont alors pas prêtes.

La preuve shadow/TV est capturée hors du checkout avec :

```bash
install -d -m 700 /home/adrien/norva-release-evidence/partners/<release_key>/runtime
PARTNERS_EVIDENCE_OUTPUT_DIR=/home/adrien/norva-release-evidence/partners/<release_key>/runtime \
PARTNERS_DEPLOYMENT_ID='<deployment-id-immuable>' \
PARTNERS_EXPECTED_COMMIT_SHA='<sha-git-40-caracteres>' \
PARTNERS_TV_TEST_PROOF_SHA256='<sha256-sortie-tests-tv>' \
PARTNERS_TV_TEST_PROOF_URL='https://github.com/Admin-Adher/Norva/actions/runs/<run-id>' \
PARTNERS_TV_TEST_PROOF_COMMIT_SHA='<sha-git-40-caracteres>' \
  bash ops/hetzner/scripts/capture-norva-partners-shadow-tv-evidence.sh
```

Le rapport TV peut satisfaire `tv_relay_security_verified` lorsque les
contrats passent et que la production reste fermée pendant la revue. Le rapport
shadow refuse explicitement la gate tant qu'aucun fait financier réel n'a été
comparé : des milliers de passages à vide sans écart ne constituent pas une
certification économique.

Si Node.js est présent sur l'hôte, le script rejoue lui-même les tests. Sur
l'hôte Hetzner minimal, il exige à la place le hash, l'URL du run GitHub Actions
protégé et le SHA exact qu'il a testé ; une URL générique ou un autre commit est
refusé.

## 3. Ordre de déploiement

La baseline de production certifiée est le commit `eda071e`, avec déploiement,
base-backup et répétition physique `postdeploy` verts. Elle contient déjà les
quatre migrations de finalisation propriétaire, crédit multi-devise, fiscalité
Web et plafond de validité. Ne jamais les rejouer. La prochaine répétition
physique `predeploy` doit exiger ses 31 marqueurs présents et uniquement le
marqueur du correctif bootstrap absent :

1. `20260809090000_partners_bootstrap_nonmember_boolean.sql`.

Appliquer cette migration dans une seule fenêtre DB transactionnelle. Elle ne
modifie aucune donnée métier : elle rend seulement explicite le booléen JSON
`credit_readiness.ready=false` avant l'adhésion, au lieu de sérialiser `null` et
de faire rejeter le bootstrap par le contrat Edge. Rejouer ensuite pgTAP,
lint/Advisors et les invariants de restauration. Comme le code Edge ne change
pas, une recréation des replicas n'est pas requise pour ce correctif SQL ; la
parité et la santé des deux replicas restent toutefois contrôlées. Les gates et
flags actifs doivent ensuite être rattachés au manifeste du nouveau commit.
Didit, la fiscalité cash et les virements restent inertes pour tout compte hors
cohorte.

La preuve `postdeploy` doit restaurer un base-backup R2 capturé après cette
fenêtre, constater `migrations_applied=0`, `migration_replay_skipped=true`, les
marqueurs attendus présents, puis rejouer le vérificateur et les pgTAP sans
mutation. Enregistrer le cron de purge seulement après un webhook terminal
contrôlé, une suppression Didit `204|404`, un heartbeat frais et zéro
dead-letter.

1. sauvegarde logique et contrôle de restauration ;
2. fenêtre DB transactionnelle unique pour
   `20260809090000_partners_bootstrap_nonmember_boolean.sql`, puis pgTAP,
   lint/Advisors et postcondition du booléen non-membre ;
3. écrire explicitement `NORVA_PARTNERS_ACCESS_REQUESTS_ENABLED=false` dans
   l'environnement Hetzner avant de déployer l'Edge ;
4. déployer/recréer d'abord le service `functions`, attendre sa santé, puis
   `functions2`, avec le même keyring de suppression Didit et les contrats V2 ;
   l'adhésion/referral/crédit et le cash restent encore fermés par leurs gates
   et flags respectifs ;
5. Web, Android et TV déployés avec états `not_configured` ; vérifier que tout
   compte Cloud Web/mobile, Admin inclus, voit l'entrée utilisateur Partners ;
6. avec le kill switch à `false`, vérifier que `GET /access-request` retourne
   toujours l'état existant et que le POST retourne exactement
   `503 partners_access_requests_disabled`, sans mutation ;
7. en base jetable puis sur la restauration isolée, valider le replay exact, le
   cooldown 60 secondes, la neuvième nouvelle clé sur 24 heures, le
   `429 rate_limited` avec `Retry-After: 60` et la rétention d'idempotence
   30 jours ;
8. passer le kill switch à `true`, recréer successivement `functions` puis
   `functions2` avec contrôle de santé après chacun, puis exécuter un POST
   contrôlé et son replay exact ;
9. vérifier la file Admin avec Support|Risk, puis une décision sandbox
   Risk+AAL2 et confirmer qu'elle ajoute seulement l'allowlist ;
10. webhook Didit enregistré, secrets de signature et de purge injectés,
    événement de test validé, worker de suppression et heartbeat vérifiés ;
    cette étape certifie uniquement le futur parcours cash ;
11. un programme versionné et le catalogue d'accès Norva sont insérés ; une
    policy de juridiction payout est ajoutée seulement pour les pays cash ;
12. comptes pilotes ajoutés à l'allowlist par décision auditée ou contrôle Admin
   équivalent ;
13. après approbation auditée de `membership_privacy_approved`,
   `partners_enabled=true`, `partners_invite_only=false`,
   `partners_cash_pilot_allowlist_only=true`,
   `partners_earnings_enabled=true` après preuve financière,
   `partners_credit_redemptions_enabled=true` après preuve catalogue,
   `partners_shadow_mode=true`, `partners_tv_relay_enabled=true`,
   `partners_payouts_live=false`,
   `partners_revolut_api_enabled=false` et kill switch Edge API à `false` ;
14. calcul shadow comparé au ledger financier pendant au moins un cycle complet ;
15. deux cycles de versement supervisés avant toute extension.

Avant de déclarer `pilot_ready`, archiver également :

- le replay `/r/{code}` depuis l'AAB installé par Google Play ;
- un snapshot DB sanitisé couvrant programme, policies, devises, routes payout,
  volume allowlist, flags et release gates ;
- un export de lot Revolut manuel puis l'import du relevé officiel, avec
  références Norva, montants et devises exactement rapprochés et preuve de
  complétude ; la preuve inclut un export réel du compte Basic dans sa langue
  configurée, les en-têtes et le séparateur reconnus, sans conserver les
  données bancaires brutes dans le dépôt ;
- les références strictes URL/run/SHA-256 décrites dans
  `NORVA-PARTNERS-RELEASE-EVIDENCE.md`.
- une session Didit sandbox complète puis une session live contrôlée, avec deux
  preuves indépendantes, le fingerprint/config et la version du workflow
  déployé ; une simple preuve sandbox ne permet jamais le pilote ;
- une troisième preuve indépendante rejouant la non-autorité sandbox et la
  quarantaine d'un conflit environnement/fingerprint ;
- le SHA Git candidat, l'identifiant du déploiement correspondant et la
  validation manuelle du workflow protégé **Partners Release** par les
  reviewers requis.

La cohorte 20–50 appartient au journal de release. La DB conserve
volontairement une précondition technique minimale `>= 1` afin que le dogfood
fail-closed reste possible avant le pilote.

Le webhook Revolut doit inclure `ORDER_COMPLETED`, `DISPUTE_LOST` et
`DISPUTE_WON`.
`DISPUTE_ACTION_REQUIRED`/`DISPUTE_UNDER_REVIEW` sont non économiques.
`DISPUTE_WON` produit uniquement une contre-correction append-only reliée au
chargeback exact. Le timestamp provider est obligatoire, l'ordre inversé reste
rejouable et toute divergence de lineage passe en conflit/dead-letter.

Une migration ne doit jamais seeder une juridiction comme « live ». La
configuration de production est une action Admin auditée avec motif.

### Enregistrement manuel du worker financier

Après déploiement et smoke test de `/norva-partners-worker/cron/run`, enregistrer
la cible réelle avec le secret cron déjà présent dans Vault. Le script
reproductible est
`ops/hetzner/scripts/register-norva-partners-cron.sql` ; son contenu
autoritatif équivaut à :

```sql
select cron.schedule(
  'norva-partners-worker',
  '*/5 * * * *',
  $$
    select net.http_post(
      url := 'https://api.norva.tv/functions/v1/norva-partners-worker/cron/run',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'norva_cron_shared_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);
```

Confirmer qu'un seul job porte ce nom et vérifier les compteurs
leased/succeeded/retry/dead-letter ainsi que la réconciliation shadow. Ne
jamais inscrire cette cible par migration.

## 4. Smoke tests

### Préflight payout pilote : corridor explicite, sans activation

Ce préflight autorise seulement la couche de virement cash ; son échec ne doit
jamais désactiver une adhésion, un lien, une attribution, une maturation ou un
crédit d'accès déjà autorisés par leurs propres gates. Il ne choisit jamais un
pays, une devise, un exposant monétaire, un
seuil local, un âge minimum, un environnement ou un commit candidat à la place
de l'opérateur. Ces huit valeurs sont
obligatoires à chaque exécution :

```bash
cd /home/adrien/norva
export NORVA_PARTNERS_PILOT_COUNTRY='<ISO2>'
export NORVA_PARTNERS_PILOT_COUNTRY_ISO3='<ISO3>'
export NORVA_PARTNERS_PILOT_CURRENCY='<ISO4217>'
export NORVA_PARTNERS_PILOT_CURRENCY_EXPONENT='<0-6>'
export NORVA_PARTNERS_PILOT_THRESHOLD_MINOR='<minor-units>'
export NORVA_PARTNERS_PILOT_MINIMUM_AGE='<18-99>'
export NORVA_PARTNERS_DEPLOYMENT_ENVIRONMENT='preproduction'
export NORVA_PARTNERS_CANDIDATE_COMMIT_SHA='<40-or-64-char-lowercase-sha>'
bash ops/hetzner/scripts/check-norva-partners-pilot-preactivation.sh
```

Les placeholders échouent volontairement. Pour un corridor payé en USD, le
contrat impose `PILOT_CURRENCY=USD`, exposant `2` et seuil `1000`. Pour toute
autre devise de règlement, le seuil local doit être décidé et figé
explicitement ; aucune conversion USD implicite n'est autorisée.

#### Lot FX ultérieur — hors P0 et sans promesse de disponibilité

Le crédit d'accès P0 consomme uniquement un solde `USD` au quote autoritatif :
Norva Plus vaut `499` unités mineures et Norva Family `899`. Tout solde dans une
autre devise reste affiché séparément dans sa devise d'origine, n'est jamais
présenté comme zéro et ne déclenche ni conversion ni KYC. Un futur lot FX ne
pourra être cadré qu'avec source de taux autoritative, timestamp, règles
d'arrondi/exposant, traitement fiscal/comptable, disclosure versionnée,
contre-écritures et tests de réconciliation. Ce runbook ne promet ni pays, ni
devise, ni date pour ce lot.

Le script inspecte en mémoire les deux conteneurs Edge sans afficher les
secrets, puis exécute une transaction PostgreSQL `READ ONLY`. Tout manque
devient un bloqueur nommé et la commande termine avec un code non nul. Elle ne
source pas `ops/hetzner/.env`, ne change aucun flag ou gate, n'active aucune
route et ne planifie aucun cron.

Ce préflight cash s'exécute après la mise en service des couches publiques
d'adhésion, d'attribution et de crédit, et juste avant la promotion finale de
la couche cash. L'état sûr attendu est :

- `partners_enabled=true`, `partners_earnings_enabled=true` et
  `partners_credit_redemptions_enabled=true`; `partners_tv_relay_enabled=false` ;
  ces quatre états sont vérifiés et archivés, mais jamais modifiés par ce
  préflight payout ;
- `partners_invite_only=false`,
  `partners_cash_pilot_allowlist_only=true`, `partners_shadow_mode=true` ;
- `partners_payouts_live=false`, `partners_revolut_api_enabled=false` et
  `NORVA_PARTNERS_REVOLUT_API_ENABLED=false` sur les deux réplicas ;
- aucune credential Revolut Business API et aucun cron payout/API ;
- exactement un programme individuel actif à 20 %, attribution 30 jours,
  maturation J+45, frais absorbés par Norva, référence commerciale immuable
  `USD=1000` et seuil exact pour la devise pilote fournie ;
- exactement une policy nationale disponible pour le pays fourni, son mapping
  ISO3 vers ISO2, KYC Didit individuel, métadonnée monétaire active et unique
  route `revolut_manual` active pour le couple pays/devise fourni ;
- 20 à 50 comptes confirmés, tous explicitement allowlistés pour ce pays ;
- deux opérateurs Finance Admin distincts avec TOTP vérifié pour le
  maker-checker et au moins un release manager Admin avec TOTP vérifié ;
- les workers commission, correction, maturation, réconciliation et
  RevenueCat TRANSFER sains et frais, avec exactement un cron Partners et un
  cron RevenueCat TRANSFER.

Le brouillon historique ne doit pas être édité ni réinterprété. Si son objet
`payout_thresholds` ne contient pas la devise sélectionnée et son seuil exact,
créer via l'Admin/AAL2 une nouvelle version, puis l'activer par la RPC auditée.

Ordre de configuration, exclusivement depuis les RPC/contrôles Admin audités :

1. provisionner un release manager côté serveur et deux opérateurs Finance
   Admin distincts ; chacun enrôle puis vérifie son TOTP, sans partager de
   session ;
2. créer la nouvelle version en `draft` avec `admin_partners_program_create`,
   enregistrer devises et mapping pays, puis créer la policy nationale encore
   indisponible et sa policy de tentatives Didit ;
3. enregistrer le commit, l'environnement et les hashes des preuves réellement
   déployées avec `admin_partners_deployment_manifest_register` en AAL2 ;
4. faire approuver `legal_and_tax_approved`; archiver la notice, le ROPA et la
   revue de minimisation de l'adhésion, puis activer
   `membership_privacy_approved` sous Risk/AAL2 ; terminer séparément l'AIPD
   cash Didit et activer `privacy_approved` sous Risk/AAL2, avec l'empreinte
   distincte du consentement biométrique ;
5. activer cette version avec `admin_partners_program_activate` ;
6. après les tests maker-checker/réconciliation externes, satisfaire
   `manual_payout_workflow_verified` et enregistrer uniquement la route
   `revolut / revolut_manual / <ISO2> / <ISO4217> / active` avec
   `admin_partners_payout_route_set` ;
7. rendre cette policy payout disponible avec
   `admin_partners_country_policy_set_available`; traiter séparément 20 à 50
   demandes d'accès cash par la décision Risk+AAL2. L'allowlist contrôle
   uniquement le cash, jamais l'adhésion, et ne constitue pas un résultat KYC ;
8. lever les autres gates uniquement avec leur preuve, conserver
   `partners_invite_only=false` et
   `partners_cash_pilot_allowlist_only=true`, puis activer d'abord
   `partners_enabled=true`, ensuite `partners_earnings_enabled=true`, puis
   `partners_credit_redemptions_enabled=true` et enfin
   `partners_shadow_mode=true`. Enregistrer le cron RevenueCat TRANSFER et
   attendre les cinq heartbeats frais ;
9. exécuter le préflight avec le corridor explicite. Ne promouvoir ni
   `partners_payouts_live` ni cette route cash tant qu'une seule ligne reste en
   `FAIL`; un échec payout ne rabaisse pas les flags sans KYC.

Ce contrôle ne crée aucune preuve fournisseur. Avant que le pilote puisse être
déclaré prêt, l'opérateur doit encore fournir et archiver hors Git :

1. l'approbation juridique et fiscale écrite pour la juridiction sélectionnée,
   les versions et hashes des documents publics ;
2. l'évaluation Membership Privacy visée avec notice, ROPA et minimisation,
   puis l'auto-évaluation Cash Privacy et l'AIPD immuables limitées au pilote
   Didit France allowlist-only, avec analyse documentée de l'obligation DPO,
   risques et déclencheurs de réévaluation ;
3. les trois preuves Didit distinctes (sandbox non autoritaire, live lié au
   fingerprint/version, conflit mis en quarantaine) ;
4. un App Link signé par Google Play rejoué depuis l'AAB publié ;
5. l'identifiant exact de chaque application RevenueCat autorisée, une clé API
   secrète serveur permettant le re-fetch TRANSFER et la preuve du webhook
   HMAC ;
6. un compte de service Google Play dédié, autorisé côté Play Console pour la
   lecture autoritative des commandes du seul package `tv.norva.phone` ;
7. la preuve maker-checker du registre bénéficiaire, de la révocation, du lot
   manuel Revolut, du relevé et du rapprochement sans secret ni identité
   bancaire dans le journal ;
8. le restore drill, les Advisors, le snapshot DB sanitisé, le run CI vert et
   le journal privé `pilot_ready` validé dans l'environnement GitHub protégé
   **Partners Release**.

L'ordre de promotion de l'étape 8 est impératif : le contrôle audité exige
`partners_enabled=true` avant `partners_earnings_enabled=true` et
`partners_credit_redemptions_enabled=true`. Le relais TV reste un flag distinct.
Si une validation de couche échoue, rabaisser
uniquement son flag et les dépendances aval ; ne jamais utiliser un échec Didit,
fiscal ou corridor pour fermer l'adhésion ou le crédit d'accès.

Pendant tout le pilote, `partners_invite_only=false` et
`partners_cash_pilot_allowlist_only=true`; le flag et le kill switch Revolut API
restent faux. L'état de repos conserve
`partners_shadow_mode=true` et `partners_payouts_live=false`. Une fenêtre de lot
manuel supervisée suit le cycle dédié du chapitre 8 : elle ne change
`partners_payouts_live` que le temps strictement nécessaire, avec maker-checker
et retour immédiat à `false`. Aucun versement n'est déclenché par le préflight.

### Membre Web/Android

- entrée utilisateur Partners visible pour tout compte Cloud authentifié,
  compte Admin inclus, avec les flags et gates fermés ;
- `GET /access-request` avec `request.exists=false` : forme exacte, aucun effet
  de bord ;
- `POST /access-request` pendant la fermeture du programme, avec son kill switch
  de collecte à `true` : demande `requested`, `next_action=await_review`, replay
  idempotent et aucune création de compte/KYC/lien/ledger ;
- kill switch de collecte à `false` : GET inchangé, POST en
  `503 partners_access_requests_disabled`, aucune perte d'état ;
- même clé/body rejoués immédiatement sans quota supplémentaire ; deux nouvelles
  clés à moins de 60 secondes puis neuf nouvelles clés sur 24 heures produisent
  `429 rate_limited` et exposent `Retry-After: 60` ;
- une clé âgée de plus de 30 jours devient purgeable sans supprimer la demande
  ni son audit ;
- compte confirmé avec `membership_privacy_approved=true` : `POST /join` accepte les
  Conditions/disclosure courantes sans pays, KYC, profil fiscal ou corridor ;
  le replay est exact et une seule adhésion `member_status=active` existe ;
- après adhésion, créer ou lire un unique lien opaque actif puis vérifier copie,
  partage natif/fallback et QR avec disclosure indivisible ;
- une attribution valide et un paiement financier complet créent une écriture
  pending, qui ne devient disponible qu'à J+45 ; aucun résultat Didit n'est lu ;
- `POST /credit/quotes` puis `/credit/redemptions` débitent uniquement le solde
  disponible sous le même verrou que le cash, sans KYC ni seuil de retrait ; le
  catalogue pilote est Norva Plus à `USD 499` unités mineures (Norva Family
  reste `USD 899`) et aucune conversion de devise implicite n'est permise ;
- pour un compte allowlisté cash, le choix **Recevoir un virement cash** demande
  alors seulement le pays de résidence payout explicite, vérifié par le
  serveur, puis Didit, fiscalité et corridor dans cet ordre ; aucune donnée IP,
  locale ou timezone ne choisit le pays à la place du membre ;
- pour un compte hors cohorte, le serveur retourne
  `cash_pilot_not_allowed`; l'interface conserve lien, commissions et crédit
  d'accès, et ne demande ni pays, ni KYC, ni fiscalité, ni donnée bancaire ;
- fiscalité : aucun `verified` sans déclaration v1 et `self_attested_at` ; les
  anciens états sans consentement deviennent `expired` sans consentement
  synthétique, restent lisibles, puis reviennent à `pending` uniquement après
  une nouvelle auto-attestation explicite ;
- file fiscale : auto-attestation membre -> ligne `pending` par `partner_key`
  -> revue AAL2 par clé publique -> GET membre `verified` -> devise manuelle
  autorisée, sans UUID/e-mail/référence provider dans la file ;
- fiscalité et onboarding payout : replay exact avant quota, une nouvelle clé
  par 60 secondes, huit sur 24 heures, neuvième clé en `429 rate_limited`, clés
  d'idempotence purgeables après 30 jours sans supprimer l'état ni l'audit ;
- l'ancien setter membre de profil payout est inaccessible à `service_role` ;
  le navigateur ne peut soumettre ni token, ni IBAN, ni provider ;
- onboarding manuel : `rejected -> pending` dans la même révision est refusé ;
  une resoumission produit une nouvelle révision ;
- contact payout : modèle serveur allowlisté, ticket Support/outbox `ready`,
  replay idempotent et aucune adresse/UUID dans la réponse ; tout texte libre
  ou quatrième envoi sur 24 heures est refusé ;
- concurrence payout : toutes les mutations registre suivent
  `global -> account -> request`; rejouer en concurrence demande/completion et
  autorisation/proposition bénéficiaire sans deadlock `40P01` ;
- avant `complete`, rejouer séparément compte `held`, fiscal `expired`, policy
  ou programme expiré, devise/route désactivée et route `revolut_api` : tous
  doivent échouer avant le contrôle du binding, puis le corridor manuel restauré
  doit encore exiger le profil et le binding maker-checker actifs ;
- décision d'accès au pilote cash `approved|declined` affichée sans réouverture
  ni resoumission et sans modifier l'adhésion ;
- cohorte ou pays payout absent/inactif : adhésion, lien, attribution,
  maturation et crédit continuent ; seul le virement reste
  `cash_pilot_not_allowed`, `payout_country_required` ou indisponible ;
- l'ancien parcours d'adhésion `/applications -> KYC -> activation` n'est plus
  un chemin membre ; `/join` est l'unique mutation d'adhésion sans KYC ;
- entreprise : waitlist, aucun KYC/KYB ;
- session Didit absente de config : message public, aucun changement d'état ;
- webhook falsifié, expiré ou rejoué : rejet sans mutation ;
- webhook Didit chunked sans `Content-Length` au-delà de 2 MiB : lecture
  interrompue/cancelée et `413`, sans allocation du corps complet ;
- KYC approuvé signé : résultat minimal seulement, aucune image/payload brut ;
- conditions obsolètes : lien bloqué ;
- rotation : exactement un lien actif ;
- partage Android : disclosure et URL restent indivisibles ;
- `/r/{code}` : cookie `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, TTL
  égal ou inférieur à la fenêtre d'attribution ;
- claim consommé une seule fois après auth ; self-referral et conflits refusés.

### TV

- le QR est temporaire, expire et ne contient aucune identité ;
- Back ferme le panneau et restaure le focus ;
- chaque contrôle est atteignable au D-pad ;
- TV ne crée ni compte partenaire, ni KYC, ni attribution, ni paiement ;
- la reprise téléphone demande une authentification utilisateur normale.

### Admin Support/Risk

- Support seul peut lister, rechercher et filtrer la file sanitisée, mais ne
  voit ni UUID utilisateur, ni e-mail complet et ne peut décider ;
- Risk sans AAL2 ne peut ni approuver ni refuser ;
- Risk avec AAL2 et justification valide peut décider une seule fois ;
- une approbation ajoute uniquement l'allowlist pays/subdivision, sans modifier
  flags, gates, programme, policy, corridor ou statut de compte ;
- un refus n'ajoute aucune allowlist et oriente l'utilisateur vers le support ;
- focus, scroll, filtre et page de la file sont conservés après l'action.

### Finance

- paiement Web et Google Play/RevenueCat produisent un fait immuable ;
- Google Play : vérifier `total` après remise, `tax`, devise/exposant 0/2/3,
  order/product mismatch, service account absent, OAuth 401/429 et réponse
  surdimensionnée ; aucune adresse, purchase token ou payload brut n'est stocké ;
- remboursement Google complet : total/taxe exacts ; partiel : exactement un
  événement traité est accepté, plusieurs événements restent `incomplete` ;
- Web/Revolut sans moteur fiscal : fait `incomplete`, jamais `tax_minor=0`
  fabriqué ;
- événement rejoué ou hors ordre ne crée pas de seconde commission ;
- fait incomplet : `facts_status=incomplete`, aucun job et aucun zéro estimé ;
- remboursement partiel/complet ou chargeback complet crée une contre-écriture
  seulement si le fait et son parent sont complets ; `DISPUTE_WON` restaure
  uniquement la reversal exacte, y compris après un release partiel ;
- `TRANSFER` reste `quarantined` sur le rail financier et ne crée aucune
  écriture ; la projection d'entitlement RevenueCat est une machine d'états
  séparée qui préserve tout achat strictement postérieur ;
- maturation impossible avant J+45 ;
- shadow reconciliation retrouve chaque fait et chaque écriture ;
- `partners_payouts_live=false` interdit la préparation de nouveaux lots et
  tout lease API. Il n'annule jamais un virement déjà saisi manuellement dans
  Revolut : l'opérateur cesse toute nouvelle saisie, conserve le lot et ses
  références immuables, puis rapproche les virements déjà créés avant toute
  reprise supervisée.

## 5. KYC, quota et circuit

Surveiller séparément :

- sessions créées, approuvées, refusées, en revue, abandonnées et expirées ;
- taux de webhook invalide/rejoué ;
- quota gratuit estimé et dépense payante ;
- alertes à 80 %, 100 %, puis aux plafonds journaliers/mensuels ;
- taux d'erreur fournisseur et latence.

Le passage au contrôle payant après le quota gratuit ne bloque pas un utilisateur
légitime. Le circuit ne s'ouvre que pour incident provider/facturation,
dépassement anormal du plafond anti-abus ou instruction opérateur auditée.

## 6. Jobs et alertes

Chaque worker utilise un lease borné, `FOR UPDATE SKIP LOCKED`, une clé
idempotente, des retries exponentiels bornés et une dead-letter. Alerter sur :

- plus ancien job prêt non traité ;
- lease expiré ;
- dead-letter nouvelle ;
- écart de réconciliation shadow ;
- commission disponible sans profil payout ;
- lot bloqué ou rejet provider ;
- solde négatif sans activité future ;
- webhook KYC/finance invalide ;
- capacité Admin attendue mais non configurée.

Les workers publient des heartbeats réels et indépendants :
`commission`, `correction`, `maturation`, `reconciliation`,
`revenuecat_transfer` et, lorsque `revolut_api` est effectivement exécuté,
`payout`. Le mode `revolut_manual`
n'invente pas de heartbeat provider : le dashboard expose séparément lots
préparés/exportés/soumis, imports de relevé, lignes non rapprochées,
quarantaines et décisions Finance en attente. Un worker non configuré reste
`not_configured` ; aucun simple succès HTTP/cron ne fabrique un état sain.

Une alerte « cron sain » ne prouve jamais que le travail asynchrone est terminé.
Le dashboard mesure les lignes leased/processed/dead-letter et les observations
exactes.

Les définitions, capacités, indisponibilités honnêtes et seuils stables sont
figés dans
[NORVA-PARTNERS-OBSERVABILITY-CONTRACT.md](./NORVA-PARTNERS-OBSERVABILITY-CONTRACT.md).

Le sweep existant `norva-admin/ops-alert` lit le snapshot Partners sanitisé
uniquement lorsque `partners_enabled=true`. Il transforme chaque code/count
autoritatif en une clé de cooldown `partners_*`, puis réutilise les canaux
Telegram et e-mail ainsi que les notifications de rétablissement déjà exploités
par Norva Ops. Aucun payload provider, identifiant de partenaire, document KYC
ou détail financier ne quitte le snapshot. Si la RPC de supervision devient
indisponible pendant que le programme est actif, l'incident distinct
`partners_monitoring_unavailable` est envoyé.

## 7. Backup et restauration

Les dumps logiques doivent inclure `public` **et** `affiliate_private`. Les
scripts sous `ops/backup/` et `ops/hetzner/backup/` portent cette sélection.

Le drill trimestriel vérifie au minimum :

- présence du schéma, fonctions, contraintes, RLS et privilèges ;
- nombres de demandes d'accès, comptes, claims, attributions, faits, écritures,
  lots et événements ;
- append-only et équilibre du ledger ;
- aucune fonction privée exécutable par `anon` ; pour `authenticated`, seules
  les implémentations Admin explicitement allowlistées, protégées par les
  capabilities Support/Risk/Finance, sont exécutables ;
- aucun accès direct table ou séquence dans `affiliate_private` pour
  `anon`/`authenticated` ;
- secrets absents du dump ;
- restauration dans une base jetable, jamais au-dessus de la production.

## 8. Cycle de versement pilote

1. figer la période ;
2. lancer la réconciliation shadow ;
3. résoudre tous les faits manquants et contre-écritures ;
4. générer un dry-run de lot ;
5. double approbation Finance, avec séparation créateur/approbateur ;
6. vérifier KYC, fiscalité, token payout et seuil ;
7. autoriser temporairement la préparation du lot `revolut_manual`, exporter
   le TSV et vérifier son SHA-256 ;
8. saisir les virements dans Revolut Business avec leur référence Norva
   exacte, puis marquer uniquement `YES` dans `entered_in_revolut` par
   sous-ensembles si nécessaire, sans copier d'identifiant bancaire ni modifier
   les colonnes figées du TSV ;
9. refermer `partners_payouts_live`, importer le relevé officiel et rapprocher
   référence, montant, devise et destination masquée avec l'exposant obtenu du
   contexte SQL autoritaire ;
10. faire revoir puis décider chaque ligne par deux acteurs Finance distincts,
    le décideur final étant aussi distinct du finalisateur du lot, puis archiver
    la preuve de complétude.

Les deux premiers cycles restent supervisés manuellement. Aucun bouton Admin ne
peut contourner une gate DB ou modifier une écriture existante.

## 9. Incident et rollback

Ordre de réduction du risque :

1. `NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED=false` et
   `NORVA_PARTNERS_REVOLUT_API_ENABLED=false` ;
2. `partners_revolut_api_enabled=false`, puis
   `partners_payouts_live=false` ;
3. suspendre le worker et tout paiement manuel du lot concerné sans supprimer
   la file ni le lot ;
4. `partners_shadow_mode=true` ;
5. désactiver la création de nouvelles sessions KYC ; en cas d'incident
   financier, rabaisser `partners_earnings_enabled` puis
   `partners_credit_redemptions_enabled` sans fermer les adhésions existantes ;
6. utiliser `partners_enabled=false` seulement pour un incident propre à
   l'adhésion ou au lien, sans effacer comptes/ledger ;
7. conserver les preuves, correlation IDs et événements sanitisés ;
8. corriger par contre-écriture ou reprise idempotente, jamais par édition
   manuelle d'un montant canonique.

La restauration de base est un dernier recours. Un incident métier normal se
répare par machines d'états, reprises et contre-écritures.

### Reprise d'une activation après KYC asynchrone

Si Didit a signé un résultat vérifié pendant que `partners_enabled`, une gate ou
l'allowlist était fermée, le compte doit rester `pending_verification` avec son
évidence KYC persistée. Après correction de la configuration, le client appelle
une fois `POST /functions/v1/norva-partners/activation/reconcile` avec le body
exact `{}`. La route n'accepte ni user ID ni clé d'idempotence ; elle relit
l'identité du JWT, verrouille le compte et revalide le programme, la politique,
les contrats, l'e-mail, les gates et l'allowlist.

Contrôles obligatoires sur une restauration isolée puis pendant le pilote :

1. gate fermée + compte KYC `verified` → `changed=false`, compte toujours
   `pending_verification`, `next_action=activate_account` ;
2. ouverture autorisée de la gate → `changed=true`, compte `active`,
   `next_action=share_link` ;
3. retry exact → `changed=false` et toujours un seul événement
   `account_activated` ;
4. version conditions/divulgation périmée → aucune activation et
   `next_action=accept_terms` ;
5. compte held/suspended → aucune réactivation et
   `next_action=contact_support`.

Ne rejouez pas le webhook et ne modifiez jamais directement le statut du compte
pour débloquer ce parcours.

Fermer `partners_enabled` ou une release gate ne doit pas masquer l'entrée
utilisateur Partners ni interrompre GET ; tant que le kill switch dédié reste à
`true`, cela n'interrompt pas non plus POST. Si la collecte des demandes
elle-même doit être suspendue pour un incident dédié, utiliser uniquement
`NORVA_PARTNERS_ACCESS_REQUESTS_ENABLED`, jamais un kill switch financier ou
KYC.

### Pause et reprise de la collecte des demandes

Pour mettre la collecte en pause sans perdre la visibilité ni l'historique :

1. définir `NORVA_PARTNERS_ACCESS_REQUESTS_ENABLED=false` dans l'environnement
   Hetzner, sans modifier `partners_enabled` ni les tables ;
2. recréer `functions`, attendre son état sain et vérifier son endpoint, puis
   recréer `functions2` et répéter le contrôle afin d'éviter une coupure globale ;
3. confirmer avec un compte Cloud que `GET /access-request` retourne toujours
   l'état et que `POST /access-request` répond
   `503 partners_access_requests_disabled` ;
4. confirmer que la file Admin Support|Risk et les décisions déjà prises sont
   lisibles ; ne supprimer ni demande, ni clé d'idempotence récente, ni audit ;
5. surveiller les corrélations 503/429 séparément des incidents KYC et finance.

Pendant le déploiement roulant, l'ancienne réplique peut encore accepter un
POST jusqu'à sa recréation. Ne déclarer la pause effective qu'après parité
`false` et santé vérifiée sur les deux conteneurs Edge.

Pour reprendre :

1. corriger et documenter la cause de la pause, puis valider la migration, la
   santé DB et les contrats sur une restauration isolée ;
2. définir `NORVA_PARTNERS_ACCESS_REQUESTS_ENABLED=true` et recréer de nouveau
   `functions`, puis `functions2`, avec contrôle de santé entre les deux ;
3. vérifier d'abord GET, puis effectuer un seul POST contrôlé et son replay avec
   la même clé ; confirmer que le replay ne consomme pas une nouvelle tentative ;
4. vérifier la file Admin et les métriques 201/429/503. Ne jamais purger les
   clés pour contourner le cooldown ou la limite de 8 sur 24 heures.

La reprise n'est effective qu'après parité `true` et santé vérifiée sur les deux
conteneurs ; des 503 intermittents sont attendus durant la fenêtre roulante et
ne justifient aucun retry agressif côté client.

## 10. Matrice de mise en service

| Contrôle | État du dépôt | Validation attendue avant activation | Action externe |
|---|---|---|---|
| Migrations/RPC Partners | livrées | baseline production `eda071e` postdeploy certifiée ; `supabase db start`, puis `db reset --local --no-seed`, pgTAP, lint et Advisors verts ; répétitions `predeploy` puis `postdeploy` sur restaurations isolées | sans rejouer la baseline, appliquer atomiquement le seul hotfix bootstrap booléen, vérifier la parité, puis enregistrer le manifeste du même commit et renouveler les gates exactes |
| Type-check Edge Partners | config et lock Deno dédiés | Deno `2.9.4`, mêmes entrypoints et `deno check --frozen` verts | ne régénérer `deno.partners.lock` qu'intentionnellement, avec le même runtime et `--frozen=false`, puis revoir le diff |
| API membre, demandes d'accès cash, referral, crédit et TV | livrées | entrée visible à tout compte Cloud Web/mobile ; compte confirmé + `membership_privacy_approved` -> `/join` public sans pays/KYC -> lien/partage ; access-request ne sert qu'à la cohorte cash ; attribution et J+45 sous `partners_earnings_enabled` ; quote/redeem Plus au prix de référence `USD 499`, avec débit exact de la devise source et snapshot FX immuable, sans KYC sous `partners_credit_redemptions_enabled` ; hors cohorte, `cash_pilot_not_allowed` sans collecte payout ; contrats Node, E2E Web/mobile et replay émulateur TV | déployer les flags à `false`, valider chaque couche puis lever `partners_enabled` avec `partners_invite_only=false`; conserver `partners_cash_pilot_allowlist_only=true`; synchroniser les secrets HMAC et publier les App Links |
| Didit KYC cash-only et suppression provider | code, consentement biométrique versionné, outbox chiffrée et worker borné livrés ; aucune session n'est créée avant le choix cash et le pays payout explicite | session sandbox non autoritaire, session live liée au fingerprint/version déployés, webhook KYC documenté avec `session_kind` absent ou `user`, refus de tout marqueur KYB, suppression `204|404`, replay, backoff, heartbeat frais et zéro dead-letter ; un échec n'altère ni membership, lien, maturation ni crédit | renseigner API key, workflow/application/node IDs, webhook secret/URL/callback et keyring de purge identique sur les deux replicas ; enregistrer le cron de purge après smoke test et archiver trois preuves distinctes sans secrets |
| Worker commission/J+45/shadow | livré | capture → accrual → J+45/reversal → shadow sans écart ; heartbeats frais | réutiliser le secret cron existant vérifié par `norva_verify_cron_secret`, confirmer son entrée Vault et créer le job `pg_cron` |
| Google Play Orders | producteur exact livré, inactif sans secrets/devise | capture/renewal/refund exacts, nanos sans arrondi, réponse PII non persistée, quota réservé aux comptes attribués | injecter le compte de service dédié, autoriser le package, configurer les exposants ISO actifs |
| RevenueCat/Revolut | producteurs, TRANSFER entitlement et contre-correction livrés ; contrat fiscal Web France/USD versionné et autoritatif livré | HMAC/replay, source expirée, nouvel achat préservé, ordre inversé ; capture/refund/chargeback Web résolus par policy exacte ; toute juridiction, devise ou policy absente reste `incomplete` sans commission | activer les événements provider et secrets par environnement ; renouveler ou remplacer explicitement la policy avant son expiration et avant toute extension pays/devise |
| `DISPUTE_WON` | contre-correction append-only livrée | LOST/WON rejoués, WON avant LOST, reversal/release partiels, restauration exacte et réconciliation propre | activer l'événement Revolut et vérifier la lecture autoritative sur l'environnement disponible |
| Payout onboarding/dispatch | `revolut_manual` livré pour Basic : lots exacts, référence `NORVA-[A-F0-9]{12}`, acquittement `YES` sans identifiant bancaire saisi, import de relevé sanitisé, incidents append-only, double validation et ledger de règlement ; `revolut_api` livré mais multi-gated | cycle J+45 → lot → export/hash → saisie manuelle → relevé → rapprochement exact, doublon/montant/devise inconnus quarantainés, deux acteurs Finance distincts ; route manuelle active, gate DB API, flag DB API et kill switch Edge à `false`, aucun cron API/provider | configurer uniquement les corridors Revolut manuels, réaliser deux cycles supervisés et conserver les secrets Business API absents tant qu'aucun upgrade n'est décidé |
| Admin/alertes | surfaces, file de demandes d'accès cash, gates Membership/Cash Privacy, heartbeats et relais Ops Telegram/e-mail livrés | Support|Risk lit la file sanitisée ; seule Risk+AAL2 décide ; `membership_privacy_approved` exige notice/ROPA/minimisation, `privacy_approved` exige AIPD/consentement Didit ; une décision d'accès ajoute uniquement l'allowlist cash ; capacités vérifiées, agrégats redacted, snapshot service-role et cycle alerte/rétablissement réels | attribuer Support/Risk/Finance et vérifier les deux canaux sur un incident sandbox |
| Adhésion publique + pilote cash France | séparation des gates/policies livrée et fail-closed ; première preuve technique des pages juridiques archivée le 30 juillet | avant adhésion : artefacts Membership Privacy normalisés, pages HTTP directes, snapshot DB, App Link signé Play et restore drill ; avant cash : AIPD Didit, policy FR, route manuelle, allowlist 20–50 et maker-checker ; 45 jours observés avant généralisation cash | ouvrir l'adhésion mondiale sans KYC avec `partners_invite_only=false`; configurer seulement la cohorte cash France en allowlist, sans invitation obligatoire pour devenir membre |

Une case « code livré » ne suffit jamais pour lever une gate. L'opérateur doit
conserver l'attestation structurée du run CI/runtime et de la configuration
externe correspondante dans le journal de release, puis corréler manuellement
URL, run ID et SHA-256 avec l'artefact réel. Le validateur ne lit ni Supabase ni
les APIs fournisseurs.

Le format non secret de ce journal et son validateur sont décrits dans
[NORVA-PARTNERS-RELEASE-EVIDENCE.md](./NORVA-PARTNERS-RELEASE-EVIDENCE.md).
Ils rendent les preuves manquantes visibles, sans remplacer les RPC Admin ni
stocker les identités de l'allowlist.

Le journal privé utilisé pour lever une gate réside uniquement dans le secret
d'environnement GitHub `PARTNERS_RELEASE_EVIDENCE_B64`. Le workflow manuel
`.github/workflows/partners-release-gate.yml` doit être protégé par des
reviewers obligatoires et une règle de branche d'environnement limitée à
`main`. Le workflow refuse repository/ref non canoniques avant tout décodage.
La CI Partners ordinaire continue uniquement de
valider le template `draft` public et ne doit jamais recevoir ce secret.

Pour éviter qu'un ancien visa approuve une nouvelle configuration, les quatre
preuves d'approbation pilote sont horodatées strictement après la dernière
preuve autoritative/config/runtime. La décision de généralisation est à son
tour strictement postérieure à la preuve des 45 jours, au second cycle
rapproché et aux quatre approbations. Une égalité d'horodatage reste fail-closed.
Les deux cycles rapprochés commencent au plus tôt au début du pilote et le
second se termine au plus tard à la clôture de son observation. Des cycles
historiques, même rapprochés, ne satisfont jamais cette gate.

`generalization_ready` est produit après retour à l'état sûr
`partners_shadow_mode=true`, `partners_payouts_live=false`. Il exige 45 jours
calendaires, deux cycles `supervised_and_reconciled` et la gate
`general_release_approved`, mais ne déclenche pas lui-même la bascule live.
