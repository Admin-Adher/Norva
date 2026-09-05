# Public live playback capacity

This is a routing optimization, not a certification of 1,000 simultaneous viewers.

## Why the route matters

An audit on 2026-09-05 found a 1 Gbit/s negotiated interface on the media host.
The gateway has 6 CPU, 10 GiB RAM, a 512-task limit and four video encoders.
Tasks include threads; these limits cannot be interpreted as a viewer count.
The actual Node process already has a 524,288 file-descriptor limit.

At 4 Mbit/s each, 1,000 viewers require 4 Gbit/s of video egress, or 1.8 TB per
hour before protocol overhead. Even sharing one FFmpeg producer per channel
does not remove the per-viewer egress if this host serves every segment.

For a verified public HLS stream, the browser can retrieve the media from the
publisher's CDN. Norva still performs source ownership, catalogue generation,
device, entitlement and playback-session admission. The media bypasses both
the gateway and the Norva relay. No new video hosting service is needed for
this route. Each viewer obtains its own upstream manifest; advertising and
regional parameters are preserved.

## Initial scope

Only the managed Norva Selection `xumo-curated` feed and these two exact media
identities are eligible:

| Channel | Publisher channel ID |
| --- | --- |
| MovieSphere by Lionsgate | 99951251 |
| DOCUMENTARY+ | 99991638 |

The initial HTTP verification checked the master manifests, all declared
rendition codecs, one rendition and a video fragment per channel, plus the
external DOCUMENTARY+ subtitle playlist and WebVTT fragment. Both masters
declared five H.264/AAC-LC variants. CORS covered the sampled resources from
the `https://norva.tv` origin. This sample is not a promise that future media,
advertising insertions or every viewer country will behave identically.

Eligibility must come from server-owned catalogue identity and the reviewed
publisher target. Client hints cannot authorize a new public source. Private
M3U/Xtream sources and explicit conversion requests retain their existing
route. Old clients without the session guard retain their existing route too.

The public URL itself is not a Norva access credential. Norva controls access
to its app and stops the managed player when its session is rejected; it cannot
revoke a publisher's publicly accessible URL. No Norva token or cookie is added
to publisher requests.

## Evidence required for rollout

- Unit and contract tests: trusted media identity, private and forged-source
  rejection, explicit-mode preservation, client capability negotiation, stale
  heartbeat responses, expiry, teardown and bounded network failures.
- Browser: actual moving video for each channel; publisher media requests;
  no gateway session created for the optimized play; functioning channel switch
  and session release. Test authenticated Norva playback, not only HTTP 200.
- Runtime: preserve unrelated deployed functions, bundle the affected Edge
  entry points, verify both replicas and record their hashes and rollback path.

## Capacity acceptance still required

1. Define the expected mix of direct public TV, relayed TV, gateway TV and VOD.
   Track these lanes separately: a successful direct play says nothing about
   the capacity for a thousand independent video encodes.
2. Exercise controlled media and test accounts in steps of 100, 250, 500 and
   1,000 viewers. Do not load-test third-party public providers at that scale.
3. At each step measure session-start latency, playback failures, playback
   continuity, heartbeat latency/error rate, DB pool/waits, API CPU/RAM and NIC
   throughput. Include a start burst, session replacements and departures.
4. Hold the target plateau long enough to cover session renewal and normal
   catalogue traffic. Define numerical acceptance thresholds before running.
5. Verify publisher availability and permitted throughput separately. A public
   playlist is not an upstream service-level or concurrency guarantee.

For the direct route, video does not consume Norva media-host bandwidth or an
FFmpeg process. The remaining scaling work is the API/session control plane,
catalogue access, and any viewers using other routes. The existing private R2
cache was not configured as a general consumer route during this audit and
must not be counted as current offload capacity.
