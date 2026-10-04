# Featured MULTI-SUB playback stutter

4 October 2026, observations through 14:02 UTC. Controlled owner, ordinary browser playback paths. This is a targeted investigation, not a certification of the whole catalogue.

## Reproduced scope

- Bolt from the Blue [MULTI-SUB]: first browser frame in 3.790 seconds; source-input H.264 reference errors, AAC decoding errors and timestamp irregularities. A subsequent resume took 16.679 seconds and later failed. The exact cause of the resume termination remains unclosed.
- Lost on a Mountain in Maine [MULTI-SUB]: user independently reported the same symptom. The active Gateway had buffered media ahead, an uninterrupted bounded input stream and no background Whisper process; no server saturation was observed. Input logs contained repeated Matroska EBML, H.264 reference and AAC errors.
- The initial conclusion must not be restricted to one film. Nor must an error in one received source be presented as proof that all other VODs or all Norva routes are healthy.

## Comparison before conversion

Two short, bounded original-byte samples were obtained through authenticated native recovery sessions, sequentially, with the normal account ownership and playback coordination. Sessions were expired after reading. No parallel provider read or limit override was introduced. These bytes bypass HLS conversion, but still pass through Norva's native transport and pinned provider route; they are not a direct independent download from the provider's storage.

An offline, networkless FFmpeg software decode reproduced corruption:

| Exact version | Sample | Decode observation |
| --- | ---: | --- |
| Bolt [MULTI-SUB] | 16 MiB | 3 corrupt decoded frames and 7 invalid-audio errors in a 40-second test |
| Lost [MULTI-SUB] | 8 MiB | Invalid EBML at byte 1,058,196 and a corrupt decoded frame in an 18-second test |

Lost's invalid EBML byte position matches the live HLS input error exactly. This establishes that the corrupted bytes already reach the input before HLS encoding and browser rendering. It does not by itself prove which upstream storage or transport component originally introduced them. Exit code zero alone is not evidence of clean decoding: FFmpeg concealed errors.

The safe receipt contains sample hashes and aggregate observations. Both media samples and the temporary diagnostic authentication file were deleted after comparison. All earlier short-lived speech diagnostic WAV files were also confirmed expired and removed. No media URLs, credentials, transcripts or account identifiers are included in this report.

## Same-provider control

The separate **EN| Lost on a Mountain in Maine** MKV version was opened from Movies search and its Versions selector in the real application. It used the same secondary Gateway, HTTP provider slot 1 and VAAPI decode/encode path.

- Gateway ready in 2.238 seconds (not browser time to first frame).
- Distinct file size: 1,119,477,021 bytes, versus 1,941,640,457 for MULTI-SUB.
- At the 14:02 observation, input had run for 190.6 seconds with no range reopen. The scoped log window had zero EBML, invalid-audio, missing-reference or corrupt-frame diagnostics.
- The user explicitly confirmed: **"Cette copie est fluide"**.

This is a working alternative for this film. It is not a repair of the damaged MULTI-SUB version or proof of complete-file playback. Browser frame-drop counters were not available through the inspection surface; none are claimed.

## Remaining work

The current VOD player intentionally does not silently switch between copies that may have different dubbing or subtitles. Inspection of that existing policy does not constitute deployment of automatic source-quality selection. No production playback setting, codec threshold, health flag, catalogue ordering or source file was changed during this comparison.

The multi-file corruption and Bolt resume failure remain open. Any future mitigation must preserve the user's version/language choice and provider mono-connection. The active clean comparison copy was left playing for the user; strict language jobs correctly defer while playback owns the provider account.
