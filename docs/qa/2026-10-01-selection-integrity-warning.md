# Exact-file advisory (implementation complete; runtime validation pending)

The server helper attaches a bounded status/checkedAt advisory only to an owned
canonical Selection movie variant whose current URL digest matches a terminal
SELECTION_AUDIO_SOURCE_TRUNCATED job. Generic failures, unfinished/recovered
jobs, other owners/sources, changed URLs, future timestamps and evidence older
than 24 hours are excluded. The timestamp is the terminal completed_at.
Catalogue visibility, entitlement and play actions remain available.

Wired paths: grouped title variants and flat movie lists in norva-catalog,
public payload sanitizer, and the exact selected version in MoviesPage. The
public payload contains no URL/hash, job id or raw error. The API's existing
variant normalization preserves the field. The warning clears when changing
to a healthy version and also rejects expired cached evidence in the browser.
Ten locales are registered; the standard i18n build updates generated bundles,
resource entries and asset references.

Verification: 15 focused server/public-payload/actual-page-method tests passed;
strict i18n build check passed. The Android WebView fixture now exercises the
actual warning renderer/CSS at portrait and landscape dimensions, font/text
scales 100/130 and ten languages, including healthy-version clearing and RTL
bounds. Its runtime execution is still pending; adding the fixture is not proof
that it passed. Physical ADB currently lists no devices.

No publication of this warning yet. Main Gateway rollout independently remains
pending live transcription PID3002824. The full commercial objective is open.
