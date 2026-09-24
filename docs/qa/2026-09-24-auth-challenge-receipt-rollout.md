# Signup code receipt guard — 24 September 2026

The live `norva-auth-challenge` worker accepted any successful HTTP status from
the private Postal gateway as proof that a signup code was queued. The versioned
worker already required a syntactically valid delivery ID in Postal's response
and returned failure after a transport exception. The private gateway returns
an ID for a durable accepted message, so the versioned guard closes a false
success path without changing the intended recipient or email transport.

Twelve focused auth-challenge, preverification, and private transport tests
passed. They include successful and malformed acknowledgements, a non-200
response, and a pending durable queue. The TypeScript dependency graph parsed
with esbuild. All four direct imports of the worker were checked against the
running production mount and matched by SHA-256 after newline normalization.

The exact versioned worker from `main` at
`00e3446c9e2c79556bda888a86dffec3903ed555` was staged and passed a guarded
preflight against both healthy Edge replicas. Its Git LF SHA-256 is
`dcdeb7db975ca64c21b2251f0d187738935c866ee1b0bcb8782e07f1421f58a8`;
the deployed Windows CRLF file is
`f87a3fa7ee516336cdaf1cb32c701c26b32e00de6660ef9f46d72f006247e157`.
The previous production file was
`5fc8a553bb33165c2ca62838a3be02e6261b078971cb237f020b6b530e84fee0`.

At 05:43:05 UTC, the one-file rollout backed up the old worker and restarted
both Edge replicas in sequence. Both reported healthy auth-challenge protocol
1 and healthy `norva-cloud`. The public
`https://api.norva.tv/functions/v1/norva-auth-challenge/health` returned HTTP
200 with `ok=true` and `protocol=1`. Rollback backup:
`/home/adrien/.norva/auth-challenge-reconcile-20260924/backup-20260924T054305Z`.

This is a deployed acceptance guard, not a new end-to-end signup delivery
proof. The ordinary QA account's successful email verification happened before
this rollout. A fresh controlled QA mailbox signup is still needed to confirm
the new rule through the live browser and inbox; no such email was sent during
this deployment. Payment entitlement and playback remain separate commercial
gates.
