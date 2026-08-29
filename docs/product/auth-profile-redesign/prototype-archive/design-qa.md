# Prototype L design QA

Date: 2026-08-29

## Scope

- Local prototype only; no production files or Provider Access rollout state changed.
- Primary viewport: 390 x 844.
- Compact viewport: 375 x 667.
- Landscape viewport: 844 x 390.
- Large-text fixture: 390 x 844 at font scale 1.3.

## Visual sources

- Netflix welcome reference: `C:\Users\ADRIEN~1\AppData\Local\Temp\codex-clipboard-ba488bd5-f866-4284-a5eb-f5af62169e7f.png`
- Netflix second welcome reference: `C:\Users\ADRIEN~1\AppData\Local\Temp\codex-clipboard-632c6e76-b119-4f3f-b22b-b43dd465d892.png`
- Netflix email reference: `C:\Users\ADRIEN~1\AppData\Local\Temp\codex-clipboard-2a2d59b5-116e-42f9-8a80-6a145e33e2f3.png`
- Netflix code reference: `C:\Users\ADRIEN~1\AppData\Local\Temp\codex-clipboard-18a6efcd-b1a3-414d-bcdd-63ef0c194ca9.png`
- Netflix checking reference: `C:\Users\ADRIEN~1\AppData\Local\Temp\codex-clipboard-414da139-0abf-4976-8f87-ab10d173dc9e.png`
- Norva duplicate-brand report: `C:\Users\ADRIEN~1\AppData\Local\Temp\codex-clipboard-234cf9c8-d3de-4b1c-9619-45df9ed2d35f.png`
- Netflix profile chooser reference: `C:\Users\ADRIEN~1\AppData\Local\Temp\codex-clipboard-afa5ec05-506b-4b8a-b884-7ccc95eb9095.png`
- Netflix profile management reference: `C:\Users\ADRIEN~1\AppData\Local\Temp\codex-clipboard-c9200d4e-bc59-41f0-827a-45fe985726e5.png`
- Netflix create-profile reference: `C:\Users\ADRIEN~1\AppData\Local\Temp\codex-clipboard-5ae702da-f70b-4871-84ac-4622b4dbd03.png`
- Netflix avatar-library reference: `C:\Users\ADRIEN~1\AppData\Local\Temp\codex-clipboard-5ec3af29-5867-49c7-a4e8-1204562a6f7e.png`

## Implementation evidence

- `qa-evidence/welcome-prototype-390x844.png`
- `qa-evidence/email-prototype-390x844.png`
- `qa-evidence/code-prototype-390x844.png`
- `qa-evidence/verify-prototype-390x844.png`
- `qa-evidence/new-prototype-390x844.png`
- `qa-evidence/password-prototype-390x844.png`
- `qa-evidence/profile-chooser-390x844.png`
- `qa-evidence/profile-setup-390x844.png`
- `qa-evidence/profile-avatars-390x844.png`
- `qa-evidence/profile-manage-390x844.png`
- `qa-evidence/profile-edit-390x844.png`
- `qa-evidence/profile-reference-comparison.png`
- Responsive fixture board: `qa-l.html`
- Interactive funnel board: `profile-funnels.html`

## States exercised

1. Welcome.
2. Email entry.
3. Existing-account secure code.
4. Code checking.
5. New-account email verification.
6. Optional password fallback.
7. Returning-account profile chooser.
8. First-profile setup.
9. Avatar selection from the real Norva avatar set.
10. Profile management and edit.
11. Profile-created and Home handoff states.

## Full-view findings

- The Norva mark appears exactly once on every exercised state.
- Welcome keeps the single `Get started` entry action; no duplicate `Sign in` action returned.
- Email entry now says `Enter your email.` so the persistent `Norva` wordmark is not repeated in the heading.
- The blue-to-indigo brand gradient remains legible across all auth states.
- Mobile, compact, landscape, and 1.3 font-scale fixtures have no horizontal or vertical document overflow.
- Every exercised profile state reported `scrollWidth == clientWidth` and `scrollHeight == clientHeight`.
- Every exercised profile state reported zero visible `Kids` strings.

## Focused-region findings

- Header: back target, wordmark, progress indicator, and help link remain distinct at 390 px and 844 px widths.
- The wordmark uses the real Norva app icon and remains visible during email, code, checking, account creation, and password fallback.
- OTP, primary actions, Google action, and fallback actions retain at least 44 CSS px hit targets.
- No visible crop, overlap, empty poster gap, or duplicate wordmark remains in the checked fixtures.
- Profile setup now asks only for the profile name and avatar, matching Norva's current profile model.
- The chooser, management view, setup form, and avatar library reuse the real Norva avatars and keep the product's blue/indigo visual language.

## Fix history

- Fixed the one-time-code fixture's initially blank first digit.
- Removed the redundant welcome `Sign in` action.
- Added known-account versus new-account routing, with password kept as an optional existing-account fallback.
- Added the Norva blue/indigo/black auth gradient.
- Moved the Norva wordmark into the persistent auth header because the previous scene-hosted mark was hidden.
- Replaced `Continue to Norva.` with `Enter your email.` to remove the visible brand repetition.
- Added returning-user, first-profile, profile-management, avatar-selection, success, and Home-handoff prototype states.
- Removed the proposed Kids-profile control after confirming that Norva does not offer a Kids profile mode.
- Compared the Netflix reference and Norva prototype together in `qa-evidence/profile-reference-comparison.png`; retained the concise hierarchy while removing Netflix-only functionality and branding.

## Final result

final result: passed
