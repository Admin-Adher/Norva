# Norva Blog — content source & auto-publishing pipeline

This folder is the **source of truth** for the Norva blog. Static pages under
`public/blog/` are generated from it; do not hand-edit the generated HTML.

## Layout

| Path | Role |
| --- | --- |
| `articles/NNN-*.md` | 1,000 Markdown drafts (front matter + body). `NNN` is the content id. |
| `publication-calendar.csv` | The schedule: sequence, `scheduled_publish_at`, content id, slug, per article. |
| `published-state.json` | Generated. Records each published article's real first-publication instant so dates never drift or get back-dated. |
| `content-plan.csv` | Search intent / cluster / funnel mapping (reference). |
| `EDITORIAL-GUIDE.md`, `FACT-CHECK-GUIDE.md`, `ARTICLE-TEMPLATE.md`, `README.source.md` | Original editorial handoff docs (reference). |

## How publishing works

`scripts/blog/build-blog.js`:

1. Reads the calendar and the persisted state.
2. Marks an article **live** when its `scheduled_publish_at` has passed. A floor
   of `BLOG_MIN_PUBLISHED` (default **4**) is always live — that is how the first
   batch goes out for testing before the calendar catches up.
3. Renders each live article to `public/blog/<slug>/index.html`, rebuilds
   `public/blog/index.html` and `public/sitemap-blog.xml`, and records the first
   publication instant in `published-state.json`.
4. Never un-publishes and never rewrites article prose. Internal `/blog/…` links
   whose target is not yet live are shown as plain text, and related-article
   cards only surface published articles.

The build is **idempotent**: a run with no newly-due article changes nothing.

### Run it locally

```bash
npm run blog:validate     # render all 1,000 drafts and report any problem
npm run blog:build        # publish due articles into public/blog/
npm run blog:build -- --dry-run   # show what would be live, write nothing
BLOG_MIN_PUBLISHED=10 npm run blog:build   # raise/lower the live floor
```

### Automation

`.github/workflows/blog-autopublish.yml` runs on a schedule (shortly after the
06:00 and 20:00 `Europe/Paris` slots, in both DST offsets), rebuilds the blog,
commits any newly published pages to `main`, and deploys `public/` to Cloudflare
Pages. It activates once the workflow file is on `main`, and needs the workflow
to be allowed to push to `main` (branch protection) plus the `Cloudflare`
environment secrets already used by `deploy-cloudflare.yml`.

## Before scaling beyond the test batch

The drafts ship with `status: draft`, `robots: noindex,nofollow`, and
`product_claims.verified: false`, and the editorial guide asks for human review
and original proof (a screenshot, a tested workflow, a measured result) before
each article is indexed. The builder publishes with `robots: index,follow` so
the test batch is genuinely live; set `BLOG_ROBOTS=noindex,nofollow` (or add a
front-matter review gate) if you want to keep articles out of the index until a
reviewer signs off.
