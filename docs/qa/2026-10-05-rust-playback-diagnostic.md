# Rust MULTI-SUB — diagnostic du 5 octobre 2026, 08:35–08:38 Paris

## Résultat
La copie exacte Rust [MULTI-SUB] de MAX OTT a échoué trois fois à 06:31:00, 06:31:05 et 06:31:10 UTC, avant création d'une session Gateway persistée ou première image. Les événements conservés indiquent gateway_502 / INVALID_MKV_INPUT. Le Gateway secondaire confirme « Provider response is not a Matroska file ». Aucun refus HTTP 403 n'est établi pour ces essais.

Un contrôle système libcurl indépendant du lecteur média Norva, sur la même cible et le même proxy HTTP CONNECT secondaire slot 1, a reçu HTTP 206 après redirection. Content-Range commence à zéro et annonce 2 767 471 612 octets. Le préfixe borné de 65 536 octets a été reçu en 1,799 seconde ; les 377 premiers octets sont tous nuls. Aucun en-tête Matroska, MP4 ou synchronisation TS initiale n'est reconnu. SHA-256 du préfixe : de2f256064a0af797747c2b97505dc0b9f3df0de4f489eac731c23ae9ca9cc31.

Cette preuve situe le préfixe invalide avant le traitement média Norva. Elle ne distingue pas stockage distant et relais proxy commun. Elle ne prouve pas que tout le fichier est nul ou irrécupérable. Aucun essai de contournement de l'en-tête n'a été réalisé.

## Correctifs antérieurs
Les deux Edge chargent le helper de PR640, SHA-256 6dde13f1e4b904f92a45ac949c4d6faf7cddf4281f53b86dc4e9bbcb0221cf4c. PROVIDER_FILE_REFUSED figure bien dans l'allowlist, INVALID_MKV_INPUT en est absent. Le parcours de récupération web est spécialisé sur PROVIDER_FILE_REFUSED. Cela explique pourquoi la correction des refus n'offre pas ses actions pour cette autre erreur. Aucune régression du correctif 403 n'est démontrée. Aucun nouveau correctif ou déploiement n'est revendiqué.

## Protections et état final
Un seul diagnostic opérateur, sans retry, claim direct ordinaire avec vérification de la cible exacte et de l'affinité du proxy, heartbeat 0,5 seconde / timeout 1 seconde, arrêt borné puis expiration acquittée. Contrôle préalable sans lecteur Gateway. Préfixe, en-têtes et log curl supprimés après preuve. Marqueur prefix-diagnostic.consumed : ne pas rejouer. Deux Gateways HTTP 200 après contrôle ; deux Edge en fonctionnement, démarrages inchangés. Aucun changement de copie, configuration, codec, garde, bail forcé ou langue.

Reçus locaux : .codex-artifacts/rust-playback-20261005/prefix.safe.json. Opérateur conservé pour audit seulement : prefix-diagnostic.py. La copie originale demeure non réparée ; le défaut de présentation de cette erreur reste distinct du défaut des octets reçus.
## Investigation complémentaire — 08:39–08:41 Paris

Deux contrôles différentiels uniques, sans retry ni changement de route : GET sans Range, préfixe 8 Mio, puis GET Range exact 0–262143. Ils utilisent les mêmes claims ordinaires, cible hashée, proxy et heartbeat que le premier diagnostic. Les corps, en-têtes et logs sont supprimés après preuve, chaque session expire normalement. Marqueurs distincts consommés, ne pas rejouer.

Le GET sans Range renvoie HTTP 200 après redirection, 8 388 608 octets en 2,941 s, SHA-256 18b504a6f9a5d6b0b1b8220955bdd3e70d0bcd07c9b47d4f6f34fcdd4f75e7aa. Premier octet non nul à 262 144 ; aucune signature EBML, Segment ou Tracks trouvée dans cet échantillon, une signature Cluster à 1 106 016. Une signature seule ne valide pas la structure complète ni la décodabilité.

Le GET limité aux seuls 262 144 premiers octets renvoie HTTP 206 et Content-Range exact 0–262143/2767471612. Tous ces octets sont nuls, SHA-256 8a39d2abd3999ab73c34db2476849cddf303ce389b35826850f9a700589b4a90. Le hash des 64 Kio initiaux correspond au premier contrôle et au GET sans Range. La panne n'est donc pas expliquée par une différence simple entre GET complet et requête de plage.

Cause immédiate établie : la réponse livrée a perdu son en-tête MKV et les faits de pistes nécessaires. La cause de ces données nulles dans le stockage ou la livraison derrière le proxy commun reste inconnue. Aucune reconstruction spéculative d'en-tête, saut de préfixe ou substitution silencieuse n'est admissible. Pour réparer cette copie originale il faut une livraison correcte ou un remplacement à la source, non réalisé ici.

## Correctif Norva préparé

L'allowlist conserve désormais INVALID_MKV_INPUT dans les deux passages de sanitisation. Le Web et le démarrage natif via WebView affichent une explication localisée en dix langues et les trois actions explicites existantes. Ce code est terminal : aucun retry automatique ou conversion cachée. Une erreur de données ne pose pas le marqueur « refus récent », réservé aux vrais refus d'accès. Les gardes de fermeture, identité, propriétaire, langues et sélection restent celles du parcours de récupération. Ce changement corrige le traitement de toutes les copies produisant ce code, pas leurs octets source.

Tests locaux : 98 tests réussis (chaîne Edge/cloudApi/UI, reprise native, fermeture/handoff), plus groupe initial 108 tests recoupés. Premier build i18n a détecté le champ source manquant dans la nouvelle entrée ; corrigé avant build réussi. Aucun déploiement à ce stade.
