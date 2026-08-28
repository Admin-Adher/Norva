# Microsoft Clarity native — Android phone and TV

This runbook is the release contract for Norva's consent-gated Clarity Mobile
integration. It complements \`PLAY_STORE.md\`; it does not replace Google Play's
current Data Safety questionnaire.

## Projects

| Surface | Clarity project | Project ID | App |
|---|---|---|---|
| Public website | Norva | \`y8fgihobbx\` | browser only |
| Android phone/tablet | Norva Android mobile | \`y9fagfyr9a\` | \`tv.norva.phone\` |
| Android TV | Norva Android TV | \`y9fxs54jpc\` | \`tv.norva.tv\` |

Never send two surfaces to the same project. The project ID is public routing
configuration, not a secret. A missing ID keeps native collection disabled.
Clarity currently builds on Android API 19-28 but does not upload from those
versions; native replay coverage therefore starts at API 29. Keep Norva's own
operational telemetry as the fallback for older supported phones and TVs.

## Privacy and consent contract

- Clarity is not initialized before an explicit \`granted\` decision.
- A decline is valid on every platform; Android TV initially focuses Decline.
- Revoking consent pauses Clarity. On phone it also disables Firebase Analytics.
- No custom user ID, account ID, source ID, provider name, media title or
  playback URL is sent.
- The bridge accepts only the closed \`norva-native-clarity:v1\` protocol, only
  from the HTTPS \`norva.tv\` main frame, and rejects extra JSON keys.
- Native login/setup and playback roots are masked with \`maskView\`.
- Inside the WebView, \`data-clarity-mask=true\` is applied to the document root.
  Clarity can reconstruct geometry, scroll and interaction targets, but text,
  images, credentials, provider names and media titles remain masked.

## Dashboard settings, per Android project

Before uploading a build containing the project ID:

1. Settings -> Masking: choose **Strict**.
2. Settings -> Setup -> Data capture rules:
   - enable WebView capture;
   - allow only \`https://norva.tv/*\`;
   - phone/tablet: allow Wi-Fi and cellular so real mobile-network friction is
     visible, bounded by a 20 MB daily per-device upload cap;
   - TV: upload recordings on Wi-Fi only, with the same 20 MB daily cap;
   - disable recordings on Android devices with less than 4 GB RAM;
   - keep a bounded per-device daily network limit.
3. Keep all Norva Activities available for analytics. Sensitive views are
   masked in code; screen names are identifier-free.
4. Filter and report only the 16 bounded custom events in
   \`NativeClarity.EVENTS\`. Do not convert unrelated signals into Smart Events;
   Clarity's separate Smart Events limit is 20.

## Google Play Data Safety delta

Collection is optional because the SDK initializes only after consent. For
both Android listings, re-answer the questionnaire before publishing:

| Play category | Clarity data | Collected | Shared | Purpose |
|---|---|---|---|---|
| Approximate location | Country/region | Yes, optional | No, when Microsoft is declared as a service provider under the current Play definition | Analytics |
| App activity -> App interactions | Taps, gestures, scroll and screen transitions | Yes, optional | Same service-provider assessment | Analytics |
| App info and performance -> Diagnostics | Application errors/exceptions | Yes, optional | Same service-provider assessment | Analytics |
| App info and performance -> Other performance data | App/version/device/display context | Yes, optional | Same service-provider assessment | Analytics |
| Device or other IDs | Random SDK identifier | Yes, optional | Same service-provider assessment | Analytics |

Data is transmitted off-device and encrypted in transit with TLS. Norva does
not sell it. Confirm Microsoft's current processor terms before relying on the
Play service-provider exception. Consent withdrawal stops future collection.
Because Norva deliberately sends no account identifier to Clarity, account
deletion cannot be used to target a single pseudonymous Clarity session;
project-level deletion requests remain available through Clarity Support.

## Release and evidence gate

1. Build phone \`1.3.11\` (\`versionCode 24\`) and TV \`3.8.15-hybrid\`
   (\`versionCode 28\`) from the exact reviewed commit.
2. Run JVM/contracts and emulator replay on phone and TV:
   Accept, Decline, relaunch persistence, Back, WebView navigation, Provider
   Access, player first frame/error and \`prefers-reduced-motion\` web behavior.
3. Verify no credential/title/provider value appears in Clarity logs, tags,
   events, heatmaps or a reconstructed session.
4. Compare cold start, P95 frame time, memory and network with/without consent.
5. Upload only after the Play Data Safety delta and privacy URL are saved.
6. Confirm one real session in each native project. Complete sessions can take
   up to two hours to appear.
7. Treat this release as a material Provider Access change: mark the active
   20% observation stale and start a fresh 24-hour observation only after both
   production builds and Clarity settings are proven.
