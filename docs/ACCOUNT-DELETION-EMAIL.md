# Confirmation de suppression de compte

La suppression du compte reste l'action prioritaire et definitive. Le mail de
confirmation est decouple via `cloud_account_deletion_email_outbox`; une panne
Resend ne peut ni annuler ni relancer la suppression.

## Protocole

1. L'Edge authentifie la session, exige son niveau AAL courant (AAL2 si un
   facteur verifie existe), une authentification interactive de moins de 15
   minutes, puis la confirmation explicite `DELETE`/email. Un simple refresh de
   JWT ne renouvelle jamais cette preuve.
2. Le sujet, HTML, texte brut, expediteur, `reply_to`, destinataire et tags sont
   figes dans une ligne `prepared` valable 30 minutes.
3. `deleteUser` ferme l'identite `auth.users`; les donnees directement liees
   sont supprimees ou desidentifiees selon les cascades et la politique de
   confidentialite. Les rares obligations legales de conservation ne sont pas
   presentees comme supprimees.
4. Un trigger `AFTER DELETE` rend la ligne `ready` dans la meme transaction. Une
   ligne `prepared` n'est jamais revendiquee par le worker et ne peut donc jamais
   annoncer une suppression qui a echoue.
5. Le cron minute revendique la livraison avec lease, l'envoie sequentiellement
   (250 ms minimum entre appels afin de respecter la limite Resend partagee de
   5 req/s) avec une `Idempotency-Key` stable, puis l'acquitte seulement apres
   HTTP 2xx + id Resend. Un 429 propage `Retry-After` a tout le reste du lot sans
   effectuer d'autres appels reseau.

Un second RPC Edge idempotent confirme l'activation apres le succes de
`deleteUser`; il couvre un eventuel warning du trigger. Ce fallback revalide en
base que l'UUID exact n'existe plus dans `auth.users` et que son empreinte
correspond a la preparation avant de l'activer. Si l'email ne peut pas etre
prepare ou active, la suppression reussit tout de meme et la reponse indique
`emailConfirmation: "unavailable"`.

## Confidentialite

- aucune FK vers `auth.users` et aucun UUID brut ne survit : seul le SHA-256 du
  UUID aleatoire sert de correlation;
- le template n'est pas personnalise;
- tags Resend sans PII : `category=transactional_auth`,
  `flow=account_deleted`, `app=norva`;
- le texte et le HTML renvoient vers `/privacy.html` et decrivent explicitement
  la suppression/desidentification ainsi que les conservations legales limitees,
  sans promesse absolue du type "toutes les donnees sont supprimees";
- apres acceptation Resend, destinataire, HTML et texte sont effaces
  immediatement de l'outbox;
- les diagnostics Resend persistants sont limites a une liste blanche, avec
  redaction des emails, URL et secrets;
- les webhooks conservent l'id provider, le statut, les horaires et les tags,
  mais effacent `to_emails` et refusent toute suppression locale derivee pour
  `app=norva, flow=account_deleted`;
- preparations expirees, succes et dead letters sont purges automatiquement;
  une dead letter conserve le destinataire au maximum 30 jours pour permettre
  une remediation.

## Reprises et erreurs

Les erreurs reseau, 401/403 de configuration, 408/425/429 et 5xx sont retentees
avec backoff exponentiel borne. Les requetes invalides passent en dead letter.
Une acceptation Resend dont l'acquittement SQL est ambigu conserve son lease : le
replay reutilise le meme payload et la meme `Idempotency-Key`, mais seulement
pendant une fenetre de securite de 23 heures (l'idempotence Resend expire apres
24 heures). Ensuite la ligne passe en `dead_letter` avec
`idempotency_window_expired_manual_review`; elle doit etre reconciliee avec
Resend par un operateur et n'est jamais renvoyee aveuglement.

## Deploiement

1. appliquer `20260721235200_account_deletion_email_outbox.sql`, puis les
   hardenings `20260721235300_account_deletion_email_delivery_hardening.sql` et
   `20260721235310_account_deletion_delivery_privacy.sql`;
2. redeployer `norva-account-delete` et la configuration Edge contenant
   `verify_jwt = false` — la fonction verifie elle-meme JWT utilisateur ou secret
   cron selon la route;
3. verifier les jobs `norva-account-deletion-email` et
   `norva-account-deletion-email-prune`.

Si `pg_cron`/`pg_net` ne sont pas disponibles, appeler chaque minute :

```text
POST https://api.norva.tv/functions/v1/norva-account-delete/cron/run
Authorization: Bearer <norva_cron_shared_secret>
```

## Supervision

```sql
select state, count(*)
from public.cloud_account_deletion_email_outbox
group by state
order by state;

select delivery_key, state, attempt_count, last_http_status,
       last_error, next_attempt_at, exhausted_at
from public.cloud_account_deletion_email_outbox
where state in ('ready', 'processing', 'dead_letter')
order by coalesce(exhausted_at, next_attempt_at), created_at;
```
