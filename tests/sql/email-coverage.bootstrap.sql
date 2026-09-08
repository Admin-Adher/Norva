-- Add production-shaped Auth event tables to the networkless lifecycle fixture.
alter table auth.users add column email_confirmed_at timestamptz,
 add column phone text,add column phone_confirmed_at timestamptz;
create table auth.identities(id uuid primary key,user_id uuid references auth.users(id) on delete cascade);
create table auth.mfa_factors(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,status text not null);
alter table public.cloud_revolut_customers add column amount_cents integer,
 add column discount_next_pct integer,add column pending_effective_at timestamptz;
create table public.fixture_renewals(user_id uuid,renews_at timestamptz,cycle_key text);
create function public.norva_pending_renewal_emails(integer default 100)
returns table(user_id uuid,renews_at timestamptz,cycle_key text)
language sql as 'select * from public.fixture_renewals limit $1';
-- Capture only; no transport exists in this fixture.
create table public.captured_security_email(id uuid default gen_random_uuid(),recipient text,flow text,dedupe text unique,user_id uuid);
create function public.norva_enqueue_branded_email(text,text,text,text,text,text,text,text,text,uuid)
returns uuid language plpgsql as $$declare v_id uuid;begin
 insert into public.captured_security_email(recipient,flow,dedupe,user_id)
 values($1,$8,$9,$10) on conflict(dedupe) do nothing returning id into v_id;
 return coalesce(v_id,(select id from public.captured_security_email where dedupe=$9));end$$;
