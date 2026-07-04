# Fiabilité du pipeline sous-titres IA — audit des 10 échecs & correctifs (2026-07-02)

**Contexte.** Le Cockpit affichait `10 échoués / 4 prêts` sur les sous-titres IA. Audit multi-agents
(34 agents : 4 investigateurs code+DB, un vérificateur adversarial par conclusion, synthèse) →
**4 causes distinctes**, aucune liée à la qualité Whisper. Correctifs livrés dans ce commit-set
(gateway v60 + norva-playback + migration `20260702150000`).

## 1. Les 4 causes racines (résumé, preuves dans l'audit)

| Groupe | Jobs | Cause prouvée |
|---|---|---|
| **A — super8k × 6** « Audio extraction failed » | 1350344, 789863, 1933470, 770994, 27774, 1775747 | Refus de connexion du panel mono-slot : le ffmpeg d'extraction (IP proxy résidentiel) atterrissait **pendant** un batch de probes relay (IP Cloudflare) du même compte — prouvé à la seconde le 01/07 00:45. La queue gateway (concurrency 1) exécute les jobs 15-50 min après l'enqueue 00:20/25/30 → en plein grid des crons nuit. Les deltas « échec après 45 min » = attente de queue + fast-fail ~1 s. |
| **B — Ninja 1990257** « Audio extraction failed » | 1990257 | Refus panel-side des lectures VOD automatisées cette nuit-là (aucune collision cron prouvée ; zéro probe positif jamais pour ce titre). Trancher exige les logs stdout Railway du 02/07 ~01:15. |
| **C — « no output » × 2** | Ferran 1003534, Airysat 194484 | Extraction **réussie**, puis whisper **SIGKILL au timeout plat de 20 min** — whisper.cpp n'écrit le `.vtt` qu'à la fin, donc kill = zéro sortie. Arithmétique exacte sur la queue série (~90 s / ~35 s d'extraction + 1 200 s pile). |
| **D — OCR apdxes 401** | 18690 | Blocage anti-abus temporaire du panel pendant le premier test e2e du pipeline OCR (30/06 15:37) : premiers refus type 429 (créds authentifiées), escalade 401 après essais rapprochés. Le retry avec break 401/403 (d7cdbce) a été ajouté 30 min APRÈS. Créds valides (sync OK le 02/07 10:28). |

Amplificateurs transverses confirmés : queue transcribe concurrency-1 globale (drift hors du
stagger d'enqueue) ; aucun verrou cross-lane par compte dans le gateway ; garde `userHasLiveSession`
uniquement à l'enqueue ; diagnostics jetés (2 chaînes constantes pour 9 échecs sur 10 ; la seule
ligne verbeuse — OCR — exposait username/password en clair dans le Cockpit).

## 2. Correctifs livrés

1. **#1 Diagnostic réel, créds masquées** (gateway) — `extractAudioWav` retourne `{ok, path|error}`
   (stderr tail / timeout / WAV vide), `runWhisperVtt` retourne `failReason` (SIGKILL-timeout vs
   crash) ; `redactCreds()` appliqué à toute chaîne dérivée du stderr (fuite OCR corrigée). Les
   erreurs DB deviennent auto-diagnostiquantes dans le Cockpit.
2. **#2 Verrou par compte, cross-lane** (gateway) — `withAccountJobLock` : un seul ffmpeg
   provider-touchant à la fois par compte (extraction transcribe, OCR par tentative,
   /detect-language avec fast-fail « busy », /transcribe sync). Les chemins viewer (/raw, /subtitle,
   playback) gardent leur machinerie d'éviction dédiée. Whisper/tesseract (pur CPU) hors verrou.
3. **#5 Budget Whisper adaptatif** (gateway) — `whisperBudgetMs = max(20 min, durée_audio × 0,5)`
   (RTF mesuré ~0,09-0,15 → marge 3-5×). Film 90 min → 45 min ; 3 h → 90 min. Env :
   `WHISPER_RTF_BUDGET` (0,5), `WHISPER_TRANSCRIBE_TIMEOUT_MS` reste le plancher.
4. **#3 Coordination crons ↔ pregen** (migration + edge + gateway) — deux directions, fail-open :
   - *(a) les crons cèdent aux jobs* : `claim_generated_subtitle_job(+p_claimed_by)` mémorise le
     compte dont le job utilisera le slot ; les dimensions d'enrichissement (probe/vod/subtitle +
     whisper-LID) skippent le compte tant qu'une ligne `processing` fraîche (< 2 h, seuil du reaper)
     lui appartient → `skipped:"pregen-active"`. Index partiel `(claimed_by) where processing`.
   - *(b) les jobs cèdent aux ticks et aux viewers* : heartbeat `enrichment_tick_heartbeat`
     (1 upsert par run de dimension provider-touchante) ; le gateway POST `norva-playback/pregen-gate`
     (auth token gateway) avant d'ouvrir la connexion provider → défère si viewer live ou heartbeat
     < 150 s. Jobs déférés : rotation en fin de queue (les autres comptes avancent), re-scan 60 s,
     échec explicite après ~4 h. Convergence rapide : dès le 1ᵉʳ tick skippé (a), plus de heartbeat →
     le gate (b) s'ouvre en ≤ 2,5 min.
5. **#4 Résilience extraction** (gateway) — flags `-reconnect/-reconnect_streamed/-reconnect_delay_max 5/
   -rw_timeout 15 s/keep-alive` (parité playback, toujours SANS `-reconnect_on_http_error`) + retry
   job-level 2×, backoff espacé 30/60 s, **break immédiat sur 401/403** (anti-abus).

## 3. Traitement des 10 lignes `failed`

| Ligne | Décision |
|---|---|
| 1350344 (super8k) | **Purgée** : titre supprimé du catalogue par la re-sync du 01/07 (plus aucune variant) — job orphelin impossible à réussir. |
| lang=`fr` OCR 18690 (apdxes) | **Purgée** : clé de cache legacy (le code actuel écrit `fr#<index>`) — ligne zombie inréclamable. L'OCR se re-déclenchera à la demande (menu sous-titres du viewer) avec le bon index de piste. |
| 789863, 1933470, 770994, 27774, 1775747 (super8k) | **Re-enfilés** après déploiement v60 (mode service `transcribe-enqueue`, séquentiel — la coordination (a)/(b) gère les crons jour). |
| 1003534 (Ferran), 194484 (Airysat) | **Re-enfilés** après v60 (le budget adaptatif corrige leur cause). 194484 : si re-échec « ready/segments 0 », média placeholder → ne plus retenter. |
| 1990257 (Ninja) | **En attente** : consulter les logs Railway du 02/07 ~01:15 (seule trace du code d'erreur réel pré-v60) ; le panel refusait toutes les lectures VOD automatisées cette nuit-là. |

## 4. Ce qui reste / suivi

- Compteur de réussite pregen **par provider** au Cockpit (super8k était à 0/6 all-time sans signal) —
  non demandé dans ce lot, candidat au prochain.
- Alerte « sync en erreur > N h avec relances en boucle » (le cas super8k 29/06→01/07) — idem.
- Ninja : diagnostic via logs Railway, puis décision (retry vs média/panel définitivement fermé).
- Après la prochaine nuit de crons : vérifier `emptySeries`/`noTarget` et le ratio ready/failed.

---

## Addendum 2026-07-04 — coordination viewer↔jobs prouvée en live + affichage player (PR #107 → #110)

Constaté en production sur « Bagarre » (film 1840392, transcript 1 863 cues) : quatre bugs
distincts, chacun prouvé avec données live avant correction.

### 1. La gate pregen était aveugle en lecture stable (PR #107)
La transcription a ouvert la 2ᵉ connexion provider à 08:11 alors que le visionnage était actif
(watch-history bumpé à 08:13). Les deux signaux de `userHasLiveSession` s'éteignent ~4 min après
le début d'une lecture continue : aucun événement entre `first_frame` et `pause`/`ended`, et les
lignes `cloud_playback_sessions` sont expirées quelques secondes après le démarrage (observé :
36 s – 2 min) alors que le ffmpeg de lecture tourne 1h30. Correctifs :
- **Edge** : `userHasLiveSession` lit aussi `cloud_watch_history.updated_at` — la sauvegarde de
  progression (toutes les 10 s en lecture active) est le heartbeat, zéro écriture ajoutée. Couvre
  du même coup toutes les dimensions cron (même fonction).
- **Gateway** : garde locale `accountSlotBusyLocally` (sessions transcode + rawPumps par proxyKey)
  vérifiée AVANT la gate edge dans la file de jobs et la boucle detect-language — instantanée,
  voit le viewer en pause dont le ffmpeg transcode encore.
- **Gateway** : préemption viewer — un play (transcode ou /raw) tue les extractions de fond du
  même compte (registre `accountExtractions` sur les 3 extracteurs) ; le job repasse `deferred`
  et se re-file. Le viewer ne se bat plus contre un ffmpeg de fond (458 en boucle).

### 2. Le menu re-proposait « Generate » sur un transcript prêt (PR #108)
Au rechargement, l'état IA repartait à `idle` et le cache partagé n'était consulté qu'au clic.
`_ensureAiCacheProbe()` : sonde one-shot par titre (chargement + ouverture menu) — ready → ligne
« show original » + « Translate to » d'emblée ; job en cours → progression honnête + polling.
Règle `_aiUserRequested` : la sonde (ou le job d'un autre user du panel) ne fait que changer le
menu — l'attache du track (partiels inclus) reste réservée aux chemins cliqués.

### 3. hls.js efface les cues des pistes labellisées (PR #109)
`onMediaDetaching` (chaque `recoverMediaError()`, routinier sur les stalls du transcodage
temps réel) vide les cues de toute piste sous-titres AVEC label (`filterSubtitleTracks`), en
laissant `mode='showing'` → menu « actif », écran vide. Correctifs : piste IA sans label ;
`_reattachAiTrackIfActive()` post-recovery ; rebasage `streamStartOffset` des cues film-absolus
(reprises/seek) ; libellés explicites « show original (Français) ».

### 4. …et un 2ᵉ mécanisme hls.js efface TOUTES les pistes (PR #110)
Symptôme résiduel : le sous-titre flashe au clic puis disparaît. `TimelineController._cleanTracks`
(vérifié à l'octet dans le bundle 1.5.7) vide les cues de CHAQUE textTrack — sans filtre de
label — à chaque `MEDIA_ATTACHING`, y compris lors des recoveries INTERNES du error-controller
hls.js (append error non-fatal « MediaSource readyState: ended ») que notre handler ERROR ne voit
jamais (`renderTextTracksNatively:false` ne gate pas `_cleanTracks`). Correctifs :
- Hook `MEDIA_ATTACHED` (post-wipe, toutes origines de recovery) : `_reattachAiTrackIfActive()` +
  `seenCues.clear()` du subtitle-engine (les pistes probe, labellisées, subissent les DEUX wipes ;
  sans purge du dédup, les ticks ne re-ajoutaient jamais les cues effacés).
- `clearExternalSubtitleTracks({keepAiPolling})` : l'attache d'un partiel (qui tourne DANS le tick
  de poll) ne tue plus son propre timer — avant, la livraison progressive s'arrêtait au premier
  lot de cues, plus jamais de partiels ni de transcript final dans la session.

Suivi (non bloquant) : re-attache IA après seek/audio-switch (aujourd'hui la piste est droppée,
`restorePendingSubtitlePreference` n'a pas de source 'ai') ; brancher les pistes probe/native sur
la même règle « viewer gagne » si un futur hls change son filtre.

### 5. Gateway v64 : crash-loop /raw + restauration des sous-titres après bascule de lane (PR #111, #112)
Incident prod (04/07 ~11h UTC, diagnostiqué en direct avec l'owner) : `nodeStream.pipe(res)` du
`/raw` sans handler `'error'` — un reset provider en plein flux ou un abort client (seek engine)
levait une `uncaughtException` qui TUAIT le process (aucun filet global) → 502 Railway edge sans
CORS pour tous les viewers → crash-loop. Fix : erreurs gérées des deux côtés du pipe + filet
`process.on(uncaughtException/unhandledRejection)` (log redacted, on continue) + v64.
Dans la foulée, cause finale des sous-titres qui « disparaissent » : toute bascule de lane
recharge le même `<video>` avec un nouveau src et le NAVIGATEUR désactive alors chaque piste
(mode='disabled', cues=null, élément intact — observé au watcher 11:01:13). Fix player : stash
au reset de loadVideo + self-heal au first-frame (piste régénérée si 'disabled'/vidée ; un
masquage volontaire au clavier — mode 'hidden', cues intacts — n'est jamais écrasé).
