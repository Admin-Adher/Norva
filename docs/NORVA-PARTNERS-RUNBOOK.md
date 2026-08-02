# Norva Partners — runbook pilote

**Version :** 30 juillet 2026
**Principe :** tout reste fail-closed tant que KYC, juridiction, finance et
versement ne sont pas vérifiés séparément.

Ce runbook ne remplace ni une revue juridique/fiscale locale ni les procédures
d'incident des fournisseurs. Il décrit les contrôles techniques nécessaires
avant et pendant le pilote individuel Norva Partners.

## 1. Portes de mise en service

Ne jamais ouvrir `partners_enabled` uniquement parce que le code est déployé.
Pour chaque pays/subdivision, conserver une preuve datée des cinq portes :

1. contrat et disclosure approuvés ;
2. KYC individuel Didit couvrant identité, âge, pays et capacité ;
3. traitement fiscal du partenaire individuel défini ;
4. rail de versement individuel, devise, seuil et retours testés ;
5. sources financières capables de fournir le montant final réellement payé,
   la taxe, la devise/exposant, le mouvement parent et l'état de remboursement.
   La remise séparée reste un contexte facultatif et ne doit pas être soustraite
   une seconde fois du montant Google Play déjà remisé.

L'activation initiale est limitée à une allowlist nominative de 20 à 50 comptes.
Le KYB, les sociétés et les versements réels restent fermés.

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
NORVA_REFERRAL_EDGE_HMAC_SECRET
NORVA_REFERRAL_COOKIE_SECRET
NORVA_PARTNERS_ALLOWED_ORIGINS
NORVA_PARTNERS_TV_RELAY_SECRET
NORVA_PARTNERS_TV_RELAY_HANDOFF_URL
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

Toute modification de ces variables doit être suivie d'un nouveau déploiement
Pages : les déploiements existants conservent leur instantané d'environnement.

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
est HTTPS, sous `*.norva.tv`, sans query ni fragment ; son TTL est compris entre
120 et 600 secondes. Didit reçoit directement la `kyc.reservation_key` opaque
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
  `/manual/beneficiaries/propose`. Une autorisation Finance/AAL2 à usage unique
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
explicite du plan Revolut. Le sandbox valide l'authentification, l'idempotence et
les contrats que Revolut y expose, mais ne constitue pas une preuve de paiement
de bout en bout : `/pay/fields` n'y est pas disponible et le client reste
volontairement fail-closed. Avant la gate API, Finance réalise donc un
micro-virement supervisé en production, vérifie `/pay/fields`, le quote, la
transaction canonique puis son rapprochement exact. Activer un seul des deux
verrous ne lance aucun job. Pour un rollback, passer d'abord le kill switch Edge
à `false`, puis le flag DB à `false`, remettre les corridors en
`revolut_manual` et traiter les jobs ambigus en revue manuelle.

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
ou refléter, puis répond `303` vers `/app.html?mobile=1#partners` avec
`Cache-Control: private, no-store` et `Referrer-Policy: no-referrer`. Le Service
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

Le compte de service Google Play est dédié au backend, limité à la lecture des
commandes du package Norva et absent de tout client Android/Web. Les deux
variables Google absentes laissent l'enrichissement inactif et les faits
`incomplete`. Une seule variable présente, un JSON invalide ou un échec OAuth
est une mauvaise configuration visible à corriger, jamais un motif pour
reconstruire la taxe depuis RevenueCat.

## 3. Ordre de déploiement

1. sauvegarde logique et contrôle de restauration ;
2. migrations DB et tests pgTAP ;
3. Edge Functions KYC/referral/worker déployées mais désactivées ;
4. Web, Android et TV déployés avec états `not_configured` ;
5. webhook Didit enregistré, secret injecté, événement de test validé ;
6. une policy de juridiction approuvée et un programme versionné insérés ;
7. comptes pilotes ajoutés à l'allowlist ;
8. `partners_enabled=true`, `partners_invite_only=true`,
   `partners_shadow_mode=true`, `partners_tv_relay_enabled=true`,
   `partners_payouts_live=false`,
   `partners_revolut_api_enabled=false` et kill switch Edge API à `false` ;
9. calcul shadow comparé au ledger financier pendant au moins un cycle complet ;
10. deux cycles de versement supervisés avant toute extension.

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

Remplacer `<project-ref>`, confirmer qu'une seule ligne porte ce nom et vérifier
les compteurs leased/succeeded/retry/dead-letter ainsi que la réconciliation
shadow. Ne jamais inscrire cette cible par migration.

## 4. Smoke tests

### Membre Web/Android

- pays absent/inactif : aucune adhésion ;
- demande individuelle idempotente ;
- entreprise : waitlist, aucun KYC/KYB ;
- session Didit absente de config : message public, aucun changement d'état ;
- webhook falsifié, expiré ou rejoué : rejet sans mutation ;
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
`commission`, `maturation`, `reconciliation`, `revenuecat_transfer` et, lorsque
`revolut_api` est effectivement exécuté, `payout`. Le mode `revolut_manual`
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
- nombres de comptes, claims, attributions, faits, écritures, lots et événements ;
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

1. `NORVA_PARTNERS_REVOLUT_API_ENABLED=false` ;
2. `partners_revolut_api_enabled=false`, puis
   `partners_payouts_live=false` ;
3. suspendre le worker et tout paiement manuel du lot concerné sans supprimer
   la file ni le lot ;
4. `partners_shadow_mode=true` ;
5. désactiver la création de nouvelles sessions KYC ou claims ;
6. si nécessaire `partners_enabled=false`, sans effacer comptes/ledger ;
7. conserver les preuves, correlation IDs et événements sanitisés ;
8. corriger par contre-écriture ou reprise idempotente, jamais par édition
   manuelle d'un montant canonique.

La restauration de base est un dernier recours. Un incident métier normal se
répare par machines d'états, reprises et contre-écritures.

## 10. Matrice de mise en service

| Contrôle | État du dépôt | Validation attendue avant activation | Action externe |
|---|---|---|---|
| Migrations/RPC Partners | livrées | `supabase db start`, puis `db reset --local --no-seed`, pgTAP, lint et Advisors verts ; la migration versionnée des extensions précède tout usage de `pg_cron`/`pg_net` | appliquer toutes les migrations en attente dans l'ordre |
| Type-check Edge Partners | config et lock Deno dédiés | Deno `2.9.4`, mêmes entrypoints et `deno check --frozen` verts | ne régénérer `deno.partners.lock` qu'intentionnellement, avec le même runtime et `--frozen=false`, puis revoir le diff |
| API membre, referral et TV | livrées | contrats Node, E2E Web/mobile et replay émulateur TV | synchroniser les secrets HMAC et publier les App Links |
| Didit KYC-only | code livré, inactif sans configuration complète | session sandbox non autoritaire, session live liée au fingerprint/version déployés, conflit environnement/fingerprint mis en quarantaine, décision signée, replay et refus KYB | renseigner API key, workflow/application/node IDs, webhook secret/URL et callback ; archiver trois preuves distinctes sans secrets |
| Worker commission/J+45/shadow | livré | capture → accrual → J+45/reversal → shadow sans écart ; heartbeats frais | réutiliser le secret cron existant vérifié par `norva_verify_cron_secret`, confirmer son entrée Vault et créer le job `pg_cron` |
| Google Play Orders | producteur exact livré, inactif sans secrets/devise | capture/renewal/refund exacts, nanos sans arrondi, réponse PII non persistée, quota réservé aux comptes attribués | injecter le compte de service dédié, autoriser le package, configurer les exposants ISO actifs |
| RevenueCat/Revolut | producteurs, TRANSFER entitlement et contre-correction livrés ; Web reste incomplet sans ventilation fiscale | HMAC/replay, source expirée, nouvel achat préservé, ordre inversé et aucun `tax=0` supposé | activer les événements provider et secrets par environnement ; sélectionner un moteur/contrat fiscal Web avant commission |
| `DISPUTE_WON` | contre-correction append-only livrée | LOST/WON rejoués, WON avant LOST, reversal/release partiels, restauration exacte et réconciliation propre | activer l'événement Revolut et vérifier la lecture autoritative sur l'environnement disponible |
| Payout onboarding/dispatch | `revolut_manual` livré pour Basic : lots exacts, référence `NORVA-[A-F0-9]{12}`, acquittement `YES` sans identifiant bancaire saisi, import de relevé sanitisé, incidents append-only, double validation et ledger de règlement ; `revolut_api` livré mais multi-gated | cycle J+45 → lot → export/hash → saisie manuelle → relevé → rapprochement exact, doublon/montant/devise inconnus quarantainés, deux acteurs Finance distincts ; route manuelle active, gate DB API, flag DB API et kill switch Edge à `false`, aucun cron API/provider | configurer uniquement les corridors Revolut manuels, réaliser deux cycles supervisés et conserver les secrets Business API absents tant qu'aucun upgrade n'est décidé |
| Admin/alertes | surfaces, heartbeats et relais Ops Telegram/e-mail livrés | capacités vérifiées, agrégats redacted, snapshot service-role et cycle alerte/rétablissement réels | attribuer Support/Risk/Finance et vérifier les deux canaux sur un incident sandbox |
| Pilote mondial | gates/policies livrées mais vides/fail-closed ; première preuve technique des pages juridiques archivée le 30 juillet | avant ouverture : artefacts juridiques normalisés, pages HTTP directes, snapshot DB, App Link signé Play, pays approuvés et restore drill ; après ouverture contrôlée : 45 jours observés avant généralisation | configurer juridictions, programme, devises/routes, allowlist et invitations ; laisser invite-only |

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
