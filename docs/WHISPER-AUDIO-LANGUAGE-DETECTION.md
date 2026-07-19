# Phase 2 — audio-track language detection (self-hosted whisper.cpp)

Last-resort detection of the **real language of an untagged audio track**, for the residual
case Phase 1 + the gateway ffprobe can't resolve: a multi-audio file whose track carries no
language tag and no inferable signal (label/category/region/original_language), so the menu
is stuck on "Audio N".

Invariant (same as Phase 1): **enrich, never override** a provider- or demux-supplied
per-track language. A detected language only ever fills a `null`, and only when confident.

**Fully self-hosted and free** — whisper.cpp runs on the gateway (which already has ffmpeg).
No paid API, no Cloudflare Workers AI, no per-use cost; the audio clip never leaves the
gateway.

## Pipeline (all on the gateway)

```
untagged track ─► ffmpeg: 20s mono 16kHz WAV ─► whisper.cpp --detect-language
               ├─ confidence >= 0.95 ─► detected (never verified)
               └─ otherwise ─► full transcript on the same WAV
                              ─► transcript language detector ─► detected
               ─► persist (cloud_titles.audio_tracks / catalog_file_tracks) ─► next play instant
```

The result is cached, so the extra provider connection (the WAV extraction) happens at most
once per untagged file.

The fast result is a **high-confidence language identification**, not a certification. It may
fill an untagged language as `detected`, but it can never produce `verified`. The strict
multi-window verification path and all of its transcript/word-count checks are unchanged.

### Signed scopes and mode isolation

The Edge signs the requested LID mode in the byte-pipe token. The gateway does not accept a
client query parameter as authority for changing modes:

- no LID scope: legacy full-transcription path;
- `lid-shadow`: run detect-only for timing/agreement telemetry, discard its
  decision, then use the legacy full-transcription result;
- `lid-production-detect-only`: allow detect-only as the primary non-certifying result only
  when its probability is at least `0.95`. The Edge signs this scope only for untagged,
  canonical exact-file rows; tagged corrections and legacy title-only rows keep the full path;
- `lid-benchmark`: isolated, read-only benchmark route; it does not enable a production mode.

A shadow result must never be returned as the production decision, written to
`cloud_titles.audio_tracks`, written to `catalog_file_tracks`, or counted as a successful
catalog detection. Shadow mode therefore leaves catalog data identical to the legacy path.
If detect-only fails, times out, returns no normalized language, or is below the threshold,
the gateway reuses the **already extracted WAV** for full transcription; it does not open a
second provider connection.

The flags are server-side `admin_feature_flags` and are evaluated fail-closed:

- `audio_lid_enabled=true`: common LID kill switch. Set it to `false` to stop new automatic
  detections without deleting already persisted languages;
- `lid_detect_only_shadow_enabled=false`: signed shadow scope, telemetry only;
- `lid_detect_only_production_enabled=false`: signed production scope for the fast primary
  path.

The common kill switch must be enabled in addition to either rollout flag. If shadow and
production are accidentally enabled together, the Edge reports `conflict` and signs neither
scope. The production flag does not weaken strict verification and does not promote a
detect-only result to `verified`.

`--detect-language` alone does not prove that a window contains speech: silence or music can
still produce a language probability. Therefore the production flag stays **off** until the
shadow corpus is large enough and shows an acceptable `shadowNoFullVerdict` rate (or a
speech/VAD selector is added). Shadow is the active calibration step, not an accuracy claim.

## Gateway — `GET /detect-language/<token>?index=N&dur=20` (DONE, deploy on gateway infra)

Same byte-pipe token as `/raw`. Steps, all in-process:
1. `extractAudioWav` — ffmpeg extracts a mono/16 kHz `pcm_s16le` WAV of audio stream `N`.
2. `runWhisperDetect` — `whisper-cli -l auto -nt -otxt` transcribes and auto-detects the
   language; we capture both the transcript and whisper's own LID line (`auto-detected
   language: xx (p = …)`).
3. `detectLanguageFromText` — a zero-dependency detector over the transcript: non-Latin scripts
   by Unicode range (incl. **Persian/Kurdish/Urdu vs Arabic** by the letters Arabic lacks, and
   **Ukrainian/Serbian vs Russian** by distinctive Cyrillic) and Latin scripts by stop-word
   frequency. Validated 10/10 on sample transcripts (ar/fa/ru/ja/fr/en/es/it/pt/de).

The legacy/full path returns
`{ language, candidate, confidence, whisperLang, wordCount, sample }`. `language` is the
transcript detector's result when confident (it disambiguates script families better), else
whisper.cpp's own LID. The detect-only primary path reports its method/evidence explicitly,
keeps `verified=false`, and does not invent transcript words (`wordCount=0`). Returns 503 if
whisper isn't configured and no fallback can run.

### Dockerfile / runtime

A multi-stage build compiles a **static** `whisper-cli` (`-DBUILD_SHARED_LIBS=OFF`) and bundles
the model (`small` in the current image; `ARG WHISPER_MODEL=small`, e.g. `tiny` for a smaller
image). Runtime needs `ffmpeg` + `libgomp1`. Env:
- `WHISPER_BIN` (default `/usr/local/bin/whisper-cli`), `WHISPER_MODEL`
  (default `/opt/whisper/ggml-model.bin`) — **unset either to disable** `/detect-language`.
- `WHISPER_THREADS` (4), `WHISPER_TIMEOUT_MS` (60000).

`GET /health` reports `languageDetect: true|false`.

## Edge trigger — `norva-playback` (DONE, flag-gated)

After the **first** probe of a file, if untagged audio tracks remain it runs
`detectUntaggedAudioLanguages` in the **background** (`EdgeRuntime.waitUntil`, never blocks the
response): for each untagged track (cap 2 per resumable pass) it calls the gateway
`/detect-language` (one call — the gateway does extraction + whisper + detection), fills the
`null` lang, and re-persists to `cloud_titles.audio_tracks` + `audio_languages` and
`catalog_file_tracks`. A detect-only result is deliberately not merged into the irreversible
title-wide language union during the canary; historical transcript results keep that existing
merge. Work is cached and resumable per track.

Gated by `NORVA_WHISPER_DETECT` (runtime config / env). **Off by default** → no behaviour change.

**Single-slot caveat:** the WAV extraction is a second provider connection, so on a single-slot
source (e.g. `super8k.top`) it can lose to the live `/raw` stream (458) and yield nothing that
play. Use the **offline backfill** below instead on single-slot accounts.

## Offline backfill — `POST /audio-backfill` `{ "mode": "whisper" }` (DONE, single-slot-safe)

The single-slot-friendly path: run it **when nothing is streaming** (manually or via cron), so
the WAV extraction never contends with a live stream. It walks titles whose `audio_tracks` still
have untagged entries (lang null), resolves each title's provider URL, and runs the gateway
`/detect-language` per untagged track (reusing the same detect+persist logic). Service-gated by
the `NORVA_BACKFILL_TOKEN` bearer, like the other backfill modes.

```bash
curl -X POST "$EDGE/norva-playback/audio-backfill" \
  -H "Authorization: Bearer $NORVA_BACKFILL_TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"whisper","userId":"<uuid>","type":"movie","limit":100,"concurrency":1}'
# → { mode, processed, candidates, detected, lastId, hasMore }. Page with afterId=lastId while hasMore.
```

`concurrency` defaults to **1** (serialized — safe for single-slot; each detection is one
provider connection); raise it (max 4) only on multi-connection providers. Resumable by `afterId`
cursor. Does NOT require `NORVA_WHISPER_DETECT` (that flag only gates the inline trigger); it does
require the gateway with whisper deployed.

## Enabling and staged rollout

1. Deploy the gateway (`services/media-gateway`) — the new Dockerfile builds whisper.cpp + the
   model and exposes `/detect-language`. Confirm `GET /health` → `languageDetect: true`.
2. Apply the feature-flag migration. Verify `audio_lid_enabled=true` and both detect-only flags
   still `false`; this is the legacy baseline.
3. Deploy `norva-playback` — ships both the inline trigger and the `whisper` backfill mode.
   Migration-first keeps per-track detection provenance available from the first Edge request.
4. Enable `lid_detect_only_shadow_enabled` only. Compare real catalog samples, agreement,
   fallbacks, errors and latency. Shadow must produce no fast-path catalog writes.
5. Keep `lid_detect_only_production_enabled=false` until the Norva corpus is large enough and
   reviewed (including `shadowNoFullVerdict`), or a calibrated speech/VAD selector is present.
   Only then disable shadow and enable production for a bounded canary. A detect-only result
   is accepted only at probability `>= 0.95`; every other outcome falls back to the full
   transcript using the same WAV.
6. Compare catalog counts and sampled languages against the pre-canary baseline before
   expanding the run.
7. Then either:
   - **Offline backfill (recommended for single-slot):** `POST /audio-backfill {"mode":"whisper",…}`
     when nothing is streaming. It ignores `NORVA_WHISPER_DETECT`, but still obeys the common
     `audio_lid_enabled` kill switch and selected detect-only rollout mode.
   - **Inline self-heal:** set `NORVA_WHISPER_DETECT=true` and it detects automatically on first
     play (best on multi-connection providers).

### Rollback

Rollback does not require a deploy:

1. Set `lid_detect_only_production_enabled=false` to return immediately to full transcription.
2. Keep `lid_detect_only_shadow_enabled=false` unless collecting bounded read-only telemetry.
3. For an incident affecting either path, set `audio_lid_enabled=false`; this stops new LID
   work while preserving existing catalog data.
4. Confirm that no new fast attempts or LID writes appear, investigate, then re-enable
   `audio_lid_enabled` first with both detect-only flags still off.

Never enable shadow and production simultaneously during a rollout. Never bypass provider
leases or active-playback guards to increase throughput.

### Where does `NORVA_WHISPER_DETECT` go?

It's read in `getRuntimeConfig`, from **either** source (env wins):
- **Edge env / secret** — `supabase secrets set NORVA_WHISPER_DETECT=true` (or the Dashboard →
  Edge Functions → Secrets). Applies after the next deploy.
- **DB runtime config** — a row in `cloud_runtime_config`:
  `insert into cloud_runtime_config (key, value) values ('NORVA_WHISPER_DETECT','true')
   on conflict (key) do update set value = excluded.value;` (picked up within ~30 s — the config
  cache TTL — no redeploy needed). Only affects the **inline** trigger; the backfill ignores it.

No relay or Workers AI changes are needed (the earlier Workers AI approach was dropped in favour
of self-hosted whisper.cpp).
