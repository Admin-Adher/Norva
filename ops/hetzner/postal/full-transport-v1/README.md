# Norva — transport Postal général

## État de production au 6 septembre 2026

Le transport Postal est activé pour les **nouveaux envois** de tous les circuits Norva :
authentification GoTrue et OTP, support, suppression de compte, facturation,
import, notifications d'accès fournisseur, sous-titres, alertes internes,
emails de service et relances déjà autorisées dans la file générique.

Les deux réplicas Edge sont raccordés. Aucune clé d'envoi Resend utilisable
ne leur est transmise. Le worker de synchronisation des contacts Resend est
arrêté avec redémarrage désactivé. Les deux fichiers d'environnement Norva
ont leurs clés d'envoi/gestion Resend vidées ; les autres applications et
les clés du compte fournisseur partagé ne sont pas modifiées.

**Changer le transport ne lance aucune nouvelle campagne marketing.** Les
consentements, suppressions, conversions, heures de silence et cohortes
restent les autorités métier existantes. Aucun ancien email n'a été rejoué.
L'historique Resend est conservé, notamment pour les anciens reçus/rebonds.

## Architecture et garanties techniques

1. Les dix points d'envoi Edge passent par `email-provider-request.mjs`.
2. Une requête AES-GCM authentifiée et sa réponse chiffrée traversent uniquement
   `http://norva-private-mail-gateway:18185/v1/mail` sur `norva_default`.
3. La passerelle, sans secret ni port publié, rejoint `/bridge/mail.sock`.
4. `norva-private-mail-v1` conserve une file SQLite persistante, WAL/FULL,
   avec corps chiffrés et identités d'envoi stables.
5. Une commande SSH forcée prépare le MIME/DKIM dans Postal, puis effectue
   l'envoi SMTP avec STARTTLS vérifié. Aucun worker Postal sortant concurrent
   ne doit être démarré.
6. Les reçus sont rapprochés de `norva_postal_full` et des six familles
   d'outboxes métier ; l'authentification accuse réception de sa file durable,
   pas d'une réception en boîte principale.

Le pare-feu hôte bloque volontairement l'accès Edge direct à `172.18.0.1:18185`.
Cette adresse reste un diagnostic **local hôte**, jamais la destination Edge.
La passerelle Unix corrige ce point sans changement du pare-feu.

L'autorisation est vérifiée avant et après la préparation MIME. Les erreurs
temporaires ont des reprises bornées ; un résultat incertain après DATA est
terminal et n'est jamais rejoué automatiquement. Aucun secours Resend.
Limites initiales : 1 000 nouveaux messages/jour, 500 actifs, priorité Auth,
expiration Auth 15 minutes et métier 24 heures, 12 essais SMTP au maximum.
Ne pas annoncer une livraison universelle ni un placement garanti en boîte principale.

Les rebonds corrélés/signés alimentent les exclusions. Les plaintes vérifiées
peuvent être enregistrées par l'opérateur avec une preuve ; aucun collecteur
JMRP/SNDS universel n'est revendiqué. Le classement Outlook en spam a été
explicitement accepté par le propriétaire et reste distinct de la migration.

## Vérifications effectuées

- 40 contrôles PostgreSQL isolés, redémarrage et restauration ; les six
  familles de complétion sont exercées sans achat ni suppression réelle.
- 150 tests ciblés Node réussis : signatures Auth, deux destinataires, OTP,
  transport chiffré, reprises, conversions, suppressions et files métier.
- Suite complète : **3 695 réussis, 0 échec, 3 ignorés** (3 698 au total),
  puis vérifications i18n et modèle régional réussies. Les deux problèmes de
  dépendances du worktree et une assertion sensible aux CRLF Windows ont été
  résolus localement sans modifier le produit ni le test UI hors périmètre.
- 10 tests Python SMTP/DNS, dont DNS hors conteneur Postal isolé.
- 18 sondes de démarrage HTTP sur les deux Edge ; rejet des hooks non signés.
- Premier email depuis une véritable outbox : reçu en Primary Gmail à 11:45
  heure de Paris, puis complété en base avec reçu Postal et sans reçu Resend.
- Second test : créé dans l'outbox et laissé au **cron de production normal**,
  sans appel manuel de la complétion. Son état courant est exposé par
  `verify-production.py` et `live-queue-proof.py --status`.
- Ce second test a été complété par le cron à **12:17:00 heure de Paris** :
  état `sent`, reçu Postal présent, aucun reçu Resend, contenu temporaire effacé.
- Réception du second test vérifiée séparément dans Gmail : un seul résultat
  « Norva - Production worker test », libellé Inbox, horodaté 12:08.
- Un envoi Auth réel a également atteint l'état SMTP `Sent` après activation.

Les erreurs de liaison réseau du second test ont retardé son rapprochement
selon le backoff existant ; elles n'ont pas produit de doublon. SMTP `Sent`,
complétion de l'outbox et réception visible sont trois preuves distinctes.

## Exploitation et reprise

Hôte privé : `/home/adrien/.norva/postal-full-service-v1`.
Sources Edge actives : `/home/adrien/.norva/postal-full-edge-20260906-v1/functions`.
VM : `/var/lib/norva-postal-full-v1`, journal indépendant permanent.

`verify-production.py` est un contrôle en lecture seule, sans contenu client
ni secret. `control.py` contient des opérations explicites : ne pas réutiliser
ses modes d'envoi de test. Le mode `host close` ferme les nouveaux envois mais
ne les redirige pas vers Resend. Ne jamais vider les journaux pour réessayer.

Sauvegardes chiffrées hôte/VM copiées hors serveur et déchiffrées pour contrôle
des empreintes. Les clés privées de récupération restent hors Git. Une
restauration doit garder la configuration désactivée et rapprocher les journaux
PostgreSQL, SQLite et VM avant toute reprise : restaurer une seule base n'est
pas une autorisation de renvoyer.

Derniers exports après bascule et réception :

- Hôte, 6 fichiers : SHA-256 `2f31567d920853881cfeb30be4b8bff7003d8a6d31fae672139641a9406b76b1`.
- VM, 27 fichiers : SHA-256 `421fd534ab98bb3499f1c3742d97a0a514dbab339ac5cc415b2f07923d0dbe6b`.
- Répertoire hors serveur : `.codex/postal-preparation-20260905/full-service-backup-20260906`.

Les migrations sont des installations historiques **gardées et à usage unique**,
déjà appliquées sur Hetzner. Elles ne doivent pas être rejouées par un `db push`.
L'installation neuve exige les prérequis Postal et le schéma privé du pilote
précédent ; ces fichiers ne sont pas un installateur universel sur base vide.
`release-stage.mjs` produit le manifeste du runtime autonome avant construction.

Les noms historiques de quelques helpers/champs (`sendResendDelivery`,
`resend_configured`, erreurs `resend_http_*`) sont des alias de compatibilité,
pas des appels au fournisseur. L'écran admin peut donc encore afficher un
libellé historique. L'API expose désormais `email_provider: postal`.

Ne pas supprimer le compte Resend ni révoquer des clés partagées avec BuildTrack
pour nettoyer ces libellés. Ce nettoyage fournisseur n'est pas nécessaire au
fonctionnement autonome des emails Norva.
