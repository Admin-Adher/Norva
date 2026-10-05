# Trois VOD MULTI-SUB : vérification des sauts — 5 octobre 2026

## Périmètre et résultat

Essais de production du 5 octobre, 17:23–17:45 UTC (19:23–19:45 Paris), sur les copies exactes MAX OTT choisies par Adrien : Until Dawn, A Breed Apart et What Happens After the Massacre?. Une seule lecture à la fois, gardes et fermetures ordinaires. Aucun code, codec, seuil, route, bail ou paramètre de production modifié.

La dégradation après saut est reproduite. Les observations montrent plusieurs mécanismes : lenteur de préparation après seek, origine de tampon non alignée à la reprise, et trous dans les données de deux copies. Ils ne doivent pas être confondus. Aucun correctif de fluidité n'est déclaré livré par ce contrôle.

## Lecture réelle dans Norva

| Copie | Départ / lecture continue | Reprise ou saut |
|---|---|---|
| Until Dawn | Départ à zéro : prêt serveur 2,400 s ; vidéo ensuite en progression, readyState 4. | Reprise à 194 s : prêt serveur 31,121 s. Saut vers 30 % : 22,331 s. Retour vers 10 % : attente initiale, puis progression. |
| A Breed Apart | Après redémarrage à zéro : temps 6,376 puis 26,905 s, lecture active. | Reprise à 127 s : prêt serveur 33,124 s ; vidéo paused=true/currentTime=0 alors que le tampon commence à 3,569333 s et finit à 31,596333 s. Saut vers 30 % : erreurs EBML, H.264 et AAC dans le décodage ; progression du temps ensuite observée. |
| What Happens After the Massacre? | Départ à zéro et progression observés. Dans sept segments fermés produits sans saut, intervalle vidéo maximal de 4,129 s ; audio continu. | Saut vers 30 % : dans sept segments fermés, intervalle vidéo maximal de 2,085 s ; audio continu. Le temps du lecteur avance pendant les observations, ce qui ne prouve pas la fluidité des images. |

Les analyses des segments lisent uniquement les sorties déjà produites. Elles ne déclenchent aucune acquisition fournisseur supplémentaire. Les passages froids et après saut diffèrent : ces mesures ne constituent pas une comparaison image par image du même passage.

## Contrôle indépendant des données reçues

Un GET borné par copie, via libcurl système hors code média Norva, sur le même proxy HTTP CONNECT épinglé. Claim direct ordinaire, heartbeat 0,5 s avec timeout 1 s, arrêt avant expiration, expiration normale et suppression des fichiers temporaires. Analyse ffprobe locale en conteneur sans réseau ni GPU. La limite est 40 MiB ou 45 s ; aucune relance ni rotation d'IP.

| Copie | Taille / durée réseau | Structure et horodatages du préfixe |
|---|---|---|
| Until Dawn | 26 161 349 octets / 45,032 s ; limite de temps curl atteinte | Aucun diagnostic EBML/invalid ; aucune plage de zéros >=64 KiB. Environ 81 s disponibles : intervalle vidéo maximal 0,126 s, audio 0,023 s ; aucun intervalle >0,25 s. |
| A Breed Apart | 41 943 040 octets / 9,079 s ; arrêt intentionnel à la borne | 17 plages de zéros >=64 KiB ; 10 diagnostics EBML et 10 invalid. Sur les 100 premières secondes analysées : trous vidéo jusqu'à 5,922 s et audio jusqu'à 5,740 s. |
| What Happens After the Massacre? | 41 943 040 octets / 22,038 s ; arrêt intentionnel à la borne | 11 plages de zéros >=64 KiB ; 11 diagnostics EBML et 11 invalid. Sur les 100 premières secondes analysées : trous vidéo jusqu'à 5,672 s et audio jusqu'à 5,570 s. |

Ces résultats situent les anomalies des deux derniers préfixes avant le traitement média Norva. Ils ne départagent pas le stockage/livraison fournisseur et le relais proxy commun. Le préfixe propre d'Until Dawn ne certifie pas le reste du film ni les positions atteintes par saut. Un code de sortie ffprobe 0 ne signifie pas absence de corruption.

Empreintes SHA-256 des préfixes supprimés :
- Until Dawn : 17bf74aa63a7cf2581f383262006506bf2fdc701fda667506e509b92097782b6
- A Breed Apart : cbfb96aa6513d8179cda435da9f7cf6da5c4fc7af77ddedc5be18ffc655ddfd3
- Massacre : 6fddd97067914efa654d9ab0903f4a1e7d16095d5daec27eccf45c3c7b8bd2b6

## Défauts Norva à traiter séparément

1. La reprise MKV utilise un lecteur par plages de 2 MiB, alors que le départ à zéro peut garder une entrée séquentielle. L'écart de préparation est mesuré sur Until Dawn, mais la part causale de chaque étape réseau/index/décodage reste à isoler. Aucune augmentation de fenêtre ou baisse de réserve n'est appliquée sur supposition.
2. Sur A Breed Apart, le tampon initial commence à 3,569333 s tandis que la position reste à zéro. Le garde de démarrage n'aligne actuellement qu'une origine fraîche <=1 s ; il ne peut donc compter la réserve à cette position. Ce défaut concret mérite une correction de l'origine temporelle et un test de non-régression conservant les protections contre les sauts involontaires. L'essai a été interrompu avant le timeout complet : pas de panne terminale de six minutes observée.
3. Un redémarrage à zéro d'Until Dawn a reçu un HTTP 500 claim-session à 17:23:57, avant création de la nouvelle session. Le réessai utilisateur ordinaire suivant a réussi. La cause SQL/réseau n'est pas établie. Une télémétrie play_started sur l'ancienne session juste après playback_error ne constitue pas une réussite réelle ; le cycle de télémétrie des seeks mérite également une correction.

La comparaison continue d'A Breed Apart jusqu'au passage exact à 127 s n'a pas été réalisée : le contrôle froid UI s'est arrêté vers 27 s, et le contrôle indépendant décrit seulement les 100 premières secondes. Ne pas la revendiquer.

## Conservation et fin des essais

Reçus anonymisés et scripts sous `.codex-artifacts/three-vod-seek-20261005/`. Les détails privés restent sur le serveur. Tous les trois opérateurs indépendants sont consommés, leurs sessions expirées et leurs fichiers binaires/header supprimés. Ne pas rejouer leurs marqueurs. Audit à 17:45:18 UTC : aucune session active correspondant aux trois cibles. Navigateur rendu à la grille Films. Ce contrôle ne certifie pas l'absence de lectures d'autres propriétaires.

Les confirmations humaines d'audio anglais des trois copies sont distinctes de cet audit de fluidité. Aucun succès de reconnaissance audio ajouté.

## Correctif du lecteur en préparation

La garde calcule désormais la réserve depuis une origine positive attestée, sans déplacer le lecteur avant que la réserve normale ou la preuve adaptative existante soit acquise. Au-delà d'une seconde, elle exige un élément jamais joué, des plages buffered/seekable concordantes, le premier fragment de la liste (séquence 0 ou 1), une origine comprise dans ce fragment et bornée à 12,25 s. Une liste glissante, une lecture antérieure, une pause explicite ou un seek local en attente n'autorisent pas cet alignement. Changer d'origine réinitialise la mesure de croissance.

Le remplacement Gateway après seek démarre aussi un nouveau contexte de télémétrie après fermeture de l'ancien flux. Les événements play d'un élément en pause ou en erreur ne sont plus considérés comme un démarrage réussi. Aucune modification du lecteur réseau, du fournisseur, du codec ou des seuils.

Validation locale : 191 tests WatchPage réussis, dont reproduction de l'origine 3,569333, réserve insuffisante, début de liste manquant, plages discordantes, pause, lecture antérieure et croissance adaptative. La fixture partagée Android contient aussi le cas 3,569333. À ce stade, validation émulateur et rejeu de production restent à effectuer.
