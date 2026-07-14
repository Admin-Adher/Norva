---
content_id: "NVB-333"
title: "How to Write TV Error Messages That Work From the Sofa"
seo_title: "Write TV Error Messages That Work From the Sofa"
meta_description: "Write TV error messages that explain what failed, preserve context, offer a useful remote-friendly next step, and separate optional technical details."
slug: "write-tv-error-messages"
canonical_url: "https://norva.tv/blog/write-tv-error-messages/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "content design guide"
topic_cluster: "TV Interface Ergonomics"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How should error messages be written for a TV interface?"
supporting_questions:
  - "Which information helps a remote user recover?"
  - "How should technical details be separated from the primary message?"
audience:
  - "TV product and content designers"
  - "Norva teams reviewing errors and recovery"
author:
  name: ""
  profile_url: ""
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
estimated_reading_minutes: 7
excerpt: "A four-part TV error pattern that explains the visible problem, protects unaffected state, offers one recovery, and preserves a support-ready reference."
hero:
  src: ""
  alt: ""
  width: 1600
  height: 900
og_image: ""
schema_type: "BlogPosting"
faq_schema:
  enabled: false
is_pillar: false
parent_pillar: "/blog/tv-interface-ergonomics-guide/"
related_articles:
  - "/blog/make-tv-loading-states-readable/"
  - "/blog/design-tv-confirmation-dialogs/"
  - "/blog/remote-dpad-navigation-qa/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "awareness"
sources:
  - "https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/error-suggestion.html"
  - "https://developer.android.com/docs/quality-guidelines/tv-app-quality"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "TV error-message recovery card"
  summary: "A review card captures failed object, plain-language symptom, preserved state, primary recovery, secondary escape, support reference, focus, and post-action result."
  methodology: "Reviewers rewrite real non-sensitive error states, test comprehension at viewing distance, complete recovery by remote only, and record whether message, focus, and page context remain aligned."
  asset_urls: []
---

# How to Write TV Error Messages That Work From the Sofa

> **In short:** Name the task or object that failed, describe the visible problem in plain language, state what remains unchanged when verified, and offer one clear next action. Keep Retry, Back, and support details remote-friendly. Do not expose internal systems, blame the viewer, promise an outcome, or reset page context after recovery.

TV errors must work at distance and under input constraints. The viewer cannot hover over an icon, copy a long code easily, or scan a dense troubleshooting paragraph while focus is unclear.

## Use the four-part pattern

1. **What happened:** “Episode details could not load.”
2. **What remains:** “Your current filters are unchanged,” only when verified.
3. **What to do:** “Retry” as the primary action and “Go back” as escape.
4. **Reference:** a short optional identifier for support, not the whole message.

Avoid “Something went wrong” when the failed object is known. Avoid “Check everything” when one specific action is available.

## Match the message to the state

Differentiate no results, unavailable media, verified network failure, invalid input, verified account state, unsupported action, and unknown failure. Do not label an empty filtered result as a server error. Use [the TV loading-state model](/blog/make-tv-loading-states-readable/) to decide when waiting has become failure.

## Make recovery actionable

The primary action should address the immediate state: Retry, Clear filters, Choose another version, Return to details, or Contact support. Use only actions supported by the current product.

W3C error-identification and error-suggestion guidance provides useful principles: identify the error and offer a known correction when possible. Do not guess a correction.

## Keep copy readable at distance

Use a short heading, one or two concise explanatory sentences, and labelled buttons. Place technical details behind an optional “More details” action only when that layer has remote-tested focus and Back behavior.

Do not use color alone for severity. Protect text contrast over artwork and keep focus unmistakable on the recovery control.

## Preserve viewer context

Keep the search query, filters, selected title, profile, and row position when safe and technically valid. After Retry succeeds, restore focus to the action or item that can continue the task. After Back, return one layer.

If a consequential recovery requires confirmation, apply [the TV confirmation-dialog pattern](/blog/design-tv-confirmation-dialogs/).

## Provide support evidence safely

A short reference code, local timestamp, visible product version, and action sequence can help support. Never display or request passwords, authentication secrets, payment data, or source credentials in an error message.

Link to the verified support route. Run the path through [remote D-pad QA](/blog/remote-dpad-navigation-qa/) so the error does not create a focus trap. Norva’s actual error taxonomy and recovery actions require current-build verification.

## Original evidence: recovery card

Take five existing non-sensitive error states and fill Failed Object, Message, Preserved State, Primary Action, Back Result, Focus Target, and Support Reference. Ask a second reviewer to explain the recovery without developer context.

The card measures message and interaction clarity for those states. It does not establish service reliability or guarantee that Retry succeeds.

## Common mistakes and limitations

Review each message in its real layout from normal viewing distance. Confirm that the headline, recovery action, and retained context remain understandable before exposing any optional diagnostic detail.

Repeat the review after changing language, connection state, and available recovery actions.

- Using the same generic error everywhere.
- Exposing raw internal detail as the headline.
- Offering an action that cannot resolve the state.
- Blaming the viewer.
- Losing filters and focus after recovery.
- Making a long support code the only explanation.
- Requesting secrets in diagnostic copy.

## Frequently asked questions

### Should every error include Retry?

No. Offer Retry only when repeating the operation is safe and can plausibly address the state.

### How technical should the message be?

The primary message should explain the viewer’s task. Put concise diagnostic detail in an optional, privacy-safe layer.

### What if the cause is unknown?

Say the task could not complete, preserve context, offer a safe next step, and provide a support reference without inventing a cause.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [W3C: Understanding Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html)
- [W3C: Understanding Error Suggestion](https://www.w3.org/WAI/WCAG22/Understanding/error-suggestion.html)
- [Android TV App Quality Guidelines](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [Norva Support](https://norva.tv/support)
