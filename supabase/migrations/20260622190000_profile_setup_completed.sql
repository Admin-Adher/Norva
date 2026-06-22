-- First-run profile personalisation (Netflix-style).
--
-- The default profile is auto-provisioned server-side (getOrCreateDefaultProfileId)
-- with avatar-01 and the account name. This flag lets the client show a one-time
-- "Set up your profile" screen (pick name + avatar) the first time, and never
-- again once completed or skipped. Explicitly-created profiles start true.
alter table public.cloud_account_profiles
  add column if not exists setup_completed boolean not null default false;

comment on column public.cloud_account_profiles.setup_completed is
  'True once the profile has been personalised (name/avatar chosen) or first-run setup was skipped. Auto-provisioned default profiles start false to trigger the one-time setup screen.';
