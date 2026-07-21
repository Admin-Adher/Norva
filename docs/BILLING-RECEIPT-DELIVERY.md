# Fiabilite des confirmations de paiement

Les confirmations Revolut ne sont plus un effet reseau *best effort* du debit. La ligne
`cloud_billing_ledger` reste la preuve financiere; un trigger cree, dans la meme
transaction, une livraison dans `cloud_billing_receipt_outbox`.

Le nom historique des tables, RPC, cles d'idempotence et du tag interne
`flow=payment_receipt` est conserve pour compatibilite. Le message client est
explicitement une **Payment confirmation**: il ne se presente ni comme facture,
ni comme recu fiscal, et ne fait aucune promesse de TVA tant que les champs legaux
necessaires ne sont pas produits. Il affiche uniquement les donnees fiables du
ledger: date de confirmation, plan, cadence, montant, devise, fin de periode et
une reference `NV-...` derivee du digest de livraison (jamais l'identifiant brut
du provider).

## Invariants

- Un paiement capture correspond a une seule ligne d'outbox (`ledger_pi_id` unique).
- Le ledger financier survit a la suppression du compte: son `user_id` nullable
  passe a `NULL` (`ON DELETE SET NULL`). `user_pseudonym`, un SHA-256 stable de
  l'UUID Auth aleatoire, conserve la correlation comptable sans conserver
  l'identifiant directement rattachable. Ce digest reste pseudonyme, pas anonyme.
- La cle Resend est deterministe: `norva-receipt-<sha256(pi_id)>`.
- Le debit n'est jamais relance pour reparer un email.
- Chaque tentative est protegee par un lease et `FOR UPDATE SKIP LOCKED`.
- Destinataire, expediteur, sujet, HTML, texte brut, `reply_to` et tags sont figes
  en base sous le lease avant tout appel reseau; un changement de template ne
  modifie jamais un replay.
- `reply_to` vaut `support@norva.tv` par defaut. Les tags Resend sont stables et
  sans PII: `app=norva`, `category=transactional`, `flow=payment_receipt`.
- Seule une reponse Resend 2xx portant un `email id` acquitte la livraison.
- A l'acquittement, adresse, prenom, sujet et corps HTML/texte sont effaces de
  l'outbox. Les reponses provider sont reduites a une allowlist (`id`, `name`,
  `message`, `status_code`), redactees et bornees; les erreurs le sont aussi.
- Une reponse acceptee dont l'acquittement SQL est ambigu conserve son lease. Le
  replay reutilise la meme `Idempotency-Key`.
- La fenetre d'idempotence Resend est de 24 heures. Norva demarre son horloge juste
  avant l'appel provider, rejoue une issue ambigue avec la meme cle pendant au plus
  23 heures, puis la **quarantine**. Une ligne quarantinee n'est jamais rejouee
  automatiquement apres expiration de la protection provider.
- `409 concurrent_idempotent_requests` est ambigu et retente; `409
  invalid_idempotent_request` (ou tout autre 409) est terminal. Les erreurs reseau,
  401/403 de configuration, 408/425/429 et 5xx utilisent un backoff exponentiel
  borne. `Retry-After` est respecte.
- Les envois sont sequentiels et espaces d'au moins 250 ms. Cela respecte le debit
  partage Resend et evite qu'un petit batch genere lui-meme des 429.
- La table, ses donnees destinataire et les RPC sont reservees au `service_role`.
- Les lignes envoyees sont supprimees apres 90 jours; dead letters et quarantaines
  apres 30 jours. Le ledger financier suit sa propre duree de conservation legale.

Le cron `norva-revolut-billing` traite au plus cinq recus apres les debits et la
reconciliation checkout. Cette borne protege le temps disponible pour la
facturation; les lignes restantes sont reprises au run horaire suivant.

## Deploiement

Appliquer, dans l'ordre, `20260721235000_billing_receipt_delivery_outbox.sql`,
`20260721235100_billing_receipt_rich_payload.sql`, puis
`20260721235150_billing_receipt_privacy_reliability.sql` et
`20260721235175_billing_payment_confirmation_context.sql` avant de redeployer
`norva-revolut-billing`, car le worker ecrit les trois champs de contexte ajoutes
au ledger (`plan_code`, `bill_period`, `billing_period_end`) et appelle la version
riche du RPC de preparation. La derniere migration est compatible avec des lignes
ledger/outbox existantes: elle les backfill avant de valider les contraintes.

## Supervision

```sql
select
  count(*) filter (where sent_at is null and exhausted_at is null) as pending,
  count(*) filter (where sent_at is not null) as sent,
  count(*) filter (where exhausted_at is not null) as dead_letter,
  count(*) filter (where quarantined_at is not null) as quarantined,
  max(now() - created_at) filter (
    where sent_at is null and exhausted_at is null
  ) as oldest_pending
from public.cloud_billing_receipt_outbox;
```

Details actionnables, sans contenu d'email:

```sql
select delivery_key, ledger_pi_id, user_pseudonym, attempt_count,
       last_http_status, last_error, next_attempt_at, exhausted_at,
       delivery_uncertain, idempotency_started_at, quarantined_at
from public.cloud_billing_receipt_outbox
where sent_at is null
order by coalesce(exhausted_at, next_attempt_at), created_at;
```

Apres correction d'une erreur permanente, reouvrir explicitement une dead letter:

```sql
update public.cloud_billing_receipt_outbox
set exhausted_at = null,
    next_attempt_at = now(),
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
where delivery_key = '<delivery_key>'
  and sent_at is null
  and quarantined_at is null
  and not delivery_uncertain;
```

Ne jamais supprimer/recreer une ligne pour la rejouer: cela contournerait la cle
d'idempotence liee au paiement.

Une ligne `quarantined_at is not null` exige d'abord une reconciliation manuelle
avec Resend a partir de `delivery_key`/`resend_email_id`. Apres 24 heures, ne pas
simplement la reouvrir: l'ancienne cle ne protege plus contre un doublon. Un nouvel
envoi, s'il est prouve necessaire, doit etre une decision operateur explicite avec
une nouvelle cle documentee.
