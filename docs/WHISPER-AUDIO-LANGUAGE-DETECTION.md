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
untagged track ─► ffmpeg: 20s mono 16kHz WAV  ─► whisper.cpp (auto language id + transcript)
               ─► transcript language detector  ─► language
               ─► persist (cloud_titles.audio_tracks / catalog_file_tracks) ─► next play instant
```

The result is cached, so the extra provider connection (the WAV extraction) happens at most
once per untagged file.

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

Returns `{ language, candidate, confidence, whisperLang, wordCount, sample }`. `language` is the
transcript detector's result when confident (it disambiguates script families better), else
whisper.cpp's own LID. Returns 503 if whisper isn't configured.

### Dockerfile / runtime

A multi-stage build compiles a **static** `whisper-cli` (`-DBUILD_SHARED_LIBS=OFF`) and bundles
the model (`ggml-base.bin` by default; `ARG WHISPER_MODEL=base`, e.g. `tiny` for a smaller
image). Runtime needs `ffmpeg` + `libgomp1`. Env:
- `WHISPER_BIN` (default `/usr/local/bin/whisper-cli`), `WHISPER_MODEL`
  (default `/opt/whisper/ggml-model.bin`) — **unset either to disable** `/detect-language`.
- `WHISPER_THREADS` (4), `WHISPER_TIMEOUT_MS` (60000).

`GET /health` reports `languageDetect: true|false`.

## Edge trigger — `norva-playback` (DONE, flag-gated)

After the **first** probe of a file, if untagged audio tracks remain it runs
`detectUntaggedAudioLanguages` in the **background** (`EdgeRuntime.waitUntil`, never blocks the
response): for each untagged track (cap 5) it calls the gateway `/detect-language` (one call —
the gateway does extraction + whisper + detection), fills the `null` lang, and re-persists to
`cloud_titles.audio_tracks` + `audio_languages`, mirrored to `merge_catalog_title_audio` and
`catalog_file_tracks`. Runs once per file (the probe runs once, then the map is cached).

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

## Enabling

1. Deploy the gateway (`services/media-gateway`) — the new Dockerfile builds whisper.cpp + the
   model and exposes `/detect-language`. Confirm `GET /health` → `languageDetect: true`.
2. Deploy `norva-playback` (push to `main`) — ships both the inline trigger and the `whisper`
   backfill mode.
3. Then either:
   - **Offline backfill (recommended for single-slot):** `POST /audio-backfill {"mode":"whisper",…}`
     when nothing is streaming. No flag needed.
   - **Inline self-heal:** set `NORVA_WHISPER_DETECT=true` and it detects automatically on first
     play (best on multi-connection providers).

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
