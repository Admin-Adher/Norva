-- Lifecycle-email send markers on the entitlement projection, so the norva-lifecycle cron
-- sends each message once (or, for dunning, in bounded escalating stages). Additive + nullable:
-- the billing webhook's upserts are unaffected.
ALTER TABLE public.cloud_entitlement_projection
  ADD COLUMN IF NOT EXISTS welcome_email_at        timestamptz,
  ADD COLUMN IF NOT EXISTS trial_reminder_email_at timestamptz,
  ADD COLUMN IF NOT EXISTS winback_email_at        timestamptz,
  ADD COLUMN IF NOT EXISTS dunning_last_at         timestamptz,
  ADD COLUMN IF NOT EXISTS dunning_stage           smallint NOT NULL DEFAULT 0;

-- Partial indexes to keep the cron's "who still needs X" scans cheap.
CREATE INDEX IF NOT EXISTS idx_entproj_welcome_pending
  ON public.cloud_entitlement_projection (created_at)
  WHERE welcome_email_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entproj_trial_reminder_pending
  ON public.cloud_entitlement_projection (trial_ends_at)
  WHERE trial_reminder_email_at IS NULL AND status = 'trialing';
