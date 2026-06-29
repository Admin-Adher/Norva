# Engine in-band text subtitles

Fixes: on the byte-pipe engine path, selecting a **text** subtitle showed nothing on a
single-slot provider (e.g. `super8k.top`). The gateway extraction (`/subtitle?index=`)
runs `ffmpeg -i <provider URL>` — a **second** provider connection — while the engine is
already streaming via `/raw`. The single connection slot is taken, so the extraction
gets HTTP 458, returns no cues, and the failure is silent (`fetchSubtitleCues` only warns
and stops after 3 tries). Audio-language metadata lives in the header (the in-band header
probe recovers it), but subtitle **cue text** is spread across the whole file, so the
header trick can't supply it.

## How it works

The engine already demuxes every packet to remux video+audio; it simply dropped subtitle
packets. Now, when enabled, it collects **text** subtitle packets (the payload *is* text —
no decoder, no extra connection) and exposes them as cues:

- `NorvaEngine.hasInbandSubtitles()` — true if the file has a text subtitle stream
  (subrip/srt, ass/ssa, mov_text, webvtt). Image subs (PGS/DVD/DVB) are excluded — they
  need OCR (Phase 4).
- `NorvaEngine.enableSubtitleCapture()` — start collecting (called at playback start so
  there's no coverage gap; the demuxer runs ahead of the playhead).
- `NorvaEngine.getSubtitleCues(streamIndex)` — cues in **player-local** seconds (already
  rebased to `currentTime`), ready for `TextTrack.addCue()`.

Packet → text per codec: `mov_text` strips the 2-byte length prefix; `ass`/`ssa` take the
Text field after the 8th comma and strip `{\…}` override tags; everything else is decoded
UTF-8. Cue buffers are cleared on seek (a seek re-bases the timeline), and the client keeps
the cues it already added.

Client (`WatchPage`): when the flag is on and the engine reports in-band subtitles, the
selected text track is fed from `getSubtitleCues()` on a 1 s poll instead of the gateway
extraction — **zero provider connection**, so it works on single-slot sources.

## Flag / rollout (ships dark)

Gated by `localStorage.norvaInbandSubs`. Default **off** → behaviour is identical to today
(gateway extraction). To test:

```js
localStorage.setItem('norvaInbandSubs', '1');  // then reload and play an engine-path title
```

Verify on the VP-class title (e.g. *The Secret Life of Pets* on `super8k.top`): select a
text subtitle → cues should appear with no provider hit. With the flag off you get the old
(broken-on-single-slot) gateway path.

Once validated in production, flip the default on in `_inbandSubsEnabled()` (or wire it to a
real setting). Image subtitles still won't render here — that's the Phase 4 OCR scope.

Engine and client changes are client-side assets (deploy via the Cloudflare web deploy).
The flag-off path adds no work to the engine's `_pump` hot loop.
