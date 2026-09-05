# Selection: scoped direct HLS tests

The server manifest `supabase/functions/_shared/selection-live-direct-canaries.mjs` contains seven public HLS candidates restricted to one authorized test-account hash. They are eligible for browser trials only on that account. They have not yet passed individual Norva web playback and are not approved for other users. The two existing curated Xumo channels retain their current delivery policy.

The purpose of these entries is to test the actual browser path for one public HLS stream on one authorized test account. It is not an approval to publish that stream to other users and is independent of the general TV publication evidence manifest.

Each entry contains exactly these string fields:

| Field | Exact pin |
| --- | --- |
| `feedId` | Imported `metadata.discoveryFeed` |
| `discoverySource` | Imported HTTPS `metadata.discoverySource` |
| `tvgId` | Imported `metadata.tvgId` |
| `externalId` | `norva-discovery:live:` plus SHA-256 of `live:` + canonical complete URL |
| `targetUrlSha256` | SHA-256 of `new URL(targetUrl).href`, including every query parameter in its original order |
| `origin` | Exact HTTPS origin, without a trailing slash |
| `pathname` | Exact pathname ending in `.m3u8` |
| `ownerUserIdSha256` | SHA-256 of the authenticated server user's exact ID; not an email or a client hint |

The resolver requires the deterministic Selection source ID for that authenticated owner, a visible owned live row with `sourceType: m3u` and `container: m3u8`, and identical canonical target URL in the owned playback hint and metadata media key. Credentials and fragments are refused. Changing the URL, including its query, invalidates both URL and media identity pins. Another account remains ineligible even if its own Selection source contains the exact same media row.

The manifest accepts at most sixteen entries. Ambiguous duplicate owner/item coordinates and malformed entries do not grant a direct lane. The module snapshots validated entries at initialization; the exported factory is used by server wiring and offline tests, never by request data. No raw account ID, media URL query or credential belongs in this manifest.

The existing routing conditions still apply: cloud web/mobile-web/PWA, automatic gateway selection, and the loaded client's `publicHlsDirectSessionGuard` capability. Native clients, explicit transport choices, forced conversions and relay requirements retain their existing route. New canaries also refuse explicit audio/video/subtitle stream or track indexes (camel/snake aliases, zero included) and explicit quality/resolution/rendition choices in the request, either hint alias, the resolved hint or the owned row. Negative-one, null, empty and Auto values remain automatic. This additional guard uses a private WeakSet and does not change the two existing Xumo lanes. Only a descriptor created inside the resolver's WeakSet can select the direct branch. Existing authentication, ownership, entitlement, capacity, generation and cloud session lifecycle remain in the unchanged Edge caller; the existing client heartbeat enforces expiration/revocation.

Provider admission scopes retain the `user-source:<authenticated user>:<owned source>` prefix. Xumo retains its existing shared `public-feed:xumo-curated` suffix. Each new canary receives a server-computed `public-media:<SHA-256 of live:canonical URL>` suffix. Replays of one channel retain their takeover boundary; a different channel in the same aggregate feed cannot share that channel's failure circuit. Client hints never supply a scope suffix.

Activation requires the scoped Edge release including the reviewed manifest dependency. The seven candidates are France 24 French, DW Español, Trace Caribbean, México Travel TV, Persiana Docs, WildEarth and The Film Detective. Upstream A/V and sampled CORS observations informed this shortlist; they are not a claim of completed Norva browser playback. Removing an entry on a subsequent runtime reload closes new canary admissions; it is not an immediate revocation of an already-playing session. No reader, gateway, catalogue, public credits or publication approval is changed by this preparation.
