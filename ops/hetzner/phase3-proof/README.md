# Norva Phase 3 proof stack

This directory is a deliberately separate, localhost-only Supabase proof
environment. It is not a production compose override.

It is designed to run on the Hetzner host only after `preflight.sh` accepts the
machine. It uses synthetic data, freshly generated secrets, an internal fake
gateway, a distinct Docker network, and only `/var/lib/norva-phase3-proof` for
host data. It must never be connected to a public hostname, Cloudflare, real
providers, or production secrets.

Run, from this directory on Hetzner:

```sh
./preflight.sh
./bootstrap.sh
./run-proof.sh
./down.sh
# only when the evidence has been copied out:
./destroy.sh
```

`bootstrap.sh` refuses a checkout that does not contain the complete Phase 3
migration/test graph. This branch intentionally contains the account-deletion
adapter but not the user's uncommitted provider graph, so that refusal is a
safety property rather than a reason to use production.
