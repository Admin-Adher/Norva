# Provider route owner canary, Gateway v168

The adaptive provider route policy is still observational by default. This change prepares a narrow live canary without changing any account's route at deployment time.

To exercise a shadow recommendation, an operator must set both `PROVIDER_ADAPTIVE_ROUTE_CANARY_APPLY_SHADOW=true` and `PROVIDER_ADAPTIVE_ROUTE_CANARY_OWNER_KEYS` to one to eight comma-separated lowercase SHA-256 owner keys. Empty, malformed or oversized lists fail closed. No owner key is exposed in the public Gateway status.

The canary decision is attached to the authorised owner's individual HLS, native MP4 or raw playback request. It is never placed in the provider-wide applied route map, so another Norva owner sharing the same provider account affinity keeps its existing deterministic route. An explicit service-side provider slot override takes priority. For direct HLS input, FFmpeg receives the HTTP proxy slot paired with the selected session route; loopback-only inputs still bypass provider proxies.

The activation remains pending. Before enabling it, record a baseline for the owner's playback start time, upstream status, selected slot/transport and provider 458 rate; replay one owned source with actual picture and resume; then verify an unlisted owner on the same provider affinity keeps the original route. Clear both environment variables to roll back. Do not present this as global route selection until the canary and wider rollout succeed.

Local focused verification: 75 route-related tests (74 passed, one skipped) and 253 Gateway/version-adjacent tests (251 passed, two skipped). No canary environment variable was set in production during this change.
