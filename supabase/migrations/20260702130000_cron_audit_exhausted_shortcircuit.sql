-- Cron audit — follow-up round: exhausted-dimension short-circuit (#11, CORRECTED) + autovacuum
-- tuning (#7, CORRECTED).
--
-- (#11) An EXHAUSTED enrichment dimension still cost a full variant-driven panel scan per tick
-- (airysat: 357 ms / 46 109 buffers to return 0; post-drain trajectory: ninja/promax up to 360
-- ticks/day × up to 6 chain dims × up to 172k-variant scans). The originally proposed sentinel
-- (audio_languages='{und}') was REFUTED by verification: the scan visits EVERY panel variant
-- (resolved titles are rejected at the same cost as deterministic negatives), so removing negatives
-- changes neither the plan shape nor the buffer count — and '{und}' would break
-- fill_user_audio_from_catalog (predicate audio_languages='{}') and the UI audio badge. The
-- corrected primary fix: remember "this (user, source, dimension) returned 0 candidates" and skip
-- the dimension entirely for a SHORT TTL (30 min — bounded by the auto-refresh import cadence, so
-- new content is picked up within one refresh cycle). A tick that processes work clears the mark.
-- Zero semantic change; an exhausted panel now costs one PK read instead of up to 6 panel scans.
-- Enforced in norva-playback/runAudioBackfill (both the single-dim and fallthrough-chain paths;
-- targeted/on-demand modes — titleIds/orderedTitleIds/catalog/transcribe — are never short-circuited).
create table if not exists public.enrichment_exhausted (
  k               text primary key,   -- "<userId>:<sourceId|*>:<movie|series>:<vod|probe|subtitle|whisper>"
  exhausted_until timestamptz not null,
  updated_at      timestamptz not null default now()
);
alter table public.enrichment_exhausted enable row level security;  -- service-role only (no policies)

-- (#7) The per-source media_items/variants counts in refresh_admin_dashboard pay a visibility-map
-- tax: ~130k heap fetches/run because the sync churn (3.0M deletes + 2.7M inserts on
-- cloud_media_items) invalidates the VM while default autovacuum (scale_factor 0.2, ~2-4 runs/day)
-- can't keep it fresh. Verified correction: insert_scale_factor is REQUIRED — the churn is mostly
-- delete+insert, which default settings barely count. Measured residual of the sources blob is
-- ~7-9 s; expected gain 2-5 s/run. Incremental vacuums at these thresholds only visit
-- non-all-visible pages and are throttled by autovacuum_cost_delay.
alter table public.cloud_media_items set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.05
);
alter table public.cloud_title_variants set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.05
);
