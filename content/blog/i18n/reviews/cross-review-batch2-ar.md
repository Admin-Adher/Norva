# Second batch — independent Arabic translation review

Date: 11 September 2026. Reviewer: `/root/blog_latin_translations`.
Author and first reviewer: `/root/blog_indic_arabic_translations`.

**Final: ten translations completely reviewed, all corrections resolved and
verified. Accepted for the release-review gate at the fingerprints below.**

This is AI-assisted independent review under the owner's explicit agent-review
exception, not a human review or native-speaker certification. The reviewer did
not author the Arabic translations and has not edited their content. Findings are
sent to the author, corrected by the author, and independently checked in context.

## Scope and method

The ten frozen English sources and all ten Arabic translations were read
completely, including frontmatter, H1,
every section, original example, table, list, FAQ, CTA, link text, and the image
alternative text and caption in 161. The corrected paragraphs were reread against
their English source. Review addresses meaning, completeness, idiomatic clarity,
numerical fidelity, product qualifications and evidence boundaries, not merely
structural similarity.

Sources are the ten exact files in the source-fingerprint table below, under
`content/blog/articles/`. The exact Arabic files read are:

```text
content/blog/translations/ar/028-organize-seasons-episodes.md
content/blog/translations/ar/161-personal-media-search-guide.md
content/blog/translations/ar/422-handoff-mirroring-or-casting-know-which-workflow-you-need.md
content/blog/translations/ar/442-separate-profiles-or-one-shared-profile-a-decision-framework.md
content/blog/translations/ar/502-built-in-and-separate-subtitle-tracks-what-viewers-need-to-know.md
content/blog/translations/ar/561-the-complete-guide-to-understanding-video-quality.md
content/blog/translations/ar/582-volume-and-loudness-why-they-are-not-identical.md
content/blog/translations/ar/602-bandwidth-throughput-latency-and-jitter-explained.md
content/blog/translations/ar/662-cold-start-or-warm-start-measure-the-right-tv-launch.md
content/blog/translations/ar/721-offline-storage-management-handbook.md
```

The complete i18n README, editorial guide, fact-check guide and product-evidence
record were consulted. This review follows the batch-specific agent-review
exception without inventing human approval or widening the product evidence.
The Arabic UI dictionary was read to check exact sources/next-step labels; it is
not edited or newly certified by this article review.

## Corrections requested and verified

| Article | Finding | Author correction independently verified |
|---|---|---|
| 028 | Literal partial opening was unnatural for an episode with unfinished viewing progress. | `لكل حلقة بدأت مشاهدتها ولم تُكملها` preserves the partial-viewing meaning. |
| 442 | The SEO title's `ملفات وسائط` meant media files rather than viewing profiles; isolated metadata needed the same distinction. | SEO title, meta description and excerpt explicitly use `ملفات شخصية`. |
| 442 | The scorecard's “almost all” joint viewing had become roughly “most cases.” | The question now reads `هل تتم كل المشاهدة تقريبًا معًا؟`. |
| 502 | The object of switching off in row B was an ambiguous pronoun. | `إيقاف ذلك المسار` explicitly disables the subtitle track, matching row A and the source. |
| 561 | Personal ownership could grammatically attach to the harbour rather than the video clip. | `تخيّل أنك تملك مقطع فيديو خياليًا يصوّر مرفأً.` makes the owned item unambiguous. |
| 561 | A literal verb for “certify the network” was awkward. | `ولا تكفيان لإثبات سلامة الشبكة` clearly preserves that two brief replays cannot establish network health. |
| 721 | Finished viewing and completed downloading needed to remain explicit in isolated metadata and the FAQ. | Metadata/removal advice use `انتهيت من مشاهدتها`; the completed-download FAQ uses `اكتمل تنزيلها للاستخدام دون اتصال`. |
| 721 | The Arabic offloading expression could be confused with cancelling a download. | The original term `(Offload)` is retained beside the Arabic explanation; offloading remains distinct from deleting the app. |

No further substantive correction was needed in 161, 422, 582, 602 or 662 after
full independent reading of their author-frozen versions.

## Content and evidence checks

- **028:** the six-record example retains the three numbered episodes, unresolved
  special, alternative version and separate same-name series. Localized fictional
  names remain consistent. It claims neither a performed merge nor supported
  manual renumbering. Availability and watched/unwatched progress remain separate.
- **161:** query words and invented English titles preserve the zero/two/one-result
  exercise and its assumptions. The real English filter image is reused unchanged;
  translated caption and prose retain the observed-facet-count limitation, twelve
  versions versus distinct films, and unverified playback/native-client boundaries.
  Exact UI labels needed to match that image remain English in explanatory Arabic.
- **422:** the source device and the authorized media source are distinct. Handoff,
  screen mirroring and sender/receiver casting keep their different dependencies.
  Published Google Cast availability is not converted into a tested receiver or
  compatibility guarantee. The three scenarios remain fictional and incomplete
  checks are not presented as successful tests.
- **442:** the Alex/Sam example retains episode 3 versus 7, weekly joint film,
  personal favorites and conditional French/English subtitle preferences. Two
  personal contexts are an illustrative decision, not mandatory profile capacity.
  No security, parental-control, migration or simultaneous-use right is promised.
- **502:** embedded, external, image-based and burned-in subtitle distinctions are
  maintained. The four rows, `00:18` cue and unknown origin in row D remain intact.
  Control behavior alone does not establish storage. MKV, WebVTT and other format
  references do not imply arbitrary Norva import or universal playback support.
- **561:** both `1920 × 1080` versions and the `00:42–00:52` scene retain the fixed
  factors, separate image defects and narrow conclusions. Source-camera and
  encoder information remain unknown. The Media Capabilities reference remains a
  working draft, not a product-compatibility certificate.
- **582:** both gain calculations and the threefold sample-peak ratio are correct.
  They do not establish perceived loudness, LUFS, acoustic exposure or a safe
  headphone setting. Timing landmarks, low-level comparison, stop condition,
  standards limits and qualified WHO guidance remain faithful to the source.
- **602:** all individual throughput results, medians, ranges, durations, delay and
  jitter values retain their units and method context. Quiet/busy windows do not
  infer user counts. The text distinguishes one-way and round-trip delay, loss and
  variation, and rejects a universal jitter threshold or a single-test diagnosis.
- **662:** all four launch rows and twelve timing values are preserved, including
  the `4.4–4.6` versus `1.2–1.4` second ranges. Home/Back do not establish internal
  warm/hot process state. First frame, usable navigation and artwork are separate;
  manual timing is not TTID/TTFD instrumentation or a Norva benchmark. Official
  restart guidance and the prohibitions on data clearing and unsafe power actions
  are retained.
- **721:** finished viewing, completed downloading, eligibility and verified
  offline playability remain distinct. The fictional reconciliation retains
  `8.0→5.0`, `10.2→7.2` and `12.0→15.0 GB`, an unclassified `2.2 GB` balance and a
  chosen `6.0 GB` reserve leaving `9.0 GB`, not a universal minimum. Cache is not
  equated with all app data; item-level removal, safe account recovery, no automatic
  media-byte sync and no included media catalogue remain explicit.

## Mechanical checks and hash meaning

The repository's `splitDocument` and `checkStructure` passed **10/10** Arabic
files after corrections: heading-level sequence, list/table structure, every
Markdown destination and image path, required nonempty metadata, language, source
slug and source fingerprint, H1/title equality, and the `in_review` / `ai_assisted`
status/method. Sources and next-step metadata and body H2 labels match the current
UI exactly: `المصادر` and `خطوتك التالية`.

A separate source-numeric-token presence check passed **10/10** after Markdown
destinations were excluded from the comparison. Every original numerical value
was retained; manual reading additionally checked which observation or calculation
each value belongs to rather than treating token presence as proof of meaning.

Hashes cover the complete UTF-8 file, frontmatter included, with CRLF normalized
to LF and no other normalization. They bind the actual `in_review` bytes before
any mechanical transition to `approved`. All source hashes match the frozen
English source-review report. Any prose change requires renewed review and a new
fingerprint; source and final release-byte gates remain separate.

## Frozen source fingerprints

| Source file | Reviewed source SHA-256 |
|---|---|
| 028-organize-seasons-episodes.md | 5bf127fdded9a2e747c07533396e0e1087f951aaabf6110d741bc6f04cf1ba90 |
| 161-personal-media-search-guide.md | ceb386fa88d66020c14536e63e0925f2938d1bd815892c69dbf3f7a13bce9767 |
| 422-handoff-mirroring-or-casting-know-which-workflow-you-need.md | b46f9a584d473e98e7d7972e1d512ff3202c7d9490c7c540717f8958313a123e |
| 442-separate-profiles-or-one-shared-profile-a-decision-framework.md | 99bfb58866328e9d2feb47aa9731a6392ed917bfb5d6f7de67602205c4efea0a |
| 502-built-in-and-separate-subtitle-tracks-what-viewers-need-to-know.md | 98b9d0bbd83440fb5f247e1595988ce7cc53b352a8396f7bd1e88988ce55ed90 |
| 561-the-complete-guide-to-understanding-video-quality.md | 99fccd54d5b6af5a6451f65c4e35b01af916d28dea353eeef1e7b80fc0beb5cc |
| 582-volume-and-loudness-why-they-are-not-identical.md | c5afea01c019d7d716ee9c9381688084918f14896336a67afc5e83d8a17ed1d1 |
| 602-bandwidth-throughput-latency-and-jitter-explained.md | 1187d6fb8fd3c55e3350243076646f12a474e161b0a321d197fcb55237b068da |
| 662-cold-start-or-warm-start-measure-the-right-tv-launch.md | 1d98978ab5f697cccbc66a8ab0cd8d60492abc5f7897a76ab52c9df291edcdcb |
| 721-offline-storage-management-handbook.md | 4ad5c1694f9825a417d72d6c7ab37dd5066001c03760f05a46f96604b116836a |

## Reviewed translation fingerprints

| Translation key | Reviewed SHA-256 |
|---|---|
| ar/organize-seasons-episodes | c481fb283e291913e62dfcd566495feede8e2fdf8f38547b3f75830347055840 |
| ar/personal-media-search-guide | a949598a76c233ca51cce0cf34b3db755580a4a85ac00cd6e49384e543e14d4d |
| ar/handoff-mirroring-or-casting-know-which-workflow-you-need | 76967309d913594a16e456e46b982dc06cf9ffd228dc005fc11900d74237829c |
| ar/separate-profiles-or-one-shared-profile-a-decision-framework | c170d38168c1129bffe19648eb77b3a487828b7412de958b5e292ddfa6e798d1 |
| ar/built-in-and-separate-subtitle-tracks-what-viewers-need-to-know | 703c301700e613fe9097db540a6d2afe5c1e17725e13d798c6cd72024a54069c |
| ar/the-complete-guide-to-understanding-video-quality | f424ae67f79112ffbf849630d073ae23707772b96b3a918852eb300f7cacd683 |
| ar/volume-and-loudness-why-they-are-not-identical | 5e73765951aa8c9dd23881f02951ef970c2974550744e86631ecd8b317c2a14b |
| ar/bandwidth-throughput-latency-and-jitter-explained | 1844be2134cf04b07ce7302e31c880ba6f431837324ab0054c5f3a7690c66cb1 |
| ar/cold-start-or-warm-start-measure-the-right-tv-launch | 7875ef9e0bd7553664f1b358615bc29450c384be6cc61ccc726604b5b69aec52 |
| ar/offline-storage-management-handbook | 46816ae7ef50f8314bd6645a6fbcf46c14a5fff1c200bdb74f3eaec3709f5ea9 |

## Verdict and limits

**Accepted for the release-review gate: 10/10 translations, no unresolved
editorial finding.** This verdict binds only the complete-file fingerprints above
and does not itself change any translation or release status.

This is a prose/source-fidelity review, not fresh live product testing, legal
certification, a native-speaker endorsement or production acceptance. RTL layout,
mixed-direction labels and numbers, table scrolling, localized routes, reciprocal
hreflang, generated metadata and deployment remain separate rendering/release
checks owned by the parent task. English source claims, UI, release ledger,
generated files and Git were not modified by this independent review.
