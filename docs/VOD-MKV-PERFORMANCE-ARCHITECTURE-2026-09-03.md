# VOD MKV : architecture de performance et journal de stabilisation

Dernière mise à jour : 3 septembre 2026.

Ce document garde une trace exploitable des travaux réalisés pour accélérer la
lecture VOD Web de Norva sans sacrifier les pistes, la durée, la reprise, la
fluidité ni la libération du compte fournisseur. Il ne contient volontairement
aucun secret, identifiant de compte, hôte fournisseur ou jeton d'infrastructure.

## Résultat recherché

Norva doit :

- laisser les MP4 compatibles au navigateur démarrer directement ;
- convertir les MKV et conteneurs non sûrs en HLS sur le Media Gateway ;
- afficher la durée réelle, la timeline, l'audio et les sous-titres exacts dès
  le premier démarrage ;
- commencer à rendre dès qu'un tampon réellement lisible est disponible, puis
  continuer à charger avec backpressure ;
- choisir automatiquement une route fournisseur rapide et stable, sans nom de
  fournisseur codé en dur ;
- réutiliser un HLS privé exact pour que les lectures suivantes du même fichier
  deviennent très rapides ;
- rendre chaque autorisation révocable et terminer chaque sortie avec zéro
  session, encodeur, pompe, broker, permis et lease résiduels.

La vitesse seule n'est jamais un résultat acceptable si une langue disparaît,
si une reprise devient fausse ou si le compte fournisseur reste occupé.

## Chemins de lecture

```text
Navigateur
   |
   +-- MP4 réellement compatible ------------> lecture directe fournisseur
   |
   +-- MKV / conteneur ambigu ou incompatible
          |
          v
      Edge norva-playback
          |
          +-- objet HLS privé exact prêt ----> ticket court -> Worker -> R2
          |
          +-- objet absent -------------------> Media Gateway Hetzner
                                                   |
                                                   +-- route adaptative sticky
                                                   +-- préfixe + sonde sur la même connexion
                                                   +-- FFmpeg/VAAPI -> HLS multi-pistes
                                                   +-- publication privée éventuelle
```

### MP4 : chemin direct

Les commits `c4ed54cd` et `7f079556` ont restauré le principe suivant : un MP4
confirmé compatible reste hors Gateway. Le suffixe du fournisseur n'est pas une
preuve suffisante ; Norva conserve l'autorité issue de la sonde lorsque le
conteneur annoncé est faux. Le Gateway reste réservé aux formats qui nécessitent
réellement une adaptation Web.

### MKV : démarrage à froid

Les optimisations appliquées au chemin MKV fini sont complémentaires :

1. Le Gateway ouvre une seule connexion fournisseur et en conserve un préfixe
   borné. Cela évite la compétition entre la lecture et une seconde connexion de
   sonde sur les comptes mono-slot.
2. Le préfixe est passé à `ffprobe` localement, puis rejoué exactement une fois à
   FFmpeg via `preloadedChunks` ; les octets déjà reçus ne sont pas retéléchargés.
3. La topologie HLS audio est figée après la sonde, jamais avant. Les pistes
   découvertes font donc partie du master playlist initial.
4. Le premier rendu attend des segments référencés, présents et non vides, mais
   n'attend pas le téléchargement complet du film.
5. Le serveur continue ensuite à aspirer et segmenter le fichier en respectant
   la backpressure. Un tampon plus grand n'augmente pas le débit physique du
   fournisseur et n'est pas utilisé comme faux remède universel.
6. L'encodage vidéo matériel VAAPI est admis avec une limite de concurrence ;
   la saturation doit produire une décision explicite, pas un serveur instable.

Les principaux ancrages sont `services/media-gateway/src/index.js`,
`services/media-gateway/src/finite-mkv-linear-seek-bridge.js`,
`services/media-gateway/src/video-encoder.js` et
[`WEBENGINE-GATEWAY-INBAND-PROBE.md`](./WEBENGINE-GATEWAY-INBAND-PROBE.md).

### Reprise et seek

La reprise n'utilise plus un simple téléchargement linéaire depuis zéro :

- les fenêtres MKV indexées sont lues autour de l'offset réel ;
- les requêtes compatibles sont coalescées ;
- les tunnels, routes et préfixes déjà validés sont réutilisés ;
- la route est également testée à l'offset de reprise, car une route rapide au
  début du fichier peut être mauvaise sur un `Range` éloigné ;
- les premiers segments HLS de reprise sont rendus sans attendre des pistes de
  sous-titres non sélectionnées.

Les séries de commits `a21640f2` à `e56b3617` et `4d328020` documentent cette
stabilisation : seek indexé, fenêtres coalescées, tunnel chaud, préfixe validé,
topologie multi-audio et revalidation temps réel.

## Pistes, durée, timeline et UX de chargement

- La durée affichée vient du média exact ; une durée partielle issue d'un
  préfixe ou d'une playlist encore ouverte ne remplace pas la durée du film.
- L'audio et les sous-titres utilisent les index immuables du fichier. Un libellé
  codec tel que `AAC` n'est jamais présenté comme une langue.
- Les pistes exactes déjà préparées se sélectionnent sans redémarrer la vidéo.
- Les sous-titres exacts non encore préparés restent visibles avec un état de
  chargement et peuvent être préparés à la demande ; ils ne bloquent pas la
  première image.
- La timeline peint la plage contiguë réellement présente dans
  `video.buffered`, avec la variable CSS `--buffered`. Le texte accessible
  annonce « Loaded to ... of ... » sans inventer une avance à travers un trou
  de buffer.
- Le verrou de première frame ne doit pas laisser un faux bandeau d'échec après
  une récupération HLS.

Ancrages : `public/js/pages/WatchPage.js`, `public/css/main.css`,
`tests/watch-gateway-startup-buffer.test.js` et
`tests/watch-gateway-multi-audio.test.js`.

## Routeur fournisseur adaptatif

Le routeur est générique : Promax, Opplex, Airysat, KING365, GOTV, STRNG ou un
fournisseur inconnu suivent le même mécanisme.

- L'identité est un HMAC de l'hôte canonique et du compte fournisseur ; le nom
  commercial et l'identité de l'utilisateur Norva n'entrent pas dans l'affinité.
- Toutes les requêtes d'un même compte restent sur une route sticky afin
  d'éviter les changements d'IP suspects.
- Les candidats sont des couples `slot + protocole Node`. FFmpeg et ffprobe
  gardent une route HTTP compatible ; Node peut choisir HTTP ou SOCKS5 si les
  deux sont provisionnés.
- L'apprentissage commence par de petits échantillons séquentiels, au repos et
  sous lease distribué. Une lecture réelle peut préempter immédiatement ce
  benchmark.
- Les deux meilleures routes sont départagées sur une fenêtre plus soutenue.
- Le score tient compte du TTFB, du débit utile, de la stabilité, des timeouts et
  des erreurs fournisseur. Une confiance insuffisante conserve la route sûre.
- Une hystérésis empêche les bascules permanentes pour un petit gain ponctuel.
- Les secrets proxy restent exclusivement dans l'environnement serveur.

Ancrages : `services/media-gateway/src/providerAdaptiveRoute.js`,
`services/media-gateway/src/providerRouteBenchmark.js`,
`supabase/migrations/20260901193000_provider_adaptive_route_control_v1.sql`,
`20260902213500_provider_route_resume_seek_benchmark_v2.sql` et
`20260903114500_provider_route_realtime_viability_v3.sql`.

### Mesures de routes conservées comme référence

Mesure de laboratoire sur 16 Mio, réalisée avant la validation bout-en-bout. Ce
n'est ni un SLA ni une garantie future :

| Catalogue testé | Ancienne route | Meilleure route testée | Temps pour 16 Mio | Gain de débit |
| --- | ---: | ---: | ---: | ---: |
| Promax | 4,69 Mb/s | 59,75 Mb/s, HTTP | 2,25 s | x12,7 |
| Opplex | 3,77 Mb/s | 44,60 Mb/s, HTTP | 3,01 s | x11,8 |
| Airysat | 10,42 Mb/s | 24,15 Mb/s, SOCKS5 | 5,56 s | x2,3 |

Ces chiffres prouvent surtout qu'aucun protocole ou proxy fixe n'est meilleur
partout. Le choix automatique et sticky est nécessaire.

### Règle d'arrêt pour un fournisseur limité

Norva mesure séparément :

1. le TTFB et le débit de la source sur les meilleures routes disponibles ;
2. le temps de sonde et de création des premiers segments dans Norva ;
3. le temps jusqu'à la première frame côté navigateur.

Après plusieurs mesures cohérentes, si la meilleure route ne fournit pas assez
d'octets pour atteindre la cible, le catalogue est classé **limité par la
source**. On conserve alors la route la plus stable, un tampon honnête, une UX de
chargement claire et le bénéfice des lectures chaudes. On ne poursuit pas une
cible physiquement impossible avec des réglages agressifs.

## Cache HLS privé partagé

L'objectif du cache global est « un calcul exact, plusieurs lectures autorisées ».
Il ne rend pas magique la première lecture d'un fichier que personne n'a encore
segmenté, mais il peut rendre les suivantes très rapides entre utilisateurs qui
ont réellement accès au même fichier fournisseur.

### Identité et publication

Un objet n'est réutilisable que si son identité cryptographique couvre notamment :

- le contenu fini ;
- le profil vidéo ;
- la topologie audio ;
- la topologie des sous-titres ;
- la durée ;
- les versions du pipeline et du segmenteur.

Le Gateway n'obtient aucune clé R2. Il envoie les fichiers immuables au Worker
privé, puis publie le manifeste en dernier. Edge ne crée une liaison de catalogue
qu'après vérification de l'objet complet. Une playlist signée ne peut pas pointer
vers une autre cible de segment.

### Lecture, coordination et sécurité

- Edge émet un ticket court, lié à la session, au fichier et à l'autorité de
  catalogue courante.
- Le Worker privé vérifie ticket, chemin, expiration et signature avant chaque
  ressource HLS.
- Le single-flight distribué donne un seul lease producteur par empreinte ; les
  autres demandes deviennent followers au lieu d'ouvrir plusieurs connexions
  fournisseur et plusieurs FFmpeg.
- Le live join et la continuation en arrière-plan sont des étapes séparées. Ils
  restent révocables et préemptables par une lecture réelle.
- Les quotas L1/R2, le nombre de fichiers, la rétention, l'admission par demande,
  la purge physique, les tombstones sécurité/légal et la récupération après
  corruption sont fail-closed.
- Le cache local complet reste une optimisation mono-instance attestée. Tant que
  la promotion L1 vers R2 n'est pas certifiée, un leader global contourne ce L1
  afin de posséder lui-même l'EOF et le digest publiable.

Ancrages : `services/media-gateway/src/sharedHlsObjectPublisher.js`,
`privateMediaCacheStoreClient.js`, `mediaCacheProducerControl.js`,
`supabase/functions/_shared/media-cache-*.mjs`, le Worker
`workers/media-cache/` et les migrations `20260901*media_cache*` à
`20260903120000_media_cache_gateway_session_id_cast_v1.sql`.

### Déploiement progressif actuel

État observé le 3 septembre 2026 :

- Media Gateway v165 et Edge `norva-playback` v81 déployés ;
- Worker privé R2, tickets et callbacks configurés ;
- activation globale du cache, single-flight et live join maintenue à `false` ;
- cohorte opérateur au stade `read`, donc aucun impact global ;
- publication Gateway installée, continuation et live join désactivés ;
- objets et liaisons globaux encore à zéro avant la reprise du canari producteur.

Le premier essai `singleflight` a trouvé un défaut réel :
`cloud_gateway_sessions.external_session_id` est un `text`, alors que sept RPC
recevaient un UUID. PostgreSQL levait `operator does not exist: text = uuid` au
heartbeat. Le rollout a été immédiatement ramené à `read/shadow`, sans ressource
résiduelle. Le correctif `bcc0de64` ajoute le cast explicite et une migration de
réparation atomique ; `85ee7ce7` rend son canari PostgreSQL compatible avec un
schéma cache déjà installé. Le canari a ensuite détecté avant production une
syntaxe PostgreSQL invalide dans cette réparation ; `8a3ebd2c` l'a corrigée avec
`pg_catalog.strpos`.

La version corrigée a été validée le 3 septembre sur un clone jetable du schéma
de production :

- mode d'upgrade détecté correctement ;
- migration `20260903120000_media_cache_gateway_session_id_cast_v1.sql`
  appliquée ;
- coordination concurrente `SKIP LOCKED`, purge, reprise après corruption et
  quotas validés ;
- reçu final : 10 migrations, 3 purges terminées, 2 tombstones sécurité et
  1 récupération de corruption, sans purge en échec ;
- nettoyage automatique confirmé : 0 conteneur et 0 volume canari restant ;
- PostgreSQL principal, Gateway et les deux réplicas Edge restés sains.

Cette preuve concerne la migration isolée. Elle ne vaut pas activation globale
du cache : les drapeaux globaux restent désactivés et la cohorte opérateur reste
en `read/shadow` tant que le canari producteur puis l'acceptation réelle ne sont
pas terminés.

### Preuves de validation de la réparation

- suite locale complète après `85ee7ce7` : 3 451 tests, 3 444 réussis,
  0 échec et 7 ignorés ;
- test ciblé après `8a3ebd2c` : 3/3 réussi ;
- archive du canari isolé : SHA-256
  `3af0f8ff95b97286958a817a27a73331edeb23657123a565ebf0ac7223c5b401` ;
- GitHub Actions du commit final au vert :
  [build complet](https://github.com/Admin-Adher/Norva/actions/runs/33709775955),
  [Cloudflare Pages](https://github.com/Admin-Adher/Norva/actions/runs/33709775951),
  [Relay](https://github.com/Admin-Adher/Norva/actions/runs/33709775952) et
  [intégration Partners](https://github.com/Admin-Adher/Norva/actions/runs/33709775950).

## Mesures réelles conservées

### Lecture passive de référence du 3 septembre 2026

`Days of Summer (MULTI) FHD 2009`, cache au stade lecture seule :

- démarrage Gateway observé autour de 11,6 s et première image visible autour de
  15,5 s sur cet essai précis ;
- durée exacte : 1 h 35 min 04 s ;
- 3 pistes audio et 3 sous-titres fournisseur disponibles ;
- 45,325 s de média avancées en 45,348 s murales ;
- 129,476 s réellement visionnées ;
- reprise conservée après retour Movies ;
- après sortie : 0 session Gateway, 0 encodeur, 0 pompe raw, 0 broker, 0 viewer,
  0 continuation, 0 permis et 0 lease.

Le même jour, l'opérateur a également signalé plusieurs essais manuels sur des
fournisseurs différents perçus comme « très rapides ». C'est une confirmation UX
positive, conservée comme observation qualitative ; elle ne remplace pas les
mesures instrumentées et la preuve de nettoyage de l'acceptation finale.

## Observabilité utile

Les diagnostics doivent rester agrégés et sans secret :

- Gateway `/health` : sessions, encodeurs, pompes, brokers, viewers, cache local,
  sonde in-band, publications, heartbeats, live join et continuation ;
- Edge `/health` : version, protocole, état de configuration et stade de cohorte,
  sans exposer les hashes sélectionnés ;
- PostgreSQL : sessions de lecture, sessions Gateway, permis fournisseur, leases
  cache, objets, liaisons, décisions d'admission, métriques et purges ;
- navigateur : première frame, temps média versus temps mural, pauses, readyState,
  plages bufferisées, pistes, durée et reprise.

## Acceptation avant généralisation

Un fournisseur n'est pas « validé » après un seul démarrage réussi. Le jalon
final reste :

1. dix MKV consécutifs, fournisseurs actifs mélangés ;
2. chaque lecture réellement maintenue 2 à 5 minutes ;
3. démarrage à froid et reprises représentés ;
4. pistes audio et sous-titres disponibles dès le premier démarrage ;
5. durée, timeline, seek et reprise exacts ;
6. fluidité mesurée par progression média/murale et événements d'attente ;
7. retour Movies après chaque film ;
8. après chaque retour : zéro session, encodeur, pompe, broker, permis et lease ;
9. essais cache froid, cache chaud, concurrence, corruption, panne R2 et révocation ;
10. mesures régionales Europe, Inde et Maghreb, sans confondre latence utilisateur
    et débit fournisseur vers Hetzner.

Au 3 septembre 2026, Promax, Opplex et Airysat ont chacun déjà produit des
lectures réelles de plus de deux minutes au cours de la stabilisation, mais aucun
fournisseur n'est encore certifié selon l'intégralité de cette grille. KING365
n'est pas compté tant que son accès fournisseur reste désactivé ou défaillant.

## Chronologie technique condensée

| Date | Jalons principaux |
| --- | --- |
| 17–18 août | `7259d5d1`, `5d19f2f2`, `ad19c774` : politique de démarrage vérifiée, preuve fail-closed et baseline Gateway/Edge. |
| 30–31 août | `99f18efb`, `62752312`, `8168b02a`, `435be8c7`, `5b536aa8`, `84e34243` : sous-titres non bloquants, pistes initiales, connexion MKV réutilisée, récupération préfetch, durée/timeline. |
| 1er septembre | `51f14ba2`, `c4ed54cd`, `7f079556`, `fba1f3c5` : démarrage MKV adaptatif, MP4 direct, autorité de sonde et décodage SOCKS5. |
| 1–2 septembre | `283aa85d` à `1d4e2238` : objets globaux, Worker privé, tickets, publication manifest-last, single-flight, live join, gouvernance, purge et récupération. |
| 2 septembre | `0068397b`, `7af7029a`, `e56b3617`, `4d328020` : pistes sous-titres exactes, reprise rapide et viabilité de route à l'offset réel. |
| 3 septembre | `fac9d36b`, `c9f16bdb`, `bcc0de64`, `85ee7ce7`, `8a3ebd2c` : cible segment signée, cohorte opérateur, réparation des callbacks UUID/text et canari d'upgrade isolé validé. |

## Règles à préserver

- Ne jamais renvoyer un MKV au navigateur uniquement pour gagner du temps.
- Ne jamais faire passer un MP4 compatible par le Gateway sans nécessité.
- Ne jamais lancer plusieurs benchmarks fournisseur en parallèle.
- Ne jamais changer fréquemment l'IP d'un même compte fournisseur.
- Ne jamais geler une topologie avant la sonde exacte disponible.
- Ne jamais bloquer la première image sur une piste non sélectionnée.
- Ne jamais publier un manifeste avant tous ses fichiers vérifiés.
- Ne jamais considérer un test local ou un benchmark proxy comme preuve de
  production bout-en-bout.
- Ne jamais déclarer une cible de vitesse atteinte lorsque la source fournisseur
  ne peut physiquement pas livrer les octets requis.
- Ne jamais accepter une sortie lecteur avec une ressource serveur résiduelle.
