# Live TV — incident 458 « max connections » & contention du slot provider (2026-07-10)

> Trace complète : symptôme, diagnostic (avec la fausse piste corrigée), actions
> immédiates, correctifs durables (crons + UX + layout), vérifications, et
> analyse de la cause racine (vérifiée par workflow adversarial).
> Docs liés : `PROVIDER-ANTIBAN-NINJA.md` (le ban Ninja du 03-07 et le principe
> « 1 connexion provider par identité »), `CRON-OPTIMIZATION-AUDIT.md` (l'audit
> des 35 crons), `OFFLINE-DOWNLOAD-CODECS.md` (pistes audio/sous-titres offline).

## 1. Symptôme

Le 10-07 en journée, la page **Live TV** du propriétaire : liste de chaînes
**vide** (« No channels »), erreurs **HTTP 458 max connections / Provider
connection slot busy** en console. En parallèle, le compte Ninja est **prêté au
père** (films/séries uniquement) — il ne doit jamais être interrompu. ~90 600
chaînes live existaient pourtant en base : ce n'était **pas** un problème de
données, mais un échec de chargement + un slot provider occupé.

## 2. Diagnostic — y compris la fausse piste (à garder en mémoire)

1. **Fausse piste corrigée** : premier réflexe = pauser les crons #95
   (`norva-revalidate-provider-ids`) et #10 (`norva-audio-langs-untagged`).
   **Erreur** — lecture du code ensuite :
   - **#95** appelle `norva-source-sync/cron/revalidate` qui valide contre
     **TMDB** (`validateTmdbCandidate`), jamais le provider → n'ouvre **aucun**
     slot. Le `conc=12` est de la concurrence TMDB, pas provider.
   - **#10** cible un **autre compte** (`c5be5ac4…`, source `super8k.top`,
     identité `x:f2e3ed06…`) — vérifié en base : cette identité n'existe **que**
     sur ce compte-là. En plus, le runner audio-backfill a un garde-fou
     `userHasLiveSession` (defer si session live) + circuit breaker.
   → Les deux ont été **réactivés**. Leçon : toujours lire le code du cron
   avant de désigner un coupable.
2. **Vrais coupables** : les 6 sondes audio par-provider du compte propriétaire
   (`7bdab1df…`), qui ouvrent un flux provider pour sonder la langue audio des
   VOD — sur des comptes provider à **1 connexion max** :

   | Cron | Provider | Ancien schedule |
   |---|---|---|
   | 62 | promax (`line.4k-beast.top`) | `1-59/3 6-23` (journée) |
   | 63 | opplex (`fun-fun2026.lol`) | `2-59/6 6-23` (journée) |
   | 64 | king365 (`r656.dad`) | `4-59/12 6-23` (journée) |
   | 65 | airysat (`mandara.cc`) | `5-59/30 6-23` (journée) |
   | 79 | **ninja** (`operator1.barfik.org`) | `4-59/12 * * * *` (**24 h/24 !**) |
   | 80 | **ninja-séries** | `9-59/12 * * * *` (**24 h/24 !**) |

   79/80 tournaient toutes les heures — le pire cas pour le compte prêté.

## 3. Actions sur les crons (état final)

1. **Relief immédiat** : pause des 6 sondes (`cron.alter_job(job_id := N,
   active := false)` — l'`UPDATE cron.job` direct est refusé au rôle
   `postgres` ; `alter_job` est SECURITY DEFINER).
2. **Durable** : reprogrammation des 6 sur la **fenêtre nuit `2-5` UTC**
   (04 h–08 h heure FR l'été) — même réactivées plus tard, elles ne
   croiseront plus le visionnage de journée/soirée.
3. **Décision du propriétaire (10-07)** : *« on peut laisser actif les crons
   sauf ceux de NINJA car mon père utilise uniquement NINJA »*. Avant de
   rebrancher, vérification que les 4 autres providers ne partagent **pas**
   l'identité Ninja (un rebrand = même slot) : les 5 `providerKey` sont
   **tous distincts** → réactivation sans risque pour le père.

   | Cron | Provider | Schedule | Actif |
   |---|---|---|---|
   | 62 | promax | `1-59/3 2-5 * * *` | ✅ oui |
   | 63 | opplex | `2-59/6 2-5 * * *` | ✅ oui |
   | 64 | king365 | `4-59/12 2-5 * * *` | ✅ oui |
   | 65 | airysat | `5-59/30 2-5 * * *` | ✅ oui |
   | **79** | **ninja** | `4-59/12 2-5 * * *` | 🔴 **non (prêt au père)** |
   | **80** | **ninja-séries** | `9-59/12 2-5 * * *` | 🔴 **non (prêt au père)** |
   | 10 | super8k (autre compte) | `*/3 6-23` | ✅ oui (identité isolée) |
   | 95 | revalidate TMDB | `2-59/4` | ✅ oui (zéro slot provider) |

   **Fin du prêt → réactiver ninja** :
   ```sql
   select cron.alter_job(job_id := 79, active := true);
   select cron.alter_job(job_id := 80, active := true);
   -- optionnel : les remettre en journée si le tagging nuit est trop lent
   -- select cron.alter_job(job_id := 79, schedule := '4-59/12 * * * *');
   ```

## 4. Correctifs front (commit `fc7467a`, déployés + vérifiés en live)

Le vécu utilisateur du 458 était catastrophique parce que le guide Live ne
distinguait pas « échec de chargement » de « catalogue vide » :

1. **État vide → récupérable** (`ChannelList.js`, `LiveGuideFusion.js`) :
   - `ChannelList` trace `loadError` / `hasLoadedOnce` ; le catch de
     `loadAllChannels()` (qui ne faisait que `console.error`) alimente
     désormais l'UI ; nouvelle méthode `reloadLive()`.
   - `LiveGuideFusion.render()` : panneau d'état dédié quand 0 chaîne chargée —
     spinner (« Loading your channels… ») pendant le premier chargement,
     **« Couldn't load your channels — Try again »** sur échec (bouton qui se
     désactive au tap), « No channels yet — Refresh » si vraiment vide.
     Basé sur la liste **brute** (pas la vue filtrée) pour qu'un groupe 100 %
     masqué garde le message « No channels in this group » normal.
2. **Layout téléphone** (`main.css`) : en paysage, un téléphone (>768 px)
   tombait dans le split 2 colonnes « tablette » (rail 190 px). L'app APK
   (`norva-phone-apk`) est désormais **épinglée en 1 colonne à toute largeur**
   (bandeau de groupes horizontal → aperçu → liste).
3. Vérifié **headless** (6 scénarios : loading/error/empty × web/phone,
   clic Retry = 1 seul appel + bouton désactivé) puis **en live** sur
   norva.tv après le déploiement Cloudflare. L'app téléphone charge norva.tv
   à distance → correctifs actifs **sans rebuild APK**.

## 5. Cause racine — analyse vérifiée (workflow adversarial `wf_21b929da-f47`)

Affirmation initiale de l'ingénieur : *« la cause racine reste
max_connections:1 — n'importe quelle sonde pendant n'importe quel visionnage
sur la même identité entre en conflit ; le fix blindé = verrou « provider
occupé » au niveau de l'identité dans le chemin de sonde ; nuit + Retry
couvrent 99 % du vécu »*.

**Verdict : PARTIELLEMENT VRAI** (10 agents, 329 appels outillés ; les
citations clés ont été re-vérifiées à la main ensuite).

### 5.1 Confirmé

- Les sondes ouvrent de **vraies connexions provider** avec les identifiants
  de la source ; toute lecture simultanée sur le même **compte** se fait
  refuser (le 458 est relayé tel quel ; la gateway le resynthétise en
  `503 PROVIDER_BUSY`). Un incident identique est documenté dans le repo
  (migration `20260702150000`).
- **Le trou de garde-fou est réel** : toutes les vérifications « en train de
  regarder » du chemin de sonde standard sont scoppées **par `user_id`**
  (`userHasLiveSession` — `norva-playback/index.ts:3215-3234`,
  `accountPregenActive` `:3248-3257`), donc aveugles à : un 2ᵉ compte Norva
  sur les mêmes identifiants, la lecture native directe au-delà de ~15 min,
  les téléchargements, et — point clé — **la Live TV web elle-même** : la
  session reste `pending` à jamais, la télémétrie ne s'émet qu'au zapping →
  le signal s'éteint **~4 min après le début de tout visionnage réel** (le
  commentaire du code l'admet, `index.ts:3223-3227`).

### 5.2 Les 4 corrections découvertes (l'affirmation était imprécise)

1. **« Identité » est la mauvaise granularité.** `max_connections` est par
   **COMPTE** (host+username), pas par identité de panel. La gateway calcule
   déjà la bonne clé (`proxyKeyFromUrl`, `media-gateway/src/index.js:56-62`) ;
   un verrou par identité sur-sérialiserait des comptes distincts d'un même
   panel (cf. `PROVIDER-IDENTITY-DEDUP.md`).
2. **Un verrou « compte occupé » existe DÉJÀ** dans une voie de sonde : la
   gateway `/probe-audio` renvoie `409 account_busy`
   (`media-gateway:778-793`) — mais uniquement pour les identités
   `low_footprint` et **in-process** (une seule box). La voie relay par
   défaut n'a **aucun** verrou.
3. **Un verrou seul serait aveugle** : la table qu'il lirait est vide
   exactement là où l'incident s'est produit (la Live TV web n'écrit aucun
   heartbeat). Il faut aussi un **ÉCRIVAIN** du signal — le rapporteur
   naturel est la gateway, qui voit déjà l'occupation du slot.
4. **Le « 99 % » était surestimé.** Vérifié en prod le 10-07 : les jobs
   **10** (compte adrien.outlook/super8k, `*/3 6-23`) et **36** (jeremy,
   `*/5 6-23`, **sans sourceId** → draine sur 2 panels distincts = le
   scénario `user_multi_ip` que le code dénonce) sondaient **encore en
   journée** à 15h45 UTC. Le bouton « Try again » du guide recharge la
   **liste**, pas le flux — et le classificateur Live
   (`api.js:61-67`, re-vérifié) matche `401/403/429` mais **pas
   458/max connections** → une chaîne 458 s'affiche « morte ». Et la fenêtre
   nuit chevauche la TV du matin (02-05 UTC = 04-08 h locale l'été).
   **Couverture honnête : ~60-70 % de l'exposition totale ; ~99 % seulement
   pour « le foyer du propriétaire en soirée ».**

### 5.3 Chemins de visionnage NON protégés par les gardes actuelles

| Chemin | Pourquoi invisible |
|---|---|
| Live TV web (l'incident) | session jamais `ready`, événements au zap only → aveugle après ~4 min |
| Lecture native directe | session `ready` TTL 900 s **sans keepalive** ; historique écrit à la fermeture → un film de 2 h est collidable ~1 h 45 |
| Téléchargements | copie d'octets depuis l'IP domicile, **zéro appel cloud** pendant des heures |
| 2ᵉ compte Norva, mêmes identifiants provider | tous les reads sont `.eq user_id` |
| APK standalone (serveur local) | aucun appel cloud |
| Divers | bypass `ignoreLiveSession` ; TOCTOU ~110 s (re-check mi-tick **implémenté mais éteint** : `NORVA_CRAWL_YIELD_TO_VIEWERS`, défaut OFF, `index.ts:3207`) ; jobs whisper/pregen déjà lancés (~45 min) ; appareils non-Norva ; traîne de libération ~8 s au zap |

### 5.4 Le fix blindé, version corrigée (design validé contre le code)

1. **Clé = COMPTE** (host+username via `proxyKeyFromUrl`), pas l'identité.
2. Table `provider_account_activity(account_key PK, last_seen_at, kind)` —
   clone du pattern `provider_probe_circuit` (RLS sans policy, service_role).
3. RPCs SECURITY DEFINER : `provider_account_touch(key, kind)` /
   `provider_account_busy(key)` → `last_seen_at > now() − 5 min`.
4. **Écrivains (la pièce manquante)** : (a) rapporteur gateway→edge upsert
   ~60 s piloté par `accountExtractions/rawPumps` (canal `mediaGatewayToken`
   déjà en place) — couvre Live web + VOD transcode + pregen ; (b) `touch`
   dans `createPlaybackSession`, `recordPlaybackEvent`, `saveHistory`.
5. **Lecteur** dans le chemin de sonde (relay inclus), re-check mi-tick
   inconditionnel, famine bornée (pattern `JOB_GATE_MAX_DEFERRALS`), les
   crons ne bypassent pas via `ignoreLiveSession`.
6. Ticks **sans sourceId** (ex. job 36) : résoudre la clé par titre ou exiger
   `sourceId` partout.
7. **Limites assumées** : ne protégera jamais la lecture native > 15 min sans
   keepalive client, les téléchargements, l'APK standalone, les appareils
   non-Norva, l'auto-collision au zap (traîne 8 s).

### 5.5 Recommandation (du workflow, contresignée)

- **Immédiat (quasi zéro code)** : reprogrammer/scoper les jobs **10 et 36**
  (dernières sondes diurnes ; le 36 reproduit la collision cross-panel) ;
  **activer `NORVA_CRAWL_YIELD_TO_VIEWERS`** (le re-check existe, il est
  juste éteint).
- **Court terme (1-2 j, le vrai fix)** : verrou « compte occupé » ci-dessus —
  lecteur **et** écrivain gateway→edge, clé host+username. En parallèle,
  **classificateur Live 458-aware** (`api.js:61-67` + retry ≥ 8 s) : le fix
  UX le moins cher au meilleur rendement, car il couvre aussi les 458
  qu'aucun verrou ne peut empêcher.
- **Différable** : keepalive natif, signalement des téléchargements.
- Pourquoi pas « jamais » : la reprogrammation nocturne est une coïncidence
  d'emplois du temps, pas une garantie — chaque nouvel utilisateur ou source
  recrée le conflit ; tous les précédents techniques existent déjà.

## 7. Implémentation des 2 points (fait — 2026-07-10, commits 3e48f05 + aff38c5)

Les deux volets recommandés au §5.5 sont **implémentés, revus (workflow
adversarial 22 agents → 15 findings corrigés), et déployés sur `main`**.

### Point 1 (ops)
- Crons **10, 36, 62-65, 79-80** reprogrammés en **fenêtre nuit `1-4 UTC`**
  (03-07 h locale) — plus aucune sonde diurne. 79/80 (ninja) restent en pause.
- `NORVA_CRAWL_YIELD_TO_VIEWERS` : défaut **OFF → ON** (`index.ts`), re-check
  mi-tick actif.

### Point 2 (verrou compte occupé)
- Migration `20260710170000_provider_account_activity.sql` (appliquée) : table
  + RPCs `provider_account_touch_many` / `provider_account_touch_by_source` /
  `provider_account_busy` (fenêtre **5 min**, service_role only, fail-open).
  Clé = `lower(host)/username` **décodé** (les 3 producteurs alignés — vérifié
  y compris usernames `@`/espace/`+`).
- **Écrivains** : rapporteur gateway→edge (`POST /account-activity`, ~60 s) +
  touches dans `createPlaybackSession`, `recordPlaybackEvent`, `saveHistory`
  (+ jumeaux `norva-cloud`).
- **Lecteur** : check en tête de tick (crons par-source, **avant** la
  résolution série qui touche le panel) + par-titre (ticks account-wide) +
  branche whisper ; tick tout-occupé → `skipped` (n'efface pas l'épuisement).
- **Web** : `_looksProviderSlotBusy` (458/PROVIDER_BUSY) — une chaîne 458
  s'affiche « momentanément saturée, réessayer », plus « morte » ; **pas** de
  boucle de retry client (évite le storm sur la boucle interne du gateway).

### ⚠️ Étape ops manuelle requise (propriétaire)
Le **rapporteur gateway** est **inerte** tant que la variable d'env
**`NORVA_EDGE_CALLBACK_BASE`** n'est pas posée dans le service **Railway**
(media-gateway) :
```
NORVA_EDGE_CALLBACK_BASE=https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback
```
Sans elle, le verrou fonctionne quand même (touches session/événement/
historique + crons de nuit + lecteur), mais le cas « spectateur live web
au-delà de 5 min » n'est pas couvert par le rapporteur. Log de démarrage
gateway : `account-activity reporter IDLE — set NORVA_EDGE_CALLBACK_BASE…`.

## 8. Suivi restant

- [x] Point 1 + Point 2 implémentés, revus, déployés.
- [ ] **Poser `NORVA_EDGE_CALLBACK_BASE` dans Railway** (couverture complète).
- [ ] Différable : keepalive session lecture native ; signalement des
      téléchargements (slot tenu des heures, zéro télémétrie).
- [ ] Fin du prêt : réactiver crons 79/80 (`cron.alter_job(job_id:=79/80,
      active:=true)`).
