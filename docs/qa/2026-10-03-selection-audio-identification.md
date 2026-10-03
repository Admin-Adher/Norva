# Norva Selection — identification audio des 530 films restants

## Résultat et portée

Contrôle du 3 octobre 2026, relevé exhaustif à **05:25:50 UTC / 07:25:50 Paris**.
La cohorte demandée contient **530 cartes / 533 fichiers physiques**. Chaque
identité a été rapprochée de son URL exacte, de son travail durable et de son
état de publication. L'inventaire JSON voisin contient les 533 lignes, sans URL,
identifiant de propriétaire, reçu cryptographique ou transcription.

**530 → 468 films sans langue identifiée**, soit **62 cartes supplémentaires
résolues** ; 533 → 470 fichiers inconnus, soit 63 fichiers résolus. Les pistes
publiées comprennent portugais, anglais, japonais, coréen et espagnol. Un fichier
peut avoir plusieurs pistes : additionner leurs langues ne donne pas le nombre
de cartes. Le compteur continue d'évoluer avec le traitement.

Ce contrôle exhaustif des dossiers n'est pas une analyse audio réussie de chacun
des 533 fichiers. **L'identification de toute la cohorte reste inachevée.**

| État au relevé | Fichiers |
| --- | ---: |
| Langue publiée, sortis de la cohorte inconnue | 63 |
| Analyse terminée, résultat inconclusif | 78 |
| En file | 184 |
| Attente après ancien rejet de reçus | 79 |
| Attente de capacité, sans consommer une tentative lorsqu'attestée | 102 |
| Attente après ancien refus de lecture/extraction active | 18 |
| Ancienne interruption, reprise planifiée | 2 |
| En cours | 2 |
| HLS natif analysé séparément, inconclusif | 3 |
| Échec terminal de capture Gateway | 1 |
| Échec terminal de profil audio incomplet | 1 |
| **Total** | **533** |

Les 387 fichiers en file/en cours/en attente continuent via le worker existant.
Les 78 résultats inconclusifs ne sont pas remis à zéro automatiquement. Aucun
seuil de certification n'a été abaissé et aucune langue n'est déduite de TMDB,
du titre traduit ou de la majorité portugaise du catalogue.

## Causes démontrées et correctifs réellement déployés

1. **Reçus anciens invalides.** La vérification cryptographique du stock a établi
   103 reçus expirés dans les travaux partiels contrôlés. Avant une nouvelle
   capture, le worker vérifie désormais le préfixe de reçus sur le Gateway.
   Un rejet authentifié réinitialise seulement les reçus de la piste en cours,
   en conservant le profil exact et les pistes déjà certifiées. La file donne
   priorité aux travaux partiels pour réduire les expirations. Ce constat ne
   permet pas d'attribuer tous les anciens rejets à une expiration.
2. **Capacité/refus de lecture dépensant les tentatives.** Le débit de la seule
   tentative courante est rendu par CAS uniquement après attestation de drainage
   du Gateway. Le budget historique, la limite de huit tentatives et la priorité
   des spectateurs sont conservés. Un refus sans attestation reste un échec.
3. **Anciens échecs bloqués malgré réparation.** 273 anciens travaux admissibles
   ont été archivés puis récupérés une seule fois, avec la référence exacte du
   correctif ; deux anciennes interruptions ont suivi une récupération distincte.
   Identité de fichier, URL, propriétaire visible et génération sont revérifiés.
   L'archive unique par fichier empêche les remises à zéro répétées.
4. **Récupération bloquant la file globale.** La récupération opérateur utilise
   désormais un verrou propre au travail. Le verrou et la limite globale des
   deux travaux normaux restent en place. La preuve réelle utilise deux sessions
   PostgreSQL, sous verrou global tenu, avec annulation des écritures de test.
5. **Recherche des propriétaires trop coûteuse.** Le seeder et la recherche des
   propriétaires utilisent les lignes physiques plutôt que la vue enrichie.
   Les 26 456 associations avant/après sont identiques, sans ajout ni suppression.
   Une recherche réelle a terminé en environ 1,5 s après correction.
6. **Une seule route d'analyse.** Les nouveaux travaux se répartissent entre les
   deux Gateways existants. Leur route est persistée ; les anciennes captures
   restent sur leur route initiale. La limite totale demeure deux travaux. Au
   relevé, 53 travaux avec route 0 et 17 avec route 1 étaient terminés : il s'agit
   de résultats réels, pas seulement d'une option activée, et pas du gain de la
   cohorte de 530 cartes.
7. **HLS à segments sans extension.** L'extraction reprend les options HLS déjà
   utilisées par la sonde : protocoles réseau autorisés, `extension_picky=0`.
   Les accès imbriqués `file://` restent refusés. Une fixture réelle, sans réseau
   externe, extrait le MPEG-TS/AAC avec noms de segments sans extension.
8. **Arrêt du worker pendant une capture.** SIGTERM attend désormais une frontière
   drainée et sauvegardée avant de rendre la tentative courante. Les lectures et
   pertes de bail continuent de préempter immédiatement. Les opérateurs attendent
   une sortie propre avec un budget de 240 s avant une modification des modules.
9. **Délais d'inférence désaccordés.** Le client interrompait à 60 s une opération
   locale autorisée jusqu'à 100 s par le serveur, avec handler de 105 s. Il attend
   maintenant 110 s ; l'annulation externe demeure immédiate. C'est un défaut de
   budget corrigé, pas la preuve que les 27 anciens échecs avaient tous dépassé
   60 s. Les inférences observées pendant ce contrôle étaient plus courtes.
10. **Résultats inconclusifs sans explication durable.** Le worker conserve des
    compteurs bornés de passages acceptés, contradictoires, faibles ou répétés.
    Aucune langue candidate ni transcription n'est publiée par ce diagnostic.
    Quatre travaux finis avaient effectivement conservé ces compteurs au relevé.
11. **Longues attentes héritées.** Un passage opérateur a rapproché 61 attentes
    antérieures au premier déploiement : 53 rejets de reçus, huit refus de lecture.
    Seules date de prochaine tentative et date de modification ont changé,
    sous CAS. Profils, preuves, nombre de tentatives et identité sont conservés.
    L'archive privée préalable est conservée ; ce passage ne s'applique pas aux
    analyses inconclusives, aux échecs terminaux ni aux travaux modifiés après
    le début de la réparation.

## Cas réellement analysés et restant sans langue fiable

Les trois entrées HLS absentes du registre fini ont chacune reçu deux audits
audio réels : six passages de 20 s répartis dans le film, puis six régions
disjointes de 60 s avec sélection de 20 s de parole par le VAD de production.
Modèle, évaluateur, plan temporel et seuils de production sont conservés.

| Fichier | Premier audit | Audit avec sélection de parole | Langue publiée |
| --- | --- | --- | --- |
| Get Lucky | 5 passages insuffisants, 1 contradictoire | 2 acceptés, 2 contradictoires, 1 faible, 1 insuffisant | Aucune |
| Sawadikap Pei | 2 acceptés, 2 faibles, 2 insuffisants | 5 acceptés localement, 1 insuffisant ; consensus global refusé | Aucune |
| Godzilla Minus One | 3 acceptés, 1 faible, 2 insuffisants | 3 acceptés, 1 faible, 2 insuffisants | Aucune |

« Accepté localement » ne garantit ni quatre passages indépendants dans une même
langue, ni un consensus global. Les compteurs ne sont pas transformés en certificat.
Leur taille de manifeste HLS n'est jamais déclarée taille d'un fichier vidéo fini.

**Cha Cha Real Smooth O Próximo Passo** reste en échec après huit tentatives.
La sonde normale puis la nouvelle sonde forcée sur l'autre Gateway retournent
une carte audio vide, malgré un profil vidéo/durée/taille. La seconde a terminé
en 4,04 s, `probeComplete=true`, `audioProbeComplete=false`. Cela prouve l'absence
de piste dans ces réponses, pas définitivement l'absence d'audio dans le média.
Aucune langue ni récupération sans correctif démontré n'a été forcée.

**Pequenos Guerreiros** a ensuite atteint huit tentatives, avec cinq reçus
partiels. Le dernier diagnostic est capture / HTTP 502, sans code Gateway précis.
Sa cause fournisseur fine reste non démontrée ; ce cas n'est pas réinitialisé.

## Parité, sécurité et versions

Même image sur les deux Gateways :
`sha256:eece83dc932b3506d72aa62f9e350faf3b50057c5712f9293036e148122acd0e`.

SHA256 normalisés LF, relus dans les conteneurs de production :

- Gateway `src/index.js` : `f311bfe8677b1dc338d4e31ee385159a4baa6dcd3ca1cd45d1bb11a6b42512be`.
- Worker : `c2bb7199e0353d3acf0dcb332815ac178cd0718cf6a74246d957e3aa6e7a6540`.
- Client Gateway : `5136268efb67b82b42c40af5a303c772c9025fca27a7bc16e6256fc9ef6609d5`.

Secret des reçus identique ; modèle, binaire Whisper, VAD et binaire de sélection
de parole identiques selon les empreintes du runtime. `WHISPER_VAD_BIN` est
explicite sur le pilote et utilise la valeur par défaut sur le principal : les
empreintes effectives confirment le même binaire. Les autres réglages Whisper
comparés sont identiques. Les politiques Selection sont restées vides ; aucune
autorisation privilégiée pour le compte QA n'a été ajoutée.

Worker en marche, concurrence 2, capture activée, sans redémarrage en boucle.
Anciennes images/conteneurs et sources sauvegardés pour retour arrière. Les
migrations `20261003020000` à `20261003024000` sont appliquées dans l'ordre.
Les opérateurs versionnés permettent de reproduire contrôles et déploiements.
Aucun changement de client web, WebView ou Android dans cette réparation serveur.

## Vérifications et pièces conservées

- 51 tests ciblés worker/client réussis après les derniers correctifs : expiration,
  liaison des reçus, admission et drainage, interruption, inférence, publication,
  affinité de route et validation stricte des compteurs. Quatre tests ciblés des
  options HLS complètent la fixture réseau isolée d'extraction et de refus `file://`.
- Rejeux PostgreSQL réels, avec rollback : portée de la récupération, révision
  invalide refusée, récupération unique, idempotence, verrous concurrents et
  équivalence des propriétaires avant/après.
- CI GitHub sur `49649ec77274bd4f34480f9b066991d2c107c093` : Build Norva,
  Verify customer service notices et Norva Partners integration réussis.
- Le navigateur du compte QA ordinaire a confirmé le passage à 476 films inconnus
  à 05:20 UTC ; le relevé SQL exact de 05:25:50 donne ensuite 468. Ces observations
  ne doivent pas être présentées comme simultanées.
- `2026-10-03-selection-audio-identification-inventory.json` : les 533 identités,
  états, langues publiées, progression et compteurs diagnostiques disponibles.
- `2026-10-03-selection-audio-identification-evidence.json` : empreintes relues,
  runtime réel, répartition des travaux et résultats bornés des audits HLS.
- Preuves privées et archives sur le serveur :
  `/home/adrien/.norva/selection-audio-audit-20261003/`, avec les répertoires de
  déploiement `selection-audio-*`, `selection-hls-audio-*` et
  `selection-inference-budget-*`. Aucun contenu privé n'est copié dans ce rapport.

**Ce rapport clôt le contrôle et documente la réparation ; il ne certifie pas
que les 530 langues ont toutes été identifiées.** Le traitement durable reprend
les dossiers admissibles. Restent des analyses inconclusives, trois HLS sans
consensus et deux échecs terminaux, en plus de la file encore active.
