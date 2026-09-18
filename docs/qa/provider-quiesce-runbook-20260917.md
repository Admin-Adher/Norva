# Suspension effective des admissions de fond — procédure v2, soumise à accord

État : **proposition. Rien n'a été exécuté.** La v1 de ce document proposait une « session de garde » : elle est
**retirée** (voir §1). Aucune opération ci-dessous ne sera lancée sans accord explicite.

---

## 1. Ce qui est retiré, et pourquoi

La v1 ouvrait une session de lecture sur le principal pour déclencher `preemptBackgroundWorkGlobally()` et le
blocage `viewerPlaybackActiveLocally()`. Trois défauts, tous fondés :

1. **Elle détourne une lecture pour bloquer des traitements** et consomme un compte fournisseur pendant toute la
   fenêtre.
2. **Elle ne protège que le principal.** Quatre autres conteneurs de la famille Gateway tournent
   (`v154-canary`, `v155-canary`, `media-lab-gateway`, `media-lab-runner`) et ne sont pas affectés par elle.
3. **Attendre l'inactivité puis créer la garde laisse une course** : un travail peut redémarrer entre le relevé
   et la création, et se faire tuer.

S'y ajoute un défaut de la v1 sur la mesure : la sonde `ffprobe` n'y était pas séquencée avec la lecture, donc
elle pouvait ouvrir une **seconde connexion sur le même compte**.

## 2. Ce que le principal sait déjà faire, et ce qui manque

| primitive existante | effet | suffisant ? |
|---|---|---|
| `POST /sessions/stop-provider-affinities` (auth) | vide un compte précis : sessions, raw pumps, extractions, validations de langue ; renvoie `providerDrained` **vérifié**, sinon HTTP 409 | **non** : draine, mais ne bloque pas la ré-admission |
| `preemptBackgroundWorkGlobally()` via `POST /sessions` | préempte extractions, Whisper et CPU de fond | non : effet de bord d'une lecture, et lié à la garde retirée |
| `viewerPlaybackActiveLocally()` → `backgroundJobBlockedByViewer()` | diffère les admissions de fond | non : conditionné à une session vivante |

**Ce qui manque est une barrière d'admission explicite, à durée bornée, indépendante d'une lecture.** Le
principal n'en a pas. Le pilote, lui, la possède déjà (`maintenance-fence.js` + `maintenance-http.js`,
`GATEWAY_MAINTENANCE_ENABLED=true`), et elle a servi sans incident à chacune de ses bascules.

## 3. Modification demandée — exactement celle-ci, et rien d'autre

**Objet :** porter sur le principal la barrière d'admission déjà en service sur le pilote, et lui ajouter un mode
« quiesce fournisseur » à expiration automatique.

**Fichiers ajoutés/remplacés (trois, dérivés de l'image actuellement en service) :**
- `maintenance-fence.js` — ajout, identique à celui du pilote ;
- `maintenance-http.js` — ajout, identique à celui du pilote ;
- `index.js` — patch ancré minimal : montage des routes de maintenance, et test de la barrière dans le
  chemin d'admission de fond, à côté du `backgroundJobBlockedByViewer(job)` existant.

**Comportement demandé :**
- `POST /maintenance/prepare` ouvre une barrière qui **refuse toute nouvelle admission de travail de fond** et
  renvoie un jeton ainsi que l'état de drainage courant ;
- la barrière **expire d'elle-même** (délai borné, proposé : 20 minutes) et se libère aussi à
  `POST /maintenance/cancel` ; **aucune action d'opérateur n'est nécessaire pour restaurer** ;
- elle ne tue rien : les opérations en cours vont à leur terme (cf. §4) ;
- désactivée par défaut (`GATEWAY_MAINTENANCE_ENABLED` absent ⇒ comportement actuel inchangé).

**Interruption impliquée :** un échange de conteneur du principal (même protocole cloné/reçu/rollback que les
bascules pilote). C'est le seul redémarrage demandé. Conséquences précises :
- les six storyboards rechargent depuis leurs checkpoints (156/24/120/30/126/30, `savedFrames == intactFrames`,
  vérifiés à plusieurs reprises) ;
- **l'inférence Whisper en cours et le travail prioritaire non différable n'ont pas de checkpoint** : ils sont
  perdus en avancement et doivent être ré-enfilés. À faire **avant** l'échange : attendre
  `transcribeBusy == false` et `whisperInferenceActive == 0`, ce qui supprime cette perte ;
- rollback : conteneur précédent conservé sous suffixe `-retained`, reçu privé, restauration automatique en cas
  d'échec pendant la bascule.

**Synergie à considérer.** Les identifiants proxy exposés ne peuvent être changés qu'en recréant les
conteneurs : l'environnement est figé à la création. Le principal a été créé le **2026-09-16T09:46:26Z**, soit
avant l'exposition, et n'a pas été recréé (`RestartCount=0`) ; le pilote a été cloné depuis lui. Les empreintes
des deux variables proxy sont **identiques** sur les deux conteneurs. La rotation et l'installation de la
barrière exigent donc **le même unique échange de conteneur** : les faire ensemble évite un second
redémarrage.

**Si cette modification n'est pas accordée**, aucune exclusion effective n'est atteignable sur le principal, et
l'essai fournisseur doit rester suspendu. Je ne propose pas de contournement.

## 4. Séquence de la fenêtre, une fois la barrière en place

Aucune étape ne repose sur un simple relevé d'inactivité.

1. **Fermer les admissions partout où le compte testé pourrait être pris.**
   - Principal : `POST /maintenance/prepare` → barrière active, jeton, expiration 20 min.
   - Quatre conteneurs secondaires (`v154-canary`, `v155-canary`, `media-lab-gateway`, `media-lab-runner`) :
     `docker pause` — suspension **effective** et atomique du processus, et non une surveillance.
     `docker unpause` restaure.

     Vérifié à la rédaction : Caddy ne route que `@playback` vers `127.0.0.1:8081`, c'est-à-dire le seul
     principal. Les deux canaris n'écoutent que sur des ports de boucle locale (`18083`, `18084`) sans route
     Caddy, les deux conteneurs `media-lab` n'exposent aucun port, et les quatre présentaient zéro connexion
     sortante établie et aucun hôte fournisseur. Aucun ne sert donc de trafic utilisateur. À revérifier au
     moment de l'exécution : absence de connexion entrante sur `18083`/`18084` et absence de slot proxy actif.
2. **Laisser terminer les opérations actives non sauvegardées.** La barrière n'interrompt rien. Attendre que
   `transcribeBusy == false`, `whisperInferenceActive == 0`, `activeSessions == 0`, `rawPumpCount == 0`.
   Rien n'est tué, donc rien n'est perdu.
3. **Vider et vérifier le compte testé.** `POST /sessions/stop-provider-affinities` avec l'empreinte du compte
   de l'essai ; exiger `providerDrained: true` (un HTTP 409 interdit de continuer). La barrière étant déjà
   fermée, la ré-admission qui rendait ce drain insuffisant en v1 ne peut plus se produire.
4. **Essai unique**, sur une variante identifiée sans ambiguïté, sur le pilote.
5. **Restauration** : `POST /maintenance/cancel` sur le principal (ou expiration automatique),
   `docker unpause` des quatre conteneurs, puis contrôles §6.

**Restauration garantie même en cas d'échec de l'essai** : la barrière expire seule ; `docker unpause` est la
seule action manuelle, et elle est idempotente. Un échec de l'essai n'a aucun effet sur l'état du principal, qui
n'a rien tué.

## 5. Séquencement sonde / lecture — jamais simultanés

La correspondance temps ↔ octets ne sera **pas** obtenue par un `ffprobe` parallèle.

- **Source principale, sans aucune connexion supplémentaire** : les cibles de seek de la session elle-même. Le
  Gateway calcule chaque `actualStartOffset` depuis l'index du fichier, et `finiteMkvSeekBroker.windowTrace`
  publie le `providerStart` correspondant. Plusieurs seeks dans la **même** session donnent donc plusieurs
  couples (temps réel, octet réel) issus de l'index, dont celui de la position sauvegardée.
- **Si un `ffprobe` complémentaire est jugé nécessaire**, il est lancé **strictement après** la fermeture de la
  lecture, et seulement une fois `stop-provider-affinities` revenu avec `providerDrained: true` sur ce compte.
  Jamais pendant la lecture, jamais en parallèle.

## 6. Contrôles de restauration (tous exigés)

- `activeSessions == 0` ; barrière relâchée ; quatre conteneurs `unpause` et `Running`.
- Six storyboards présents, `savedFrames == intactFrames`, **aucun `savedFrames` en régression** face au relevé
  initial.
- Aucun travail disparu de la file par rapport au relevé initial, déduction faite des travaux réellement finis.
- `RestartCount` du principal inchangé **après** la bascule, et image égale à celle installée.
- Reprise effective du fond (`transcribeBusy` redevient vrai, ou la file décroît).

## 7. Conditions d'abandon immédiat

Un hôte ou un slot proxy inattendu apparaît sur l'un des cinq conteneurs ; une lecture utilisateur réelle
démarre ; un checkpoint régresse ; `providerDrained` revient faux ; la fenêtre atteint 20 minutes.

## 8. Mesures du seul essai autorisé

Ensemble, sur une variante identifiée sans ambiguïté (`rawTitle`, `streamId`, `sourceId` relevés avant lecture,
plus l'identifiant de session) : position réelle du lecteur au fil du temps ; position réellement sauvegardée ;
plages **demandées** (`windowTrace`, `providerStart`/`providerEnd`) ; plages **conservées** et évictions
(`GET /debug/resume-ranges`, déjà déployé) ; et les couples (temps, octet) issus des cibles de seek.

Aucune modification de politique de conservation ne sera proposée avant que cette trace existe.
