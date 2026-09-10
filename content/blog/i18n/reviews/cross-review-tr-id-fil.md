# Independent translation review: Turkish, Indonesian and Filipino

Reviewer: Codex agent `/root/blog_latin_translations`, independent of the author of these translations. This is an AI-assisted editorial cross-review, not a human or native-speaker certification. The parent agent records the user-authorized release decision separately.

Review date: 10 September 2026.

Status: complete. All 21 Turkish, Indonesian and Filipino articles and all three UI dictionaries have been read in full. The author applied the seven correction items below, and the reviewer independently rechecked the changed wording. No unresolved editorial blocker was found in this scoped AI-assisted cross-review. Publication remains the parent agent's separate, user-authorized release operation.

## Method and source material

Read all seven English source articles in full, including their metadata, and compared every translated substantive section, example, caveat, FAQ, table and call to action. Checked the product position (software player/organiser, no included catalogue or media access), authorisation and compatibility conditions, offline conditions, profile counts, account continuity qualifications, and the distinction between observed catalogue behaviour and unvalidated playback/native/cross-device behaviour.

The factual and editorial references read were `AGENTS.md`, `content/blog/EDITORIAL-GUIDE.md`, `content/blog/FACT-CHECK-GUIDE.md`, `content/blog/README.md`, `content/blog/README.source.md`, and `content/blog/PRODUCT-EVIDENCE-20260909.md`. This review translates and checks the existing evidence; it is not a new product test, source-rights determination or verification of cited external websites.

The English UI reference `content/blog/i18n/ui/en.json` was also independently reread in full after the dynamic `{count}` library notice change: all 40 values, the source/next-step labels, original-English-image disclosure, player-without-included-media disclaimer and placeholders were checked. Its LF-normalized SHA-256 is recorded below so the target UI approvals can bind to this exact reference.

English source articles read in full:

- `content/blog/articles/014-norva-getting-started.md`
- `content/blog/articles/015-connect-compatible-media-source-norva.md`
- `content/blog/articles/027-organize-large-movie-collection.md`
- `content/blog/articles/089-what-is-norva-media-player.md`
- `content/blog/articles/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md`
- `content/blog/articles/542-legibility-and-readability-two-different-viewing-problems.md`
- `content/blog/articles/562-resolution-and-bitrate-why-they-are-not-the-same.md`

Automated verification uses the parent's `splitDocument`, `checkStructure`, `hashText` and `loadUi` functions. It compares heading-level sequences, every link destination, original image paths/order, list-item and table-row counts, LF-normalized source SHA-256, localized source/next-step headings, UI keys and placeholders. Automated structural agreement supports but does not replace the full semantic reading.

## Files read in full

- `content/blog/translations/tr/014-norva-getting-started.md`
- `content/blog/translations/tr/015-connect-compatible-media-source-norva.md`
- `content/blog/translations/tr/027-organize-large-movie-collection.md`
- `content/blog/translations/tr/089-what-is-norva-media-player.md`
- `content/blog/translations/tr/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md`
- `content/blog/translations/tr/542-legibility-and-readability-two-different-viewing-problems.md`
- `content/blog/translations/tr/562-resolution-and-bitrate-why-they-are-not-the-same.md`
- `content/blog/translations/id/014-norva-getting-started.md`
- `content/blog/translations/id/015-connect-compatible-media-source-norva.md`
- `content/blog/translations/id/027-organize-large-movie-collection.md`
- `content/blog/translations/id/089-what-is-norva-media-player.md`
- `content/blog/translations/id/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md`
- `content/blog/translations/id/542-legibility-and-readability-two-different-viewing-problems.md`
- `content/blog/translations/id/562-resolution-and-bitrate-why-they-are-not-the-same.md`
- `content/blog/translations/fil/014-norva-getting-started.md`
- `content/blog/translations/fil/015-connect-compatible-media-source-norva.md`
- `content/blog/translations/fil/027-organize-large-movie-collection.md`
- `content/blog/translations/fil/089-what-is-norva-media-player.md`
- `content/blog/translations/fil/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md`
- `content/blog/translations/fil/542-legibility-and-readability-two-different-viewing-problems.md`
- `content/blog/translations/fil/562-resolution-and-bitrate-why-they-are-not-the-same.md`
- `content/blog/i18n/ui/tr.json`
- `content/blog/i18n/ui/id.json`
- `content/blog/i18n/ui/fil.json`

## Corrections requested from the author

| Item | Concrete issue | Required correction | State |
|---|---|---|---|
| Turkish 542 | `seçilebilirlik` can imply selectability rather than visual legibility, especially the FAQ referring to `seçilemeyen kontroller`. This blurs the article's central distinction. | Use `okunaklılık` for legibility and `okunabilirlik` for readability, adapting title, metadata, headings, table and sentences consistently; retain exact English illustration text. | Fixed by author and rechecked throughout the complete corrected article; FAQ now describes controls that cannot be distinguished. |
| Turkish 014, 015, 027 | `Nordic languages` was explained as `İskandinav dilleri`, which can narrow the regional meaning to Scandinavian languages. | Retain exact English UI label and use `Nordik diller` for the explanation. | Fixed and rechecked in all three files. |
| Turkish 014, 015 | `tespit edilen dosya parçalarından` / `tespit edilen dosya parçası bilgilerini` can suggest file fragments, obscuring that the audio filter uses detected tracks inside files. | Explicitly refer to detected audio tracks in files. | Fixed and rechecked: both passages now explicitly say detected audio tracks in files. |
| Filipino 015, source-management step | `Isinasalin ang mga label na ito sa Ingles kapag ibang wika ng interface ang napili.` reverses the translation direction, saying the labels become English when another language is chosen. | Say that these English labels are translated into the selected interface language. | Fixed and rechecked: `mula sa Ingles tungo sa napiling wika`. |
| Filipino 027, reversible filtering | `nababaling pagpapaliit` suggests something breakable, not refinements that can be reversed. | Describe these as `hakbang ng pagpapaliit na maaaring bawiin` or equivalent reversible steps. | Fixed and rechecked in the filtering paragraph. |
| Filipino 027, title and category FAQ | The title's `nang hindi walang-hanggang` construction is awkward; `pagkakapare-pareho` conveys sameness rather than overlap between categories. | Prefer `nang hindi kailangang mag-scroll nang walang katapusan` and an explicit expression for overlapping categories. | Fixed and rechecked: title/H1 use the proposed natural construction; the FAQ now explains repeated titles across different categories. |
| Filipino 562, encoder paragraph | `Maaaring bigyan ng mas maraming data ng mas maluwag na puwang ang encoder` has an awkward double-`ng` construction. | Use `Maaaring magkaroon ng mas malaking puwang ang encoder kapag mas marami ang data`, preserving the controlled-comparison qualification. | Fixed and rechecked in the final bytes. |

The reviewer did not edit the author's translation or UI files. Corrections were sent to both the author and parent agent to preserve file ownership.

## Findings from completed readings

Indonesian 7/7: no blocking semantic or editorial defect found. The distinction between captions and subtitles is explained rather than asserted as a universal technical boundary; legibility and readability remain separate; illustrative calculations preserve assumptions and exclusions.

Turkish 7/7: no missing substantive section, numerical change or unsupported expanded product claim found. The terminology corrections above are verified.

Filipino 7/7: all source steps, private-data safeguards, fictional collection examples and evidence boundaries are preserved. The three explanatory articles retain the caption-cue sequence and non-universal terminology distinction, the contrast/grouping comparisons and task-versus-recognition distinction, and the bitrate calculation's assumptions and overhead exclusions. The translation-direction and wording corrections above are verified.

UI 3/3: all 40 values read. Navigation, byline, language labels, media-provider disclaimer and original-image disclosure remain faithful. `{minutes}`, `{date}` and `{count}` are retained; `libraryNotice` now uses `{count}` rather than a fixed seven. Common technical loanwords are used naturally in context and are not represented as a native-speaker sign-off.

The reproducible source facts checked include the 10 September 2026 web observation date, five first-session checkpoints, twelve displayed versions, five-step to three-step optional date path, two versus five profiles, five caption scenes, the five fictional records/four works, 1920 × 1080 and 2,073,600 pixels, assumed 4/8 Mbps, 600 seconds, 300/600 decimal MB and eight bits per byte. The illustrated examples remain distinct from product screenshots and acceptance tests.

## Final verification and verdict

All 21 translations pass structural checks, source hashes and localized source/next-step headings. Identity fields and `in_review` status were checked for all 21. All three UI dictionaries pass 40-key and placeholder validation (120 translated values total). The final structural/source-hash check was repeated after the last Filipino 562 correction.

Verdict: approved for this scoped AI-assisted cross-review under the user-authorized exception, with no unresolved editorial finding. This does not certify native-speaker or human review, accessibility conformance, source licensing, production playback, publication, or live deployment. No translation status, Git ref or publication state was changed by this reviewer. The parent still owns final review records, status changes, release validation and publication.

## Reviewed byte fingerprints

These SHA-256 values cover complete files with CRLF normalized to LF. Translation paths below are relative to `content/blog/translations/`; UI paths are relative to `content/blog/i18n/ui/`. They identify the reviewed `in_review` snapshot; a later parent-managed status-only release stamp changes the file hash without changing the reviewed prose.

| File | SHA-256 |
|---|---|
| en.json (40-value UI reference) | `ab14080d6ffb7ba84820d4e72682737d44987fdbabcec358935d97494515870d` |
| tr/014-norva-getting-started.md | `b90086440ce5058b272689e16994f024a55bfa1eee40e244088bd31c39fc5165` |
| tr/015-connect-compatible-media-source-norva.md | `c97283efa444f94f32a760e5cfb87b70716b3aed804658eaf96fe79b2fe83daa` |
| tr/027-organize-large-movie-collection.md | `59cc885b10abc30672fbf63f943397b2b1c1925581ea398f27b6c3046b43bb6b` |
| tr/089-what-is-norva-media-player.md | `91f647f000045b7212df6c7c7d0cec1246c2bbe84c14ac893fd1601b013f1f97` |
| tr/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md | `dcfaabb16858e9117d4f4982291e179c3327649ff0622f492ca2a82ba3f06b34` |
| tr/542-legibility-and-readability-two-different-viewing-problems.md | `3f173c1f87a4981a662cc50d6ceaa3979624bd22940cf5ef1dc701b079b0fefa` |
| tr/562-resolution-and-bitrate-why-they-are-not-the-same.md | `8170642fba50e8dde6da86f6dcfff2486bf41a7518e989a20ce3f5bec5b83bfb` |
| tr.json | `0d68794166a60bf3f1662cb014c07fdcb5395ed555fb92ce469deef55ecf17ca` |
| id/014-norva-getting-started.md | `bac20c5ed62cb0a8cbf7ada6da0910b2e62ac028a8178ddb9cb5e80c79319632` |
| id/015-connect-compatible-media-source-norva.md | `30e24f170bad8019f1754948f92af1ba70f966c4f074766322539ccc244a580e` |
| id/027-organize-large-movie-collection.md | `f8348fdbbcdb1362dc102ef5bb3c1c742199bffe428e966d05fc2fb564b15107` |
| id/089-what-is-norva-media-player.md | `556bda970716a4d170b4167407d58cda2aa67b972078a39e53f095515ee87ac9` |
| id/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md | `694507bd45fe0d36d428b84469329977bfa5c5ca792c03bedf233606b81265cd` |
| id/542-legibility-and-readability-two-different-viewing-problems.md | `6f7aaab0f2b50f731f0b6ebf3c6f47791c20a2c713c4219a8ea053c50bbc4199` |
| id/562-resolution-and-bitrate-why-they-are-not-the-same.md | `f6213c1542fe1bbafd7e9efba190e748faf4d6d1d5d9f0f6651b7846f095a463` |
| id.json | `19943bb3e6d4a793b4205cbf4bbd8771f534b0aa77e120a33bda5e8b9335996f` |
| fil/014-norva-getting-started.md | `4fccacce5f18a3a1ac889ed2b6383837469986b799632487c1d36ddab50ff97b` |
| fil/015-connect-compatible-media-source-norva.md | `796355f8c2f600f3afeb1a2db99267a140161e64cb2c4b8226350b6ad02c6ca0` |
| fil/027-organize-large-movie-collection.md | `027d2db55810b70d494694757fee69caae49f02d49d828c0cf4fe84ccedccece` |
| fil/089-what-is-norva-media-player.md | `68963878194dd8d9a81b78cc06cf07183bb8d9dbd4a484060d71d62fcfda09d2` |
| fil/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md | `a10937a8264e05f79ebd272cc5946308e84dd40615c680b40185a953ce337aee` |
| fil/542-legibility-and-readability-two-different-viewing-problems.md | `1c255c735dea5e10ac8a090bac128e9ab156b8cfb82179af93e24efc1568f451` |
| fil/562-resolution-and-bitrate-why-they-are-not-the-same.md | `686e3c1e4df70649d2862755cb1ed35a430c877c259e64326814b5c57e747ec4` |
| fil.json | `62e1930eb9bcf7519b4fab9cbaf170dd5a7818bcb1d1636ed582a7c50738c43d` |
