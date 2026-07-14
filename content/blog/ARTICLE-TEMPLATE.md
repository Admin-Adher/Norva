---
content_id: "NVB-000"
title: ""
seo_title: ""
meta_description: ""
slug: ""
canonical_url: ""
language: "en"
status: "draft"
robots: "noindex,nofollow"

content_type: ""
topic_cluster: ""
search_intent: "informational"
funnel_stage: "awareness"
primary_question: ""
supporting_questions: []
audience: []

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
  source_of_truth: ""

published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 0

excerpt: ""
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
parent_pillar: null
related_articles: []

cta:
  label: ""
  href: ""
  intent: ""

sources: []
proof_assets: []

original_evidence:
  required: true
  status: "missing"
  type: ""
  summary: ""
  methodology: ""
  asset_urls: []
---

<!--
PUBLICATION AND INDEXING BLOCKERS

- Keep status as "draft" or "in_review" and robots as "noindex,nofollow"
  until the article has passed human review and deployment QA.
- Do not publish without visible original evidence.
- Do not publish with unverified factual or product claims.
- Confirm that this article has a distinct primary question and intent.
- Confirm that restricted terminology is absent.
- Replace every placeholder and remove all editorial comments before publication.
-->

<!--
H1 RENDERING RULE

Use exactly one H1 on the rendered page. If the CMS automatically turns the
front matter title into an H1, remove the Markdown H1 below.
-->

# {{ title }}

> **In short:** Write a direct, self-contained answer to the primary question in approximately 40-70 words.

Write a concise introduction that identifies the reader's situation, desired outcome, and what this article will help them accomplish. Address the main intent immediately; do not use a generic or suspenseful opening.

<!-- Optional table of contents for longer articles. Use crawlable anchor links. -->

## {{ First topic-specific heading }}

Answer the most important part of the question. Include specific, verifiable details and link factual claims to primary sources where appropriate.

### {{ Supporting detail when needed }}

Add a concrete example, test result, screenshot, workflow, checklist, or other useful evidence.

## {{ Second topic-specific heading }}

Continue with the structure appropriate to the article type. Do not reuse a generic heading sequence solely for consistency.

## Original evidence

<!--
This section is mandatory. Replace it with visible evidence that adds value,
such as a first-hand test, annotated screenshot, reproducible checklist,
original measurement, expert review, or documented workflow. A decorative
image is not sufficient. Keep the front matter original_evidence fields in sync.
-->

Explain what was tested, observed, created, or reviewed, how it was produced, and what the reader can reasonably conclude from it.

## Common mistakes and limitations

Describe relevant edge cases, trade-offs, unsupported situations, or reasons the guidance might not apply. Avoid universal claims.

## Frequently asked questions

<!--
Keep only genuine follow-up questions. Two to five questions are normally
enough. Remove the entire section when it would only repeat the article.
FAQ schema remains disabled by default.
-->

### {{ Genuine follow-up question? }}

Give a concise, complete answer without repeating the primary answer or forcing query phrases.

### {{ Another genuine follow-up question? }}

Give a concise, complete answer.

## Your next step

<!-- Use one CTA aligned with the funnel stage and a verified destination. -->

[{{ cta.label }}]({{ cta.href }})

## Sources

<!--
List primary and authoritative sources used for factual claims. Keep this
visible list aligned with the front matter sources field.
-->

- [Source title](https://example.com/primary-source)

<!--
HUMAN REVIEW SIGN-OFF

Before publication, the named reviewer must confirm:
- the primary question is answered;
- original evidence exists and supports the conclusion;
- facts and product claims are verified;
- the article is original and useful;
- restricted terminology is absent;
- limitations are disclosed;
- metadata, links, CTA, canonical URL, dates, and schema are accurate;
- status and robots directives agree.

Record the reviewer, date, decision, and notes in front matter.
-->
