# Norva Growth MCP (lecture seule)

Serveur MCP local qui expose des agrégats de croissance depuis la base PostgreSQL de production auto-hébergée sur Hetzner.

## Garanties

- connexion par la clé SSH locale déjà configurée ;
- requêtes SQL fixes et transactions `READ ONLY` avec timeout ;
- aucun outil d’écriture et aucun SQL arbitraire ;
- aucune adresse e-mail, UUID utilisateur, identifiant de paiement ou autre donnée personnelle dans les réponses ;
- exclusion des comptes internes déclarés dans `public.admin_internal_accounts` ;
- aucun `user_id` n’est conservé dans la télémétrie des connexions de catalogue ;
- aucun hash d’hôte individuel, URL, chemin, paramètre, identifiant ou mot de passe n’est retourné par le MCP ;
- séparation explicite entre corrélation Google Ads (pays + plateforme + période) et attribution directe.

Le serveur n’utilise aucun service Supabase managé. Le nom `supabase/migrations` présent dans le dépôt est historique : la source interrogée est PostgreSQL dans le conteneur `norva-db` de la stack Hetzner.

## Outils

- `norva_health_check`
- `norva_get_growth_funnel`
- `norva_get_daily_growth`
- `norva_get_attribution_quality`
- `norva_get_source_connection_attempts`

`norva_get_source_connection_attempts` résume les tentatives M3U/Xtream par domaine racine, forme de chemin (`get.php`, `player_api.php`, `.m3u8`, etc.), résultat/statut, famille d’erreur, plateforme, pays d’inscription, version de l’application et jour. La matrice `by_connection_pattern` relie domaine + type + forme + résultat afin de distinguer concrètement une page web d’un endpoint de fournisseur. Le hash SHA-256 du nom d’hôte exact (sans port) sert uniquement à compter les groupes distincts ; sa valeur n’est jamais exposée. Les lignes expirent automatiquement après 90 jours.

Le pays de ce diagnostic est celui capturé lors de l’inscription du compte. Il ne s’agit pas d’une géolocalisation de la requête d’import. La version Android provient du suffixe User-Agent Norva ; les builds publiés avant cette instrumentation peuvent donc apparaître avec leur ancien marqueur jusqu’à leur mise à jour.

Quand le formulaire refuse localement une adresse incomplète, le navigateur calcule d’abord le domaine racine, la forme et le hash, puis transmet uniquement ces valeurs bornées à `/sources/attempt`. L’endpoint authentifié refuse tout champ supplémentaire et limite ces signaux à 12 par minute et par compte dans chaque instance Edge. L’adresse saisie n’est jamais envoyée à cet endpoint de diagnostic.

Le diagnostic d’attribution compare aussi le nombre de comptes créés dans `auth.users` au nombre d’utilisateurs possédant une ligne dans `cloud_signup_attribution`, afin de signaler un éventuel sous-comptage de capture.

Les deux outils de funnel mesurent des **cohortes d’inscription**. Exemple : la ligne du 2 septembre indique combien d’inscrits du 2 septembre ont, au moment de la lecture, commencé un essai ou payé après cet essai. Elle ne représente pas nécessairement les paiements survenus le 2 septembre.

## Exécution locale

```powershell
node "C:\Users\AdrienHernandez\Documents\Norva repo\tools\norva-growth-mcp\server.mjs"
```

Variables facultatives :

- `NORVA_HETZNER_SSH_TARGET` (défaut : `adrien@157.180.96.159`)
- `NORVA_HETZNER_DB_CONTAINER` (défaut : `norva-db`)
- `NORVA_HETZNER_DB_USER` (défaut : `postgres`)
- `NORVA_HETZNER_DB_NAME` (défaut : `postgres`)

## Limite d’attribution actuelle

`public.cloud_signup_attribution` conserve le pays, la plateforme et l’heure, mais pas encore `gclid`, `gbraid`, `wbraid`, l’identifiant de campagne ni Google Play Install Referrer. Une inscription Android en Inde pendant la campagne peut donc être corrélée à la campagne, mais pas attribuée de façon certaine. `norva_get_attribution_quality` rend cette limite visible dans chaque analyse.
