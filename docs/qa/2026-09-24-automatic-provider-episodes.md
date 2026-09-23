# Automatic provider episode routing — 24 September 2026

## Change

Browser relay and automatic Gateway requests for server-resolved Xtream episodes now use the same input-inspection lane as owned M3U episodes. Explicit native/direct playback and explicit conversion retain their modes. Source ownership and generation checks remain before session admission.

Provider resource suffixes remain separate from observed byte formats for exact, cached, and legacy uncached series resolution. Observing MPEG-TS must not rewrite a valid provider `.mp4` resource to a nonexistent `.ts` resource. The Gateway's input probe chooses the actual remux/conversion strategy; caller codec hints do not authorize episode fast-start.

Playback health revision: 83, automaticOwnedEpisodeGatewayProtocol: 1.

## Verification

185 focused tests passed, no failures or skips. Behavioral tests execute the production resolver and routing helper for exact, cached, and uncached episodes, provider resource preservation, owner/source query scope, caller marker spoofing, native bypass, and explicit conversion. Existing provider-circuit, language-probe, private/shared-cache, native heartbeat and Selection routing suites also pass.

## Pending

Not yet deployed. Integration CI and real Dino browser playback without manual conversion remain required. This report does not certify ordinary-account commercial readiness, Android playback, or rollout of other disabled features.
