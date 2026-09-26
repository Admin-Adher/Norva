# Playback preparation cancelled from the web player

## Reproduction in production before the fix

On 26 September 2026 at 01:17:55 UTC, resume of Men of War was opened from
Continue Watching on the authorized internal account. Back was pressed while
the player still displayed preparation. The catalogue returned immediately.
The Edge nevertheless completed preparation in 15,409 ms (13,967 ms Gateway).
The database session stayed pending and the secondary Gateway retained one
active session. The exact QA session was subsequently expired through its
owner-authenticated API (HTTP 200).

The browser's fetch cancellation did not propagate through the reverse proxy.
Aborting the response discarded the server-generated session ID, preventing
the existing late-result cleanup from running.

## Change

The playback creation request retains its response when a player attempt is
cancelled. A cancelled attempt closes only the returned session, with the
original user/device authority, before rejecting with AbortError. Back still
invalidates the attempt and navigates immediately. Requests cancelled before
creation make no POST. A receipt rejected for an older catalogue visibility
epoch is also cleaned up without exposing the stale playback result.

This fixes in-app navigation during preparation. It does not promise immediate
cancellation when the entire browser process is terminated; server expiry is
still needed for lost clients. It does not measure Android startup improvements.

## Verification

31 focused tests passed: cancellation receipt, Watch attempt invalidation,
stale result cleanup and provider-session handoff. Production replay pending
deployment of this change.
