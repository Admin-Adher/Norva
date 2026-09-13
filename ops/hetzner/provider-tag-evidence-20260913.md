# Provider-tag repair and unidentified-audio release — 2026-09-13

## Production outcome

The web, SQL and both Edge replicas now serve the unidentified-audio filter from
`49e62a1b45e432c2dbfe5ee601dae7468e8f8fc9`. The supervised release closed with
`updated=true`, `sqlApplied=true` and `cronsRestored=true`. Final checks confirmed
the Gateway container, runtime flags and quarantines were unchanged, and neither
release runner nor guard remained alive.

The user explicitly authorized interruption of the one blocking thumbnail pass.
The operator verified its PID, parent, start time, command digest and output path,
then sent SIGTERM using a pidfd to that exact process. No other process was
stopped, no Gateway restart occurred, and no storyboard table was edited.

Live browser checks on the connected account returned 6,258 movie titles and
2,292 series titles for “Langue non identifiée”. These are account-scoped counts
observed during the check, not fixed global catalogue totals. Series filters were
restored, and the movie unidentified-audio filter was retained for the user's audit.

## Why the reported labels survived the earlier correction

The six exact files were included in previous finite recheck plans but had no
completed execution receipts. Their legacy July/August audio maps still contained
RN, CH, HZ or NA, with no verified language result and no bound header profile.
The renderer correctly preferred what had been stored as accepted file evidence;
the previous display fallback change alone could not replace that stale data.

`scripts/repair-reported-provider-tags-20260913.py` completed one ordinary guarded
header request per exact provider file. Each response recorded `attempted=1`,
`persisted=1`, a bound fresh profile, and no speech-validation job. All six fresh
headers contained an AAC audio track **without a language tag**. The normal
persistence/hydration path replaced the obsolete maps and refreshed all 12 visible
variant observations across the two internal accounts; no direct language override
or blanket ISO-code blacklist was used.

| Reported file | Old label | Current supplier-based display |
| --- | --- | --- |
| Stranger in a Cab — FRQ | NA | Français |
| Cha Cha Real Smooth — NL | CH | Néerlandais |
| Bring Her Back — NL | HZ | Néerlandais |
| Man on the Run — NL | RN | Néerlandais |
| Band on the Run — EN | RN | Anglais |
| Band on the Run — NL | RN | Néerlandais |

All five title pages were inspected live. RN/CH/HZ/NA were absent from the reloaded
movie audio-filter options. The remaining unidentified Selection/SE versions were
not guessed or altered. Provider interpretation remains internal provenance, not
verified spoken-language evidence; a subtitle tag alone never becomes audio proof.

## Validation and audit boundary

- 37 focused JavaScript tests passed, including six new real-file regression cases,
  rare-language preservation, internal provenance, filter consistency and hydration.
- Six Python guard tests passed: exact finite scope, protected verified/bound/job
  states, immutable receipts, expiry and no cancellation/queue bypass.
- No application source changed for this finite data repair. The full application,
  SQL and Android verification for the filter remains recorded in the original
  release evidence; this repair adds operator/test/audit files only.
- Original dirty user checkout was preserved; publication used an isolated worktree.
- Private before/intent/probe/after receipts are retained under
  `/home/adrien/.norva/provider-tag-evidence-r2-20260913` and release evidence under
  `/home/adrien/.norva/unidentified-audio-release-r2-20260913`.
- The earlier no-I/O attempt and older unexecuted plans were retained, not reset.

## Follow-up BG question (read-only)

BG maps to Bulgarian in both the shared provider grammar and the WebView. The
Bring Her Back BG version currently has a stored EN audio track at index 1 and a
BG SubRip subtitle at index 2. This explains “Anglais” plus “ST BG · BG”: BG is not
being translated to English. However, that audio observation dates from
2026-08-09 and has neither language verification nor a bound fresh profile. It is
not proof of the current spoken soundtrack. This follow-up inspection changed no
language data and performed no additional provider request.
