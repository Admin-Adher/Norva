-- Fix norva_password_changed_trg misfiring at sign-up.
--
-- The trigger fired on ANY encrypted_password change, guarded only by
--   WHEN (old.encrypted_password IS DISTINCT FROM new.encrypted_password).
-- That includes the first-ever password write (NULL/'' -> hash) performed via
-- UPDATE during account provisioning / OAuth password-set / invite-accept, and
-- re-submitting /signup for a still-unconfirmed email (GoTrue re-hashes the
-- password and re-sends confirmation). Result: users received the security
-- email "Your Norva password was changed" at sign-up, instead of / before the
-- welcome email.
--
-- Note: the 2026-06-26 "hardened" migration (20260626132237) only ran
-- CREATE OR REPLACE FUNCTION on the notify_* bodies and never re-created the
-- triggers, so this loose WHEN clause was still the live definition. The fix
-- must recreate the TRIGGER, not the function.
--
-- The new guard fires only for a genuine password change on an already-confirmed
-- account: it still fires on password reset/recovery completion and settings
-- password changes (old hash exists + account confirmed), but never on the
-- first-ever write, an unconfirmed (re-)signup, or the email-confirm transition.
drop trigger if exists norva_password_changed_trg on auth.users;
create trigger norva_password_changed_trg
  after update of encrypted_password on auth.users
  for each row
  when (
    old.encrypted_password is distinct from new.encrypted_password
    and old.encrypted_password is not null
    and old.encrypted_password <> ''
    and new.encrypted_password is not null
    and new.encrypted_password <> ''
    and old.email_confirmed_at is not null
  )
  execute function public.norva_notify_password_changed();
