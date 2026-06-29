# Phase 2 — audio-track language detection (Whisper)

Last-resort detection of the **real language of an untagged audio track**, for the residual
case Phase 1 + the gateway ffprobe can't resolve: a multi-audio file whose track carries no
language tag and no inferable signal (label/category/region/original_language), so the menu
is stuck on "Audio N".

Invariant (same as Phase 1): **enrich, never override** a provider- or demux-supplied
per-track language. A detected language only ever fills a `null`, and only when confident.

## Pipeline

```
untagged track  ─►  gateway /audio-sample (ffmpeg: 20s mono 16kHz WAV)
                ─►  relay /detect-language (Workers AI Whisper → transcript → language)
                ─►  persist to cloud_titles.audio_tracks / catalog_file_tracks  ─►  next play instant
```

Whisper can't run in the relay Worker without audio, and the relay can't decode media, so the
gateway (ffmpeg) makes the clip and the relay (Workers AI) does the speech model — each does
what it can. The result is cached, so the extra provider connection happens at most once per
untagged file.

## Step 1 — relay `/detect-language/<token>` (DONE, CI-deployable)

`POST` the WAV bytes; the relay runs `@cf/openai/whisper` (transcribes in the **source**
language — the model has no language field, so we detect the transcript's language) and returns
`{ language, candidate, confidence, confident, wordCount, sample }`. `language` is non-null only
when `confident`.

Detector (`detectLanguageFromText`, zero dependencies → no CI bundle risk, validated 10/10):
- non-Latin scripts by Unicode range, incl. **Persian/Kurdish/Urdu vs Arabic** (letters Arabic
  lacks) and **Ukrainian/Serbian vs Russian** (distinctive Cyrillic);
- Latin scripts by stop-word frequency (en/fr/es/it/pt/de/nl/tr/ro/pl/sv);
- conservative `confident` so we never enrich on a weak guess.

Adds the Workers AI binding to `wrangler.jsonc`. **Cost:** `@cf/openai/whisper` is
$0.00045/audio-min; Workers Free includes 10,000 Neurons/day. A 20s clip is a fraction of a
minute, so light use stays within free limits.

## Step 2 — gateway `/audio-sample/<token>?index=N&dur=20` (DONE, deploy on gateway infra)

ffmpeg extracts a mono/16 kHz `pcm_s16le` WAV of audio stream `N` and returns `audio/wav`.
Mirrors the proven `/subtitle` extraction. Same byte-pipe token as `/raw`.

## Step 3 — inline self-heal trigger (DONE, flag-gated)

In `norva-playback` (engine path), right after the **first** probe of a file, if untagged audio
tracks remain it runs `detectUntaggedAudioLanguages` in the **background**
(`EdgeRuntime.waitUntil`) — never blocking the response — and re-persists the enriched map to
`cloud_titles.audio_tracks` + `audio_languages`, mirrored to `catalog_file_tracks` and
`merge_catalog_title_audio`. Runs once per file (the probe runs once, then the map is cached),
best-effort, capped at 5 untagged tracks.

Gated by `NORVA_WHISPER_DETECT` (runtime config / env). **Off by default** → no behaviour
change and no Workers AI cost until enabled.

**Single-slot caveat:** the per-track WAV extraction is a second provider connection, so on a
single-slot source (e.g. `super8k.top`) it can lose to the live `/raw` stream (458) and silently
yield nothing that play (it retries on the next first-probe of an untagged file). The
single-slot-friendly alternative is an **offline backfill** (extend `runAudioBackfill` with a
Whisper mode that detects untagged tracks when nothing is streaming) — not yet built; add it if
the inline path proves too contended on single-slot accounts.

## Enabling

1. Confirm Workers AI is enabled on the Cloudflare account, then deploy the relay (push to
   `main`) so `/detect-language` + the `ai` binding go live.
2. Deploy the gateway (`services/media-gateway`) so `/audio-sample` is available.
3. Set `NORVA_WHISPER_DETECT=true` (runtime config row or edge env) and deploy `norva-playback`.
4. Play a multi-audio title with an untagged track; after the first play the languages persist,
   so the next play (and the grid badge) show them with no probe.

## Deployment notes

- Relay (Step 1) deploys via CI on push to `main` — **requires Workers AI enabled on the
  Cloudflare account** (the `ai` binding). The relay carries playback, so deploy it
  deliberately after confirming the account is set up.
- Gateway (Step 2) has no CI workflow — deploy on the gateway infra (`services/media-gateway`).
- Step 3 lands in `norva-playback` (edge) and/or the backfill once the trigger strategy is
  chosen.
