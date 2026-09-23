# Media-cache runtime provisioning

The production Worker and Gateway already have their service/manifest keys. Edge
still needs the existing ticket and coordination keys held in the GitHub
`Cloudflare` environment. This procedure does not rotate any key or enable cache
playback.

1. Merge and verify the provisioning scripts. The pinned public recipient belongs
   to `/home/adrien/.norva/media-cache-runtime-20260924/recipient-private.pem` on
   the production host. Its private key has mode 0600 and never leaves that host.
2. Dispatch `provision-media-cache-runtime.yml` on `main`, confirmation
   `SEAL_MEDIA_CACHE_RUNTIME`. Only the two missing keys are encrypted using
   RSA-3072 OAEP-SHA256 with a purpose-specific label. No plaintext artifact is
   produced; artifact retention is one day.
3. Verify the successful workflow run, exact source revision and artifact identity
   using authenticated GitHub API access. Encryption protects confidentiality,
   not sender identity: never install an arbitrary supplied sealed file.
4. Copy the sealed artifact to the production staging directory. Run
   `provision-media-cache-runtime.py <sealed-file>` first, then with `--apply`.
   The envelope expires after 15 minutes. The installer reads the existing
   Gateway service token and fixed production Worker URL locally, requires
   distinct keys, refuses to replace nonempty runtime keys, and atomically
   verifies that global and canary activation remain off. SQL locks and queries
   have bounded timeouts. Existing values are backed up with mode 0600.
5. After the Edge configuration cache expires, verify both replica health
   responses: Worker, ticket and coordination keys configured, global playback
   still disabled. A successful provisioning receipt is not playback proof.

Next gates remain actual publication, owner-scoped grants, revocation, cache-hit
playback, ordinary-account application verification and progressive activation.
Never change rollout flags as part of this key-install step.
