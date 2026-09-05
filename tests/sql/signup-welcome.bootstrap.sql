-- DISPOSABLE DATABASE ONLY. Minimal schema; no provider or cron extensions.
\set ON_ERROR_STOP on
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key, email text, created_at timestamptz, email_confirmed_at timestamptz);
create table public.admin_internal_accounts(user_id uuid primary key);
create table public.cloud_entitlement_projection(user_id uuid primary key, welcome_email_at timestamptz,
 provider text, status text, dunning_stage integer, dunning_last_at timestamptz, winback_email_at timestamptz,
 trial_ends_at timestamptz, current_period_end timestamptz, trial_reminder_email_at timestamptz);
create table public.cloud_branded_email_outbox(id uuid primary key, user_id uuid,
 delivery_key text unique, state text, lease_token uuid, marker_kind text, marker_stage integer,
 marker_reference text, is_marketing boolean default false, transport_started_at timestamptz,
 updated_at timestamptz, last_error text, lease_expires_at timestamptz, recipient_email text,
 request_reply_to text, request_subject text, request_html text, request_text text,
 request_headers jsonb, payload_scrubbed_at timestamptz, resend_email_id text,
 resend_response jsonb, last_http_status integer, sent_at timestamptz, dead_lettered_at timestamptz,
 next_attempt_at timestamptz);
create table public.cloud_trial_reminder_deliveries(email_delivery_id uuid, user_id uuid,
 delivered_at timestamptz, trial_ends_at timestamptz);
create table public.cloud_revolut_orders(order_id text, user_id uuid, reminder_sent_at timestamptz,
 finalized_at timestamptz, superseded_at timestamptz, state text, reminder_claimed_at timestamptz, updated_at timestamptz);
create function public.norva_marketing_email_allowed(uuid) returns boolean language sql as 'select true';
