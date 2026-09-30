# Public ingress for native Live raw recovery

## Observed failure

The physical TF1 attempt around 18:40 UTC reached the new relay preparation
path, but Android reported `UnknownHostException` on both relay replacements.
No first-frame event was recorded. The Gateway observer recorded no raw pump
and no FFmpeg process; this was not a provider stream or decoder failure.

`createBytePipeAccess` returned the internal Docker route. Configuration review
confirmed that the public main ingress and the public pilot prefix were already
available in the existing public-base settings, but unused by this generic raw
client path. The public reverse proxy also rejected `/raw/*` before the Gateway.

## Correction

- Only the raw client response opts into public delivery; worker calls retain
  private routing by default.
- Public delivery uses the selected route's existing public base, preserving the
  pilot prefix. Missing or malformed public configuration fails closed.
- The signed capability, owner, exact target, expiration, preparation generation,
  coordinator and cancellation fences are unchanged.
- Health adds `publicRawPlaybackProtocol: 1` so the deployed worker can be checked.

The proxy must separately expose only the authenticated-capability `/raw/*`
GET/HEAD/OPTIONS path for main and pilot. Administrative endpoints and
`/raw-pumps` must remain private. This patch alone does not change the proxy.

## Verification

Tests execute the actual TypeScript capability and URL builders with real HMAC,
cover main/pilot, legacy/prepared, retained pilot prefix, invalid public base,
unchanged internal worker URLs and refusal of a mismatched preparation route.
The actual native raw branch verifies its explicit public-delivery selection.

Physical playback and cancellation must be replayed after both Edge and reverse
proxy deployment. No new provider request was made for this diagnosis or test.
