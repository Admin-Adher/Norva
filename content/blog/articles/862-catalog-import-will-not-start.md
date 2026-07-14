---
content_id: "NVB-862"
title: "Catalog Import Will Not Start? First Checks"
seo_title: "Catalog Import Will Not Start? First Checks"
meta_description: "Diagnose an import that does not begin by recording the request, checking source access, account context, device state, network, storage, and visible messages."
slug: "catalog-import-will-not-start"
canonical_url: "https://norva.tv/blog/catalog-import-will-not-start/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "import-start-troubleshooting"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot an import that does not begin?"
supporting_questions:
  - "Which authorization, source, account, network, device, and storage observations matter first?"
  - "How can repeated requests be avoided while preserving useful evidence?"
audience:
  - "Norva users starting a catalog import"
  - "Household source administrators"
author: { name: "", profile_url: "" }
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
  source_of_truth: "https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 8
excerpt: "A first-pass import-start check preserves the original request, verifies authorization and source reachability, and records account, device, network, storage, and message context before retrying."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/source-connection-timeout-triage/"
  - "/blog/import-finishes-with-zero-items/"
cta:
  label: "Check Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://www.rfc-editor.org/rfc/rfc9110"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "import start gate record"
  summary: "A gate record captures authorization, source response, account and profile, request time, visible acknowledgment, device and application version, network, available storage, concurrent state, and the first safe comparison."
  methodology: "The user records the initial request, verifies each visible prerequisite without changing credentials or source data, performs at most one documented comparison guided by current support, and escalates a redacted packet."
  asset_urls: []
---

# Catalog Import Will Not Start? First Checks

> **In short:** Stop repeated taps and record the original request time, screen, account, profile, device, application version, network, authorized source label, and exact message. Confirm the source is reachable through its official route, access remains authorized, required details are current, the device has reasonable storage, and no visible operation is already active. Retry only through current guidance, then escalate redacted evidence.

“Will not start” should describe an observable state: no acknowledgment, no displayed stage, or an immediate message after a request. It should not become a guess about an undocumented background process.

## Preserve the first request

Record the local timestamp with timezone, page or screen, control used, visible response, and whether the control remained enabled. If a message appeared, copy its exact text or capture a redacted screenshot. Do not keep activating the control; multiple requests make the sequence ambiguous.

The [troubleshooting handbook](/blog/catalog-import-sync-troubleshooting-handbook/) explains how to keep later observations in separate evidence layers.

## Reconfirm authorization

Verify that the household still has permission to use the connected source and that the source owner recognizes the attempted operation. Working credentials do not prove continuing authorization. If access was revoked, expired, or transferred, stop and resolve ownership through the source provider.

Never include credentials in the diagnostic record.

## Check the source independently

Use the provider's current official route to confirm service availability and account access. Record whether the source responds, rejects access, redirects, or reports maintenance. A source result is one signal, not proof of Norva's internal state.

If the source request times out, follow the [connection-timeout triage](/blog/source-connection-timeout-triage/) before changing credentials.

## Verify account and profile context

Confirm the expected Norva account and profile are active and that the source label matches the intended connection. Record whether another trusted household administrator sees the same source under an authorized context. Do not switch accounts mid-test without labeling the comparison.

## Record device and application state

Capture device model, operating system version, Norva application version, foreground or resumed state, and available storage as displayed by the device. Low storage or an outdated environment is worth recording, but neither should be declared the cause without evidence.

Avoid clearing application data or reinstalling before support has the original state.

## Compare network context safely

Record connection type and whether ordinary authorized Norva and source pages load. If practical, compare once on another trusted network without bypassing security controls. Do not disable certificate validation, change DNS settings, or install unknown profiles merely to force a result.

HTTP response semantics can help describe a provider response, but they do not identify a Norva implementation fault by themselves.

## Look for an operation already in progress

Inspect the current interface for a visible stage, activity indicator, disabled control, queue, or recent result. Do not assume a hidden queue exists. Record only what is shown. If a stage is visible but unchanged, move to the [stalled-stage timeline](/blog/catalog-import-stuck-same-stage/) rather than issuing another request.

## Distinguish no start from zero results

An operation that completes and displays zero items did start. That case requires a different investigation of source content, filters, account scope, categories, and visible results. Use the [zero-item guide](/blog/import-finishes-with-zero-items/) and preserve the completion evidence.

## Retry with a defined boundary

Follow current Norva support instructions for any retry. Before acting, record what changed since the first request and define the result that will end the test. If the same state recurs, stop. Credential edits, source removal, repeated imports, and device resets are not neutral retries.

## Original evidence: import start gate record

| Gate | Observation | Time | Result |
| --- | --- | --- | --- |
| Authorization and owner |  |  |  |
| Original request and response |  |  |  |
| Source official route |  |  |  |
| Account, profile, source label |  |  |  |
| Device, version, storage |  |  |  |
| Network comparison |  |  |  |
| Visible active operation |  |  |  |
| Guided retry, if any |  |  |  |

## Common mistakes and limitations

- Activating the request repeatedly before recording evidence.
- Rotating credentials without an access or exposure signal.
- Calling a completed zero-item result “not started.”
- Clearing local data before comparing another supported device.
- Treating one HTTP response as a complete root cause.
- Sending passwords, tokens, or full source addresses to support.

## Frequently asked questions

### Should I keep pressing the import control?

No. Preserve the first response and use current support guidance. Repetition can obscure which request produced a later result.

### Does a working source prove Norva can begin the operation?

It confirms only one layer. Account, profile, device, application, and visible operation state still need separate observations.

### Should I reinstall the application first?

Not as a first evidence step. Reinstallation can remove useful local context and does not establish the original cause.

## Your next step

[Check Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
