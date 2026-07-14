---
content_id: "NVB-298"
title: "What to Check After Switching Profiles in Continue Watching"
seo_title: "What to Check After Switching Profiles"
meta_description: "After switching profiles, verify the visible identity, one expected personal item, one expected absence, exact resume checkpoint, and safe return path before playback."
slug: "review-row-after-profile-switch"
canonical_url: "https://norva.tv/blog/review-row-after-profile-switch/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "checklist"
topic_cluster: "Continue Watching Hygiene"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "What should viewers check after switching profiles in Continue Watching?"
supporting_questions:
  - "How can the active profile be confirmed without relying on an avatar alone?"
  - "Which small sample is enough to detect a scope problem?"
audience:
  - "Households switching between viewing profiles"
  - "Norva users protecting personal progress state"
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
estimated_reading_minutes: 7
excerpt: "A five-point post-switch check that confirms profile identity and a small sample of expected resume state before the next person presses play."
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
parent_pillar: "/blog/continue-watching-hygiene-guide/"
related_articles:
  - "/blog/shared-profile-resume-clutter/"
  - "/blog/prepare-resume-row-for-shared-session/"
  - "/blog/resume-row-differs-between-screens/"
cta:
  label: "Learn About Norva Profiles"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "five-point profile-switch verification card"
  summary: "The card checks visible profile identity, expected inclusion, expected exclusion, known checkpoint, and return path using harmless reference items."
  methodology: "Each viewer preselects one non-sensitive reference item and one expected absence, switches profiles, verifies five points without playback, and records only pass, fail, or unknown."
  asset_urls: []
---

# What to Check After Switching Profiles in Continue Watching

> **In short:** Before pressing play, verify the profile name or label, one item that should belong to the new viewer, one item that should not, and the checkpoint of a known active title. Confirm that you can return to the previous profile. If any check is unknown or fails, stop playback and investigate scope rather than creating more mixed progress.

A profile switch is a boundary between viewers’ state. The safest verification is small: prove identity with known references instead of auditing the entire library every time.

## Prepare reference items in advance

Each profile owner selects:

- one non-sensitive title that should appear in Continue Watching;
- its expected episode or progress landmark;
- one harmless title that should be absent because it belongs to another profile;
- a neutral profile label that is easy to read.

Do not choose sensitive viewing history as a reference. The purpose is scope verification, not exposure of preferences.

## Run the five-point check

| Check | Pass condition |
|---|---|
| Visible identity | Name or label matches the intended profile |
| Expected inclusion | Known personal item is present or retrievable as currently designed |
| Expected exclusion | Other profile’s reference is not presented as personal state |
| Checkpoint | Known item shows the expected episode or progress context |
| Return path | Previous profile can be reached through the verified flow |

Mark Pass, Fail, or Unknown. An unknown is not a soft pass. W3C guidance on consistent identification and name, role, and value supports components whose identity and current state can be understood; the household card applies the same discipline.

## Do not rely on appearance alone

Avatars, colors, or row order can look similar. Read the text label and compare a known item. If the current interface does not expose enough identity information, do not create a new playback state merely to test it. Use one harmless sample only after confirming the action is reversible.

Norva publicly describes profile-based use and progress continuity across supported devices. Exact profile scope and current switch behavior must still be verified in the product. Plan capacity does not imply a device or simultaneous-session limit.

## Respond to each outcome

**All pass:** proceed with the intended viewer’s session. **Identity fails:** switch back and repeat through the normal route. **Expected inclusion fails:** verify version, source availability, and screen context. **Expected exclusion fails:** determine whether the profiles truly isolate that state. **Checkpoint fails:** compare the exact version and latest event before playing.

For suspected mixed ownership, use [the shared-profile clutter guide](/blog/shared-profile-resume-clutter/). If the mismatch exists only on one screen, run [the two-screen comparison](/blog/resume-row-differs-between-screens/) separately.

## Protect the profile you leave behind

At the end of a session, exit playback normally and inspect the new checkpoint before switching. Do not clear unfamiliar cards on behalf of the next viewer. For group viewing, apply [the shared-session handoff](/blog/prepare-resume-row-for-shared-session/) so everyone agrees which profile owns the progress.

If a switch yields a persistent unexpected row, capture the five-point card with timestamp and device category. Avoid screenshots containing unrelated account details.

## Original evidence: verification card

Pilot the five checks across two non-sensitive profiles. Record only Pass, Fail, or Unknown and the visible field supporting the result. Ask each owner to confirm their reference item after the test.

The card provides a reproducible boundary check without requiring broad access to a person’s history. It does not establish a universal profile model and should be rerun after meaningful interface or account changes.

## Common mistakes and limitations

- Trusting avatar color without reading the label.
- Using a sensitive title as the expected inclusion.
- Playing before checking the known checkpoint.
- Treating Unknown as Pass.
- Assuming every row difference proves a profile issue.
- Clearing cards during the switch test.
- Presenting profiles as parental controls.

Source availability can make a known item absent even when profile scope is correct. Check identity and current access before diagnosing.

## Frequently asked questions

### Must I check the whole row after every switch?

No. One expected inclusion, one exclusion, and one checkpoint provide a focused first check.

### What if both profiles show the same title?

Compare version and progress. Two viewers can independently watch the same work, so shared title identity alone is not a failure.

### Should I switch back immediately when a check fails?

Preserve the visible state first, then return through the verified flow without starting playback.

## Your next step

[Learn About Norva Profiles](https://norva.tv/#features)

## Sources

- [W3C: Understanding Consistent Identification](https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html)
- [W3C: Understanding Name, Role, Value](https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html)
- [Norva Features](https://norva.tv/#features)
