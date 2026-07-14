---
content_id: "NVB-494"
title: "What to Check When an Audio Preference Does Not Persist"
seo_title: "What to Check When an Audio Preference Will Not Persist"
meta_description: "Diagnose an audio preference that does not persist by checking scope, track availability, media identity, resume route, device, shared profile, and offline state."
slug: "what-to-check-when-an-audio-preference-does-not-persist"
canonical_url: "https://norva.tv/blog/what-to-check-when-an-audio-preference-does-not-persist/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting-guide"
topic_cluster: "Audio Track Management"
search_intent: "audio preference persistence diagnostic"
funnel_stage: "retention"
primary_question: "What should a viewer check when an audio preference does not persist?"
supporting_questions:
  - "Which preference scope and media identity should be verified?"
  - "How can shared-profile, device, resume, and offline factors be isolated?"
audience:
  - "Viewers repeatedly selecting the same audio track"
  - "People diagnosing audio defaults"
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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/#how-it-works; https://norva.tv/privacy; https://norva.tv/terms; https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 6
excerpt: "A scope-first diagnostic for audio choices that appear to reset across titles, episodes, versions, resumes, devices, profiles, or offline playback."
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
parent_pillar: "/blog/the-complete-guide-to-managing-audio-tracks/"
related_articles:
  - "/blog/account-preference-or-title-specific-choice-which-should-win/"
  - "/blog/why-the-default-audio-track-can-change-between-episodes/"
  - "/blog/how-to-recheck-audio-after-resuming-playback/"
cta:
  label: "Contact Norva Support With a Controlled Test"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "audio preference scope matrix"
  summary: "A matrix tests whether a deliberate selection persists within the same title, after resume, across episodes, versions, devices, shared profiles, and eligible offline copies."
  methodology: "The viewer establishes one unambiguous track, tests the same-context reopen first, then adds one scope at a time and distinguishes unavailable tracks from failed selection persistence."
  asset_urls: []
---
# What to Check When an Audio Preference Does Not Persist

> **In short:** First define what was expected to persist: an account preference, profile default, title choice, episode choice, or current-session selection. Confirm that the same audio track exists in the next context, then test same-title reopen, resume, episode, version, device, shared-profile, and offline boundaries one at a time. Do not assume a universal persistence rule.

“My preference reset” can describe several different outcomes. The target track may be unavailable, the media identity may have changed, another person may have used a shared context, or the choice may have had a narrower scope than expected.

## Define the selected track and scope

Record the exact visible label and verify its language or role with playback. Then state the expected scope:

- current session;
- same title after reopen;
- resume of the same item;
- next episode;
- another media version;
- another supported device;
- personal or shared profile;
- eligible offline copy.

Do not call a broad account preference and a one-title selection the same setting.

## Confirm availability before persistence

Open the destination context and inspect the complete audio list. If the target entry is absent, the immediate issue is availability or identity, not selection persistence.

A same-language entry may not be equivalent. Compare role, custom title, channels, and sampled behavior.

## Test the narrowest scope first

Choose an unambiguous track, play a dialogue sample, leave normally, and reopen the same title/version on the same device and profile. Record the selected marker before correcting it.

If that succeeds, add one boundary: resume, adjacent episode, version, or device. The guide on [account preference versus title choice](/blog/account-preference-or-title-specific-choice-which-should-win/) helps separate desired policy from actual behavior.

## Original evidence: scope matrix

| Boundary | Target available? | Starts selected? | Heard result | Repeatable? |
|---|---|---|---|---|
| Same-title reopen | Yes/no | Exact label | Verified | Yes/no |
| Resume | Yes/no | Exact label | Verified | Yes/no |
| Next episode | Yes/no | Exact label | Verified | Yes/no |
| Other version | Yes/no | Exact label | Verified | Yes/no |
| Other device | Yes/no | Exact label | Verified | Yes/no |
| Offline context | Yes/no | Exact label | Verified | Yes/no |

Test only the rows relevant to the viewer. “Not tested” is a valid result.

## Check episode and resume boundaries

For an episode-specific change, follow [the default-between-episodes workflow](/blog/why-the-default-audio-track-can-change-between-episodes/). Track identities may differ even when labels look similar.

For a resume-specific change, use [the audio-after-resume card](/blog/how-to-recheck-audio-after-resuming-playback/) and record the exact exit and return routes.

## Check shared profiles and devices

Ask whether another authorised viewer intentionally changed audio in the shared context. Do not inspect private history or treat a profile as a password. Agree a session-start recheck when preferences differ.

On another device, confirm the same item and version. Correct progress does not prove that audio choices follow the same mechanism.

## Check offline context

Confirm that the eligible local item corresponds to the intended version and that the target entry appears in its selector. Do not assume the local and connected lists are identical. Avoid deleting the local copy until evidence is captured and the owner decides whether recreation is appropriate.

## Prepare a controlled report

Include the exact preference or selection, expected scope, context matrix, steps, local time zone, expected result, observed result, and privacy-safe screenshots. Report the narrowest repeatable boundary.

Do not clear data, reinstall, remove sources, reset devices, or change credentials to force persistence.

## Common mistakes and limitations

Avoid testing an ambiguous track, overlooking version changes, assuming availability equals persistence, and using a shared profile without checking current context.

Exact preference precedence and persistence should be verified against current product behavior and official support information.

## Frequently asked questions

### Does a profile preference apply to every title?

Do not assume universal scope. A title must contain a compatible track, and current behavior should be tested.

### Why does the next episode use another label?

Its track identity or metadata may differ. Compare the two complete lists before diagnosing persistence.

### Should I reset settings?

No. Preserve the controlled test and use official support before disruptive changes.

## Your next step

[Contact Norva Support with a controlled test](https://norva.tv/support)

## Sources

- [Norva Support](https://norva.tv/support)
- [Norva Features](https://norva.tv/#features)
- [Norva: How It Works](https://norva.tv/#how-it-works)
