# Independent translation review: Hindi, Bengali and Arabic

Reviewer: Codex agent `/root/blog_asian_translations`, independent of translation author `/root/blog_indic_arabic_translations`. This is an AI-assisted editorial cross-review, not a human or native-speaker certification.

Review date: 10 September 2026.

Status: complete. All 21 Hindi, Bengali and Arabic articles and all three UI dictionaries were read in full against the seven complete English sources. The author applied all 12 correction items below. The reviewer independently checked the changed wording and reran verification after the last Arabic corrections. No unresolved editorial blocker was found in this scoped cross-review. The parent owns the separate user-authorized release decision.

## Method and source material

The semantic review covered the full translated body and metadata, including every substantive section, procedure, original example, evidence qualification, numerical statement, FAQ, table, illustration explanation and call to action. It checked natural wording and technical distinctions, not just file structure.

Editorial and factual references read were the repository instructions supplied for this task, `content/blog/EDITORIAL-GUIDE.md`, `content/blog/FACT-CHECK-GUIDE.md`, `content/blog/REVIEW-20260910.md`, and `content/blog/i18n/README.md`. The scoped user-authorized double-agent-review exception does not establish a general exemption for future translations. This review compares translations with the source evidence; it is not a new product test, a determination of media rights, or fresh verification of external reference sites.

English source articles read in full:

- `content/blog/articles/014-norva-getting-started.md`
- `content/blog/articles/015-connect-compatible-media-source-norva.md`
- `content/blog/articles/027-organize-large-movie-collection.md`
- `content/blog/articles/089-what-is-norva-media-player.md`
- `content/blog/articles/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md`
- `content/blog/articles/542-legibility-and-readability-two-different-viewing-problems.md`
- `content/blog/articles/562-resolution-and-bitrate-why-they-are-not-the-same.md`

The UI reference `content/blog/i18n/ui/en.json` was also read in full. The updated `libraryNotice` uses the dynamic `{count}` value rather than a fixed seven.

## Translation and UI files read in full

- `content/blog/translations/hi/014-norva-getting-started.md`
- `content/blog/translations/hi/015-connect-compatible-media-source-norva.md`
- `content/blog/translations/hi/027-organize-large-movie-collection.md`
- `content/blog/translations/hi/089-what-is-norva-media-player.md`
- `content/blog/translations/hi/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md`
- `content/blog/translations/hi/542-legibility-and-readability-two-different-viewing-problems.md`
- `content/blog/translations/hi/562-resolution-and-bitrate-why-they-are-not-the-same.md`
- `content/blog/translations/bn/014-norva-getting-started.md`
- `content/blog/translations/bn/015-connect-compatible-media-source-norva.md`
- `content/blog/translations/bn/027-organize-large-movie-collection.md`
- `content/blog/translations/bn/089-what-is-norva-media-player.md`
- `content/blog/translations/bn/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md`
- `content/blog/translations/bn/542-legibility-and-readability-two-different-viewing-problems.md`
- `content/blog/translations/bn/562-resolution-and-bitrate-why-they-are-not-the-same.md`
- `content/blog/translations/ar/014-norva-getting-started.md`
- `content/blog/translations/ar/015-connect-compatible-media-source-norva.md`
- `content/blog/translations/ar/027-organize-large-movie-collection.md`
- `content/blog/translations/ar/089-what-is-norva-media-player.md`
- `content/blog/translations/ar/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md`
- `content/blog/translations/ar/542-legibility-and-readability-two-different-viewing-problems.md`
- `content/blog/translations/ar/562-resolution-and-bitrate-why-they-are-not-the-same.md`
- `content/blog/i18n/ui/hi.json`
- `content/blog/i18n/ui/bn.json`
- `content/blog/i18n/ui/ar.json`

## Corrections requested from the author

| Item | Concrete issue | Correction verified in the final text | State |
|---|---|---|---|
| Hindi 522, introduction | `लिप्यंतरण` means transliteration, whereas the source says transcription. | Replaced with `प्रतिलेखन`, retaining the distinction between dialogue translation and transcription. | Fixed by author and independently rechecked. |
| Hindi 014, prerequisites and second-screen checkpoint | `दूसरा समर्थित स्क्रीन` has incorrect grammatical agreement. | Both instances now use `दूसरी समर्थित स्क्रीन`. | Fixed and rechecked. |
| Hindi 562, encoder context | `अन्य मानक` implies other standards rather than other encoder parameters. | Replaced with `अन्य पैरामीटर`. | Fixed and rechecked. |
| Hindi 014 and 015, evidence boundaries | `मूल फ़ोन/टीवी` can mean original phone/TV rather than native applications. | The applicable evidence-limit statements now explicitly say `नेटिव फ़ोन/टीवी`. | Fixed and rechecked in both files. |
| Bengali 027, grouping and fictional records | Translating a creative work as `কাজ` can imply a task or job rather than the film identity being compared. | The relevant grouping, owner-confirmation, table and four-distinct-works statements use `চলচ্চিত্র`. | Fixed and rechecked across the affected passages. |
| Bengali 027, reversible filtering | `ডজনখানেক` means about a dozen, narrowing the source's plural dozens. | Replaced with `ডজন ডজন`. | Fixed and rechecked. |
| Bengali 522, audio information | `শব্দের প্রভাব` reads as the effect of sound rather than the technical content category sound effects. | Introduction, limited-track-role section and FAQ use `সাউন্ড এফেক্ট`. | All three instances fixed and rechecked. |
| Bengali 015, favourite observation | `স্থায়ী সংরক্ষণ` can suggest permanent preservation rather than the observed persistence after reopening. | The statement is bounded to `পরে আবার খুললেও আইটেমটি সংরক্ষিত থাকার বিষয়টি যাচাই করে`, while still excluding immediate feedback and cross-device sync. | Fixed and rechecked with its surrounding qualification. |
| Arabic 014, playback limitation | `المصادقة على التشغيل` can imply authentication or certification rather than revalidation. | Now says `لم يُعَد التحقق من التشغيل`, followed by the unchanged failed-to-establish-advancing-video qualification. | Fixed and rechecked. |
| Arabic 089, evaluation worksheet | `هل تحقق؟` is ambiguous for the source header Verified?. | Replaced with `هل تم التحقق؟`. | Fixed and rechecked. |
| Arabic 562, image alternative text | `تستخدم الثانية` can be read as the second frame uses, rather than the one-second interval in the calculation. | Now explicitly says `تُستخدم في ثانية واحدة 4 و8 ميغابت على التوالي`. | Fixed and rechecked. |
| Arabic 562, encoder paragraph | `قد تمنح البيانات الأكثر المُرمّز مساحة أكبر للعمل` has an awkward noun construction. | Now says `قد تتاح للمُرمِّز مساحة أكبر للعمل عندما تتوفر بيانات أكثر`; the uncontrolled cross-codec comparison limitation remains intact. | Fixed and rechecked. |

The reviewer did not edit the author's translation or UI files. Findings were sent to the author for ownership-preserving corrections, with progress and closure reported to the parent.

## Findings from the completed readings

Hindi 7/7: all substantive source content remains present. The transcript, native-app and encoder-parameter terminology corrections remove the identified ambiguities. The distinctions between captions and subtitles, character recognition and task comprehension, and frame dimensions and data rate remain explicit.

Bengali 7/7: all original records, tables, steps and evidence limitations remain present. Film identity is now clear in the fictional collection example. The favourite observation remains restricted to reopening; it does not imply permanent retention, immediate UI feedback or verified cross-device continuity.

Arabic 7/7: full paragraphs and examples retain the original meaning and qualifications. The playback statement now clearly refers to verification. The bitrate illustration states the one-second interval unambiguously, while retaining the original English asset and unchanged illustrative arithmetic.

UI 3/3: all 40 values in each dictionary were read, for 120 translated values total. Navigation and language labels, editorial byline, media-provider disclaimer, original-image disclosure, English-library links and dynamic guide count are faithful. The exact placeholders `{minutes}`, `{date}` and `{count}` are preserved. English UI labels necessary to match screenshots remain exact in article prose and are explained locally. The disclosure does not portray unaltered English screenshots or original illustrations as new localized product tests.

The review specifically checked the software-player/organiser position, no included media catalogue or media access, compatible sources owned or authorised by the user, account-secret safeguards, conditional offline use, and two versus five profiles without invented device or concurrent-stream limits. Ready/importing catalogue states and detected language information do not become proof of successful playback. M3U import, native-device behaviour, immediate favourite feedback, cross-device continuity and other unvalidated cases remain qualified.

Numerical and worked examples checked include the 10 September 2026 observation date; the first-session timing checkpoints; twelve displayed versions; the optional-date flow changing from five steps to three; five fictional records representing four distinct works; five caption scenes; the identical Episode 18 and Audio English Subtitles Off illustration text; 1920 × 1080 and 2,073,600 pixels per frame; assumed 4/8 Mbps; 600 seconds; 300/600 decimal MB; and eight bits per byte. The bitrate examples still exclude audio, subtitles, container, encryption and network overhead, and do not promise download size, connection requirements or doubled perceived quality.

## Final verification and verdict

After all corrections, an independent local check using `splitDocument`, `checkStructure`, `hashText` and `loadUi` passed for all 21 translations and all three UI dictionaries. It checked heading-level sequences, link destinations, original image paths/order, list-item counts, table-row counts, complete-source LF-normalized SHA-256, language and source-slug identity, title/H1 consistency, exact localized sources/next-step headings, `in_review` status and `ai_assisted` method. Every UI has the same 40 keys and matching placeholders as English. Structure checks supplement, not replace, the full semantic reading.

Verdict: approved for this scoped AI-assisted cross-review under the explicit user-authorized exception, with no unresolved editorial finding. No human or native-speaker sign-off, accessibility conformance, source licensing, runtime/RTL rendering, successful playback, deployment or publication is certified by this textual review. The parent owns final status changes, review records, release validation and production verification. No translation status, Git ref or publication state was changed by this reviewer.

## Reviewed byte fingerprints

These SHA-256 values cover complete files with CRLF normalized to LF. Translation paths are relative to `content/blog/translations/`; UI paths are relative to `content/blog/i18n/ui/`. They identify the reviewed `in_review` snapshot after all corrections. The parent will separately record hashes after the mechanical status-only change to approved. Any subsequent prose or UI change requires notifying the reviewer and parent rather than silently inheriting this verdict.

| File | SHA-256 |
|---|---|
| hi/014-norva-getting-started.md | `455e8a461d900e8d012e0f27fbceaaf1da643c8602648b2ccea873309d4aa8c0` |
| hi/015-connect-compatible-media-source-norva.md | `8e13ef5ceb94498cec2f7f94e1fcd3dee23002815d69e1de4c66e468435cbc71` |
| hi/027-organize-large-movie-collection.md | `af40bc25460535eff0e1d201f23d491a5dab72c5d2d3f4bf35abb057ac03aee1` |
| hi/089-what-is-norva-media-player.md | `5a9caee04057b19642bd852c779dc48c724ef0e692288447355d468ca7528094` |
| hi/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md | `dcadbd301342e8bf90e2f62fe9c585ab786f50e80f69f2ea6287e3dab9eba2b0` |
| hi/542-legibility-and-readability-two-different-viewing-problems.md | `b198f721e10497cbd842b2c8c0fc3c4b2247c3ef26276e5b606a879f6a131bc1` |
| hi/562-resolution-and-bitrate-why-they-are-not-the-same.md | `3892532a28f20eb8d3a39fa21166519d59b3f2f34949c757f747b60bd34f008d` |
| hi.json | `303cef53a23ce862540941761dd7f3cf99f1b5050004fe50fbca823b189d66cc` |
| bn/014-norva-getting-started.md | `692f441b858c7ed30d9ae940169a87d8666c5e874437ac1dcd3a168c6e1f7fba` |
| bn/015-connect-compatible-media-source-norva.md | `e06519416704738ffc6085b57d36bc587c8ccdb1b95720a6b1e874d88c61e956` |
| bn/027-organize-large-movie-collection.md | `fa3ba96ca53a1eb7cc97e02c0ece371badce97d1744e8768c5223fa3fd7da4da` |
| bn/089-what-is-norva-media-player.md | `e121e858f1886e311073a55bf72d2b414975f4d876ae4942a273eb9bf6665c14` |
| bn/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md | `2ee576382c4f37c28d3160dc989608726802f54439d7130c1ea56d4ff94ef73f` |
| bn/542-legibility-and-readability-two-different-viewing-problems.md | `eba045159b93a230122f822b60ddc6a79d6a903fccf13e5bd8ce370a7f5278fd` |
| bn/562-resolution-and-bitrate-why-they-are-not-the-same.md | `97b264cda94197ab011da922035ffb7232c3e3d384198bdd822d72088c5bd56a` |
| bn.json | `d11ae243095396cb9c8056fd48904a8bf3a6746d7b4ed31f1dc3fe40411a7cb2` |
| ar/014-norva-getting-started.md | `de36a1dc41ee13567070beade1d075bc469216af6b7d44e4ca37b9da2783ae69` |
| ar/015-connect-compatible-media-source-norva.md | `104db7ce47d0d41b713780bbcda62f394239dd2ba9e9dc1a34446d2ac58cad77` |
| ar/027-organize-large-movie-collection.md | `7bc95089821d2953bab49291e2ef5a0efc940b97652a4c1712916ae204a3505b` |
| ar/089-what-is-norva-media-player.md | `12eddce19628c1e6b37db8d6a53510fe4937799a6956e473096fc5af063afaab` |
| ar/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md | `f98d6b496da08fb37413f048a3ba6aef95f76a80ec9b2f6374727ff40e044a94` |
| ar/542-legibility-and-readability-two-different-viewing-problems.md | `10a97fb1453d1687b7170bee17590ab47e656694483a639ca6a80b12c722af56` |
| ar/562-resolution-and-bitrate-why-they-are-not-the-same.md | `e3d33f41e1bc164c5a7751a5a732b396b09373fbfb620df3271c26ca215edf40` |
| ar.json | `912420e9250bf7618d9d01a7e635319a260f5e4d9cea9fdfe5b7948dcc1b0d4c` |
