# Independent review — batch 2, remaining Spanish and Brazilian Portuguese versions

Date: 2026-09-11. Author and first/self-review: `/root/blog_latin_translations`.
Independent second reviewer: `/root/blog_indic_arabic_translations`. Method: AI-assisted complete source/translation reading and independent verification of corrections; not human or native-speaker certification.

## Scope

Despite this report's retained filename, its actual scope is **14 translations: ES and PT-BR for 422, 502, 561, 582, 602, 662 and 721**. It covers no French files and excludes 028, 161 and 442, which the parent reviewed separately. It does not review UI dictionary changes or generated pages.

The complete frozen English sources and both complete translations of each were read, including metadata, H1, every section, paragraph, list, table, FAQ, link label and next-step text. Source image/asset destinations, where present, were compared mechanically; this scope introduces no translated replacement images. Corrections were requested from the author, applied only by the author, and their final wording was independently reread.

## Fidelity and evidence checks

- **422:** The three workflows remain distinct: continuation in the destination app, screen mirroring and receiver-based casting. Published Google Cast availability is not presented as a successful receiver, format, subtitle or network test. The completed example stays illustrative, and app/source/device prerequisites remain conditional.
- **502:** A container, selectable built-in track, external file and burned-in text remain distinct. Image-based subtitles are not confused with burned-in text. The external file's existence is not a claim of support, and disabling a track does not imply that all visible text must disappear. Timing, language, version and accessibility limitations are preserved.
- **561:** Video quality is evaluated through a controlled comparison rather than one resolution or bitrate number. The owned fictional harbour clip, 00:42–00:52 interval, 1920 × 1080 dimensions and invented observations remain explicit. Sharpening is a contributing explanation, not proof of every artifact; no player benchmark or network certification is claimed.
- **582:** Gain, program loudness, peaks, dynamic range and listening conditions remain distinct. The 0.20 × 0.5 = 0.10 and 0.60 × 0.5 = 0.30 illustration does not turn an amplitude ratio into a perceived-loudness ratio or a slider setting into an acoustic measure. No universal safe listening setting or Norva normalization capability is invented.
- **602:** Capacity, measured throughput, one-way delay, round-trip results, delay variation and loss retain their measurement scope. The paired illustrative observations, units and statistics remain intact; a speed-test result or universal jitter threshold does not diagnose a playback pause. Delivery to the application is not confused with application deployment.
- **662:** Cold, warm and hot remain separate Android launch states. TV power-on, app launch, first image and usable D-pad navigation are not conflated. The four illustrative trials, timings, preparation order and non-instrumented limitations remain intact. A normal exit is not asserted to terminate the process.
- **721:** Offline eligibility is not equated with local availability. Already-watched items eligible for cleanup are distinguished from items whose download has completed. The 8.0 GB list, 10.2 GB app footprint, 3.0 GB removal, unchanged 2.2 GB unexplained balance, 6.0 GB reserve and 9.0 GB remaining allowance retain their arithmetic and fictional status. Cache clearing, storage clearing, offloading and deletion are not treated as interchangeable; source URLs and credentials are excluded from the example records.

All 14 retain the source's player-without-supplied-content positioning, authorized-source requirements and material product/evidence limitations. The review assesses fidelity to the frozen, previously reviewed English sources; it is not a new device test, benchmark, legal determination or certification of product functionality.

## Corrections requested and independently rechecked

- **422:** Clarified the originating-device referent in the Spanish mirroring FAQ; preserved “completed test” rather than implying an exhaustive test; replaced Portuguese “monitor” with the broader “tela”.
- **502 ES:** Rephrased accessibility completeness so it refers to completeness of accessibility information, not an abstract integrity guarantee.
- **561:** Used “distinct” rather than statistically “independent” variables in Spanish; made ownership attach to the video clip, not the harbour, in both languages.
- **582:** Replaced the literal “consumption control” with a user-facing volume control; explicitly identified sound effects in the dynamic-range discussion, comparison procedure and normalization section.
- **602:** Replaced literal “consumption tools/results” with end-user tools/results; clarified data delivery to the application; retained complete bandwidth/throughput terminology in metadata and the high-throughput sentence.
- **662:** Corrected title/H1 and warm-state heading terminology so warm does not become hot; clarified normal app exit without asserting process termination. Terminology was checked against the current official [Android Spanish launch documentation](https://developer.android.com/topic/performance/vitals/launch-time?hl=es-419) and [Android Brazilian Portuguese launch documentation](https://developer.android.com/topic/performance/vitals/launch-time?hl=pt-br).
- **721:** Clarified already-watched items versus completed offline downloads in the summary, cleanup instructions, example and FAQ; made the Portuguese reported app footprint neutral as to which interface reports it.

## Mechanical acceptance and decision

Final mechanical validation passes **14/14**: exact LF-normalized source hash, locale/slug identity, required metadata fields and types, H1/title agreement, localized Sources/Next step headings, unchanged heading-level sequence, link/image destinations, list and table-row counts, Unicode validity and equivalent numeric inventory (allowing whitespace before a percent sign). Complete reading separately checked meaning and arithmetic; these mechanical checks do not establish translation quality on their own.

**PASS — no unresolved findings.** The 14 reviewed texts are editorially acceptable for the owner-authorized release, subject to the parent's mechanical approval transition and remaining technical acceptance. This report does not establish deployment or live publication. All reviewed files remain `translation_status: "in_review"` and `translation_method: "ai_assisted"`. No post-verdict prose changes are permitted without renewed review.

## Frozen sources read

All source files below are under `content/blog/articles/`. Each was compared with the same filename under both `content/blog/translations/es/` and `content/blog/translations/pt-BR/`.

| Source filename | Frozen English SHA-256 |
| --- | --- |
| 422-handoff-mirroring-or-casting-know-which-workflow-you-need.md | b46f9a584d473e98e7d7972e1d512ff3202c7d9490c7c540717f8958313a123e |
| 502-built-in-and-separate-subtitle-tracks-what-viewers-need-to-know.md | 98b9d0bbd83440fb5f247e1595988ce7cc53b352a8396f7bd1e88988ce55ed90 |
| 561-the-complete-guide-to-understanding-video-quality.md | 99fccd54d5b6af5a6451f65c4e35b01af916d28dea353eeef1e7b80fc0beb5cc |
| 582-volume-and-loudness-why-they-are-not-identical.md | c5afea01c019d7d716ee9c9381688084918f14896336a67afc5e83d8a17ed1d1 |
| 602-bandwidth-throughput-latency-and-jitter-explained.md | 1187d6fb8fd3c55e3350243076646f12a474e161b0a321d197fcb55237b068da |
| 662-cold-start-or-warm-start-measure-the-right-tv-launch.md | 1d98978ab5f697cccbc66a8ab0cd8d60492abc5f7897a76ab52c9df291edcdcb |
| 721-offline-storage-management-handbook.md | 4ad5c1694f9825a417d72d6c7ab37dd5066001c03760f05a46f96604b116836a |

## Reviewed bytes

The following hashes cover each complete Markdown file, with CRLF normalized to LF, while it is still `in_review`. The release ledger must retain these review hashes separately from hashes after the parent's mechanical status change.

| Translation key | Reviewed SHA-256 |
| --- | --- |
| es/handoff-mirroring-or-casting-know-which-workflow-you-need | 0e4c3a2a7abb824c1bf91ccfca39fd1b132d5cb4461ea4d859a7a8d7aa6fce06 |
| es/built-in-and-separate-subtitle-tracks-what-viewers-need-to-know | 28dc89e7ff23af6b7c66b28022cd954ea3a9326c93f5d7619d2455d973b91205 |
| es/the-complete-guide-to-understanding-video-quality | bdf58a24b7e402a077c2263f85d327da0d2946e8bc01efcad243e98fce119d54 |
| es/volume-and-loudness-why-they-are-not-identical | 0ace007122e2c3e7ef5dbb9811b1b92be84f8db0f0e9a6090353605b92174f80 |
| es/bandwidth-throughput-latency-and-jitter-explained | ad5a5542413fc2e04d73a5c161254b5cb7ab39c8fb615117d7e11100973fcd72 |
| es/cold-start-or-warm-start-measure-the-right-tv-launch | a3f88b7e92eabc022a5390d4b273b34a7f79caf680f974bf80339c51e4179d81 |
| es/offline-storage-management-handbook | 324c49421b8d3a72f13413dad89b4028a09e63e771f55b8bb33796a16d10d3ce |
| pt-BR/handoff-mirroring-or-casting-know-which-workflow-you-need | 2d3bfc3b8254051465aec29467bc626c9745a827deb87ff1cd1aedb980950aa2 |
| pt-BR/built-in-and-separate-subtitle-tracks-what-viewers-need-to-know | cb66eaa354cdf2a9a75188fcb1ede7025934c54466855df8df778ddb07de2631 |
| pt-BR/the-complete-guide-to-understanding-video-quality | 1562bcb4f37279b8b7f7d55ec7f1b4ce3f12a7d3821f6d47e842f0466b3a453a |
| pt-BR/volume-and-loudness-why-they-are-not-identical | 3ca60524bd13e86ce3e45e4f66823b87f15a3ab7d753a5baa1ea0b1d7cec8e97 |
| pt-BR/bandwidth-throughput-latency-and-jitter-explained | 7ddb40bcb3f87de03cbdacda7a615dab02d940c350694c7d0455af999e113e72 |
| pt-BR/cold-start-or-warm-start-measure-the-right-tv-launch | 85649acdbba80749aff9640cda0ac96c4cd116e83a27297f904b396b8cace2ec |
| pt-BR/offline-storage-management-handbook | afb1d1a26152b4b6fc94d862b47c153dc9255cc8515f281a2da5f0f46ea18f17 |

