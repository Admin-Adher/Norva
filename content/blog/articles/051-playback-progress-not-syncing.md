---
content_id: "NVB-051"
title: "Playback Progress Not Syncing? A Step-by-Step Checklist"
seo_title: "Playback Progress Not Syncing: A Practical Checklist"
meta_description: "Use this ordered checklist to isolate profile, item, connection, and device causes when playback progress does not appear on another screen."
slug: "playback-progress-not-syncing"
canonical_url: "https://norva.tv/blog/playback-progress-not-syncing/"
language: "en"
status: "draft"
robots: "noindex,nofollow"

content_type: "troubleshooting"
topic_cluster: "Cross-Device & TV Experience"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "What should I check when playback progress is not syncing between devices?"
supporting_questions: ["How can I isolate the device causing the problem?", "When should I contact support?"]
audience: ["Norva users", "multi-device viewers"]

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
  source_of_truth: "https://norva.tv/#features"

published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 6

excerpt: "An ordered diagnostic for checking account, profile, item, connection, and device state when playback progress does not follow you to another screen."
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
parent_pillar: "/blog/playback-progress-sync-explained/"
related_articles: ["NVB-040", "NVB-041", "NVB-049"]

cta:
  label: "Open Norva Support"
  href: "https://norva.tv/support"
  intent: "Get help after completing the diagnostic"

sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
proof_assets: []

original_evidence:
  required: true
  status: "present"
  type: "reproducible diagnostic worksheet"
  summary: "A two-device isolation sequence that records profile, item, timestamp, and refresh results."
  methodology: "Source-backed troubleshooting framework; no device benchmark or first-hand product test was performed."
  asset_urls: []
---

# Playback Progress Not Syncing? A Step-by-Step Checklist

> **In short:** First confirm that both screens use the same account, profile, and exact catalog item. Then create a fresh progress point on one connected device, close playback normally, refresh the second device, and record what changes. This order separates a simple context mismatch from a connection, device, or account-level problem.

Norva is designed to keep playback progress attached to your account across supported devices. When a position appears on one screen but not another, changing several settings at once makes the cause harder to find. Use the sequence below from top to bottom and stop when the expected position appears.

For background on the feature itself, read [how playback progress sync works](https://norva.tv/blog/playback-progress-sync-explained/). If your goal is a normal handoff rather than a repair, use the [mobile-to-TV workflow](https://norva.tv/blog/start-mobile-finish-tv/) instead.

## Start with the three context checks

Most apparent sync failures are worth checking as context mismatches before treating them as technical faults.

1. **Confirm the account.** Check that both devices are signed in to the same Norva account.
2. **Confirm the profile.** In a shared household, make sure the same profile is active on both screens. Progress and preferences can be personal to a profile.
3. **Confirm the exact item and version.** Similar artwork or titles do not prove that two cards represent the same catalog entry or grouped version.

Write down the active profile and item on each device. If either differs, correct it and check again before continuing.

## Create one clean test point

Use a fresh, easy-to-recognise position rather than relying on an old memory of where playback stopped.

1. On device A, open the chosen item while connected to the network.
2. Play long enough to move clearly beyond the previous saved position.
3. Pause, then leave playback through the normal on-screen control.
4. Wait briefly for the interface to settle before opening the item on device B.
5. On device B, return to the relevant catalog view or reopen the item.

The observable result is simple: device B should offer or display the newer position for the same account, profile, and item. Do not delete application data, reinstall the app, or disconnect the account at this stage; those actions remove useful diagnostic context.

## Separate connection from device state

If the fresh position does not appear, check whether both devices can currently reach other account-backed information. For example, observe whether a newly changed favourite or preference appears elsewhere. Norva publicly documents synchronisation of progress, favourites, and preferences across supported devices, but this comparison is only a diagnostic clue; it does not prove that every sync category uses an identical path.

Next, reverse the direction:

- create a different progress point on device B;
- leave playback normally;
- refresh the corresponding item on device A;
- record whether the update travels in either direction.

If neither direction works, the issue may be account-wide, connectivity-related, or temporary. If only one direction fails, record the affected device, app surface, and direction. That detail is more useful to support than “sync is broken.”

## Use the progress isolation worksheet

This compact worksheet is the original evidence element for this guide. Copy it into a note and complete one row per attempt.

| Check | Device A | Device B | Result |
| --- | --- | --- | --- |
| Account identifier matches |  |  |  |
| Active profile matches |  |  |  |
| Exact catalog item matches |  |  |  |
| New position created | Timestamp: | Checked at: |  |
| A to B update |  |  | Pass / fail |
| B to A update |  |  | Pass / fail |

Also note the date, local time, device type, whether each device was online, and the visible position. This is a reproducible diagnostic record, not a performance test.

## Escalate with useful evidence

Contact support after the context checks and two-direction test if the problem persists. Include:

- the two device types;
- the affected profile, without sharing a password;
- the item title and version you selected;
- the direction that failed;
- the approximate time of each attempt;
- whether favourites or other preferences also appeared stale;
- any visible error message, copied exactly.

Avoid posting account credentials, source credentials, pairing codes, or private links in screenshots or public forums. The [Norva privacy page](https://norva.tv/privacy) describes the account and device information used to provide cross-device features.

## Common mistakes and limitations

- Testing with different household profiles can resemble a sync failure.
- Comparing two similarly named variants can produce different progress records.
- Force-closing immediately after seeking may not represent a normal playback exit.
- Reinstalling too early can erase local clues without addressing the underlying cause.
- A successful favourite update does not guarantee that every other category is healthy; it only narrows the investigation.
- Sync applies across supported devices and requires a usable connection for cloud-backed updates.

If favourites are the only inconsistent element, use the separate guide to [keep favourites consistent across screens](https://norva.tv/blog/sync-favorites-across-devices/).

## Frequently asked questions

### Should I sign out immediately when progress is stale?

No. First record the account, profile, item, and two-direction results. Signing out may help later if support recommends it, but doing it first removes evidence and can introduce another variable.

### Does a different progress point always mean sync failed?

Not necessarily. Verify the active profile and exact item or version first. A context mismatch can produce two valid but different positions.

### How long should I wait before contacting support?

Complete one controlled A-to-B test and one B-to-A test. If neither produces the expected result after both devices have been refreshed and confirmed online, send the worksheet details to support rather than repeating uncontrolled attempts.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva features and cross-screen experience](https://norva.tv/#features)
- [Norva Privacy Policy](https://norva.tv/privacy)
- [Norva Support](https://norva.tv/support)

