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
