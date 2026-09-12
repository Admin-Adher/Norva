# VOD loading presentation

The web Watch player covers its video with the supplied Norva alien while it prepares playback. The video stays attached and rendered underneath; `markPlaybackUsable()` and the existing first-frame observer own the reveal. There is no minimum animation duration and artwork is never awaited by playback.

| Before | After | Why |
| --- | --- | --- |
| Spinner inside auto-hiding transport controls | Opaque, independent loading cover | Controls cannot disappear together with loading feedback or receive accidental input. |
| Playback shortcuts available during preparation | Transport UI inert and shortcuts ignored; canonical Back retained | Preparation remains uninterrupted without trapping the viewer. |
| No branded loading fallback | Alien animation, static poster for reduced motion/data saving, text if artwork fails | Accessibility and recovery do not depend on animation decoding. |
| Generic “Preparing…” label | “Preparing your video” plus automatic-playback explanation | Viewers know what is being prepared and that no further action is needed. |

The preparation heading and help text have dedicated keys in all ten web locales. Both belong to one polite, atomic status region. Offline feedback replaces both lines with connection guidance; it does not promise immediate playback. Copy adds no timer, progress estimate or playback dependency. The supporting line wraps within 38 characters of typographic width rather than being truncated.

## Artwork provenance and budget

- User-supplied `Norva-Alien-60fps.zip`, `webp/256/norva-loading.webp` and `posters/loading.png`; no other animations from the pack are shipped.
- Delivery: animated WebP, 192 × 192, 216 frames, 3,600 ms, alternating 16/17 ms timestamps, infinite loop. Static WebP: 256 × 256.
- The 60 fps timestamps are retained, not a guarantee that every device renders 60 fps. Artwork downloads are low priority and start only during preparation. Animation sources and listeners are removed when hidden or stopped.
- Animated budget: 1 MiB; poster budget: 25 KiB. Supplied animation: 2,614,272 bytes; optimized animation: 999,756 bytes; poster: 10,408 bytes.
- Optimized from the supplied WebP with Pillow 12.3.0: RGBA, Lanczos resize to 192 × 192, original durations/loop, WebP quality 70, alpha quality 65, method 4, minimize size. Poster: Lanczos 256 × 256, WebP quality 85, method 6.

## State ownership

Loading hides only transport UI/accessibility nodes; CSS never sets the video to `display:none`. Back/Escape, terminal errors and the explicit Play action after autoplay rejection remain available. A route exit cancels artwork; internal session handoff retains the cover. Late `waiting` events cannot restart it off-route. Existing source/session, buffer and first-frame policies are unchanged.

`tests/watch-loading-presentation.test.js` covers masking/focus restoration, transport input, cancellation cleanup, first-frame reveal, asset errors, offline status, reduced motion, data saving, hidden tabs and the WebP frame/duration/size contract. Existing first-frame, startup-buffer and lifecycle tests remain release gates.

The Android/TV native `PlayerActivity` is not changed by this web-only feature.
