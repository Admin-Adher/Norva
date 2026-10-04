# MAX OTT — user-authorized alias diagnostic

## Scope and status

4 October 2026, UTC. The user supplied three provider bases and credentials to investigate the unresolved original-file delivery failures described in [the four-file report](2026-10-04-four-original-refusal-rootcause.md). This report identifies the bases only by their supplied order: **index0, index1 and index2**. No address, credential, source identifier or account-affinity hash is published.

**HIT's media request remains refused on both newly authorized aliases: index0 returns 403 and index1 returns 401.** Their account and HIT metadata requests succeed. A control file, MMA Cop, is redirected by index1, showing that its initial response is not an identical refusal of every media request. That redirect was not followed and does not certify playback. The [combined safe receipt](2026-10-04-max-authorized-alias-diagnostic.json) preserves the completed comparison and final health audit. No alternative base was saved to a source or promoted as a playback route. The existing failures and malformed-input observations remain open.

## Verified configuration and ownership scope

The immediate private comparison at 19:35:23 confirmed that both supplied credential digests match the current MAX OTT configuration. Its base is **index2**, the third supplied address. This is a comparison of private values, not a network authentication result.

The complete read-only inventory, most recently checked at 19:47:08, inspected 21 encrypted Xtream source configurations across owners with **zero decryption failures**. It found two sources with these credentials, belonging to one owner. There were no sources with the same credentials on other registered bases and no additional same-username source on the three authorized bases.

| Authorized base | Sources with matching credentials | Current source state |
| --- | ---: | --- |
| index0 | 1 | Soft-deleted: `enabled=true`, `deleted=true`; not an active source |
| index1 | 0 | No registered source found |
| index2 | 1 | Active original source; current configured base |

The distinction for index0 matters: it is **not** an `enabled=false` source. A restore could make it active, so a diagnostic must guard against that transition rather than infer safety from a stale inventory snapshot.

The audit found three distinct host-based account affinities. The existing mono-connection claim is scoped by host/account identity; a claim for index2 alone does not demonstrate exclusion of activity through index0 or index1. At the audit instant, the union had zero live claims, strict-language leases, exact-file-probe leases or direct-fallback leases. Those zeros are a snapshot and do not establish a cross-alias atomic lock.

## Mono-connection safeguards

The operator compared account information and exact HIT metadata sequentially, with **no media request** during this first phase. It retained the ordinary claim for the active source, checked the private input/configuration/generation snapshots, and preserved existing provider limits and foreground-playback priority.

Additional safeguards applied to each of these four requests were:

- Foreground fences for the three relevant affinities on both Gateways, with a 120-second TTL and natural expiry. All eight Gateway responses in this metadata phase confirmed background drain; all reported zero extractions and zero language validations stopped. The subsequent operations also returned these confirmations. The final fences were set at 19:58:59; their configured expiry is around 20:00:59. The 19:59:39 final audit precedes that deadline and does not claim their natural expiry was already observed.
- A bounded `FOR SHARE NOWAIT` lock on the exact soft-deleted index0 source row, with snapshot validation. It prevents that row from being restored or changed while the guarded provider request is in flight.
- An eight-second maximum for a provider request and a 12-second idle-transaction timeout. Loss of the lock or claim must stop the request. No automatic retries, concurrent provider requests or proxy rotation were added; redirects were not followed.
- Normal release/expiry and post-run checks. No source restore, credential rewrite, deadline reset or forced lease removal is authorized by this diagnostic.

The row-lock helper was independently exercised at **19:43:07** without provider I/O. It acquired the lock, observed a competing `FOR UPDATE NOWAIT` fail with SQLSTATE `55P03`, rolled back successfully, then observed the same competing lock succeed after release. No data was updated. This proves the row-exclusion primitive for that test; it does not alone certify the full upcoming multi-alias protocol.

The private guard snapshot was enriched at 19:47:08 with the exact inactive-source lock fields. No provider comparison had started when that update was coordinated with the operator. Each completed request then revalidated its loaded snapshot and reported unchanged catalogue context. All four row guards were acquired without loss and rolled back; all four independent heartbeat threads retained their claim and stopped; all four claims expired normally. Raw temporary bodies, HTTP headers and error logs were removed. Restricted result payloads were retained for the private metadata comparison.

These safeguards are scoped to this audited configuration and these bounded requests. They do not establish a permanent atomic account identity across aliases: each receipt retains `crossAliasAtomicLeaseProven=false`. No restoration or permanent source/affinity change was made.

## Provider metadata results

| Base | Account-info result | Exact HIT metadata result | Media delivery |
| --- | --- | --- | --- |
| index0 | 19:48:41; HTTP 200, authenticated/active, 0.637 s | 19:49:14; HTTP 200, exact stream/title/MKV, 0.572 s | 19:55:09; empty HTTP 403, 1.271 s |
| index1 | 19:48:59; HTTP 200, authenticated/active, 0.961 s | 19:49:25; HTTP 200, exact stream/title/MKV, 0.754 s | 19:55:21; empty HTTP 401, 1.011 s |
| index2 | Existing 19:22:02 control: active/authenticated, zero connections, maximum one | Existing original-file metadata authority; no new request in this phase | Earlier exact-file 403; see original report |

Both new account responses satisfied the operator's explicit assertion that `active_cons` is present, numeric and zero, and that `max_connections` matches the known index2 control value of one. These values are supported by successful assertions, not inferred from absent fields. Both returned `server_info` authorities map to **index0**; index1's advertised authority therefore differs from the queried alias. This is provider-supplied metadata, not proof of a distinct media backend or successful delivery through index0.

The complete retained HIT metadata bodies on index0/index1 are identical, including all field paths and values. They provide no nonempty `direct_source`. A safe read-only projection records field names/types and allowlisted technical values only:

- Duration: 9,420 seconds (02:37:00).
- Video: H.264 High, 1920 × 816, 24 frames/s, `yuv420p`.
- Audio: AAC-LC, 48,000 Hz, six channels/5.1.
- Additional numeric stream byte/frame/bitrate statistics are retained as provider declarations in the safe receipt. They are not measurements from reading the media file.
- No explicit current availability/health field was found among the inspected health-field names. This absence does not establish healthy media.

Unlike the earlier deliberately reduced metadata retention, these complete bodies include audio/video descriptors. Editorial fields, release dates and technical declarations do not establish why the original file returned 403. A listing, authenticated account or matching stream identifier alone does not establish successful media delivery.

## Media responses and guarded preflight incident

The first index0 media operation at **19:51:08** stopped with `AliasRowGuardError` during preflight. It made **zero provider requests and zero media requests**. Its claim was kept alive until cleanup and expired normally; the temporary files were removed. It is not a media refusal or a completed test, and the receipt does not establish successful row-lock acquisition for that attempt.

A separate read/lock-only diagnostic at **19:52:30** confirmed the exact enabled/deleted/revision/affinity/cipher snapshot, then acquired and released the intended lock in 62.632 ms without provider I/O. This proves that follow-up succeeded, but does not establish the original preflight error's cause. The later index0 request used a distinct one-shot operator marker after this diagnostic; it was not an automatic retry loop.

At 19:55:09, index0 returned **HTTP 403 with zero body bytes**. At 19:55:21, index1 returned **HTTP 401 with zero body bytes**. Each test retained the original HIT stream/path/extension and changed only to the corresponding explicitly authorized base for that request. The earlier account and exact-file metadata prerequisites were verified. Both used the reviewed CONNECT proxy and unchanged production-default User-Agent, did not follow redirects, and were bounded to eight seconds/64 KiB. Neither delivered media bytes or proved playback.

Both completed media operations acquired their inactive-source guard, acknowledged rollback, retained their heartbeat and expired normally. Their catalogue contexts were unchanged. Their Gateway fences reported zero extractions or language validations stopped. The empty 401 response does **not** establish that the supplied credentials are wrong, that the account is banned, or any particular internal reason; authentication through that alias had succeeded minutes earlier. The different status codes are observed behavior, not a proven explanation of the upstream refusal.

No source, route policy, codec or account limit was changed based on these refusals.

## Same-alias control file

The operator then tested the exact original MMA Cop file on **index1** with the same account, User-Agent, reviewed proxy and guard protocol. Its metadata request at **19:58:45** returned HTTP 200 in 0.643 s, with the expected stream identifier, normalized title and MKV extension, and no nonempty direct source. The original media GET at **19:58:59** returned **HTTP 302 in 1.076 s**, with a Location header and an empty body. The private redirect destination was not published or followed.

This contrasts with HIT's empty 401 on the same alias minutes earlier. It rules out describing the observed behavior as an identical initial refusal of all media requests under that account/alias configuration. It does not establish that MMA's redirected bytes are available, that playback is fluent, or which internal rule rejected HIT. Time-dependent state and file-specific delivery remain possible; no internal cause has been proved.

Across the new-alias diagnostic, the operator made **eight provider requests: five metadata requests and three initial media GETs**. There was also one stopped preflight with zero provider I/O. Redirects were not followed in these eight calls; the CONNECT tunnel handshakes are recorded separately in the HTTP status arrays. All eight completed calls retained their guards and heartbeats, acknowledged rollback and expired normally, with unchanged catalogue context and zero extractions/language validations stopped.

## Final read-only health and conclusion

At **19:59:39 UTC**, both Gateways returned HTTP 200/`ok` with the same deployed image. The three-affinity union had zero Gateway readers, live claims across owners, strict jobs, language-validation leases, exact-probe leases, other probe leases or fallback leases. The primary Gateway still had one unrelated global reader; it was preserved. No transaction bearing the scoped row-guard marker remained open, no source-table lock was held by those guard transactions, and no global source-table RowShareLock was observed. These PostgreSQL observations are scoped checks, not a universal audit of every possible row lock.

The original source ciphertext, configuration revision and active generation were unchanged. The other configured alias remained soft-deleted. The permanent language dispatcher was running and healthy. The temporary foreground fences retain their natural TTL; no force-clear was performed.

The bounded comparison is complete, but **HIT is not repaired and its internal rejection reason remains unknown**. The supplied client credentials allowed account and catalogue queries; the collected responses did not provide server-side request/rejection logs. Neither the successful metadata nor the different media status codes justify a speculative source switch, header change or account-policy change. The earlier corrupt-input observations for the other originals also remain unresolved.

## Evidence and limits

Local safe audit inputs:

- `.codex-artifacts/max-user-alias-quick.safe.json`
- `.codex-artifacts/max-user-alias-audit.safe.json`
- `.codex-artifacts/provider-alias-row-guard-proof.safe.json`
- `.codex-artifacts/max-authorized-alias-receipts/` — nine safe operator receipts (eight requests and one stopped preflight), technical metadata projection and health audits.

The private source/configuration and affinity coordinates remain in the operator's restricted files. No production application code or persistent source configuration changed in this diagnostic. This is a completed diagnostic record with an unresolved media fault, not a playback repair or a certification of the whole catalogue.
