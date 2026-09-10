# Independent cross-review — batch 2 — Hindi and Bengali

Verdict: APPROVED for translation fidelity and editorial consistency after independent AI review of 20/20 in-scope documents and verification of all requested corrections. No unresolved finding remains. Review completed on 2026-09-11. This is not a production release, product test, or approval-ledger mutation.

Reviewer: Codex AI agent `/root/blog_asian_translations`, independent of the translation author `/root/blog_indic_arabic_translations`. This is an AI review, not a claimed native-speaker or human review.

Actual scope: 20 complete Hindi (`hi`) and Bengali (`bn`) translations of English articles 028, 161, 422, 442, 502, 561, 582, 602, 662 and 721. The parent reassigned the ten Arabic translations to another independent reviewer before any Arabic translation was read here; they will be covered by `cross-review-batch2-ar.md`. This report retains its originally assigned filename but does not claim an Arabic review. All translations must remain `in_review` / `ai_assisted`; the parent owns release approval and sealing.

## Method and boundaries

The reviewer reads every English source and complete translated document, including frontmatter, H1, all prose, tables, list items, FAQ answers, call to action, links and image descriptions. Truncated tool outputs are recovered before a document is marked read. Review covers meaning, grammar, numbers and units, fictional versus observed evidence, source limitations, exact English UI labels where applicable, and the player-without-included-content positioning. Author-confirmed self-review/freeze precedes the independent reading.

Mechanical checks use `splitDocument` and `checkStructure`, compare the source SHA-256 against the complete English file normalized from CRLF to LF, and verify language, source slug, H1/title, method/status, and source/next-step UI labels. These checks supplement, not replace, the full reading. No product playback test, native-client test or publication is claimed by this report.

## Complete reading inventory

All ten complete English sources have been read. The following translation files have been fully read after author-confirmed freeze:

- `content/blog/translations/hi/028-organize-seasons-episodes.md`
- `content/blog/translations/hi/161-personal-media-search-guide.md`
- `content/blog/translations/hi/422-handoff-mirroring-or-casting-know-which-workflow-you-need.md`
- `content/blog/translations/hi/442-separate-profiles-or-one-shared-profile-a-decision-framework.md`
- `content/blog/translations/hi/502-built-in-and-separate-subtitle-tracks-what-viewers-need-to-know.md`
- `content/blog/translations/hi/561-the-complete-guide-to-understanding-video-quality.md`
- `content/blog/translations/hi/582-volume-and-loudness-why-they-are-not-identical.md`
- `content/blog/translations/hi/602-bandwidth-throughput-latency-and-jitter-explained.md`
- `content/blog/translations/hi/662-cold-start-or-warm-start-measure-the-right-tv-launch.md`
- `content/blog/translations/hi/721-offline-storage-management-handbook.md`
- `content/blog/translations/bn/028-organize-seasons-episodes.md`
- `content/blog/translations/bn/161-personal-media-search-guide.md`
- `content/blog/translations/bn/422-handoff-mirroring-or-casting-know-which-workflow-you-need.md`
- `content/blog/translations/bn/442-separate-profiles-or-one-shared-profile-a-decision-framework.md`
- `content/blog/translations/bn/502-built-in-and-separate-subtitle-tracks-what-viewers-need-to-know.md`
- `content/blog/translations/bn/561-the-complete-guide-to-understanding-video-quality.md`
- `content/blog/translations/bn/582-volume-and-loudness-why-they-are-not-identical.md`
- `content/blog/translations/bn/602-bandwidth-throughput-latency-and-jitter-explained.md`
- `content/blog/translations/bn/662-cold-start-or-warm-start-measure-the-right-tv-launch.md`
- `content/blog/translations/bn/721-offline-storage-management-handbook.md`

Hindi: 10/10 fully read; Bengali: 10/10 fully read. Mechanical checks and complete numeric-token multiset comparisons passed for all 20 reviewed documents after correction. Numeric words, units, assumptions and conclusions were also checked during the full reading. The exact minimal frontmatter keys, source slug, LF-normalized source hash, H1/title agreement, language, UI headings, `in_review` status and `ai_assisted` method all passed for 20/20 documents.

## Concrete findings and correction verification

| File | Finding | Requested correction | State |
| --- | --- | --- | --- |
| hi/028 | Meta description made changing metadata the required next action; English says to check before changing it. Excerpt could imply an entire fictional series rather than a worked example. | Use the conditional ordering `मेटाडेटा बदलने से पहले...` and `एक काल्पनिक सीरीज़ का विस्तृत उदाहरण`. | Author applied; corrected full metadata lines independently re-read and accepted. |
| hi/442 | Error-cost paragraph said watching different series rather than viewing series independently. Guest-TV heading was awkward. | `सीरीज़ को स्वतंत्र रूप से देखने में`; `कभी-कभार मेहमानों द्वारा इस्तेमाल किया जाने वाला साझा टीवी`. | Author applied; corrected paragraph and heading independently re-read and accepted. |
| hi/561 | Sharpening table made a stronger causal assertion than the source's “contributed”. | Preserve contribution rather than sole causation: `तीखापन बढ़ाने का उन सीमाओं में योगदान था, सभी दोषों में नहीं`. | Author applied; complete corrected table row independently re-read and accepted. |
| hi/582 | Introductory grammar used `आपकी` rather than `आपको`; three “loud effects” phrases did not explicitly identify sound effects. | `आपको सुनाई देने वाली ध्वनि`; `तेज़ ध्वनि-प्रभाव` with the appropriate inflection. | Author applied; introductory summary and all three corrected paragraphs/list item independently re-read and accepted. |
| bn/442 | Guest-TV heading described guests arriving at a TV rather than occasionally using it. | `মাঝেমধ্যে অতিথিরাও ব্যবহার করেন এমন যৌথ টিভি`. | Author applied; corrected heading independently re-read and accepted. |
| bn/582 | `লাউডনেস-সম্মতি পরীক্ষা` used the word for consent where the source means loudness compliance. | `লাউডনেসের মানদণ্ড মেনে চলার ... পরীক্ষা`. | Author applied; full corrected limitations paragraph independently re-read and accepted. |

## Fidelity and evidence conclusions

No substantive omission remains in the 20 reviewed documents. In both languages, the complete articles, translated metadata, headings, examples, tables, FAQ answers, CTA, sources, links and the 161 screenshot description preserve the English meaning and qualifications.

| Articles | Independently checked boundaries |
| --- | --- |
| 028 | Six illustrative records are not six consecutive episodes; versions do not extend the sequence; the special's placement remains unknown; no inferred merge or renumbering feature. |
| 161 | The invented 0/2/1 query results remain separate from the recorded 10 September web observation. English screenshot labels, 12 grouped versions, source dependence, and the lack of playback/native-client/actor-search proof are retained. |
| 422 | Handoff, screen mirroring and receiver playback remain distinct; public Google Cast availability does not become a tested receiver or media combination. Privacy, source access and no-included-content limits remain explicit. |
| 442 | Independent progress, personal favourites, shared viewing and language preferences are preserved. Profiles are not access control, simultaneous-play permission or guaranteed state migration. |
| 502 | Embedded, external, image-based and burned-in text remain distinct. A working selector/off control does not identify storage. The Harbour Gate example remains fictional and does not imply Norva import support. |
| 561 | Same dimensions do not guarantee quality. The harbour comparison remains invented, sharpening contributes to outlines without explaining every defect, and two pause-free replays do not certify the network. |
| 582 | 0.20 × 0.5 = 0.10 and 0.60 × 0.5 = 0.30 remain exact. Threefold sample peaks do not establish threefold perceived loudness, a LUFS reading, a safe headphone level, or a slider target. |
| 602 | Throughput medians 82/28 Mbps, range 14–31 Mbps, timing and jitter examples, 8 Mbps = 1 MB/s, and the lack of a universal jitter threshold remain exact and qualified. RFC 7679/7680 links are unchanged. |
| 662 | Cold/warm/hot terminology is separated from observed preparations. Home/Back do not establish warm state. All four trials and 4.4–4.6 versus 1.2–1.4 seconds remain fictional, with reaction-time uncertainty and no cache-causation claim. |
| 721 | Fully downloaded items are distinguished from already-watched items. Removing A alone leaves 5.0 GB downloads, 7.2 GB app footprint, 15.0 GB free, an unexplained 2.2 GB balance and 9.0 GB above a fictional 6.0 GB reserve. Cache, app data and offline media are not interchangeable. |

All source link destinations and image paths are unchanged. English fictional work names were either retained or faithfully localized where this does not change the example; the English query terms and their matching catalogue titles in 161 remain consistent. No human/native review, additional product test, included media catalogue, new compatibility guarantee, or unsupported remedial control is claimed.

## English source fingerprints

Each filename below is under `content/blog/articles/` and was read completely. SHA-256 covers the complete source document, including frontmatter, after CRLF-to-LF normalization.

| English source file | Source SHA-256 |
| --- | --- |
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

SHA-256 covers each complete translated file, including its `in_review` frontmatter, after CRLF-to-LF normalization. These are the exact corrected bytes independently read and approved above. A later mechanical status-only change requires a separate release fingerprint; prose changes require renewed review.

| Translation key | Reviewed SHA-256 |
| --- | --- |
| hi/organize-seasons-episodes | ed436390be399c1e8620bdb291e690352bd634bc185cbe2c89ccca208825a942 |
| hi/personal-media-search-guide | 986294e5f3804beaf4265bebd44a430c713d1127a084d2c07c2276b622da1356 |
| hi/handoff-mirroring-or-casting-know-which-workflow-you-need | b85fde74a1632347b8a3d06cc4526a87c5c3450b88e183feeecd6ee11739845f |
| hi/separate-profiles-or-one-shared-profile-a-decision-framework | af3af241e6f67560888baa862f9b8bfba45ce653dcf3054b6dbd6ceb9084fc91 |
| hi/built-in-and-separate-subtitle-tracks-what-viewers-need-to-know | 549dda71ae5b136cc41e9fe035d294d6feb54eeee52b8e5f1a4afbdf26d9a86a |
| hi/the-complete-guide-to-understanding-video-quality | 00e2f7d1516059ae7c2d8d91c373c5f3f70b0f490f022ab1b6c766379e552e45 |
| hi/volume-and-loudness-why-they-are-not-identical | db55ce0db2091cee049307043b74cc02a8f52dc221220522673071992b719c77 |
| hi/bandwidth-throughput-latency-and-jitter-explained | e522ae3365b5c669ebadb83048821d4936d79016f773db9d4ea61605ed1dc1b5 |
| hi/cold-start-or-warm-start-measure-the-right-tv-launch | 8e8a903e2d7cf17655fb432a3340399cec768eb0468b42a135fa15127f5aebfe |
| hi/offline-storage-management-handbook | eef2c0865006466e3cb39451b6af4309c29d68b763292c8057926cb5dd0d8978 |
| bn/organize-seasons-episodes | 70ab025a2f252cb6b4fb1c6df33e13e3fa2f4020e157c7b35405bdce197e7681 |
| bn/personal-media-search-guide | 402c3cad9adab46bb214dcef0cc7da7f222506ab9eebf15a6dc0f86ef2bc1c63 |
| bn/handoff-mirroring-or-casting-know-which-workflow-you-need | 4f469fdf6b4f0a888c9f74390cfe6bfcac57728f0baa073ed45433a2ea4a51bf |
| bn/separate-profiles-or-one-shared-profile-a-decision-framework | 3d40872393ffcac716787cee8d316f2225b660c13539712811b8c05e282168fc |
| bn/built-in-and-separate-subtitle-tracks-what-viewers-need-to-know | ffa49bc41079c2c4b243f2eb63fd8d80ae082d32b0428663bf4ed0503010420e |
| bn/the-complete-guide-to-understanding-video-quality | e2dcb49ae8fd350bd5be84412af3a6f84c8599a085250706e2b3cc30a7d0b164 |
| bn/volume-and-loudness-why-they-are-not-identical | 868b7d31cb068179d683dd00255c416138ee831d8a9d23fe51d73d386afb198b |
| bn/bandwidth-throughput-latency-and-jitter-explained | 9da111569753e4204e2690d2b6f41b646f8cfe60e464f4c9bee1399c81b26495 |
| bn/cold-start-or-warm-start-measure-the-right-tv-launch | f99b18f20aee11bada94f3f1a261f32102b6c7a9c4c5bf6d5189bce6020c3630 |
| bn/offline-storage-management-handbook | 9d5965cd1c431463de84def4fb8419ad20003f30011035f17ef3ba1f1758a85d |
