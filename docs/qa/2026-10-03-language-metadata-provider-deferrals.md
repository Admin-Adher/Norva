# Métadonnées audio : reports fournisseur — 3 octobre 2026

## Défaut confirmé

`runOwnedMovieLanguageMetadata` vérifie deux fois les circuits fournisseur : avant de réclamer un bail, puis juste avant la requête réseau. Les refus explicites locaux remontaient au gestionnaire générique comme des échecs de fichier à issue incertaine. Aucune requête n'avait pourtant commencé. Cela consommait une tentative et maintenait inutilement un bail de métadonnées de trois minutes.

Le contrôle de production de 19:13 UTC relève huit nouvelles tentatives MAX OTT portant `metadata-request-failed`, alors que le circuit de sondes est effectivement ouvert jusqu'à 19:33 UTC. Le contrôle du code et les essais exécutant les vraies fonctions reproduisent le classement erroné. Les erreurs historiques ne sont ni effacées ni requalifiées sans preuve individuelle.

Une réponse HTTP 200 entièrement reçue mais de forme invalide conservait aussi l'exclusion réseau. Cette issue demeure un échec de métadonnées ; seule l'incertitude de transport est levée lorsque le corps a effectivement été reçu.

## Correction

- Seuls les deux codes explicites `PROVIDER_ACCOUNT_BUSY` et `PROVIDER_PROBE_CIRCUIT_OPEN`, produits par les garde-fous locaux, deviennent des reports avant réseau : zéro requête, zéro tentative dépensée, aucune incertitude de transport.
- Le bail fournisseur éventuellement acquis au deuxième garde-fou est libéré par le `finally` existant.
- Les exceptions SQL inconnues et les exceptions de transport conservent le traitement prudent. Une exception réseau portant un code ressemblant à un garde-fou n'obtient pas cette exemption.
- Le reçu d'un corps invalide entièrement consommé indique `transportCompleted=true`, tout en restant un échec avec la politique normale de nouvelle tentative.
- Priorité aux lecteurs, contrôles de propriétaire/source/génération, circuits fournisseur, plafonds et quarantaines conservés.

## Vérification

**58 tests ciblés réussis** : précontrôles aux deux étapes, bail libéré après la deuxième, aucune requête sur report, échec de transport réellement incertain, forme invalide après réception, écriture cloisonnée, finalisation des reçus et ordonnanceur de campagne.

Le premier contrôle CI complet a signalé trois échecs du banc de test existant : il extrayait seulement l'ancienne fonction et omettait son nouveau helper. Le banc charge maintenant les deux vraies fonctions ; ses assertions sur les accès, écritures et exclusions restent en place.

Le candidat Edge isolé utilise le même réseau, la même configuration et les mêmes garde-fous que la production. MAX OTT et Dino ont répondu HTTP 200 en 0,77–1,18 s avec un report d'occupation, zéro tentative, zéro échec. Ce contrôle valide le respect de l'occupation réelle ; il ne prétend pas avoir traversé le nouveau garde-fou de circuit, situé plus loin, ni avoir identifié une langue.

## Livraison

PR 608, code `3518bf72a588d7940136190eacba0c2e6c1dd087`, banc corrigé `3ed47b83a`.

Empreinte de `norva-playback/index.ts` déployé sur les deux Edge à **19:23:12 UTC** : `b8eb6211524bc9ebafd1e70ba183f30430b2257e76228aaab2d0e9a77894bef3`. Référence antérieure vérifiée identique sur les deux routes avant remplacement. Aucun changement d'image, de configuration fournisseur ou de Gateway.

Le contrôle CI cloud a réussi : 40 contrôles SQL, puis 5 781 tests de régression réussis, zéro échec et 27 tests sautés selon leur configuration. Les contrôles i18n, région et syntaxe ont réussi. Les constructions natives sont indépendantes de ce changement serveur et ne constituent pas une nouvelle validation Android de la campagne.

Les admissions ont été suspendues le temps de terminer les travaux existants, puis l'état précédent a été rétabli (`enrichment_paused=false`, cron strict actif, STOP absent). Aucun bail n'a été supprimé et aucune sonde active n'a été annulée. Le candidat isolé est arrêté.

**Essai réel en production après publication** : MAX OTT renvoie HTTP 200 en 0,49 s, `provider_probe_circuit_open`, une entrée différée, zéro tentative et zéro échec. À 19:23:43, deux lignes portent ce report avec `attempts=0` et aucun bail actif. Les huit anciennes tentatives `metadata-request-failed` restent inchangées. Cela valide le nouveau parcours de report sans contourner le circuit ouvert.

À 19:23:28 : les deux Gateways répondent HTTP 200, aucune erreur HTTP supplémentaire du dispatcher, 106 lots de métadonnées non vides terminés depuis 18:01:46. Les diagnostics Edge sont à zéro depuis leur recréation ; le relevé distinct de 19:12 conservé dans les preuves certifie déjà zéro expiration SQL entre 18:01 et 19:12. Le redémarrage des conteneurs ne doit pas être présenté comme conservant leurs anciens journaux.

Cette correction supprime des attentes artificielles ; elle ne réduit pas les pauses fournisseur légitimes et ne prouve pas une hausse mesurée du débit après publication. La campagne et le suivi horaire restent actifs.
