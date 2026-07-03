-- Switch the Stancer payment rail to USD (global settlement currency, better for
-- international scaling). Stancer accepts USD (settles to the EUR bank account).
-- All edge-function inserts now pass currency='usd' explicitly; this only realigns
-- the column DEFAULT so any future implicit insert is correct too. No table rewrite.

alter table if exists public.cloud_stancer_payments
  alter column currency set default 'usd';
