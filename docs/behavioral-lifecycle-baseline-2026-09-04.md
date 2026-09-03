# Baseline comportementale avant déploiement — 4 septembre 2026

> Portée : photographie agrégée et en lecture seule, sans identifiant utilisateur, URL de fournisseur, secret ou autre donnée personnelle. Cette baseline ne prouve aucune attribution Google Ads et n'autorise ni déploiement, ni activation, ni envoi.

## Sources et fenêtre

- Fenêtre : 14 jours calendaires, fuseau d'analyse `Europe/Paris`.
- Vérité métier : PostgreSQL Hetzner, lecture agrégée générée entre `2026-09-03T22:29:54Z` et `2026-09-03T22:29:59Z`.
- Couverture analytique : propriété GA4/Firebase `543876012`, interrogée le 4 septembre 2026.
- Base de mesure Hetzner : cohorte d'inscriptions et résultats connus à la date de génération.
- Limite d'attribution : aucun `gclid`, identifiant de campagne ou Play Install Referrer n'est actuellement stocké avec l'inscription. Les filtres pays/plateforme décrivent une corrélation, pas une attribution publicitaire démontrée.

## Funnel Hetzner observé

| Cohorte | Inscriptions | Essais démarrés | Paiements après essai | Accès actif |
|---|---:|---:|---:|---:|
| Tous pays et plateformes | 126 | 0 | 0 | 0 |
| Inde, Android mobile | 109 | 0 | 0 | 0 |
| Bangladesh, Android mobile | 4 | 0 | 0 | 0 |

Ces valeurs ne doivent pas être interprétées comme des conversions Google Ads tant que l'attribution directe n'est pas instrumentée.

## Tentatives de connexion de source

| Cohorte | Tentatives | Acceptées | Échouées | Taux d'acceptation |
|---|---:|---:|---:|---:|
| Tous pays et plateformes | 71 | 1 | 70 | 1,41 % |
| Inde, Android mobile | 48 | 1 | 47 | 2,08 % |
| Bangladesh, Android mobile | 4 | 0 | 4 | 0 % |

Répartition globale :

- M3U : 45 tentatives, une acceptée ;
- Xtream : 26 tentatives, aucune acceptée ;
- `invalid_input` : 44 échecs (`30 × 422`, `14 × 400`) ;
- fournisseur inaccessible : 16 échecs `502` ;
- endpoint introuvable : cinq échecs `404` ;
- format de playlist : deux échecs `400` ;
- identifiants manquants : un échec `422` ;
- timeout : un échec `504` ;
- autre : un échec `413`.

La version Android `1.3.16` ne représente que trois tentatives : une en Inde et deux au Bangladesh. Cet échantillon est insuffisant pour conclure que la correction récente de l'import fonctionne ou échoue. La majorité des observations provient de `1.3.15` (46 tentatives) et `1.3.14` (14 tentatives).

## Couverture GA4/Firebase

Événements produit observés :

| Événement | Nombre d'événements sur la fenêtre |
|---|---:|
| `first_open` | 311 |
| `sign_up` | 4 |
| `provider_connect_started` | 21 |
| `provider_connected` | 3 |
| `catalog_sync_started` | 4 |
| `content_opened` | 261 |
| `playback_started` | 205 |
| `playback_first_frame` | 195 |

`catalog_ready` n'a pas été observé. Les comptes d'événements GA4 ne constituent pas un funnel utilisateur strictement ordonné et ne doivent pas être comparés directement aux cohortes Hetzner.

Les 16 événements exacts du futur moteur sont tous absents de GA4 avant déploiement :

`message_eligible`, `message_queued`, `message_sent`, `message_provider_accepted`, `message_delivered`, `message_opened`, `deep_link_opened`, `source_form_opened`, `source_attempted`, `import_success`, `first_play`, `playback_resumed`, `trial_started`, `subscription_started`, `message_cancelled_after_conversion`, `email_unsubscribed`.

Cette absence est cohérente avec un moteur non déployé et non activé ; elle n'est pas une preuve d'échec du code préparé.

## Contrat de réconciliation

Hetzner reste le registre canonique des 16 événements de cycle de vie, notamment pour la file, les transitions de transport, l'annulation et la désinscription. Firebase/GA4 conserve un vocabulaire produit et client : ouverture, inscription, tentative de connexion, synchronisation, catalogue prêt et lecture.

La future vérification ne demandera donc pas une égalité artificielle de tous les événements serveur dans GA4. Elle devra prouver :

1. l'exhaustivité et l'ordre des 16 événements dans le journal Hetzner ;
2. la correspondance documentée des jalons client avec les événements produit GA4/Firebase ;
3. la cohérence agrégée par pays, plateforme et version dans une tolérance explicitée ;
4. l'absence de doublon, de relance après conversion et de PII dans les deux systèmes.

## Décision de préparation

Le taux d'acceptation de source de 1,41 % confirme que la fiabilisation de l'import reste un prérequis produit. Les automatisations ne doivent pas être activées pour renvoyer davantage d'utilisateurs vers ce parcours tant que :

- la version corrigée ne dispose pas d'un échantillon suffisant ;
- `catalog_ready` et les jalons de conversion ne sont pas vérifiés de bout en bout ;
- les scénarios M3U, Xtream et gros catalogue ne sont pas rejoués sur un staging réaliste ;
- les sept preuves externes de l'audit de complétude ne sont pas réunies.

Cette baseline sert de point de comparaison aux rapports J+7/J+14 ultérieurs. Elle ne remplace ni un pilote autorisé ni son groupe témoin permanent de 10 %.

La mise en oeuvre ajoute une attestation append-only de préparation de l'import, liée au commit, à la version Android et au SHA-256 de l'artefact. Elle devra confirmer M3U, Xtream, catalogue d'au moins 25 000 entrées, guidage d'erreur et WebView Android sur la release exacte. Une attestation absente, échouée ou âgée de plus de quatorze jours interdit le pilote ; elle ne modifie pas rétrospectivement cette baseline.
