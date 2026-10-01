# Strict range cache: initial target miss

The real Forrest Gump capture reported HTTP502 VOD_CHANGED after an earlier
broker had retained fragments tied to a different signed CDN path. PR528 now
preserves that diagnostic; it did not remove the avoidable first-attempt failure.

A loopback regression seeds old bytes (0x61) at the prior target, then serves
fresh bytes (0x62) with an exact206, unchanged size and same strong ETag from a
new target. Before this fix it reproduces502; after it returns all5000 fresh
bytes, zero cached bytes, and requests exactly [0,0] then [1,4999]. No duplicate
range or retry is added.

The fallback applies only to the first provider response before any provider
bytes, with an optional prior fragment and no caller-supplied validator/target
pin. A same-ETag target mismatch invalidates/disables the old fragment and pins
the fresh target. All later bytes come through the normal range, length,
encoding, validator, target and drain checks. Different/missing/weak ETags,
explicit pins, size mismatch, a target change during the session and provider
errors remain terminal. Owner isolation, bounded storage and redirects are
unchanged; no scope or provider account exception is introduced.

Focused broker, strict reuse and finite playback reuse suites:123 tests,
121 passed, two existing conditional skips. Added controls verify explicit
identity/validator pins and a third target appearing after the cold fallback.
The latter may close before HTTP headers arrive or during body transfer; the
test requires a rejected transfer and exact VOD_CHANGED terminal reason in
both cases. It does not accept a complete mixed representation.

Not yet deployed. Live retry of the existing Forrest Gump durable job must be
observed separately; no new recovery or retry-budget reset is permitted.
