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

## Périmètre confirmé par Adrien

Adrien confirme ne pas disposer du panneau de stockage/livraison MAX OTT ni d'un contact technique. Il demande de terminer le message et l'accès intuitif aux autres versions, en reconnaissant que Norva ne peut pas réparer ces fichiers. L'objectif livré est donc le traitement sûr de l'erreur et le choix explicite d'une autre copie. Aucun contact externe n'est envoyé et aucun remplacement de source n'est revendiqué.

## Intégration et vérifications

PR661 intégrée dans main par 794bbf1265197dd03e1cd9d83019a8849508f6de, code dac0f030635d5b306925db30295bff1c3d3938e5. Les 17 check-runs observés sont réussis, paquets Windows/Phone/TV compris. Android37274114892 : quatre configurations téléphone (gestes/trois boutons et police1/1.3) ont réussi le parcours réel WebView en portrait/paysage, texte zoom100/130, français/anglais, refus et entrée invalide. Les deux contrôles TV portent sur consentement/D-pad, pas sur un décodeur média. TV1.3 a d'abord échoué « Decline reachable » (granted au lieu de denied) puis un unique rerun111648834096 a réussi sans changement de code/seuil ; cause exacte non établie. La première demande de rerun avait été refusée par GitHub car la matrice tournait encore, donc n'avait exécuté aucun test.

Régression Gateway :123 tests réussis,1 verrou Linux ignoré sur Windows,0 échec (124 tests déclarés). Aucun code Gateway modifié. Tests navigateur locaux réussis sur les deux codes,8 scénarios web et4 natifs par code, sans fournisseur. Capture local-invalid-media.png. Serveur et onglet de preuve locaux arrêtés.

## Déploiement Edge

Un seul helper changé sur194 fichiers : _shared/catalog-visibility-response.mjs, SHA-2569fcabd100118c9344f60373f10920a338affe8ece9841d72a5fd2f2c646e6333. Les193 autres fichiers et leurs permissions sont conservés. Runtime /home/adrien/.norva/rust-invalid-media-edge-20261005/runtime-functions ; préserver lors des prochains déploiements. Canary du sanitiseur en réseau none, UID1000 ; canary santé Edge sur réseau Edge normal. Tous arrêtés/retirés, aucun média fournisseur.

Admissions suspendues06:52:34.711469–06:53:15.297448UTC (40,585979s), drainage naturel d'un travail en vol, aucun bail forcé. Edge principal recréé06:53:07.407 et secondaire06:53:11.263. Santé et194empreintes vérifiées06:53:46.918 ; Gateways inchangés sains, cron/admission/worker restaurés et même dispatcher permanent. Marqueur apply consommé, ne pas rejouer. Aucune migrationSQL, configuration fournisseur, langue, modèle, concurrence, quarantaine ou délai modifié. La planification Codex supprimée reste supprimée.

## Vérification finale en production — 09:00–09:04 Paris

Publication Cloudflare37275042943 réussie à06:59:05UTC. Navigateur rechargé : WatchPage ed3f44bf90, standalone acd6de4485 et i18n967117f53a effectivement chargés. Une seule lecture explicite de l'original Rust, sélection active vérifiée, commence07:00:28.671 et échoue07:00:30.779 sans première image. Le message réel est désormais « Les données reçues pour cette copie sont illisibles. Vous pouvez choisir une autre version. », avec Autres versions (action principale et focus), Réessayer cette version et Retour à la fiche. Aucun code interne exposé.

Le clic Autres versions ferme le parcours de lecture et ouvre la fiche Rust avec11 choix, langue audio, sous-titres lorsqu'ils sont connus, fournisseur et conteneur. Focus sur une autre version ; aucune sélection ni lecture alternative automatique. Le navigateur est laissé sur ces choix. Ces11 choix ne sont pas une certification de lecture ni un inventaire exhaustif des18 variantes sous-jacentes liées aux deux titres internes.

Audit read-only07:04:38 : une seule nouvelle session Rust depuis le déploiement, état failed, aucune nouvelle tentative automatique après l'échec ; aucune session Gateway persistée ou première image. Les trois sessions diagnostiques antérieures sont expired. Captures locales production-invalid-media.png et production-other-versions.png. La copie originale reste illisible ; le traitement UX des copies produisant INVALID_MKV_INPUT est corrigé et vérifié. Aucun contact fournisseur ni nouvelle sonde opérateur pendant cette vérification.
