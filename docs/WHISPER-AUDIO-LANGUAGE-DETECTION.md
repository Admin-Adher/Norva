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

## Step 3 — trigger + persist (TO DECIDE)

Two ways to wire the trigger; pick per the trade-off:

- **Inline self-heal (flag-gated), during playback.** After the engine-path probe, if untagged
  tracks remain, run detection in the background (`EdgeRuntime.waitUntil`) and persist for next
  play. Automatic, but it's a second provider connection during streaming (single-slot 458
  risk) and bills Workers AI per untagged play until cached. Ship behind an off-by-default
  config flag.
- **Offline backfill (service-gated), out of band.** Extend `runAudioBackfill` with a Whisper
  mode that walks titles with untagged `audio_tracks` and detects them when nothing is playing.
  No playback-time slot contention, controlled cost, but runs on demand/cron rather than
  automatically.

Both persist identically (`cloud_titles.audio_tracks` + `audio_languages`, mirrored to
`catalog_file_tracks`), so the player and grid get the language with zero further work.

## Deployment notes

- Relay (Step 1) deploys via CI on push to `main` — **requires Workers AI enabled on the
  Cloudflare account** (the `ai` binding). The relay carries playback, so deploy it
  deliberately after confirming the account is set up.
- Gateway (Step 2) has no CI workflow — deploy on the gateway infra (`services/media-gateway`).
- Step 3 lands in `norva-playback` (edge) and/or the backfill once the trigger strategy is
  chosen.
