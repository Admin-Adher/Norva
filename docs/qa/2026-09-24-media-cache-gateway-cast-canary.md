# Shared R2 cache: Gateway callback repair and ordinary-account canary

## Scope

On 24 September 2026, the shared R2 cache was enabled only for the ordinary
commercial QA account's exact Matroska film. Both global read and singleflight
flags remained false. The selected account had stage `singleflight`, and the
database admission policy was `enforced`; other accounts were not enrolled.
The film was `South Park Guerras do Streaming` from the QA-owned Norva
Selection source. Its exact file profile contained a 539,967,493-byte source,
one audio track, and a 48:11 running time.

## Production defect and repair

The first producer admission reached the main Gateway, but its lease pulse
returned HTTP 500. The production definition of
`norva_pulse_media_cache_producer_for_gateway` compared
`cloud_gateway_sessions.external_session_id` (`text`) with a UUID parameter.
PostgreSQL reported SQLSTATE `42883`: `operator does not exist: text = uuid`.
The same comparison was present in seven Gateway cache callback functions.

The repair already existed in Git as
`20260903120000_media_cache_gateway_session_id_cast_v1.sql` but had not been
applied to production. Its idempotent body was first executed unintentionally
outside a transaction during a planned dry run. It was then applied again under
`BEGIN`/`COMMIT`. A read of all seven live definitions confirmed the explicit
`::text` comparison. No-match pulse and abandon RPCs returned `missing` rather
than SQLSTATE 42883. The one-account canary was returned to `off`/empty cohort
while the repair was checked, then re-enabled.

PR #400 (`30bd34f547b0bbfb62cdfb0cbb6591c0b6e8f3ec`) adds a schema-only
production runtime fixture that checks all seven casts and executes no-match
pulse/abandon calls. All 25 assertions passed in an isolated PostgreSQL
container; the disposable container and volume were removed. Its full CI run
passed. The production Gateway image was unchanged: both nodes remain v168 on
`sha256:f523bc18cd0571a264a6c00e930502fbe2f728a937f6cb8f04c5362d47e98392`.

## Real playback evidence

After the repair, the QA film showed decoded frames in the web app. The main
Gateway's producer-control renewals advanced without another lease-pulse
failure during that session. The viewer left at about 38:44 of 48:11, so the
exact input and FFmpeg graph did not reach EOF and no R2 object was published.
This partial playback proves admission and heartbeat, not a cache hit.

The film was restarted from zero at 08:26 UTC and played to 48:11, with
decoded frames in the browser. The Gateway read all 539,967,493 source bytes
and recorded a clean full-file input attestation at 08:58:49 UTC. Its producer
heartbeat renewed throughout the playback without another failure. Yet no R2
object or publication callback appeared.

The second integration defect is the production `BOUNDED_HLS_OUTPUT_ENABLED`
mode. It produces a rolling playlist of 64 segments with `delete_segments`,
and the shared-cache scheduler refuses every bounded session. The health flag
`sharedMediaCache.enabled=true` described a configured publisher, not a
reachable producer-to-R2 journey. This is a reproducible configuration/code
incompatibility, not a provider or card problem.

A v169 candidate now retains all segments only for an admitted exact MKV
producer with a complete profile, source at most 768 MiB, and duration at most
one hour. It continues using the viewer-paced HTTP output writer and reserves
and enforces a 4 GiB disk ceiling. Ordinary playback retains the 64-segment,
512 MiB rolling mode. The candidate also makes the FFmpeg `close` handler wait
for the asynchronous output drain begun on `exit`; otherwise it could inspect
the completion flag before the final admitted HTTP PUT had reached disk.

An isolated run in the production v168 codec image, without network access or
provider data, generated 12 seconds of synthetic video and audio through the
candidate retained output path. It produced six sequential segments, an EVENT
playlist containing all six, and `ENDLIST` within a 64 MiB cap. Twenty-two
focused local tests passed. A broader Windows Gateway test run was not usable:
the worktree lacks the `undici` dependency required by several harnesses; Linux
CI was the remaining regression gate before deployment. At this point,
**no application R2 hit had been observed**.

## v169 rollout and live canary, 09:41 UTC

PR #401 merged as `e44448a7a008733a86fe1457fd60bb91462d10e6`. Its second
Build Norva run passed all jobs: 5,102 Node tests passed, zero failed, and 20
were skipped. The complete Gateway source from that merge was archived and
built without network access against the pinned production codec image. The
resulting reference image is
`sha256:5b11b77ae9c0af4397c764c627902bf362eb56bb21f96c8d1230ee92c8b7bcd6`.
An isolated, networkless container served health v169 with zero sessions.

The guarded rollout plan passed on both idle production nodes with no
environment change. The pilot was replaced at 09:41:33 UTC and the main
Gateway at 09:41:45 UTC. Both served healthy v169 after replacement, from the
same image and source revision. Rollback receipts are respectively
`/home/adrien/.norva/gateway-reference-rollout/20260924T094133716216Z` and
`/home/adrien/.norva/gateway-reference-rollout/20260924T094145031318Z`.
The main Compose override was pinned to the new image, with a protected backup
at `/home/adrien/.norva/gateway-v169-e44448a7-20260924/override-before-v169.yml`;
its SHA-256 changed from `4d206963e2ba2a1d295600f9d198db4f275ddd3f82d30365f8725137f692e415`
to `afc791d304af6afeb8dcb3bb41b29172745a548686eb7392185e1243f4c2958d`.

At the first ordinary QA replay, the browser decoded 1280×720 frames and
advanced through the complete 48:11 film at 1.5×. The live health reported
one admitted producer and one retained HLS session; 95 lease renewals succeeded
without a lease failure. At 10:14:24 UTC the first R2 publication failed with
`MEDIA_CACHE_WORKER_UNAVAILABLE`. The Gateway recorded one publication failure,
abandoned the producer lease and cleaned up the output after the viewer ended.
There is no ready `media_cache_objects` row and no cache-hit replay to claim.

The Worker health endpoint was healthy afterwards. From the same Gateway
container, a missing manifest lookup returned 404, and disposable synthetic
40-byte and 4 MiB asset uploads returned 201; each was immediately purged
with a verified one-object deletion. Thus the live endpoint and basic R2 write
path work, but these probes do not establish why the earlier request failed.
Its client retries only twice at 100 and 500 ms after the first attempt, and
the one-shot publication does not resume after those attempts fail.

A follow-up Gateway candidate retries only explicitly retryable Worker read or
write failures after 5, 20 and 60 seconds. Every retry must renew the same
producer lease, and teardown keeps the heartbeat alive until publication
settles. Immutable asset names and manifest-last publication make a replay of
the same graph safe after a partial upload. Terminal conflicts are never
retried. Nineteen focused publication, wiring and producer-control tests pass.
This candidate has not yet passed full CI or been deployed. The database still
has exactly one account in stage `singleflight`; global read, singleflight and
live-join flags remain false.

## Remaining checks

- Merge and deploy the bounded Worker retry candidate after CI and an isolated
  runtime smoke, then repeat the ordinary QA full-file replay.
- Observe Gateway publication and a ready R2 object.
- Replay the film in the ordinary QA app and confirm decoded frames with a
  shared-cache session and no new provider-backed Gateway session.
- Verify another owner cannot use this owner's source binding in production.
- Keep global cache flags disabled until the owner-scope, concurrent-viewer,
  fallback, and rollback paths have live evidence.
