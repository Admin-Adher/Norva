# Norva Blog Editorial Guide and Publishing Standard

## Purpose

This guide defines the production, review, publication, and maintenance rules for a 1,000-article English-language Norva blog collection.

The objective is to publish useful, original, verifiable content for real readers. Search visibility is an outcome of content quality, technical accessibility, and sustained usefulness; it is never guaranteed.

The 1,000 planned articles are an editorial pipeline, not a bulk-publishing operation. No article may be published simply because a calendar slot exists.

## Non-negotiable publication gates

Every article must:

- answer one distinct reader question or need;
- add an original contribution such as a test, screenshot, workflow, checklist, dataset, template, or expert analysis;
- be reviewed by an identified human before publication;
- have every factual and product claim verified against a primary source;
- use calm, precise English without keyword stuffing or exaggerated claims;
- pass the anti-duplication check in this guide;
- remain `noindex,nofollow` while its status is `draft` or `in_review`;
- have a correct canonical URL before it becomes indexable;
- avoid restricted terminology defined by the Norva legal and brand policy.

If any gate fails, publication is blocked.

## Editorial portfolio

### Editorial archetypes

The library combines pillar guides, practical how-to guides, troubleshooting articles, educational explainers, decision frameworks, accessibility guidance, privacy guidance, and carefully qualified product education. Article length is determined by the reader's intent rather than by a ranking target; the automated corpus gate requires at least 700 useful body words, while human reviewers must remove padding and may approve a shorter answer when brevity genuinely serves the query better.

### Topic distribution

`content-plan.csv` is the source of truth for the 1,000 unique URLs, their clusters, primary intents, funnel stages, pillars, and publication order. `TOPIC-PLAN-QA.md` records the uniqueness and near-duplicate review. Counts must be regenerated from the plan whenever the portfolio changes rather than copied into this guide.

Each brief receives exactly one primary topic cluster, one primary question, one search intent, and one funnel stage. Similar topics must differ by audience, task, device, symptom, decision, or stage of the workflow; wording alone is not sufficient differentiation.

## Voice and language

- Language: English, with one consistent spelling convention across the collection.
- Tone: clear, composed, practical, modern, and respectful.
- Lead with the answer or outcome rather than a long introduction.
- Prefer concrete verbs and observable results.
- Explain technical language at first use.
- Avoid hype, fear, vague superlatives, and universal claims.
- Never imply that a feature, store listing, device, integration, price, or policy exists unless it has been verified.
- State limitations and trade-offs when they matter.
- Write for the reader first; never distort sentences to repeat a query phrase.

## CMS-neutral metadata

All articles use the front matter defined in `ARTICLE-TEMPLATE.md`.

Important state rules:

| Status | Robots value | Eligible for publication |
| --- | --- | --- |
| `draft` | `noindex,nofollow` | No |
| `in_review` | `noindex,nofollow` | No |
| `approved` | `noindex,nofollow` | Not until deployment checks pass |
| `published` | `index,follow` | Yes |
| `archived` | Determined by redirect or removal plan | No |

Never switch `robots` to `index,follow` without all of the following:

- `status: published`;
- completed human review;
- verified product claims;
- a populated canonical URL;
- valid publication date;
- completed original-evidence field;
- internal links and structured data checked.

Do not add a meta-keywords field. The internal `primary_question` and `supporting_questions` fields are editorial planning fields and must not be used for repetitive phrasing.

## Required article anatomy

The renderer must output exactly one `h1`. If the CMS generates the `h1` from `title`, omit the Markdown `#` heading in the body.

Every article contains:

1. A descriptive title.
2. A direct-answer summary near the top.
3. A short introduction identifying the reader's situation and outcome.
4. A topic-specific body using a logical `h2` and `h3` hierarchy.
5. At least one original evidence element.
6. Relevant limitations, edge cases, or common mistakes.
7. A FAQ only when genuine follow-up questions exist.
8. One contextual primary CTA.
9. Sources for factual claims.

Headings must describe the actual information that follows. Do not reuse the same heading sequence across the full collection.

## Structures by article type

### Pillar guide

- Direct answer
- Scope and definitions
- Decision framework
- Three to six topic sections
- Practical workflow
- Examples or original evidence
- Limitations
- Frequently asked questions
- Next step

Typical structure: five to eight `h2` headings, with `h3` headings only when they make scanning easier.

### Practical how-to

- Expected outcome
- Before you begin
- Numbered workflow
- How to verify success
- Troubleshooting
- Frequently asked questions
- Next step

Every step must contain an action and an observable result.

### Troubleshooting article

- Symptom
- Fast diagnostic
- Probable causes ordered by likelihood
- Fixes
- How to confirm resolution
- When to escalate
- Prevention
- Frequently asked questions

Do not imply certainty when the diagnosis is conditional.

### Decision or comparison guide

- Short recommendation by use case
- Evaluation criteria
- Neutral comparison table
- Trade-offs
- Recommendations by scenario
- Limitations
- Frequently asked questions
- Next step

Do not declare one choice universally best. Every comparison criterion must be relevant and verifiable.

### Educational explainer

- Plain-English definition
- Why it matters
- How it works
- Concrete example
- Misconceptions
- Practical takeaway
- Frequently asked questions

### Case study or original research

- Initial situation
- Method
- Evidence
- Results
- Interpretation
- Limitations
- Reproducible takeaways
- Sources

The method and limitations must be explicit enough for a reader to judge the evidence.

### Product education or update

- What changed
- Who benefits
- How to use it
- Availability and limitations
- Verified screenshots or test evidence
- Related documentation
- Next step

Release information must be checked immediately before publication.

## FAQ policy

- Include two to five questions only when readers genuinely need the answers.
- Keep every answer self-contained, direct, and non-repetitive.
- Do not restate the article merely to lengthen the page.
- Keep the FAQ visible in the article body.
- Default `faq_schema.enabled` to `false`.
- Do not treat FAQ structured data as a traffic tactic or promise a rich result.

## CTA policy

Use one primary CTA per article and align it with the reader's stage.

| Funnel stage | Objective | Example |
| --- | --- | --- |
| Awareness | Continue learning | `Explore the complete guide` |
| Consideration | Understand the experience | `See how Norva works across your devices` |
| Decision | Begin the verified signup path | `Review current Norva plans` |
| Existing user | Apply the advice | `Open Norva and try these steps` |

Rules:

- answer the main question before presenting a commercial CTA;
- use only an approved, verified destination;
- do not repeat the same CTA wording across all articles;
- do not insert multiple competing conversion actions;
- never attach an unsupported promise to a CTA.

## Internal-linking rules

Each non-pillar article should normally contain:

- one contextual link to its parent pillar;
- two links to genuinely complementary articles;
- one relevant product or support link;
- an external primary source when a factual claim requires it.

When publishing a new article:

1. Add it to its parent pillar.
2. Add at least two contextual inbound links from existing articles.
3. Confirm that it is not orphaned.
4. Use descriptive anchor text that explains the destination.
5. Keep the editorial target within three clicks of the blog hub.
6. Record the relationships in the front matter.

Technical rules:

- render internal links as crawlable `<a href>` elements;
- avoid generic anchors such as `click here`;
- vary anchors naturally rather than repeating an exact phrase;
- do not link repeatedly to the same destination in one body without a user need;
- avoid large unrelated link blocks;
- audit broken links, redirects, and orphan pages quarterly.

## Anti-duplication and cannibalisation rules

Maintain a topic map containing every article's ID, primary question, reader, intent, direct answer, parent pillar, and canonical URL.

Before drafting:

- compare the proposed primary question with every existing brief;
- identify the reader's distinct situation and desired outcome;
- define the article's unique evidence before writing;
- confirm that the page serves a meaningfully different intent.

Merge or cancel a proposed article when it gives the same direct answer as an existing page and shares three or more fundamental sections.

Do not:

- create variants where only a device, language, year, or adjective changes;
- paraphrase a third-party article without substantial original value;
- reuse the same introduction, FAQ, examples, or conclusion;
- generate titles where only one query phrase changes;
- publish unreviewed automated output;
- update dates without a material content change;
- create multiple URLs for one canonical answer.

When two published pages begin serving the same intent, select the stronger canonical resource, merge useful material, update internal links, and apply the appropriate redirect plan.

## Original evidence policy

At least one evidence type is mandatory:

- first-hand product test;
- original screenshot or annotated workflow;
- reproducible checklist or template;
- original dataset or measurement;
- expert interview or named review;
- documented before-and-after result;
- source-backed analysis that adds a new decision framework.

Record the evidence in front matter and explain it in the visible article. A decorative image does not count as original evidence.

## Human review policy

The reviewer must verify:

- the article answers its declared primary question;
- the evidence exists and supports the conclusion;
- factual claims match primary sources;
- Norva product claims match the current product;
- the writing is original and useful;
- restricted terminology is absent;
- links, CTA, metadata, and canonical URL are correct;
- limitations are disclosed;
- publication state and robots directives agree.

The reviewer records their name, role, date, decision, and notes in front matter. `approved` is not a substitute for `published`; deployment checks still apply.

## Quality checklist

### Editorial blockers

- [ ] The intent is distinct from the other planned articles.
- [ ] Original value is identifiable and visible.
- [ ] Every fact and claim has been verified.
- [ ] Product claims have an approved source of truth.
- [ ] A named human has reviewed the article.
- [ ] The article contains no restricted terminology.
- [ ] The copy is not scraped, spun, or lightly rewritten.
- [ ] There is no keyword stuffing.
- [ ] The canonical URL is correct.
- [ ] Non-published content remains `noindex,nofollow`.

### Content quality

- [ ] The direct answer appears near the top.
- [ ] The title is descriptive, unique, and non-sensational.
- [ ] There is exactly one `h1` in the rendered page.
- [ ] The `h2` and `h3` hierarchy is logical.
- [ ] No paragraph exists only to increase length.
- [ ] Examples, evidence, limitations, and edge cases are present.
- [ ] FAQ questions are genuine and non-redundant.
- [ ] The CTA matches the reader's stage.
- [ ] English usage is consistent.
- [ ] Grammar and style have been proofread.

### Search and technical quality

- [ ] `seo_title` is unique and concise.
- [ ] `meta_description` accurately summarises this page.
- [ ] The slug is readable and stable.
- [ ] Internal links are crawlable and contextual.
- [ ] At least two useful inbound links are planned.
- [ ] There are no broken links.
- [ ] Images are relevant, compressed, and dimensioned.
- [ ] Alternative text describes informative images.
- [ ] `BlogPosting` or `Article` structured data matches visible content.
- [ ] Author information links to a real profile.
- [ ] Dates are accurate.
- [ ] Structured data validation passes.
- [ ] URL inspection passes.
- [ ] The sitemap contains the canonical URL after publication.

### Page experience

- [ ] The full article is usable on mobile.
- [ ] The table of contents is accessible when present.
- [ ] No interstitial blocks the main answer.
- [ ] Images reserve their display dimensions.
- [ ] Field performance targets are monitored: LCP below 2.5 seconds, INP below 200 milliseconds, and CLS below 0.1.

## Publication calendar

The planning calendar reserves up to two **approved** articles per day at 06:00 and 20:00 in `Europe/Paris`, from 14 July 2026 through 25 November 2027. A calendar slot never overrides the review and evidence gates. Missed slots expire: reschedule the article and store its actual first-publication instant rather than backdating it.

| Period | Maximum volume | Editorial priority |
| --- | ---: | --- |
| Days 1-30 | 60 | Foundational pillars, entry guides, and verified setup help |
| Days 31-120 | 180 | Discovery, organisation, cross-device, and accessibility workflows |
| Days 121-300 | 360 | Troubleshooting, performance, privacy, and household topics |
| Days 301-500 | 400 | Long-tail questions, maintenance, evaluation, and validated gaps |
| **Total** | **1,000** | Subject to approval before each slot |

Planned daily rhythm:

- 06:00: evergreen guide, explainer, pillar, or awareness article;
- 20:00: how-to, troubleshooting, comparison, or retention article;
- rotate clusters throughout the queue instead of publishing one entire cluster consecutively;
- leave a slot empty when its assigned article has not passed human review.
- Friday: link, indexation, and reader-feedback QA.

After each group of ten articles, run a formal quality gate. From week 12 onward, use Search Console and Bing Webmaster Tools evidence to refine future briefs. Do not delete or rewrite a new article solely because it does not receive immediate search traffic.

## Publication and maintenance workflow

1. Approve the brief and confirm its unique intent.
2. Define the original evidence before drafting.
3. Draft with `status: draft` and `robots: noindex,nofollow`.
4. Verify facts, sources, screenshots, and product claims.
5. Complete human editorial review.
6. Validate metadata, links, canonical URL, and structured data.
7. Mark the release candidate `approved` while retaining `noindex,nofollow`, then validate it through a protected preview that renders the final document.
8. Select a future slot. If the planned slot has passed, reschedule it; do not reuse the missed instant as `published_at`.
9. Deploy the approved document with `status: published`, `robots: index,follow`, and the actual first-publication instant as one release operation.
10. Re-fetch the public URL and verify the intended title, H1, body, canonical, robots directive, and structured data. Roll back to a non-indexable state if the document or route is wrong.
11. Add the verified live canonical URL to the sitemap and add contextual links from existing live pages.
12. Notify supported search services of the new or substantively updated URL, then monitor indexation, impressions, clicks, query coverage, engagement, and assisted conversions.

Review evergreen pages at least every six months and time-sensitive product pages whenever the underlying product changes. Do not change the displayed update date unless the visible article has materially changed.

## Official reference baseline

Editorial and implementation decisions should be checked against current primary documentation before major publishing batches:

- [Google: Creating helpful, reliable, people-first content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
- [Google: Spam policies for web search](https://developers.google.com/search/docs/essentials/spam-policies)
- [Google: Title link best practices](https://developers.google.com/search/docs/appearance/title-link)
- [Google: Snippet and meta-description guidance](https://developers.google.com/search/docs/appearance/snippet)
- [Google: Link best practices](https://developers.google.com/search/docs/crawling-indexing/links-crawlable)
- [Google: Article structured data](https://developers.google.com/search/docs/appearance/structured-data/article)
- [Google: Build and submit a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Google: Core Web Vitals](https://developers.google.com/search/docs/appearance/core-web-vitals)
- [Bing Webmaster Guidelines](https://www.bing.com/webmasters/help/webmaster-guidelines-30fba23a)
- [Bing: IndexNow](https://www.bing.com/webmasters/help/indexnow-0z209wby)
