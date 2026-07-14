---
content_id: "NVB-639"
title: "What Not to Reset During Early Buffering Diagnosis"
seo_title: "What Not to Reset During Buffering Diagnosis"
meta_description: "Preserve app state, sessions, device settings, router configuration, DNS, mesh, QoS, and source evidence during early buffering diagnosis before any destructive recovery."
slug: "what-not-to-reset-during-early-buffering-diagnosis"
canonical_url: "https://norva.tv/blog/what-not-to-reset-during-early-buffering-diagnosis/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "non-destructive-diagnostic-guide"
topic_cluster: "Buffering Diagnostics"
search_intent: "avoid destructive buffering troubleshooting"
funnel_stage: "retention"
primary_question: "Which state should not be reset during early buffering diagnosis?"
supporting_questions: []
audience: []
author:
  name: ""
human_review:
  required: true
  status: "pending"
  reviewer_name: ""
  reviewer_role: ""
  reviewed_at: null
  decision: ""
  notes: ""
product_claims:
  verified: false
  verified_by: ""
  verified_at: null
  source_of_truth: "https://norva.tv/; https://norva.tv/support; https://norva.tv/privacy; https://norva.tv/terms"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 4
excerpt: "Do not begin by clearing app data, signing out, deleting downloads, resetting device settings, factory-resetting the router, changing every DNS or QoS control, rebuilding mesh, or deleting source configuration. These actions can erase evidence, security, accounts, calibration, and rollback. Capture the state and use one reversible check first."
hero:
  src: ""
  alt: ""
  width: 1600
  height: 900
og_image: ""
schema_type: "BlogPosting"
faq_schema:
  enabled: false
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "evidence-preservation and reset-risk register"
  summary: "A register lists each app, device, network, account and source state, evidence it contains, reset consequence, backup, authorization, lower-risk check, recovery owner, and escalation threshold."
  methodology: "Follow the article's visible workflow, record observable results, and compare only the stated variables before drawing a conclusion."
  asset_urls: []
is_pillar: false
parent_pillar: "/blog/a-symptom-pattern-atlas-for-video-buffering/"
related_articles:
  - "/blog/restart-or-reset-the-router-know-the-difference/"
  - "/blog/how-to-collect-buffering-evidence-for-support/"
  - "/blog/a-buffering-escalation-checklist/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://csrc.nist.gov/pubs/ir/8425/a/final"
  - "https://csrc.nist.gov/pubs/sp/800/153/final"
  - "https://www.rfc-editor.org/rfc/rfc2330"
---
# What Not to Reset During Early Buffering Diagnosis

> **In short:** Do not begin by clearing app data, signing out, deleting downloads, resetting device settings, factory-resetting the router, changing every DNS or QoS control, rebuilding mesh, or deleting source configuration. These actions can erase evidence, security, accounts, calibration, and rollback. Capture the state and use one reversible check first.

Recovery and diagnosis are different goals. A broad reset may restore playback while making the relevant cause impossible to locate.

## Preserve app state

Record app version, source selection, title version, quality mode, tracks, error messages, cache or storage warnings, and playback timeline. Do not clear app storage or reinstall before understanding downloaded media, sign-in, settings, and logs.

An ordinary app restart is less destructive, but it still changes volatile state; record evidence first.

## Preserve session and account state

Do not sign out everywhere, revoke devices, change passwords, or remove account permissions as a generic buffering fix. Those actions can interrupt other users and erase session evidence.

Use them only when a session or security concern is validated and official support explains consequences.

## Preserve device configuration

Avoid factory-resetting a TV, tablet, or phone. It can remove accessibility settings, display and audio calibration, trusted networks, accounts, logs, downloads, and app versions. Record model, OS, power, output, and capability first.

Do not enter service menus or install unofficial firmware.

## Preserve router and mesh configuration

[Restart and reset are different](/blog/restart-or-reset-the-router-know-the-difference/). A factory reset can erase security, provider settings, Wi-Fi, guest isolation, QoS, DNS, address reservations, mesh pairing, and device access. NIST IR 8425A treats router configuration as part of cybersecurity outcomes.

Confirm ownership and recovery before any disruptive action.

## Original evidence: reset-risk register

| State | Evidence at risk | Reset consequence | Lower-risk check | Backup/recovery | Authorized by |
|---|---|---|---|---|---|
| App/session | Version, message, logs | Sign-in/data loss | Restart app after capture | Method | Owner |
| Device | Output, network, logs | Full setup | Compare title/device | Method | Owner |
| Router/mesh | Topology, security, metrics | Network outage | Status and link tests | Method | Admin |
| Source | Version, tracks, access | Lost configuration | Alternate authorised title | Method | User |

Store backups securely and never attach them to a public support case.

## Avoid changing every network control

DNS, guest isolation, firewall, band steering, channel, QoS, and mesh placement are separate variables. Change only one documented control after a baseline. NIST SP 800-153 emphasizes secure wireless configuration.

Do not disable encryption, filtering, or isolation to chase performance.

## Preserve measurement context

Record endpoint, protocol, direction, duration, device, link, location, time, and household activity. RFC 2330 provides a framework for performance metrics. A reset can change route, channel, address, clock, and queue state.

[The support-evidence guide](/blog/how-to-collect-buffering-evidence-for-support/) creates a redacted packet before intervention.

## Use a low-risk ladder

Verify source status and exact version, compare another title, check the active path, inspect cables and Wi-Fi context, compare another device, and repeat at another time. Then restart only the affected app or device through official controls if evidence supports it.

[The buffering escalation checklist](/blog/a-buffering-escalation-checklist/) defines when to move outward.

## Know when reset may be justified

A trusted manufacturer, provider, or app support process may request reset after evidence review. Before proceeding, verify exact model steps, backup, credentials, security settings, offline data, calibration, critical-device impact, maintenance window, and recovery owner.

If any requirement is missing, pause and escalate.

## Keep product boundaries accurate

Norva organises and plays compatible authorised sources. It does not require broad device or router resets as a universal fix. Current app-specific recovery instructions must come from official Norva support.

## Frequently asked questions

### Is restarting the app always harmless?

No. It can clear volatile state or interrupt downloads, but it is usually narrower than clearing data; capture evidence and follow official guidance.

### Should DNS be changed before collecting evidence?

No. It changes one setup stage and can introduce privacy or policy differences without addressing the actual cause.

### When is factory reset acceptable?

When authorized official guidance supports it and backup, credentials, security, impact, and full recovery are understood.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [NIST IR 8425A: Consumer-Grade Router Requirements](https://csrc.nist.gov/pubs/ir/8425/a/final)
- [NIST SP 800-153: Wireless LAN Security Guidelines](https://csrc.nist.gov/pubs/sp/800/153/final)
- [RFC 2330: Framework for IP Performance Metrics](https://www.rfc-editor.org/rfc/rfc2330)