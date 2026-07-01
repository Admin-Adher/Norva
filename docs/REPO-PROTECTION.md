# Repo protection & deploy flow

Trace of the `main` branch-protection decision (2026-07-01) and how deploys work under it.

## Branch protection — ruleset `protect main`
- **Target:** `main` · **Enforcement:** Active.
- **Rules:** ✅ Restrict deletions · ✅ Block force pushes. (No "Require PR" / "Restrict updates" — normal
  pushes still allowed for bypassed actors, so the direct-push deploy flow is preserved.)
- **Bypass list (Always allow):** `Repository admin` (role) + `Claude` (App · anthropics — the identity that
  pushes on the assistant's behalf).
- **Effect:** force-push and deletion of `main` are blocked for everyone; the owner and the deploy automation
  can still push normally. Protects against history rewrite / accidental deletion / a leaked non-admin token.

## How deploys reach `main`
**Chosen method: PR-flow (Option 2).** The assistant's git-proxy pushes as a third-party actor that isn't in
the bypass list (not the `Claude` app, not an admin user), so direct pushes to `main` are refused by the
ruleset. Deploys therefore go: push a branch → open a PR → merge via the API as an admin (`Admin-Adher`, in the
bypass). Bonus: API-merged commits come out GitHub-**signed / Verified**, which also retires the recurring
unverified-signature nag.

Direct `git push → main` still works for actors that ARE in the bypass (the owner from their own machine); it's
just the automation's opaque pusher that isn't covered — hence PR-flow for assistant-driven deploys.

## Notes
- Secret scanning push protection is on: never commit real key material. `google-services.json` (Firebase
  Android config) is written at build time from the `GOOGLE_SERVICES_JSON` secret and is gitignored.
- The `norva-ci` WASM-build bot now commits as `github-actions[bot]` (was mis-attributed to the unrelated
  GitHub user `@ci` / "Catalin" via an email collision — cosmetic, not access; see git history).
