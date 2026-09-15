# Scoped native VOD transport

The September 15 KING365 diagnostic found two different failures: Cloudflare
Relay returned 403 for a current MP4, while Gateway Undici's HTTP CONNECT also
returned 403. The same owned file and proxy slot returned the exact requested
206 bytes with `proxyTunnel: false`. HTTPS still requires CONNECT/TLS.

This is an opt-in deployment, not a change to the default provider pool:

- Gateway `PROVIDER_HTTP_FORWARD_ACCOUNT_HASHES`: comma-separated SHA-256
  hashes of canonical `providerAccountAffinityKey` values. Compute on the
  production host; never put provider credentials in a release artifact.
- Edge `NORVA_NATIVE_MP4_GATEWAY_SOURCE_IDS`: comma-separated owned source UUIDs.
  The server resolves the source and actual container before applying the rule.

Only HTTP `.mp4`/`.ts` files of selected Gateway accounts use forward HTTP, on
the account's existing slot. MKV, live, metadata, HTTPS and other accounts retain
their routes. The scoped files do not train the legacy CONNECT/SOCKS learner.
For selected sources, browser movie MP4 goes through the existing signed Gateway
HLS session, with normal entitlement, coordinator, expiry and single-account
guards. Compatible H.264 is copied/remuxed rather than re-encoded. Direct/native
clients, explicit conversion and browser-engine requests keep their lanes.

The public ingress deliberately publishes only GET/HEAD/OPTIONS /sessions/*.
Do not expose /raw, administrative endpoints or an internal Docker hostname to
make native byte-pipe playback work. An intermediate native-raw rollout was
rejected during browser verification (internal DNS, then the public 404 gate);
the final policy uses the already-authorized HLS surface without any Caddy change.
Remove the obsolete NORVA_NATIVE_MP4_GATEWAY_PUBLIC_URL if that intermediate
release was staged; it is not used by the final implementation.

Deploy both halves together after a fresh idle gate. Preserve live runtime files
outside the four-file overlay, all proxy credentials/slots, models and cron
states. Retain the original containers and configuration for rollback. Do not
start a provider resync, remove catalogue entries, or rewrite language metadata
as part of this transport rollout.

Verification requires several distinct files per format, one provider connection
at a time, with startup and 120-second browser continuity measurements. A bounded
206 probe is transport evidence only, not proof of two-minute playback. Recheck
one working MKV and unrelated native MP4 as regression samples. Disable both
allowlists or restore the retained containers if rollback is needed.
