# Preserve cache representation changes

The real El ultimo Regalo capture failed at range-validation after HTTP206,
with a strong ETag and targetIdentityMatch=false. The existing bounded diagnostic
reported VOD_CHANGED, while capture/worker received PROVIDER_FETCH_FAILED.
No conclusion about expiry, missing bytes or provider downtime follows.

The range-reuse cache can throw VOD_CHANGED before the broker has pinned its
own effective URL. The catch path previously wrapped that exception as a generic
transport failure. It now records the existing terminal error before teardown,
preserving the cache invalidation and refusing further bytes/retries in that
broker. No representation fence is relaxed and no automatic retry is added.
The Selection client's diagnostic allowlist retains VOD_CHANGED; its existing
bounded durable retry policy remains unchanged. It is not classified as a
permanently truncated source.

A real loopback broker test seeded cached bytes, changed the CDN path under the
same ETag, and reproduced PROVIDER_FETCH_FAILED before the fix. Afterward it
receives VOD_CHANGED, exactly one provider call, zero retained/reused bytes.
Broker/cache suites: 112 tests, 110 passed, two existing platform skips.
Client suite: 17 passed, including no hidden retry or upstream-text disclosure.

This is not yet a production rollout or a successful parallel-analysis proof.
Existing El ultimo Regalo job d594d89c-77c0-410b-87fc-e1f3c5d56e45 retains its
normal schedule; the bounded parallel trial is closed with admission false.
