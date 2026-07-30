# Norva Partners — runbook pilote

**Version :** 29 juillet 2026
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
```

Configurer séparément sur Cloudflare Pages :

```text
NORVA_PARTNERS_REFERRAL_EDGE_URL   # URL complète terminée par /resolve
NORVA_REFERRAL_REDIRECT_URL
NORVA_REFERRAL_EDGE_HMAC_SECRET
NORVA_PARTNERS_API_URL
```

`NORVA_REFERRAL_COOKIE_SECRET` reste exclusivement côté serveur : il ne doit
jamais être injecté dans Pages. Le worker financier réutilise le secret cron
Norva existant (`NORVA_CRON_SHARED_SECRET`, conservé dans Vault) et ne possède
pas de secret parallèle. Ses réglages optionnels sont bornés :
`NORVA_PARTNERS_WORKER_BATCH`, `NORVA_PARTNERS_WORKER_MAX_BATCHES`,
`NORVA_PARTNERS_WORKER_LEASE_SECONDS` et
`NORVA_PARTNERS_SHADOW_WINDOW_HOURS`.

`NORVA_PARTNERS_TV_RELAY_SECRET` contient 32 à 512 caractères. L'URL de handoff
est HTTPS, sous `*.norva.tv`, sans query ni fragment ; son TTL est compris entre
120 et 600 secondes. Didit reçoit directement la `kyc.reservation_key` opaque
émise par la DB comme `vendor_data` : aucun second secret vendor n'est requis.

Le workflow Didit doit être un workflow KYC individuel. Aucun module KYB ne doit
être présent. Pour préserver le retour Web et Android App Link, configurer
exactement `DIDIT_CALLBACK_URL=https://norva.tv/app.html?mobile=1#partners` ;
aucun identifiant de session ou résultat KYC ne doit être ajouté au callback.
Le webhook HTTPS lit le corps brut et vérifie la signature avant tout parsing ou
accès DB. Après toute rotation du secret webhook, un ancien secret doit devenir
invalide et un événement test signé doit être rejoué.

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
   `partners_shadow_mode=true`, `partners_payouts_live=false` ;
9. calcul shadow comparé au ledger financier pendant au moins un cycle complet ;
10. deux cycles de versement supervisés avant toute extension.

Le webhook Revolut doit inclure `ORDER_COMPLETED` et `DISPUTE_LOST`.
`DISPUTE_ACTION_REQUIRED`/`DISPUTE_UNDER_REVIEW` sont non économiques.
`DISPUTE_WON` reste fail-closed jusqu'au contrat de contre-correction dédié :
ne pas considérer la couverture chargeback comme complète sans ce lot.

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
      url := 'https://<project-ref>.supabase.co/functions/v1/norva-partners-worker/cron/run',
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
  seulement si le fait et son parent sont complets ; `TRANSFER` reste
  `quarantined` et ne crée aucune écriture ;
- maturation impossible avant J+45 ;
- shadow reconciliation retrouve chaque fait et chaque écriture ;
- `partners_payouts_live=false` interdit tout débit provider.

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

Le worker financier publie trois heartbeats réels et indépendants :
`commission`, `maturation` et `reconciliation`. Aucun heartbeat `payout` ne doit
être attendu ou fabriqué tant qu'un véritable worker provider n'existe pas.

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
7. autoriser temporairement le rail et envoyer ;
8. consommer le webhook provider ;
9. rapprocher montants envoyés/rejetés/retournés ;
10. refermer la gate et archiver le rapport.

Les deux premiers cycles restent supervisés manuellement. Aucun bouton Admin ne
peut contourner une gate DB ou modifier une écriture existante.

## 9. Incident et rollback

Ordre de réduction du risque :

1. `partners_payouts_live=false` ;
2. suspendre le worker concerné sans supprimer la file ;
3. `partners_shadow_mode=true` ;
4. désactiver la création de nouvelles sessions KYC ou claims ;
5. si nécessaire `partners_enabled=false`, sans effacer comptes/ledger ;
6. conserver les preuves, correlation IDs et événements sanitisés ;
7. corriger par contre-écriture ou reprise idempotente, jamais par édition
   manuelle d'un montant canonique.

La restauration de base est un dernier recours. Un incident métier normal se
répare par machines d'états, reprises et contre-écritures.

## 10. Matrice de mise en service

| Contrôle | État du dépôt | Validation attendue avant activation | Action externe |
|---|---|---|---|
| Migrations/RPC Partners | livrées | `db reset`, pgTAP, lint et Advisors verts en CI Supabase jetable | déployer les cinq migrations dans l'ordre |
| API membre, referral et TV | livrées | contrats Node, E2E Web/mobile et replay émulateur TV | synchroniser les secrets HMAC et publier les App Links |
| Didit KYC-only | code livré, inactif sans configuration complète | session sandbox, décision signée, replay et refus KYB | renseigner API key, workflow/application/node IDs, webhook secret/URL et callback |
| Worker commission/J+45/shadow | livré | capture → accrual → J+45/reversal → shadow sans écart ; heartbeats frais | réutiliser le secret cron existant vérifié par `norva_verify_cron_secret`, confirmer son entrée Vault et créer le job `pg_cron` |
| Google Play Orders | producteur exact livré, inactif sans secrets/devise | capture/renewal/refund exacts, nanos sans arrondi, réponse PII non persistée, quota réservé aux comptes attribués | injecter le compte de service dédié, autoriser le package, configurer les exposants ISO actifs |
| RevenueCat/Revolut | producteurs livrés ; Web reste incomplet sans ventilation fiscale | événements économiques rejoués deux fois sans double écriture ; aucun `tax=0` supposé | activer les événements provider ; inclure Revolut `DISPUTE_LOST` ; sélectionner un moteur/contrat fiscal Web avant commission |
| `DISPUTE_WON` | **fail-closed** | alerte visible et aucune mutation financière | ne pas acquitter silencieusement ; livrer d'abord le contrat de chargeback reversal |
| Payout onboarding/dispatch | **non livré, bloqué fournisseur** | aucun débit réel autorisé | sélectionner et contractualiser le provider, intégrer onboarding/webhooks/dispatch ; conserver `partners_payouts_live=false` |
| Admin/alertes | surfaces, heartbeats et relais Ops Telegram/e-mail livrés | capacités vérifiées, snapshot service-role et cycle alerte/rétablissement réels | attribuer Support/Risk/Finance et vérifier les deux canaux sur un incident sandbox |
| Pilote mondial | gates et policies livrées mais vides/fail-closed | Terms/Privacy publiées, pays approuvés et restore drill réussi | configurer juridictions, programme, allowlist et invitations ; laisser invite-only |

Une case « code livré » ne suffit jamais pour lever une gate. L'opérateur doit
conserver la preuve du run CI/runtime et de la configuration externe
correspondante dans le journal de release.

Le format non secret de ce journal et son validateur sont décrits dans
[NORVA-PARTNERS-RELEASE-EVIDENCE.md](./NORVA-PARTNERS-RELEASE-EVIDENCE.md).
Ils rendent les preuves manquantes visibles, sans remplacer les RPC Admin ni
stocker les identités de l'allowlist.
