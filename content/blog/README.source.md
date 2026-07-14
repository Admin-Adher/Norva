# Norva Blog — 1,000-Article Editorial Library

This folder contains an English-language, CMS-neutral editorial library for the Norva blog.

## Important publishing rule

The 1,000 articles are drafts, not permission to publish unchecked pages. Publish each article only after a human review, a product fact check, and the addition of at least one original proof element such as a tested workflow, a Norva screenshot, a measured result, or a first-hand example.

The planning calendar starts on 14 July 2026 and reserves two reviewable slots per day at `06:00` and `20:00` in `Europe/Paris`. A slot is not a publication instruction. If its article is not approved and technically ready, leave the slot empty, choose a new future slot, and record the actual first-publication time; never backdate a missed release.

## Folder contents

- `articles/`: 1,000 Markdown drafts.
- `content-plan.csv`: search intent, cluster, funnel stage, and pillar mapping.
- `publication-calendar.csv`: 500-day schedule with two daily time slots.
- `EDITORIAL-GUIDE.md`: writing, quality, linking, and publication standards.
- `ARTICLE-TEMPLATE.md`: reusable CMS-neutral article template.
- `FACT-CHECK-GUIDE.md`: approved product claims, caution areas, and source rules.
- `SCALED-CONTENT-GUARDRAILS.md`: mandatory quality gates for a large editorial corpus.
- `internal-link-map.csv`: every contextual body link between planned blog articles and its target status.
- `build-published-sitemap.ps1`: generates a blog sitemap from approved, indexable articles only.
- `validate-corpus.ps1`: validates the draft handoff baseline, calendar, metadata, links, sources, encoding, and safety defaults.
- `build-qa-report.ps1`: regenerates the inventory files and `QA-REPORT.md` from the current drafts.
- `QA-REPORT.md`: generated corpus checks and remaining human-review requirements.
- `FINAL-HANDOFF.md`: delivery status, operational blockers, and safe CMS transition.
- `BODY-SIMILARITY-QA.md`: full-body duplicate review and the completed NVB-520 differentiation.
- `FACTUAL-RISK-QA.md`: final factual-risk review and mandatory human verification areas.
- `SOURCE-LINK-QA.md`: the dated source-link snapshot and repaired retired URLs.
- `source-url-inventory.csv`: every cited source and the articles that use it.
- `source-url-live-check.csv`: the latest recorded HTTP response snapshot for cited sources.
- `check-source-urls.mjs`: repeatable live source checker for Node.js 18 or later.
- `TOPIC-PLAN-QA.md`: plan uniqueness and similarity-review evidence.
- `FIRST-DAY-PUBLISHING.md`: the two assignments and approval checklist for 14 July 2026.

## Draft safety defaults

Every article starts with:

```yaml
status: "draft"
robots: "noindex,nofollow"
product_claims:
  verified: false
```

Change these values only after editorial and product review. Add the real author, reviewer, publication dates, original images, and proof assets before publishing.

## SEO approach

The collection is designed around one primary intent per URL, distinct titles and descriptions, topical clusters, descriptive internal links, visible authorship, and useful answers written for people first.

There is no guaranteed ranking outcome. Search visibility depends on content quality, original evidence, technical implementation, competition, site authority, crawlability, and ongoing measurement.

## Deployment checklist

1. Build a real `/blog/` index and `/blog/{slug}/` article route. At the 14 July 2026 deployment review, the public blog paths still returned a homepage fallback rather than article documents.
2. Render one visible `h1` per article.
3. Generate canonical URLs and `BlogPosting` structured data from the front matter.
4. Add an author page with a real byline and review ownership.
5. Add original, crawlable article images with useful alt text.
6. Use the calendar only for reviewed pages and add only published canonical URLs to the sitemap.
7. Add links to each new article from its pillar and at least two relevant existing pages.
8. Inspect the deployed URL in Google Search Console and Bing Webmaster Tools.
9. Measure impressions, clicks, click-through rate, engagement, assisted registrations, and factual support requests.
