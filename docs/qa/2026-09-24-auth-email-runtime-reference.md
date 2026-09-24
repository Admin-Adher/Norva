# Auth email runtime reference, 24 September 2026

The deployed `norva-auth-email/index.ts` still differed from Git after the Postal transport rollout. Git retained an unused injectable `postalPair` handler from an isolated proof; the deployed Send Email Hook directly enters `Deno.serve` and sends through the private Postal request adapter. The injection was not selected by the live entry point, but rebuilding from Git would produce a different module.

This change copies the exact deployed entry point into the repository. The deployed source SHA-256 was `6a375c47e9a0806ed7c88602d0c9c9a118eeec0cde75caec5a32273a9d5fce97` on 24 September. The signed hook verifier, payload construction, delivery idempotency, 4-second transport bound, receipt validation and retry response remain the same. No production service was changed by this reference update.

All 47 focused authentication email, integration, locale and Postal transport tests passed locally. A fresh signup and delivered inbox receipt after the separate auth-challenge rollout remain to be checked with an ordinary QA account. Other production-only Postal modules and configuration are outside this single-file reconciliation; full Edge rebuild parity is still open.
