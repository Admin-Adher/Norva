# Cache hybride de démarrage et reprise — 15 septembre 2026

## État de livraison

Implémentation et vérifications **locales**, dans la branche
`codex/vod-resume-cache-all-formats-20260915`, sur la base `fea1ecba`.
Aucune publication, aucun déploiement et aucune activation de production pendant ce travail.
Les nouveaux caches sont désactivés par défaut. Aucun fournisseur réel n'a été contacté pour ces essais.

**Décision pré-déploiement, 16 septembre : pas de feu vert pour une activation générale.**
Le raccord fonctionne sur les trois formats et plusieurs passages de deux minutes sont bons,
mais la campagne comporte encore des incidents intermittents de rendu, un incident HTTP du banc,
et l'ancien délai MPEG-TS dont la cause n'est pas prouvée. Voir la revalidation ci-dessous ;
un passage réussi ne remplace pas les passages échoués.

## Fonctionnement livré

- **MP4 natif** : conserver des plages déjà téléchargées, notamment l'index `moov`.
  À la prochaine session, valider une plage actuelle de 64 Kio avant de réutiliser les octets.
  Une première lecture sans cache garde le parcours natif existant ; elle n'attend pas un remplissage complet.
- **Reprise privée HLS** : capturer les segments finalisés autour de la position d'arrêt,
  pour des sources MP4, MKV et MPEG-TS. La position est envoyée à la fermeture de la page
  comme au retour au catalogue, et uniquement pour la session courante.
  Le début est disponible depuis le cache ; le même Gateway produit la continuation.
- **Fragments partagés** : priorité au début du fichier et à son index terminal.
  Un fragment intérieur n'est conservé dans le pool partagé qu'après des demandes de deux utilisateurs distincts.
  Il s'agit uniquement de plages déjà reçues et complètement validées, pas d'un téléchargement anticipé du film entier.
- **Continuité** : conserver la frontière fractionnaire des segments ; encoder audio et vidéo
  de la continuation sur la même origine ; insérer une seule discontinuité HLS.
  Les en-têtes EVENT restent immuables. `TARGETDURATION=30` correspond au plafond d'admission
  des segments, pas au tampon exigé pour démarrer, qui est de 6 secondes pour une reprise validée.
  Voir [RFC 8216, section 6.2.1](https://www.rfc-editor.org/rfc/rfc8216.html#section-6.2.1).
- **Arrêt** : un SIGTERM volontaire n'est plus confondu avec une panne du média.
  Il ne constitue pas une preuve de fin de fichier pour le cache de films complets.

Le cache HLS de reprise accepte un graphe simple audio/vidéo, sans chiffrement,
sans variantes multiples ni sous-titres intégrés au graphe. Les autres cas restent sur le parcours normal :
aucune piste n'est supprimée pour obtenir artificiellement un succès de cache.
La prise en charge des trois conteneurs ne signifie donc pas que toutes leurs variantes sont accélérées.

## Isolation, autorisation et mémoire

Le privé est lié au propriétaire, à l'URL exacte de la source, à sa révision, à la taille
et au profil de pistes. Il exige un ETag fort actuel et une identité de cible concordante.
Une taille égale, `Last-Modified`, un titre ou un identifiant TMDB ne suffisent pas.

Le partage exige en plus :

1. Une identité fournisseur résolue côté serveur, expressément autorisée dans l'Edge.
2. Une autorisation de session propre au consommateur et une validation actuelle via son accès fournisseur.
3. La même URL finale **entière**, paramètres compris, le même ETag fort et la même taille.
4. Une réponse explicitement partageable (`public` ou `s-maxage` positif), sans `private`,
   `no-store`, `no-cache`, `Vary` ni `Set-Cookie`.

Les liens signés différents ou l'absence d'identité commune provoquent un repli privé/normal,
pas un rapprochement approximatif de fichiers entre comptes. Le parcours ne crée pas de connexion
fournisseur parallèle. Un échec de comptabilité du cache ne relance pas une plage valide.
Les autorisations et les octets sont séparés ; un arrêt invalide les anciennes URL de lecture.
La révocation propriétaire invalide aussi les opérations de cache en cours.

| Stockage en mémoire, par processus | Maximum global | Par fichier | Durée |
| --- | ---: | ---: | ---: |
| Plages privées | 128 Mio | 32 Mio | 30 min |
| Segments HLS privés | 128 Mio, réservations incluses | 32 Mio | 30 min pour une nouvelle acquisition |
| Fragments partagés | 64 Mio | 16 Mio | 10 min |

Ces limites concernent les caches, pas la mémoire totale du Gateway, des copies de réponse,
des brokers déjà existants ou de FFmpeg. Aucun stockage de film entier sur disque n'est ajouté.
Une fenêtre déjà acquise reste liée à la session autorisée, puis est libérée à l'arrêt ;
une révocation la rend inutilisable immédiatement.

## Résultats reproductibles

### Contrats, régressions et sécurité

- Suite générale : **4 902 réussites, 0 échec, 19 tests ignorés**, 198,7 secondes.
  Trace : `output/playwright/hybrid-cache-1789503584620/full-suite-final.tap`.
- Suite ciblée élargie : **270 réussites, 0 échec, 1 ignoré**.
- Test supplémentaire du gros index MP4 : lecture de 6 334 289 octets ; lors de la seconde session,
  **65 536 octets** seulement viennent du fournisseur et **6 268 753** du cache privé, à contenu égal.
  Les 7 tests du module MP4 passent séparément après son ajout.
- Partage à deux comptes testé sur les trois extensions avec le véritable broker de plages :
  le second compte valide lui-même 64 Kio, puis réutilise le reste du préfixe ; pic fournisseur = 1 connexion.
- Tests réels FFmpeg d'alignement MKV : audio copié avec 3,36 s de décalage dans le témoin,
  contre environ 21 ms après encodage AAC aligné.
- Syntaxe Node, syntaxe TypeScript via esbuild, empreintes des assets et `git diff --check` vérifiés.
  Ce n'est pas une vérification TypeScript complète ni une validation Android par émulateur.

### Gateway complet, sources synthétiques locales

Création à froid → production de 80 secondes → arrêt à 10,375 s → nouvelle session →
revalidation du fichier → reprise privée → continuation → décodage → révocation.
Le contrat de seek existant arrondit la requête à 10 s ; la frontière des segments n'est pas arrondie.

| Source | Création à froid | Création avec reprise | Connexions fournisseur simultanées maximales |
| --- | ---: | ---: | ---: |
| MP4 | 2 968 ms | 59 ms | 1 |
| MKV | 3 249 ms | 365 ms | 1 |
| MPEG-TS | 3 006 ms | 106 ms | 1 |

**Ce sont des durées de création Gateway, pas des temps de première image en production.**
Les fichiers sont synthétiques, de faible résolution, sur boucle locale ; le réseau réel n'est pas représenté.
Les anciennes URL répondent 404 après arrêt. FFmpeg termine le décodage avec le code 0,
mais signale des avertissements de timestamps/compteurs au raccord : ne pas les présenter comme un décodage sans avertissement.
Preuve : `output/playwright/hybrid-cache-1789503584620/gateway-1789506120636/report.json`.

Un essai intermédiaire MPEG-TS n'a pas atteint la fin de sa continuation dans la limite du test.
Les deux essais suivants ont réussi (isolé, puis les trois formats à la suite), sans correctif arbitraire
masquant cet échec. Sa cause n'est pas établie. Conserver cette réserve pour le canari.

### Première campagne navigateur — résultats historiques

HLS.js livré par Norva et méthodes réelles de politique de tampon de WatchPage sont utilisés,
sur les segments produits par le vrai Gateway. Il ne s'agit pas du parcours applicatif complet.

Le navigateur visible a traversé les raccords sans erreur HLS fatale, mais sa progression était
inférieure au temps écoulé. Le contrôle simultané MP4 natif, sans cache ni HLS, montre les mêmes
gels avant le raccord : 99,58 s lues contre 99,60 s pour la reprise HLS en 120 s.
Ces mesures établissent une perturbation de l'environnement ; elles **ne certifient pas la fluidité**.
Traces : `output/playwright/control-browser-20260915/browser-{control,mp4}.json`.

Dernier passage navigateur, sur la sortie Gateway finale et sans la suite générale en parallèle :

| Source des segments | Première image en mouvement, page locale | Progression sur 120 s | Frames perdues / décodées |
| --- | ---: | ---: | ---: |
| MP4 | 1,141 s | 117,66 s | 0 / 2 951 |
| MKV | 1,045 s | 117,52 s | 2 / 2 941 |
| MPEG-TS | 0,895 s | 117,59 s | 0 / 2 950 |

Aucune attente après démarrage, erreur HLS fatale ni trou de callback supérieur à 500 ms n'a été enregistré.
Le raccord est franchi dans les trois cas. La progression reste inférieure au temps écoulé :
ne pas convertir ces chiffres en « deux minutes de lecture parfaite » ni en SLA fournisseur.
Ces temps démarrent à l'initialisation du lecteur local, pas au clic Lire de l'application en production.
Traces : `output/playwright/final-browser-gateway-20260915/browser-{mp4,mkv,ts}.json`.

## Revalidation pré-déploiement du 15 au 16 septembre

### Correction supplémentaire

La playlist de reprise pouvait publier les premiers segments de la continuation alors que
sa validation de démarrage n'était pas terminée. Un repli local de FFmpeg pouvait encore
remplacer ces fichiers. Cela contredit le caractère immuable d'une playlist EVENT déjà consommée.
La publication de la continuation attend désormais la réussite de `startSessionWithProviderRetry` ;
une préparation interrompue ou échouée ne lève pas cette barrière.

Quatre tests exécutent les branches réelles du Gateway : playlist pendant la préparation,
réussite, échec et interruption. Les 24 tests du module de reprise privée passent.
Cette correction est fondée sur le chemin de code et les régressions ; **elle n'établit pas
la cause de l'ancien dépassement de délai MPEG-TS**.

### Reproduction et injection de pannes

- Cinq répétitions isolées MPEG-TS ont terminé : reprise, continuation complète, décodage et révocation.
  Chaque exécution conserve la chronologie des sessions et des ouvertures fournisseur.
- Les nouvelles sources synthétiques font 165 secondes, 640 × 360 à 25 images/s,
  H.264 avec images B et AAC stéréo ; elles occupent 53,7 à 56,0 Mo. Elles dépassent
  le budget privé de 32 Mio : la continuation ne peut pas être validée uniquement grâce
  à un film entier déjà présent dans le cache de plages.
- Un corps MPEG-TS coupé volontairement après 256 Kio, avec livraison ralentie,
  a permis une reconnexion et une continuation complète (`gateway-1789507688656`).
- Sur `gateway-1789508782582`, une absence de données de 25 secondes pendant la reprise TS
  a déclenché le watchdog d'inactivité en 15,1 secondes. Le broker a ensuite récupéré
  exactement les 940 octets restants de la plage interrompue, sans connexion simultanée.
  La lecture a avancé de 120,194 secondes en 120,689 secondes, sans attente après démarrage.
  Ce passage précédait le chargement du correctif de publication ci-dessus.

Un essai ultérieur (`gateway-1789509391145`) a échoué sur un `fetch` de contrôle local
avec `ECONNRESET`, avant le lancement de la lecture navigateur. Les diagnostics obtenus
immédiatement après montrent une session MP4 `ended`, sans `lastError`, et une playlist
complète avec `ENDLIST`. Cet essai reste un échec de la campagne, pas un succès média.
Le point HTTP exact n'avait pas été enregistré ; le harnais l'enregistre désormais sans
ajouter de nouvelle tentative silencieuse. Ne pas confondre cet incident avec l'ancien échec TS.

### Correction du protocole de mesure

Le banc affiche maintenant uniquement des résumés pendant la lecture : sérialiser chaque
intervalle d'image dans le DOM perturbait ses propres callbacks. Les lectures sont séquentielles,
la fenêtre Chrome dédiée reste visible, et la suite générale ne tourne pas simultanément.

Un contrôle au cours d'une lecture TS montre une horloge régulière après désactivation du
`muted` de l'élément vidéo : 40,203 secondes média pour 40,203 secondes écoulées.
Les nouveaux essais utilisent donc l'élément non muet et l'option `--mute-audio` du navigateur
isolé pour ne pas diffuser le son synthétique. Ce réglage concerne **le banc de test uniquement**.
Il n'est pas un correctif de lecture pour les utilisateurs. Le moteur Chromium utilise des
chemins différents pour la sortie audio muette, ce qui rend cette précaution pertinente :
[AudioRendererImpl](https://chromium.googlesource.com/chromium/src/media/+/refs/heads/main/renderers/audio_renderer_impl.cc),
[NullAudioSink](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/audio/null_audio_sink.cc).

Le comptage réseau du premier banc ralenti incluait artificiellement une pause de 20 ms
après livraison du dernier octet `Content-Length`. Cette pause a été supprimée : le débit
est ralenti **entre** les morceaux uniquement. Le délai de libération de slot est désormais
celui du code Gateway (2,5 s), sans substitution à zéro. Aucune configuration serveur de
production n'a été consultée ou modifiée pour ces essais.

Les fichiers de cette campagne se trouvent sous `output/playwright/hybrid-live-20260915/`.
Les nouvelles exécutions enregistrent l'empreinte SHA-256 du Gateway dans `execution.json`.

### Mesures du dernier correctif chargé

Empreinte Gateway : `109ac3b03389f63a352d233451ed4642ba7e54661f9ca382c3fd451b12d6c79d`.
Les traces `gateway-1789509634091` et `gateway-1789510052169` correspondent à cette version.

| Essai local | Première image en mouvement | Vidéo effectivement lue / temps écoulé | Attentes après démarrage | Images perdues / total |
| --- | ---: | ---: | ---: | ---: |
| MP4, Gateway en cours de production | 0,603 s | 120,001 / 120,199 s | 0 | 0 / 3 010 |
| MKV, premier passage | 0,872 s | 120,122 / 120,807 s | 1 × 214 ms | 0 / 3 006 |
| MKV, répétition complète | 0,474 s | 120,076 / 120,403 s | 0 | 2 / 3 004 |
| MPEG-TS, défaut réseau injecté | 1,014 s | 120,160 / 121,035 s | 2 événements, 3,7 ms au total | 10 / 3 015 |
| Rejeu des mêmes segments TS, sans encodage parallèle | 0,554 s | 120,024 / 120,381 s | 0 | 0 / 3 010 |

Les premières images sont chronométrées à l'initialisation du lecteur de test, **pas au clic Lire
dans Norva**, ni depuis la création de session. Les durées de création Gateway sont distinctes :
MP4 froid/reprise 2,664/0,271 s ; dernier MKV 1,905/2,198 s ; dernier TS 2,625/0,063 s.
La pause réseau injectée de 25 s est interrompue par le watchdog à environ 15,1 s ;
la reprise de plage et la continuation se terminent. Le pic fournisseur reste à une connexion.

Le passage TS sous charge présente surtout un trou de callback vidéo de **583 ms à 19,56 s média**,
avec un tampon continu jusqu'à 91,72 s. Le nombre d'événements `waiting` et leurs quelques
millisecondes ne suffisent donc pas à mesurer la coupure perçue : il faut aussi contrôler les images.
Cet incident et celui du MKV sont antérieurs au raccord cache/continuation. Les avertissements
HLS `bufferStalledError` non fatals au premier démarrage sont enregistrés séparément et ne sont
pas assimilés à des erreurs fatales du transport.

Le rejeu lit exactement les segments sauvegardés de l'essai TS échoué : il passe le même point
puis le raccord, sans attente ni image perdue. Son seul intervalle de callback supérieur à 250 ms
est avant la première image en mouvement (333 ms). C'est un indice en faveur d'une contention
du banc lorsque navigateur et encodage cohabitent, **pas une preuve définitive de sa cause**.
Trace : `output/playwright/hybrid-replay-20260916/browser-ts.json`.

Le harnais conserve désormais les segments même après un défaut de fluidité, teste le format
suivant après arrêt propre, puis termine avec un code d'échec si un critère n'est pas respecté.
Les deux campagnes de dernière version ne sont donc **pas** présentées comme entièrement vertes.
Il manque encore une validation reproductible en environnement représentatif, notamment avec
les rendus matériels et la page WatchPage complète. Aucun canari de production n'a été lancé.

### Régressions après la correction de publication

Les **53 tests ciblés** de reprise privée, plages partagées et MP4 natif passent, sans test ignoré.
Trace : `output/playwright/hybrid-live-20260915/cache-safety-final.tap`.

La suite générale relancée après la correction termine avec **4 907 réussites, 0 échec,
19 tests ignorés**, sur 4 926 tests, en 154,2 secondes. Elle a été lancée après la fin des
mesures navigateur pour ne pas les perturber.
Trace : `output/playwright/hybrid-live-20260915/full-suite-predeploy-final.tap`.
Syntaxe du Gateway et des deux harnais, empreinte de la version testée et `git diff --check`
revérifiés. Le navigateur dédié et les serveurs de test ont été arrêtés ; aucun processus
FFmpeg de cette campagne ne reste actif. Ces résultats fonctionnels verts ne lèvent pas
les réserves de rendu de la campagne navigateur.

## Activation et critères restants

Paramètres nouveaux, désactivés/vides par défaut :

- Gateway : `PRIVATE_RESUME_CACHE_ENABLED=true`.
- Gateway : `PRIVATE_RESUME_CACHE_OWNER_HASHES=<empreintes des comptes du canari>`
  limite tous les chemins privés (MP4 natif, plages et HLS) aux comptes désignés.
  Une liste non vide mais invalide refuse tous les comptes. Une liste absente/vide
  conserve le mode général, uniquement si le commutateur principal est activé.
- Gateway : `SHARED_PLAYBACK_RANGES_ENABLED=true`.
- Edge : `NORVA_SHARED_FRAGMENT_PROVIDER_IDENTITIES=<identités serveur vérifiées>`.
  Une liste vide ne fait aucune recherche supplémentaire au démarrage et n'autorise aucun partage.

Ces exemples sont des paramètres de configuration, **pas des paramètres activés**.
Le cache natif MP4 ne crée pas une nouvelle route publique et n'étend pas l'autorisation native existante.
Il n'accélère pas les flux qui passent par une autre infrastructure que ce Gateway.

Avant activation : relire les versions et réservations de production, préserver les autres travaux,
déployer les trois parties compatibles, puis canari contrôlé avant élargissement.
Tester plusieurs titres par format, démarrage à froid, arrêt/reprise et fermeture d'onglet,
avec deux minutes de lecture effective et un contrôle des images affichées.
Comparer le volume fournisseur, la première image, les attentes, le raccord A/V,
le pic de connexions, l'expiration, le changement de fichier, la révocation et les graphes multi-pistes.
Pour le partage, utiliser deux comptes autorisés du même catalogue avec une identité de fichier commune prouvée.

Une réponse lente du fournisseur lors de la validation, un cache expiré, un graphe non admissible
ou un fichier sans ETag fiable ne permettent pas de promettre une reprise quasi instantanée.
Retirer les opt-in puis effectuer un redémarrage contrôlé pour revenir au parcours antérieur ;
ne pas interrompre brutalement les sessions actives pour vider ces caches en mémoire.

## Outils locaux ajoutés

- `scripts/media/local-resume-gateway-proof.cjs` : vrai Gateway, proxy et fournisseur synthétiques
  restreints à la boucle locale ; `NORVA_TEST_FORMATS=ts` permet de cibler le conteneur.
- `NORVA_TEST_BROWSER_PROOF=true` expose une page locale branchée sur le Gateway pendant
  la production des segments ; `NORVA_TEST_UNMUTED=true` active le protocole d'horloge audio décrit ci-dessus.
  `NORVA_TEST_CHUNK_DELAY_MS`, `NORVA_TEST_STALL_ONCE_MS`, `NORVA_TEST_DISCONNECT_ONCE`
  et `NORVA_TEST_FAULT_PHASE` permettent des défauts de transport synthétiques bornés.
- `scripts/media/local-hybrid-cache-proof.cjs` : lecture HLS.js pendant 120 s, première image,
  progression, attentes, erreurs, trous de callbacks, visibilité et statistiques de frames.
  Accepte un dossier de preuve Gateway ; `?formats=mp4,control` ajoute le MP4 natif témoin.
- Les résultats volumineux restent sous `output/playwright/`, hors des sources de production.
