# Rattrapage des tags de langues fournisseur — 3 octobre 2026

## Périmètre et résultat mesuré

La demande porte sur une baisse réelle du filtre « Langue non identifiée », depuis environ 62 040 fiches, vers moins de 10 000 et idéalement 5 000. **Cet objectif n'est pas atteint.** Le compteur représente les fiches ayant au moins une version sans langue ; ce n'est pas un compteur de fichiers, ni uniquement de fiches sans aucune version identifiée.

Après le premier correctif, le navigateur de production affichait **60 477**. Les mesures continuent de varier légèrement avec les traitements automatiques. Aucun seuil, filtre d'inclusion ou critère de preuve n'a été assoupli pour réduire ce compteur.

Après le second rattrapage, la requête de référence retourne **59 849 fiches / 75 749 versions inconnues**. Parmi ces fiches, 17 722 ont également une version identifiée. Le gain comparé aux 62 040 signalées est de 2 191 fiches, environ 3,5 %, et comprend les petites évolutions des traitements concurrents. Ce gain est concret mais n'est pas la baisse drastique demandée.

Au contrôle SQL du 3 octobre à 13:02:30 UTC, le compte contrôlé possède 245 582 fiches films et 452 539 versions visibles. **374 288 versions ont déjà un libellé de langue fournisseur interprété.** Les tags sont donc déjà exploités ; le solde inconnu ne correspond pas à un import où leur extraction serait entièrement absente.

## Audit exhaustif des listes rapides

Les réponses `get_vod_streams` ont été lues intégralement, séquentiellement, via le Gateway et ses protections existantes :

| Fournisseur | Entrées reçues | Durée de la réponse | Champs audio/sous-titres séparés |
| --- | ---: | ---: | --- |
| Dino | 104 729 | 26,77 s | Aucun |
| MAX OTT | 159 379 | 21,18 s | Aucun |
| Strng IPTV 8K | 180 943 | 16,38 s | Aucun |
| Total | 445 051 | — | Aucun |

Cela concerne ces réponses de listes. Certaines fiches individuelles `get_vod_info` contiennent bien des tags de piste et restent exploitées par le rattrapage dédié de la PR 599. Les réponses brutes n'ont pas été publiées ; les artefacts de comparaison ne gardent que les identifiants locaux de contenu, noms, catégories et champs de langue autorisés, sans URL d'accès ni identifiant de connexion.

Les **79 597 versions inconnues** de l'inventaire initial de ces trois fournisseurs sont toutes retrouvées dans les réponses actuelles : Strng 33 338, Dino 13 978, MAX OTT 32 281. Comparaison de chaque nom reçu avec le nom enregistré : 18, 1 et 225 différences respectivement, principalement espaces, normalisation Unicode ou année ajoutée. Aucun nouveau tag audio exploitable n'est récupéré par ces seuls changements de nom. Norva Selection est distinct et n'utilise pas ces listes Xtream.

Les 142 catégories Dino, 181 MAX OTT et 442 Strng ont ensuite été récupérées. Le rattachement par identifiant de catégorie et de fichier ne révèle aucun tag audio supplémentaire par rapport aux catégories déjà enregistrées. Les 5 268 chaînes de catégorie MAX OTT différentes comprennent notamment des espaces de fin ; elles ne débloquent aucune identification supplémentaire. Les demandes différées par le Gateway ont été reprises après disponibilité, sans contourner ses contrôles.

## Corrections

1. Les préfixes `TG` et `TM` sur le rayon complet `VOD - INDIA` sont désormais interprétés comme les déclarations télougoue et tamoule du fournisseur. Les fiches individuelles de `TG - Mistake` et `TM - Mistake` renvoient respectivement `tel` et `tam`. Le code ne généralise pas ces abréviations à d'autres rayons.
2. Les rayons complets `[IN] KANADA` et `[IN] GUJARTI` normalisent deux noms de langues mal orthographiés, kannada et goudjarati. `IN`, `SOUTH INDIA` ou `BOLLYWOOD` seuls n'acquièrent pas de langue.

La première correction reconnaît 3 423 versions précédemment inconnues dans l'inventaire audité. Le rattrapage SQL a inséré **6 844 libellés sur les deux propriétaires concernés**, et ces 6 844 lignes sont bien visibles au contrôle après déploiement. Elles ne correspondent pas à 6 844 fiches devenues entièrement identifiées sur un seul compte. La seconde correction reconnaît 631 versions supplémentaires dans l'inventaire ; sa mesure après déploiement est consignée ci-dessous.

La seconde passe a inséré 1 417 déclarations dans la table de base. Le contrôle par les vues de visibilité confirme **631 versions / 626 fiches visibles pour un propriétaire** ; la différence n'est pas comptabilisée comme un gain utilisateur. Le premier essai de cette passe a rencontré le verrou d'une écriture concurrente et sa transaction a été annulée par le délai de verrouillage de deux secondes. La reprise suivante a abouti ; aucun délai de protection n'a été augmenté.

Les écritures portent uniquement sur les déclarations dérivées, avec contrôle de la version du parseur, lots de 500, clés de propriétaire/source/variante et absence de remplacement d'un indice existant. Les données source, observations de pistes et indices audio de lecture sont préservés. Les caches de facettes et les générations de visibilité des seuls propriétaires concernés sont invalidés.

Les imports futurs emploient le même parseur partagé que l'affichage web et les compteurs SQL. Un tag de sous-titrage ne devient pas une langue audio ; les conflits et mentions MULTI restent soumis aux règles existantes. Les observations exactes du fichier gardent la priorité sur les déclarations fournisseur.

## Vérifications

- 48 tests JavaScript ciblés réussis, dont 33 cas de déclaration indienne après le second correctif.
- 199 cas SQL réussis dans une fonction temporaire, en transaction annulée, après le second correctif.
- Pour le premier correctif : contrôles GitHub de contrats, base jetable, parcours simulés et compilations/tests Android et Windows réussis.
- Navigateur réel après le premier déploiement : la fiche `Mistake` montre trois versions, dont une encore inconnue, une télougoue et une tamoule. Sélectionner la version télougoue met également à jour la langue de la fiche. Aucune lecture n'a été lancée pour obtenir cette preuve de métadonnées.
- Le téléphone n'était pas disponible pour un contrôle Android réel pendant cette passe. Les compilations ne sont pas présentées comme une validation sur appareil.

## Déploiement de référence

Première correction : PR 600, commit intégré `9967dec62a3b06c8f14bd7dde389a7fdf5e7e03a`.

- Deux répliques Edge remplacées successivement, contrôles de santé réussis ; environnements et images conservés. Référence du code monté : `9551a4b113c8652d3f99d33b83bc073607ea97d9`.
- Parseur partagé SHA-256 : `5939d81d94a516454cb6d5175da6b68f9aa70277c6e51ffa5217204866eba639`, identique sur les deux répliques.
- Migration `20261003133000_provider_indian_language_tags.sql` appliquée.
- Web publié par le job Cloudflare `111206565265`, terminé le 3 octobre à 12:55:40 UTC : `https://944718fb.norva-web.pages.dev`.
- Reçu serveur privé : `/home/adrien/.norva/provider-language-tags-20261003/deployment.safe.json`. Le conteneur de contrôle temporaire a été supprimé après vérification.

Seconde correction : PR 601, référence du code `10bc4a6efb3f221d0b8db3e3074aa758fdf82c84`, commit intégré `f360d0e6649a1f842bdc5a138465ce87eaef7c2d`. Tous les contrôles de la PR ont réussi avant intégration.

- Migration `20261003151500_provider_language_shelf_spelling.sql` appliquée.
- Deux répliques Edge mises à jour successivement à 13:11:24 UTC, contrôles de santé réussis ; SHA-256 du parseur identique : `8d5d2d482cb8d43c5bd328a4c712081134715dbb2e1af2149804102b2851abcd`.
- Reçu : `/home/adrien/.norva/provider-language-spelling-20261003/deployment.safe.json`. Rattrapage terminé et caches invalidés ; conteneur temporaire supprimé après vérification.
- Web publié à 13:16:28 UTC par le job Cloudflare `111209931768` : `https://420c42fa.norva-web.pages.dev`. Module réellement chargé dans le navigateur : `/js/utils/mediaUtils.js?v=75a121831d`.
- Contrôle du catalogue MAX OTT dans ce navigateur : `IN| Purushothama` affiche désormais `Kannada`, tandis que sa version `MY| Purushothama` reste inconnue. Les données d'une variante ne sont donc pas copiées dans toutes les versions du film.
- Contrôle indépendant de `IN| GUJARTI| Affraa Taffri` dans MAX OTT : la carte affiche `Goudjarati` après chargement. La recherche est ensuite effacée et la source remise sur « Toutes les sources ».

## Limites établies

- Les noms et catégories indiquent souvent un marché, une plateforme, le sport, `MULTI-SUB` ou `AR-SUBS`, sans identifier l'audio. Ces libellés ne peuvent pas être convertis honnêtement en langues précises.
- L'échantillonnage des fiches individuelles confirme des tags absents ou `und`. Le préfixe `MA` du rayon indien a même fourni plusieurs langues différentes (notamment malayalam, coréen et anglais) ; il n'a pas été transformé globalement en malayalam.
- Le rattrapage de métadonnées est effectivement actif, mais Dino et MAX OTT sont régulièrement différés par les activités fournisseur et les travaux prioritaires du Gateway. Le débit constaté ne permet pas de promettre une résolution rapide des dizaines de milliers de versions restantes. Aucun verrou n'a été supprimé ni aucune protection de lecture contournée.
- La baisse depuis 62 040 doit rester distinguée du nombre de libellés insérés. Une fiche comptant plusieurs versions peut conserver une version inconnue après récupération des autres.
- Aucun résultat de cette passe ne certifie une complétude audio totale, ni l'objectif commercial global à 100 %.
