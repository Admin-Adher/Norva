-- DISPOSABLE DATABASE ONLY, after behavioral bootstrap/engine/timezone.
-- The behavioral predicates and Postal core are real. Only unrelated mature
-- schemas not traversed by this proof are represented by minimal prerequisites.
alter table public.cloud_branded_email_outbox add column mail_provider text not null default 'postal';
alter table public.cloud_branded_email_outbox add column postal_response jsonb;
create schema norva_postal_queue;
create table norva_postal_queue.bindings(outbox_id uuid);
create table public.cloud_email_suppressions(email text primary key, active boolean not null);
