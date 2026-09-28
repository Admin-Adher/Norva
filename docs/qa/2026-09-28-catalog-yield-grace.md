# Catalogue priority survives scheduler gaps

Production observation: job `7035c6bd-762f-4513-8666-fa2417d8ad32`
requested priority at 21:52 UTC. Its 90-second hold expired at 21:53:30;
catalogue activity resumed at 21:54:03 and moved the five-minute foreground
grace to 21:59:03. The two-job retry scheduler may serve other accounts between
attempts, so a 90-second renewal requirement cannot protect the full grace.

The migration changes only the three hold-duration literals in the installed
request function, with an exact baseline guard. Six minutes covers the existing
five-minute activity grace plus one scheduler interval. It preserves the shared
ten-minute maximum window, two-minute cooldown, owned live-job lease check,
foreground activity ledger, cancellation/quarantine release and service-only
permissions. It grants no provider socket or playback exception.

Trade-off: if a worker disappears while its durable job remains pending,
catalogue background work on that account may yield for up to six minutes
instead of ninety seconds. Playback is unaffected. The bounded shared window
still prevents jobs on the same account from extending priority indefinitely.

Verification: 32 assertions passed in disposable networkless PostgreSQL15.
Without this migration, the same fixture fails at
`hold_covers_full_foreground_grace`. The fixture also simulates a two-minute
scheduler gap and checks that catalogue requests still yield, while foreground
activity still blocks audio. Both temporary database containers were removed.

Not yet deployed. CI, integration and live confirmation remain required.
