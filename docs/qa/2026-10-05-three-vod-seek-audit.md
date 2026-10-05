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

## Rejeu de PR665 et second défaut isolé

PR665 fusionnée c6d63d84d903ac8ff962aa91330955fa59899b50, tête c11c97a058f9d9e70d34175fd06f9c4465259adc. Matrice Android37353483495 : six jobs réussis sur le même code applicatif 80ae4a1e2 (tête suivante : manifeste généré seul). Ancienne matrice37353124479 annulée après adaptation de la preuve seekable native. Contrats, Phone/TV/Windows réussis. Cloudflare37354269505 réussi ; suite5968 tests,5941 réussis,27 ignorés,0 échec. DOM réel WatchPage.js?v=5ed456ed1d.

À18:16:59UTC, A Breed Apart repris1857s : t27,260/pausedfalse/ready4. Ajustement du curseur a envoyé95s puis119s ; deux remplacements ordinaires successifs, pas simultanéité média revendiquée. À18:18:25, flux119s tampon[1,517333;17,534333], t0/pausedtrue ; politique1,57x non éligible, préparation serveur58,816s. À18:19:51, tampon[1,517333;111,544333], t1,517333 : alignement effectif après réserve, mais pausedtrue. Le second seek avait lu la pause technique créée par le premier et capturé autoplayfalse. L'alignement est vérifié, pas la reprise automatique dans ce cas.

Correctif complémentaire : conserver l'intention de lecture durant le remplacement et le remplissage, bornée à la tentative courante. Une pause explicite reste prioritaire, le début d'une nouvelle tentative efface l'intention et un play valide la termine. La fixture WebView reproduit lecture active -> démontage/paused -> second seek, pause explicite, autre titre et rebuffer automatique. Aucun changement de concurrence, route, seuil ou données média.

## Publication du second correctif et contrôles bornés

PR666 fusionnée par 2e9bc0fcd66a821b718a243432c2f23791be8203, code53c9f80b767995bded2d3eda5179b353e674f360. 192 tests locaux WatchPage réussis ; groupe ciblé de36 recoupé. Build37355434128 : contrats et paquets Phone/TV/Windows réussis. Matrice37355435607 : six configurations réussies au relevé final. Premier échec TVfont1.3 conservé : ConsentDpadInstrumentedTest attendait granted, a reçu denied. Une demande de relance ciblée après fin du workflow a été faite ; le relevé final retourne six jobs réussis, dont TVfont1.3 job111919866259. Aucun seuil de test modifié. Ce test TV ne certifie pas le décodage vidéo.

Rejeux sous PR665 (avant la publication PR666), même copie exacte, une lecture à la fois :

- Until Dawn : reprise659s prête serveur13,594s, politique adaptative non éligible1,249x ; attente de la réserve normale, puis lecture automatique. Saut1857s prêt17,577s, politique éligible2,243x. À18:30:57, t9,414841/pausedfalse/ready4/errornull ; à18:31:42, t54,401211. Sept segments fermés relus sans I/O fournisseur à18:31:33 :335 paquets vidéo, intervalle maximal0,042s ;655 paquets audio, maximum0,021334s, zéro intervalle>65ms. Environ14s de sortie examinées, pas une certification du film. La variation de préparation réseau ne constitue pas un gain causal prouvé du correctif client.
- What Happens After the Massacre? : saut1441s prêt serveur27,028s, politique éligible5,063x. À18:35:47, t10,306642/pausedfalse/ready4/errornull ; à18:36:14, t37,454018. Sept segments fermés à18:36:09 :138 paquets vidéo sur9,218s, un intervalle3,545s ;434 paquets audio, maximum0,021334s. La reprise fonctionne, mais un gel vidéo résiduel demeure. Diagnostics EBML et références manquantes encore présents ; les données endommagées préalablement constatées ne sont pas réparées.

Lectures clôturées naturellement par retour Films à18:31:42 et18:36:14UTC. Les confirmations de langue et la campagne audio sont inchangées. Aucun codec, route, Gateway, Edge, concurrence ou garde fournisseur modifié.

Publication Cloudflare37357094996 réussie, job111922153659 :5968 tests,5941 réussis,27 ignorés,zéro échec. Navigateur rechargé hors lecture, DOM réel WatchPage.js?v=9cbeb7d244. Cette livraison concerne le lecteur Web/WebView ; aucun nouveau paquet Google Play envoyé.

### Rejeu final PR666 — A Breed Apart

Nouvelle version9cbeb7d244 chargée. Reprise120s : play_started18:39:13, serveur31,378s. Puis sauts successifs : sessions ordinaires créées18:39:32 et18:39:36 ; la première est remplacée avant première image, la dernière vise1814s. Son play_started est enregistré18:40:23,775, first_frame18:40:23,880 (TTFF48,430s), préparation serveur42,635s. Aucun clic Lecture nécessaire après les sauts. DOM18:41:18 : t54,541331/pausedfalse/ready4/errornull ; DOM18:41:46 : t83,156522/pausedfalse/ready4/errornull. La progression correspond aux28,615s écoulées. La perte d'intention de lecture est corrigée dans ce rejeu, sans annoncer une réduction garantie de la préparation.

Limite résiduelle : sept segments fermés relus18:41:39 sans nouveau média fournisseur contiennent262 paquets vidéo sur13,972s, intervalle maximal2,127s, deux intervalles>250ms ; audio657 paquets, maximum0,021334s. Capture visuelle18:41:46 montre encore des blocs vidéo altérés. La lecture avance mais cette copie n'est PAS certifiée fluide. Les deux préfixes endommagés identifiés pendant l'audit restent une limite distincte, sans attribution certaine entre livraison fournisseur et proxy commun.

Retour Films18:41:55 environ, audit18:42 : les trois sessions de ce rejeu sont expired. Aucune session de test laissée active. Reçus `breed-intent-final.safe.json`, `breed-intent-packets.safe.json`, `breed-intent-closeout.safe.json` et `fix-summary.safe.json`. Aucune écriture de langue, relance de campagne, nouvel échantillon fournisseur indépendant ni contournement des gardes.

**Bilan : deux défauts client corrigés et déployés, reprises vérifiées. Préparation parfois longue et corruption vidéo résiduelle non résolues ; ne pas annoncer les trois fichiers entièrement réparés.**
