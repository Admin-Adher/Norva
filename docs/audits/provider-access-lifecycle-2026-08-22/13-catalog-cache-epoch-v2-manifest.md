# Catalog cache epoch v2 — rollout manifest

Contract: `catalog-cache-epoch-v2`

This manifest is the immutable activation input for the Provider Access
visibility gate. Completing the database rollout binds the operator to this
exact surface set; it does not enable a feature flag.

## Authority

- PostgreSQL owns a transactional, monotone global catalog epoch.
- PostgreSQL keeps the existing monotone per-account visibility epoch.
- Account-scoped visibility mutations advance only that account's epoch in
  their existing transaction; they never serialize or invalidate other users.
- Completing this rollout, or changing either effective visibility flag,
  advances the global epoch atomically with that global policy change.
- The authenticated Edge response token combines global and account epochs.
- Database write fences continue to use the numeric account epoch; the
  composite token is only for response consistency and cache identity.

## Server readers and writers

- `norva-catalog`: Home, Movies, Series, Search, categories, genres, facets,
  recommendations, title hydration, Live logical channels and variants.
- `norva-cloud`: sources, favorites, history, Continue Watching, EPG, series
  metadata, content events and account boot payloads.
- `norva-playback`: session creation, target/config resolution and recovery.
- background selectors, source sync, title projection, import notification,
  provider overview, series prewarm and admin/operator diagnostics remain
  fenced by the centralized visible-source or generation snapshot contracts.

## Client cache surfaces

- Edge/browser authenticated GET cache URLs and response retries;
- source, media, pagination, Home rail, Live and facet Maps;
- seven-day `norva-cc:*` catalogue cache;
- Live IndexedDB catalogue;
- source aliases, filters, recents, last channel, series version choice,
  playback resume/retry, subtitle offsets and provider backoff maps;
- Android phone and TV WebViews inherit the same Edge and SPA token;
- native playback remains server-authorized per session and source snapshot.

## Rolling order

1. Install the additive database epoch and rollout objects with all flags OFF.
2. Deploy Edge readers that bind and finalize the composite cache token.
3. Deploy the compatible SPA/WebView cache handling.
4. Wait beyond the longest in-memory/browser cache TTL and verify old clients
   accept the opaque versioned token.
5. Run two-session DB races and warm-cache cutover smokes.
6. Complete the epoch-v2 rollout with this manifest hash.
7. Enable Provider Access and visibility in separate, reversible steps.

Rollback never drops the epoch objects. Turn the visibility flag OFF; that
toggle advances the global epoch and invalidates every compatible cache.
