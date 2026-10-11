# Première minute : capacité, compression et priorité aux sorties récentes

## État du 11 octobre 2026

L'utilisateur demande d'élargir la préparation à tous les films et épisodes,
uniquement lorsque le compte fournisseur est libre, avec conservation après
redémarrage. Il propose ensuite R2 et demande de chiffrer la compression et la
priorité aux œuvres sorties en 2026.

**Choix explicite de l'utilisateur : préparer la solution sans activer de
stockage R2 payant.** Aucun bucket, secret, abonnement ou quota Cloudflare n'est
créé ou modifié. Les montants ci-dessous sont des scénarios, pas un budget accepté.

**Cette étude ne déploie pas R2 ni une file couvrant tout le catalogue.** Le
stockage persistant local et sa compression sans perte sont développés dans
la branche `codex/global-startup-durable-20261011`, encore non déployée. La
file opérateur actuellement déployée contient toujours deux fichiers. Aucun
coût R2 supplémentaire ni changement de trajet fournisseur n'est engagé.

## Inventaire réel, grain et dates

Lecture des vues de visibilité/génération en production, 17:35–17:38 UTC :

| Représentation en base | Copies disponibles | Année 2026 canonique | Année 2026 en métadonnée de secours |
| --- | ---: | ---: | ---: |
| Films | 1 240 953 | 28 303 | 27 260 |
| Épisodes explicites | 22 371 | 0 | 431 |
| Lignes `series` possédant un parent | 266 374 | 8 291 | 0 |
| Total des candidats | **1 529 698** | **36 594** | **27 691** |

41 propriétaires, jusqu'à 47 sources visibles. Toutes les lignes du périmètre
sont marquées disponibles. Les 1 529 698 coordonnées
propriétaire/source/type/identifiant externe sont distinctes ; ce sont des
**copies de catalogue**, pas autant d'œuvres ou de fichiers physiques uniques.
Une autre langue, une qualité ou un fournisseur peut changer le fichier.

La priorité 2026 rassemble **64 285 candidats** si l'on accepte l'année fournie
en métadonnée lorsque l'année canonique est absente. Les films représentent
55 563 de ces candidats. Les 29 films dont la métadonnée indique 2026 en
contradiction avec l'année canonique ne sont pas promus sur cette seule base.
Les années 2025 et 2026 rassemblent 193 592 candidats avec la même règle.

Les dates exactes de sortie/diffusion ne sont pas exposées dans les champs
`release_date`/`air_date` de ces lignes. Une année de série peut être son année
de première diffusion, et ne prouve pas la date d'un épisode ou d'une saison.
22 371 épisodes explicites n'ont pas d'année canonique ; l'année est également
absente sur 683 522 films et 168 425 lignes `series` avec parent. L'ensemble a
été importé en 2026 : **la date de création en base ne mesure pas la nouveauté
de l'œuvre**. Aucun classement certain des épisodes récents n'est revendiqué.

## Estimation de taille et de stockage R2

Hypothèses explicites : une seule variante vidéo/audio sélectionnée, audio
inclus dans le débit total, 60 secondes exactement, majoration de 5 % pour
le conteneur. Pas de déduplication supposée, pas de compression gagnante
supposée, unités décimales (1 To = 1 000 Go). Ces débits sont des scénarios de
capacité, **pas des recommandations de qualité ni des tailles mesurées pour
chaque VOD**.

`octets/minute = débit total en Mbit/s × 1 000 000 × 60 / 8 × 1,05`

| Débit audio + vidéo | Minute préparée | Candidats 2026 (64 285) | Ensemble (1 529 698) |
| --- | ---: | ---: | ---: |
| 1 Mbit/s | 7,9 Mo | 0,51 To / ~8 $ par mois | 12,05 To / ~181 $ par mois |
| 2 Mbit/s | 15,8 Mo | 1,01 To / ~15 $ par mois | 24,09 To / ~361 $ par mois |
| 4 Mbit/s | 31,5 Mo | 2,02 To / ~30 $ par mois | 48,19 To / ~723 $ par mois |
| 8 Mbit/s | 63 Mo | 4,05 To / ~61 $ par mois | 96,37 To / ~1 446 $ par mois |

Les montants représentent le stockage moyen pendant un mois à
**0,015 $/Go-mois en R2 Standard**. Les opérations coûtent séparément
4,50 $ par million en classe A et 0,36 $ par million en classe B. La sortie
directe R2 n'est pas facturée. Le calcul ne déduit pas le quota gratuit, car
Norva utilise déjà R2 pour ses sauvegardes et son solde disponible n'a pas été
mesuré. Les montants n'incluent pas l'encodage, le relais fournisseur, d'autres
services Cloudflare ou les taxes. [Tarification officielle R2](https://developers.cloudflare.com/r2/pricing/)

### Données auxiliaires à compter

La minute HLS n'est pas toujours tout le cache. Le raccord actuel peut aussi
conserver jusqu'à **8 Mio d'entrée originale**, plus jusqu'à **4 Mio de
sous-titres** et des métadonnées. Ces plafonds ne sont pas des moyennes.
Les originaux nécessaires au décodeur ne peuvent pas être remplacés par des
octets réencodés : leurs offsets et leurs signatures de vérification changeraient.

Dans le scénario de 2 Mbit/s :

- Candidats 2026 : **1,01 To** de média seul ; **1,55 To** avec le plafond des
  données d'entrée ; **1,82 To** avec également le plafond des sous-titres,
  soit respectivement environ **15 / 23 / 27 $ par mois** de stockage.
- Catalogue entier : **24,09 / 36,92 / 43,34 To**, soit environ
  **361 / 554 / 650 $ par mois**.

L'alignement sur les segments peut dépasser 60 secondes ; la capture actuelle
est admise jusqu'à 90 secondes. Ce dépassement, les index et plusieurs choix
de pistes peuvent augmenter les tailles ci-dessus. Les copies lourdes peuvent
dépasser le plafond actuel de 64 Mio et être refusées. Aucun budget de 2 To
ne promet donc de couvrir toutes les copies 2026 à leur qualité actuelle.

6 341 profils possèdent taille et durée exploitables (0,41 % du périmètre),
dont seulement 62 sont marqués complets. Leur débit médian est 2,64 Mbit/s et
le 90e percentile 7,41 Mbit/s. Cet échantillon de sondes n'est pas représentatif
de tout le catalogue et ne sert pas à extrapoler une taille moyenne certaine.

Avec deux objets R2 par capture (média regroupé et manifeste), le chargement
initial de toutes les copies demanderait environ 3,06 millions d'écritures,
soit **18 $ bruts** au barème arrondi par million, avant toute franchise
disponible. Servir chaque petit segment comme un objet indépendant augmenterait
ce nombre. Les lectures et reconstructions futures restent variables.

## Mesures de compression sur des données réelles déjà conservées

Extrait `first-cached-segments.private.ts` provenant du contrôle réel antérieur,
**12,068 s**, H.264 1280 × 536, 30 images/s, AAC, 599 908 octets. Essai isolé
avec le même FFmpeg que le Gateway, réseau désactivé, CPU limité à un cœur,
aucun accès fournisseur ouvert et aucun média transmis à R2.

| Mode | Taille | Gain | Temps d'encodage | SSIM vidéo |
| --- | ---: | ---: | ---: | ---: |
| Original | 599 908 octets | — | — | — |
| Archivage gzip niveau 9, sans perte | 526 739 octets | 12,20 % | ~0,011 s | Images inchangées après décompression |
| H.264 `fast`, CRF 20, audio copié | 610 248 octets | **-1,72 %** | 3,011 s | 0,998290 |
| H.264 `fast`, CRF 23, audio copié | 490 492 octets | 18,24 % | 3,050 s | 0,998061 |
| H.264 `fast`, CRF 26, audio copié | 405 516 octets | 32,40 % | 2,921 s | 0,997684 |

Les trois sorties se décodent sans erreur dans cet essai. SSIM est une mesure
technique sur ce court extrait, pas une validation perceptuelle ni une écoute.
La vidéo est déjà peu volumineuse ; les économies et la charge CPU ne sont
pas extrapolées aux scènes complexes, au HDR, à la 4K, aux autres codecs ou
à une minute entière. Le réglage CRF 20 montre qu'un réencodage peut même
**augmenter** le poids.

Une première exploration de huit fichiers portant l'extension `.ts` incluait
des sources TypeScript copiées dans les dossiers de preuve. Les gains de
70–82 % sur ces fichiers sont **exclus**, car FFprobe n'y identifie aucune
vidéo. Seul l'extrait MPEG-TS réellement décodable ci-dessus est retenu.

Le réencodage est distinct du remuxage actuel : il produit de nouveaux paquets
vidéo et peut modifier la qualité. [Documentation FFmpeg](https://ffmpeg.org/ffmpeg.html#Stream-copy)
Un préfixe réencodé exige un raccord testé vers l'original : paramètres du
décodeur, résolution, cadence, images clés, horloges, audio et sous-titres.
**Aucun raccord compressé/original n'est validé ni déployé par cette étude.**

## Proposition opérationnelle

1. Commencer par un cache privé R2 borné, avec un petit cache local de lecture.
   R2 offre l'API S3 de lecture/écriture ; les objets restent derrière les droits
   Norva. [API officielle R2](https://developers.cloudflare.com/r2/api/s3/api/)
2. Préserver le média existant ; appliquer une compression d'archive sans perte
   seulement lorsqu'elle économise suffisamment de place. Décompresser avant
   la lecture, avec une limite stricte de taille et vérification de chaque digest.
3. Prioriser les reprises récentes, puis les sorties 2026 documentées et les
   nouveaux épisodes dont la date de diffusion est connue, puis 2025 ; conserver
   une part du travail pour les années inconnues et les catalogues anciens.
   La priorité tourne entre comptes/sources et n'autorise aucun accès fournisseur
   occupé. La date d'import ne remplace jamais celle de sortie.
4. Fixer un quota avant une éventuelle activation. **2 To correspondent à ~30 $ par mois de
   stockage brut**, plus opérations et calcul ; c'est une enveloppe bornée pour
   commencer sur les nouveautés, pas une capacité garantie pour tout le catalogue
   ni une enveloppe autorisée par l'utilisateur.
   L'âge, la demande et la taille déterminent ensuite les évictions.
5. Tester séparément un réencodage plus compact sur plusieurs copies et au raccord.
   Ne pas diminuer globalement qualité, pistes ou cadence pour respecter un quota.

Le réencodage se fait après réception de données : il ne réduit pas les octets
à recevoir du fournisseur pour préparer la minute. R2 ne compense pas une
source durablement trop lente après cette minute.

## Persistance et validité : point à résoudre avant une conservation longue

Le prototype local stocke atomiquement média et manifeste, conserve les
révocations, refuse les écritures interrompues et les données corrompues, et
restaure les données dans le budget mémoire existant. La compression d'archive
ne change pas un octet après décompression. **114 tests ciblés réussis**, dont
la révocation pendant le flush, les quotas par propriétaire après redémarrage,
la taille des manifestes et la revalidation des preuves partielles.

Le même groupe de tests est rejoué dans une instance isolée de l'image Gateway
déployée, sous Node 20, sans réseau et sans connexion fournisseur. La preuve
Linux est conservée dans `startup-durable-linux.safe.json`. Ce contrôle ne
constitue pas un rejeu du lecteur public ou une validation R2 réelle.

Le plan de raccordement privé R2, les admissions, l'ordre de priorité et les
conditions d'activation sont détaillés dans
[`ops/hetzner/media/startup-cache-durable-plan.md`](../../ops/hetzner/media/startup-cache-durable-plan.md).
Le transport R2 pour les préfixes et la file globale ne sont **pas encore
implémentés**. Le prototype local est conservé en brouillon, désactivé par défaut.

Il n'étend pas la validité actuelle : **10 minutes** pour les preuves partielles
et **30 minutes** pour les identités fortes. Il conserve donc le cache après
un redémarrage dans sa fenêtre initiale, sans promettre une réutilisation durable
des copies sur plusieurs jours. Il faudra distinguer la rétention des objets
de la preuve fraîche autorisant leur lecture, sans traiter quatre échantillons
comme un hash du fichier entier.

Régénérer toutes les captures toutes les dix minutes serait irréaliste. Une
simple relecture de quatre échantillons de 64 Kio sur tout le catalogue représente
401 Go par tour, soit environ **5,35 Gbit/s continus** avec un tour toutes les
dix minutes, avant toute préparation. La revalidation doit être ciblée sur
les lectures demandées et les copies prioritaires, avec les admissions existantes.

À six secondes par préparation, un seul worker constamment libre aurait besoin
de **106 jours** pour tout le périmètre, ou **4,5 jours** pour les candidats 2026.
À trente secondes, ces durées deviennent **531 et 22 jours**. Ce sont des bornes
arithmétiques idéales : disponibilité, échecs, revalidations, encodage et files
de ressources les allongent. Aucune promesse de couverture immédiate n'est faite.

## Preuves reproductibles

Preuves expurgées sous `.codex-artifacts/startup-cache-20261010/`, hors Git :

- `startup-fleet-inventory.remote.py.safe.json` ;
- `startup-storage-sizing.remote.py.safe.json` ;
- `startup-storage-model.remote.py.safe.json` ;
- `startup-real-compression.remote.py.safe.json` ;
- `startup-reencode-sizing.remote.py.safe.json` ;
- `startup-storage-estimate.py` et `startup-storage-estimate.safe.json`.
- `startup-durable-linux.safe.json`.

Les sorties ne contiennent ni accès fournisseur ni identifiant de compte.
L'étude n'a pas ouvert de lecture fournisseur ni modifié les services déployés.
