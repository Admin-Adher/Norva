create role supabase_admin superuser;set role supabase_admin;create role anon;create role authenticated;create role service_role;
create schema auth;create table auth.users(id uuid,email text);create table public.admin_internal_accounts(user_id uuid);
create schema norva_postal_queue;create table norva_postal_queue.bindings(outbox_id uuid);
create table public.cloud_entitlement_projection(user_id uuid,provider text,status text,trial_ends_at timestamptz,current_period_end timestamptz,welcome_email_at timestamptz,dunning_stage smallint,dunning_last_at timestamptz,winback_email_at timestamptz,trial_reminder_email_at timestamptz);
create table public.cloud_trial_reminder_deliveries(user_id uuid,email_delivery_id uuid,trial_ends_at timestamptz,delivered_at timestamptz);
create table public.cloud_revolut_orders(order_id text,user_id uuid,reminder_sent_at timestamptz,reminder_claimed_at timestamptz,finalized_at timestamptz,superseded_at timestamptz,state text,updated_at timestamptz);
create table public.catalog_generated_subtitle_notifications(id uuid,status text,sent_at timestamptz,email text,title_label text,source_id uuid,series_id uuid);
create table public.behavioral_lifecycle_outbox(id uuid,email_outbox_id uuid,journey_key text,user_id uuid,status text);
create table public.behavioral_lifecycle_journeys(journey_key text,quiet_start_hour integer,quiet_end_hour integer);
create table public.behavioral_lifecycle_user_state(user_id uuid,timezone text);
create table public.proof_controls(marketing boolean,eligible boolean,wait_seconds integer);insert into public.proof_controls values(true,true,0);
create function public.norva_marketing_email_allowed(uuid) returns boolean language sql as $$select marketing from public.proof_controls$$;
create function public.norva_signup_welcome_eligible(uuid) returns boolean language sql as $$select eligible from public.proof_controls$$;
create function public.norva_behavioral_delivery_eligible(uuid,timestamptz) returns boolean language sql as $$select eligible from public.proof_controls$$;
create function public.norva_behavioral_next_allowed_at(timestamptz,text,integer,integer) returns timestamptz language sql as $$select $1+make_interval(secs=>wait_seconds) from public.proof_controls$$;
create function public.norva_behavioral_frequency_allowed_at(uuid,text,text,timestamptz,uuid) returns timestamptz language sql as $$select $4$$;
create function public.norva_provider_access_notification_business_eligible(uuid,uuid,uuid,text) returns boolean language sql as $$select false$$;
create function public.norva_provider_access_rollout_eligible_internal(uuid) returns boolean language sql as $$select false$$;
create table public.cloud_branded_email_outbox("id" uuid,"delivery_key" text,"dedupe_key" text,"user_id" uuid,"flow" text,"state" text,"recipient_email" text,"request_from" text,"request_reply_to" text,"request_subject" text,"request_html" text,"request_text" text,"request_tags" jsonb,"attempt_count" integer,"next_attempt_at" timestamp with time zone,"last_attempt_at" timestamp with time zone,"lease_token" uuid,"lease_expires_at" timestamp with time zone,"resend_email_id" text,"resend_response" jsonb,"last_http_status" integer,"last_error" text,"sent_at" timestamp with time zone,"dead_lettered_at" timestamp with time zone,"created_at" timestamp with time zone,"updated_at" timestamp with time zone,"is_marketing" boolean,"request_headers" jsonb,"marker_kind" text,"marker_reference" text,"marker_stage" smallint,"transport_started_at" timestamp with time zone,"payload_scrubbed_at" timestamp with time zone,"mail_provider" text,"postal_message_id" bigint,"postal_response" jsonb);
create table public.cloud_support_email_outbox("delivery_key" text,"request_id" uuid,"message_id" uuid,"ticket_id" uuid,"direction" text,"state" text,"recipient_email" text,"request_from" text,"request_reply_to" text,"request_subject" text,"request_html" text,"request_text" text,"request_tags" jsonb,"attempt_count" integer,"next_attempt_at" timestamp with time zone,"lease_token" uuid,"lease_expires_at" timestamp with time zone,"transport_started_at" timestamp with time zone,"resend_email_id" text,"resend_response" jsonb,"last_http_status" integer,"last_error" text,"sent_at" timestamp with time zone,"exhausted_at" timestamp with time zone,"payload_scrubbed_at" timestamp with time zone,"created_at" timestamp with time zone,"updated_at" timestamp with time zone);
create table public.cloud_account_deletion_email_outbox("account_key" text,"delivery_key" text,"state" text,"recipient_email" text,"request_from" text,"request_reply_to" text,"request_subject" text,"request_html" text,"request_text" text,"request_tags" jsonb,"prepared_at" timestamp with time zone,"prepare_expires_at" timestamp with time zone,"deletion_confirmed_at" timestamp with time zone,"attempt_count" integer,"next_attempt_at" timestamp with time zone,"lease_token" uuid,"lease_expires_at" timestamp with time zone,"resend_email_id" text,"resend_response" jsonb,"last_http_status" integer,"last_error" text,"sent_at" timestamp with time zone,"exhausted_at" timestamp with time zone,"created_at" timestamp with time zone,"updated_at" timestamp with time zone,"transport_started_at" timestamp with time zone);
create table public.cloud_billing_receipt_outbox("delivery_key" text,"ledger_pi_id" text,"user_id" uuid,"recipient_email" text,"first_name" text,"plan_label" text,"amount_cents" integer,"currency" text,"period_end" timestamp with time zone,"request_from" text,"request_subject" text,"request_html" text,"prepared_at" timestamp with time zone,"attempt_count" integer,"next_attempt_at" timestamp with time zone,"lease_token" uuid,"lease_expires_at" timestamp with time zone,"resend_email_id" text,"resend_response" jsonb,"last_http_status" integer,"last_error" text,"sent_at" timestamp with time zone,"exhausted_at" timestamp with time zone,"created_at" timestamp with time zone,"updated_at" timestamp with time zone,"request_text" text,"request_reply_to" text,"request_tags" jsonb,"user_pseudonym" text,"idempotency_started_at" timestamp with time zone,"delivery_uncertain" boolean,"quarantined_at" timestamp with time zone);
create table public.cloud_import_notifications("id" uuid,"user_id" uuid,"source_id" uuid,"kind" text,"payload" jsonb,"status" text,"created_at" timestamp with time zone,"sent_at" timestamp with time zone,"delivery_key" uuid,"lease_token" uuid,"lease_expires_at" timestamp with time zone,"attempt_count" integer,"next_attempt_at" timestamp with time zone,"last_attempt_at" timestamp with time zone,"last_http_status" integer,"last_error" text,"resend_email_id" text,"resend_response" jsonb,"recipient_email" text,"request_from" text,"request_reply_to" text,"request_subject" text,"request_html" text,"request_text" text,"request_tags" jsonb,"prepared_at" timestamp with time zone,"dead_lettered_at" timestamp with time zone,"updated_at" timestamp with time zone);
create table public.catalog_subtitle_email_deliveries("id" uuid,"notification_id" uuid,"delivery_key" text,"user_id" uuid,"title_label" text,"source_id" text,"series_id" text,"item_type" text,"external_id" text,"kind" text,"lang" text,"status" text,"attempt_count" integer,"next_attempt_at" timestamp with time zone,"last_attempt_at" timestamp with time zone,"lease_token" uuid,"lease_expires_at" timestamp with time zone,"recipient_email" text,"request_from" text,"request_reply_to" text,"request_subject" text,"request_html" text,"request_text" text,"request_tags" jsonb,"prepared_at" timestamp with time zone,"idempotency_started_at" timestamp with time zone,"delivery_uncertain" boolean,"quarantined_at" timestamp with time zone,"bell_created_at" timestamp with time zone,"sent_at" timestamp with time zone,"dead_lettered_at" timestamp with time zone,"last_http_status" integer,"last_error" text,"resend_email_id" text,"resend_response" jsonb,"created_at" timestamp with time zone,"updated_at" timestamp with time zone);
create table public.cloud_email_suppressions("email" text,"reason" text,"source_event_id" text,"source_email_id" text,"active" boolean,"first_seen_at" timestamp with time zone,"last_seen_at" timestamp with time zone,"resolved_at" timestamp with time zone,"created_at" timestamp with time zone,"updated_at" timestamp with time zone,"complaint_seen_at" timestamp with time zone,"provider_suppression_seen_at" timestamp with time zone,"postal_review_required_at" timestamp with time zone);
create table public.cloud_provider_access_notifications("id" uuid,"user_id" uuid,"source_id" uuid,"access_cycle_id" uuid,"event_kind" text,"channel" text,"state" text,"scheduled_at" timestamp with time zone,"delivery_key" text,"lease_owner" text,"lease_sequence" bigint,"lease_expires_at" timestamp with time zone,"attempt_count" integer,"next_attempt_at" timestamp with time zone,"transport_started_at" timestamp with time zone,"last_attempt_at" timestamp with time zone,"last_error_code" text,"completion_code" text,"provider_message_id" text,"delivered_at" timestamp with time zone,"dismissed_at" timestamp with time zone,"superseded_at" timestamp with time zone,"dead_lettered_at" timestamp with time zone,"created_at" timestamp with time zone,"updated_at" timestamp with time zone,"readiness_rollout_revision" bigint);
alter table public.cloud_email_suppressions add primary key(email);
CREATE OR REPLACE FUNCTION public.norva_redact_billing_receipt_text(p_value text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE STRICT
 SET search_path TO 'pg_catalog'
AS $function$
  select left(
    regexp_replace(
      regexp_replace(
        p_value,
        '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}',
        '[email]',
        'gi'
      ),
      '(re_|whsec_)[A-Za-z0-9_-]{12,}',
      '[credential]',
      'g'
    ),
    500
  )
$function$
;
CREATE OR REPLACE FUNCTION public.norva_redact_subtitle_email_text(p_value text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE STRICT
 SET search_path TO 'pg_catalog'
AS $function$
  select left(
    regexp_replace(
      regexp_replace(
        p_value,
        '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}',
        '[email]',
        'gi'
      ),
      '(re_|whsec_)[A-Za-z0-9_-]{12,}',
      '[credential]',
      'g'
    ),
    500
  )
$function$
;
CREATE OR REPLACE FUNCTION public.complete_import_notification_delivery(p_delivery_key uuid, p_notification_ids uuid[], p_lease_token uuid, p_recipient_email text, p_http_status integer, p_resend_email_id text, p_response jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_expected integer := coalesce(cardinality(p_notification_ids), 0);
  v_matched integer;
  v_now timestamptz := clock_timestamp();
begin
  if v_expected < 1
     or p_http_status not between 200 and 299
     or nullif(btrim(p_resend_email_id), '') is null
     or nullif(lower(btrim(p_recipient_email)), '') is null then
    return false;
  end if;

  perform n.id
  from public.cloud_import_notifications n
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token
    and n.recipient_email = lower(btrim(p_recipient_email))
    and n.request_from is not null
    and n.request_reply_to is not null
    and n.request_subject is not null
    and n.request_html is not null
    and n.request_text is not null
    and n.request_tags is not null
    and n.prepared_at is not null
  for update;
  get diagnostics v_matched = row_count;

  if v_matched <> v_expected then return false; end if;

  update public.cloud_import_notifications n
  set status = 'sent',
      sent_at = v_now,
      payload = '{}'::jsonb,
      recipient_email = null,
      request_from = null,
      request_reply_to = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      request_tags = null,
      last_http_status = p_http_status,
      last_error = null,
      resend_email_id = btrim(p_resend_email_id),
      resend_response = '{}'::jsonb,
      lease_token = null,
      lease_expires_at = null,
      next_attempt_at = v_now,
      dead_lettered_at = null,
      updated_at = v_now
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token
    and n.recipient_email = lower(btrim(p_recipient_email));

  return true;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.fail_import_notification_delivery(p_delivery_key uuid, p_notification_ids uuid[], p_lease_token uuid, p_retryable boolean, p_http_status integer DEFAULT NULL::integer, p_response jsonb DEFAULT NULL::jsonb, p_error text DEFAULT NULL::text, p_max_attempts integer DEFAULT 8, p_base_backoff_seconds integer DEFAULT 120, p_max_backoff_seconds integer DEFAULT 21600)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_expected integer := coalesce(cardinality(p_notification_ids), 0);
  v_matched integer;
  v_attempt integer;
  v_delay integer;
  v_now timestamptz := clock_timestamp();
  v_terminal boolean;
begin
  if v_expected < 1 or p_max_attempts < 1 or p_base_backoff_seconds < 1
     or p_max_backoff_seconds < p_base_backoff_seconds then
    return 'stale_or_invalid';
  end if;

  perform n.id
  from public.cloud_import_notifications n
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token
  for update;
  get diagnostics v_matched = row_count;

  if v_matched <> v_expected then return 'stale_or_invalid'; end if;

  select max(n.attempt_count) into v_attempt
  from public.cloud_import_notifications n
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token;

  v_terminal := not coalesce(p_retryable, false) or v_attempt >= p_max_attempts;
  v_delay := least(
    p_max_backoff_seconds,
    floor(p_base_backoff_seconds * power(2::numeric, greatest(v_attempt - 1, 0)))::integer
      + floor(random() * greatest(p_base_backoff_seconds, 1))::integer
  );

  update public.cloud_import_notifications n
  set status = case when v_terminal then 'dead_letter' else 'pending' end,
      next_attempt_at = case when v_terminal then v_now else v_now + make_interval(secs => v_delay) end,
      last_http_status = p_http_status,
      last_error = left(coalesce(nullif(p_error, ''), 'import notification delivery failed'), 2000),
      resend_response = case when v_terminal then '{}'::jsonb else coalesce(p_response, '{}'::jsonb) end,
      payload = case when v_terminal then '{}'::jsonb else n.payload end,
      recipient_email = case when v_terminal then null else n.recipient_email end,
      request_from = case when v_terminal then null else n.request_from end,
      request_reply_to = case when v_terminal then null else n.request_reply_to end,
      request_subject = case when v_terminal then null else n.request_subject end,
      request_html = case when v_terminal then null else n.request_html end,
      request_text = case when v_terminal then null else n.request_text end,
      request_tags = case when v_terminal then null else n.request_tags end,
      lease_token = null,
      lease_expires_at = null,
      dead_lettered_at = case when v_terminal then v_now else null end,
      updated_at = v_now
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token;

  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.fail_billing_receipt_delivery(p_delivery_key text, p_lease_token uuid, p_http_status integer, p_error text, p_response jsonb DEFAULT '{}'::jsonb, p_retryable boolean DEFAULT true, p_retry_after_seconds integer DEFAULT NULL::integer, p_max_attempts integer DEFAULT 12)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt integer;
  v_terminal boolean;
  v_delay_seconds integer;
  v_changed integer;
begin
  select o.attempt_count into v_attempt
  from public.cloud_billing_receipt_outbox o
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null
  for update;

  if not found then return 'lease_lost'; end if;

  v_terminal := not coalesce(p_retryable, false)
    or v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30));
  v_delay_seconds := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );

  update public.cloud_billing_receipt_outbox o
  set resend_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = left(coalesce(nullif(p_error, ''), 'delivery_failed'), 1000),
      exhausted_at = case when v_terminal then v_now else null end,
      next_attempt_at = case when v_terminal then o.next_attempt_at
                             else v_now + make_interval(secs => v_delay_seconds) end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null;
  get diagnostics v_changed = row_count;

  if v_changed <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$
;
CREATE OR REPLACE FUNCTION public.norva_safe_billing_receipt_provider_response(p_value jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', nullif(left(btrim(coalesce(p_value->>'id', '')), 200), ''),
    'name', public.norva_redact_billing_receipt_text(
      nullif(coalesce(p_value->>'name', p_value->>'type', p_value->>'code'), '')
    ),
    'message', public.norva_redact_billing_receipt_text(
      nullif(coalesce(p_value->>'message', p_value->>'error', p_value->>'response'), '')
    ),
    'status_code', case
      when coalesce(p_value->>'status_code', p_value->>'statusCode', '') ~ '^[0-9]{3}$'
        then (coalesce(p_value->>'status_code', p_value->>'statusCode'))::integer
      else null
    end
  ))
$function$
;
CREATE OR REPLACE FUNCTION public.complete_billing_receipt_delivery(p_delivery_key text, p_lease_token uuid, p_resend_email_id text, p_http_status integer, p_response jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_changed integer;
begin
  if p_http_status not between 200 and 299
     or nullif(btrim(p_resend_email_id), '') is null then
    raise exception 'successful Resend status and email id are required';
  end if;

  update public.cloud_billing_receipt_outbox o
  set resend_email_id = btrim(p_resend_email_id),
      resend_response = public.norva_safe_billing_receipt_provider_response(
        coalesce(p_response, '{}'::jsonb)
      ),
      last_http_status = p_http_status,
      last_error = null,
      sent_at = clock_timestamp(),
      exhausted_at = null,
      quarantined_at = null,
      delivery_uncertain = false,
      lease_token = null,
      lease_expires_at = null,
      recipient_email = null,
      first_name = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$
;
CREATE OR REPLACE FUNCTION public.fail_billing_receipt_delivery_v2(p_delivery_key text, p_lease_token uuid, p_http_status integer, p_error text, p_response jsonb DEFAULT '{}'::jsonb, p_retryable boolean DEFAULT true, p_retry_after_seconds integer DEFAULT NULL::integer, p_max_attempts integer DEFAULT 12, p_ambiguous boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt integer;
  v_was_uncertain boolean;
  v_terminal boolean;
  v_delay_seconds integer;
  v_changed integer;
begin
  select o.attempt_count, o.delivery_uncertain
    into v_attempt, v_was_uncertain
  from public.cloud_billing_receipt_outbox o
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null
  for update;
  if not found then return 'lease_lost'; end if;

  v_was_uncertain := coalesce(v_was_uncertain, false) or coalesce(p_ambiguous, false);
  v_terminal := not coalesce(p_retryable, false)
    or (not v_was_uncertain
      and v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30)));
  v_delay_seconds := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );

  update public.cloud_billing_receipt_outbox o
  set resend_response = public.norva_safe_billing_receipt_provider_response(
        coalesce(p_response, '{}'::jsonb)
      ),
      last_http_status = p_http_status,
      last_error = public.norva_redact_billing_receipt_text(
        coalesce(nullif(p_error, ''), 'delivery_failed')
      ),
      delivery_uncertain = v_was_uncertain,
      exhausted_at = case when v_terminal then v_now else null end,
      next_attempt_at = case when v_terminal then o.next_attempt_at
                             else v_now + make_interval(secs => v_delay_seconds) end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$
;
CREATE OR REPLACE FUNCTION public.complete_account_deletion_email_delivery(p_delivery_key text, p_lease_token uuid, p_resend_email_id text, p_http_status integer, p_response jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_changed integer;
begin
  if p_http_status not between 200 and 299
     or nullif(btrim(p_resend_email_id), '') is null then
    raise exception 'successful Resend status and email id are required';
  end if;

  update public.cloud_account_deletion_email_outbox o
  set state = 'sent',
      resend_email_id = btrim(p_resend_email_id),
      resend_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = null,
      sent_at = clock_timestamp(),
      lease_token = null,
      lease_expires_at = null,
      -- Immediate data minimization after provider acceptance.
      recipient_email = null,
      request_html = null,
      request_text = null,
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$
;
CREATE OR REPLACE FUNCTION public.fail_account_deletion_email_delivery(p_delivery_key text, p_lease_token uuid, p_http_status integer, p_error text, p_response jsonb DEFAULT '{}'::jsonb, p_retryable boolean DEFAULT true, p_retry_after_seconds integer DEFAULT NULL::integer, p_max_attempts integer DEFAULT 12)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt integer;
  v_transport_started_at timestamptz;
  v_terminal boolean;
  v_idempotency_window_terminal boolean := false;
  v_delay_seconds integer;
  v_changed integer;
begin
  select o.attempt_count, o.transport_started_at
  into v_attempt, v_transport_started_at
  from public.cloud_account_deletion_email_outbox o
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token
  for update;
  if not found then return 'lease_lost'; end if;

  v_delay_seconds := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );
  v_idempotency_window_terminal := v_transport_started_at is not null
    and v_now + make_interval(secs => v_delay_seconds)
      >= v_transport_started_at + interval '23 hours';
  v_terminal := not coalesce(p_retryable, false)
    or v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30))
    or v_idempotency_window_terminal;

  update public.cloud_account_deletion_email_outbox o
  set state = case when v_terminal then 'dead_letter' else 'ready' end,
      resend_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = case
        when v_idempotency_window_terminal then 'idempotency_window_expired_manual_review'
        else left(coalesce(nullif(p_error, ''), 'delivery_failed'), 1000)
      end,
      exhausted_at = case when v_terminal then v_now else null end,
      next_attempt_at = case when v_terminal then o.next_attempt_at
                             else v_now + make_interval(secs => v_delay_seconds) end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$
;
CREATE OR REPLACE FUNCTION public.norva_safe_subtitle_email_provider_response(p_value jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', nullif(left(btrim(coalesce(p_value->>'id', '')), 200), ''),
    'name', public.norva_redact_subtitle_email_text(
      nullif(coalesce(p_value->>'name', p_value->>'type', p_value->>'code'), '')
    ),
    'message', public.norva_redact_subtitle_email_text(
      nullif(coalesce(p_value->>'message', p_value->>'error', p_value->>'response'), '')
    ),
    'status_code', case
      when coalesce(p_value->>'status_code', p_value->>'statusCode', '') ~ '^[0-9]{3}$'
        then (coalesce(p_value->>'status_code', p_value->>'statusCode'))::integer
      else null
    end
  ))
$function$
;
CREATE OR REPLACE FUNCTION public.complete_subtitle_email_delivery(p_delivery_id uuid, p_lease_token uuid, p_http_status integer, p_resend_email_id text, p_response jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_notification_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_http_status not between 200 and 299
     or nullif(btrim(p_resend_email_id), '') is null then
    return false;
  end if;

  update public.catalog_subtitle_email_deliveries d
  set status = 'sent', sent_at = v_now,
      last_http_status = p_http_status,
      resend_email_id = btrim(p_resend_email_id),
      resend_response = public.norva_safe_subtitle_email_provider_response(
        coalesce(p_response, '{}'::jsonb)
      ),
      recipient_email = null,
      request_from = null,
      request_reply_to = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      request_tags = null,
      title_label = null,
      source_id = null,
      series_id = null,
      last_error = null,
      dead_lettered_at = null,
      quarantined_at = null,
      delivery_uncertain = false,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where d.id = p_delivery_id
    and d.status = 'processing'
    and d.lease_token = p_lease_token
    and d.lease_expires_at > v_now
    and d.recipient_email is not null
    and d.request_from is not null
    and d.request_reply_to is not null
    and d.request_subject is not null
    and d.request_html is not null
    and d.request_text is not null
    and d.request_tags is not null
  returning d.notification_id into v_notification_id;

  if v_notification_id is null then return false; end if;

  update public.catalog_generated_subtitle_notifications n
  set status = 'sent', sent_at = v_now,
      email = '', title_label = null, source_id = null, series_id = null
  where n.id = v_notification_id and n.status = 'queued';
  return true;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.fail_subtitle_email_delivery(p_delivery_id uuid, p_lease_token uuid, p_retryable boolean, p_http_status integer DEFAULT NULL::integer, p_response jsonb DEFAULT NULL::jsonb, p_error text DEFAULT NULL::text, p_retry_after_seconds integer DEFAULT NULL::integer, p_max_attempts integer DEFAULT 12, p_base_backoff_seconds integer DEFAULT 60, p_max_backoff_seconds integer DEFAULT 21600, p_ambiguous boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_notification_id uuid;
  v_attempt integer;
  v_was_uncertain boolean;
  v_terminal boolean;
  v_delay integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_max_attempts < 1 or p_max_attempts > 50
     or p_base_backoff_seconds < 1 or p_base_backoff_seconds > 3600
     or p_max_backoff_seconds < p_base_backoff_seconds or p_max_backoff_seconds > 86400 then
    return 'stale_or_invalid';
  end if;

  select d.notification_id, d.attempt_count, d.delivery_uncertain
  into v_notification_id, v_attempt, v_was_uncertain
  from public.catalog_subtitle_email_deliveries d
  where d.id = p_delivery_id
    and d.status = 'processing'
    and d.lease_token = p_lease_token
    and d.lease_expires_at > v_now
  for update;

  if v_notification_id is null then return 'stale_or_invalid'; end if;

  v_was_uncertain := coalesce(v_was_uncertain, false) or coalesce(p_ambiguous, false);
  v_terminal := not coalesce(p_retryable, false)
    or (not v_was_uncertain and v_attempt >= p_max_attempts);
  v_delay := least(
    p_max_backoff_seconds::numeric,
    greatest(
      coalesce(greatest(p_retry_after_seconds, 0), 0)::numeric,
      floor(p_base_backoff_seconds * power(2::numeric, greatest(v_attempt - 1, 0)))
        + mod(
            abs(hashtextextended(p_delivery_id::text || ':' || v_attempt::text, 0)::numeric),
            greatest(p_base_backoff_seconds, 1)
          )
    )
  )::integer;

  update public.catalog_subtitle_email_deliveries d
  set status = case when v_terminal then 'dead_letter' else 'pending' end,
      next_attempt_at = case when v_terminal then v_now else v_now + make_interval(secs => v_delay) end,
      last_http_status = p_http_status,
      resend_response = public.norva_safe_subtitle_email_provider_response(
        coalesce(p_response, '{}'::jsonb)
      ),
      last_error = public.norva_redact_subtitle_email_text(
        coalesce(nullif(p_error, ''), 'subtitle email delivery failed')
      ),
      dead_lettered_at = case when v_terminal then v_now else null end,
      delivery_uncertain = v_was_uncertain,
      recipient_email = case when v_terminal then null else d.recipient_email end,
      request_from = case when v_terminal then null else d.request_from end,
      request_reply_to = case when v_terminal then null else d.request_reply_to end,
      request_subject = case when v_terminal then null else d.request_subject end,
      request_html = case when v_terminal then null else d.request_html end,
      request_text = case when v_terminal then null else d.request_text end,
      request_tags = case when v_terminal then null else d.request_tags end,
      title_label = case when v_terminal then null else d.title_label end,
      source_id = case when v_terminal then null else d.source_id end,
      series_id = case when v_terminal then null else d.series_id end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where d.id = p_delivery_id
    and d.status = 'processing'
    and d.lease_token = p_lease_token
    and d.lease_expires_at > v_now;

  if v_terminal then
    update public.catalog_generated_subtitle_notifications n
    set status = 'failed', sent_at = coalesce(n.sent_at, v_now),
        email = '', title_label = null, source_id = null, series_id = null
    where n.id = v_notification_id and n.status = 'queued';
    return 'dead_letter';
  end if;
  return 'retry_scheduled';
end;
$function$
;
CREATE OR REPLACE FUNCTION public.complete_support_email_delivery(p_delivery_key text, p_lease_token uuid, p_resend_email_id text, p_http_status integer, p_response jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_changed integer;
begin
  if p_http_status not between 200 and 299
     or nullif(btrim(coalesce(p_resend_email_id, '')), '') is null then
    raise exception 'successful Resend status and email id are required';
  end if;
  update public.cloud_support_email_outbox o
  set state = 'sent',
      resend_email_id = left(btrim(p_resend_email_id), 200),
      resend_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = null,
      sent_at = clock_timestamp(),
      lease_token = null,
      lease_expires_at = null,
      recipient_email = null,
      request_reply_to = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      payload_scrubbed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$
;
CREATE OR REPLACE FUNCTION public.fail_support_email_delivery(p_delivery_key text, p_lease_token uuid, p_http_status integer, p_error text, p_response jsonb DEFAULT '{}'::jsonb, p_retryable boolean DEFAULT true, p_retry_after_seconds integer DEFAULT NULL::integer, p_max_attempts integer DEFAULT 12)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt integer;
  v_transport_started_at timestamptz;
  v_delay integer;
  v_window_terminal boolean;
  v_terminal boolean;
  v_changed integer;
begin
  select o.attempt_count, o.transport_started_at
  into v_attempt, v_transport_started_at
  from public.cloud_support_email_outbox o
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token
  for update;
  if not found then return 'lease_lost'; end if;

  v_delay := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );
  v_window_terminal := v_transport_started_at is not null
    and v_now + make_interval(secs => v_delay)
      >= v_transport_started_at + interval '23 hours';
  v_terminal := not coalesce(p_retryable, false)
    or v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30))
    or v_window_terminal;

  update public.cloud_support_email_outbox o
  set state = case when v_terminal then 'dead_letter' else 'ready' end,
      resend_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = case when v_window_terminal
        then 'idempotency_window_expired_manual_review'
        else left(coalesce(nullif(p_error, ''), 'delivery_failed'), 1000) end,
      exhausted_at = case when v_terminal then v_now else null end,
      next_attempt_at = case when v_terminal then o.next_attempt_at
        else v_now + make_interval(secs => v_delay) end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$
;
CREATE OR REPLACE FUNCTION public.claim_branded_email_deliveries(p_batch integer DEFAULT 4, p_lease_seconds integer DEFAULT 90, p_max_attempts integer DEFAULT 12)
 RETURNS TABLE(id uuid, delivery_key text, lease_token uuid, flow text, user_id uuid, is_marketing boolean, marker_kind text, marker_reference text, marker_stage smallint, recipient_email text, request_from text, request_reply_to text, request_subject text, request_html text, request_text text, request_tags jsonb, request_headers jsonb, attempt_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  update public.cloud_branded_email_outbox o
  set state = 'dead_letter', dead_lettered_at = v_now,
      last_error = 'ambiguous_delivery_after_idempotency_window',
      lease_token = null, lease_expires_at = null, updated_at = v_now
  where o.mail_provider='resend' and o.state in ('pending', 'processing')
    and o.transport_started_at <= v_now - interval '23 hours';

  return query
  with due as (
    select o.id from public.cloud_branded_email_outbox o
    where o.mail_provider='resend' and o.next_attempt_at <= v_now
      and (o.transport_started_at is null or o.transport_started_at > v_now - interval '23 hours')
      and ((o.state = 'pending' and o.attempt_count < greatest(1, least(coalesce(p_max_attempts,12),30)))
        or (o.state = 'processing' and o.lease_expires_at <= v_now))
    order by o.next_attempt_at, o.created_at
    limit greatest(1, least(coalesce(p_batch,4),20))
    for update skip locked
  ), claimed as (
    update public.cloud_branded_email_outbox o
    set state = 'processing', lease_token = gen_random_uuid(),
        lease_expires_at = v_now + make_interval(secs => greatest(30,least(coalesce(p_lease_seconds,90),300))),
        attempt_count = o.attempt_count + 1, last_attempt_at = v_now,
        updated_at = v_now
    from due where o.id = due.id returning o.*
  )
  select c.id, c.delivery_key, c.lease_token, c.flow, c.user_id,
         c.is_marketing, c.marker_kind, c.marker_reference, c.marker_stage,
         c.recipient_email, c.request_from, c.request_reply_to, c.request_subject,
         c.request_html, c.request_text, c.request_tags, c.request_headers,
         c.attempt_count
  from claimed c order by c.next_attempt_at, c.created_at;
end
$function$
;
CREATE OR REPLACE FUNCTION public.complete_branded_email_delivery(p_id uuid, p_delivery_key text, p_lease_token uuid, p_resend_email_id text, p_http_status integer, p_response jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  o record;
  v_now timestamptz := clock_timestamp();
begin
  if p_http_status not between 200 and 299 or nullif(btrim(p_resend_email_id),'') is null then
    raise exception 'successful Resend status and email id are required';
  end if;
  select * into o from public.cloud_branded_email_outbox x
  where x.mail_provider='resend' and x.id=p_id and x.delivery_key=p_delivery_key
    and x.state='processing' and x.lease_token=p_lease_token
  for update;
  if not found then return false; end if;

  update public.cloud_branded_email_outbox x
  set state='sent', resend_email_id=left(btrim(p_resend_email_id),200),
      resend_response=coalesce(p_response,'{}'::jsonb), last_http_status=p_http_status,
      last_error=null, sent_at=v_now, dead_lettered_at=null,
      lease_token=null, lease_expires_at=null, next_attempt_at=v_now,
      recipient_email=null, request_reply_to=null, request_subject=null,
      request_html=null, request_text=null, request_headers='{}'::jsonb,
      payload_scrubbed_at=v_now, updated_at=v_now
  where x.id=p_id and x.state='processing' and x.lease_token=p_lease_token;

  if o.marker_kind = 'welcome' then
    update public.cloud_entitlement_projection e
    set welcome_email_at=coalesce(e.welcome_email_at,v_now) where e.user_id=o.user_id;
  elsif o.marker_kind = 'dunning' then
    update public.cloud_entitlement_projection e
    set dunning_stage=greatest(coalesce(e.dunning_stage,0),o.marker_stage), dunning_last_at=v_now
    where e.user_id=o.user_id and e.status='past_due';
  elsif o.marker_kind = 'winback' then
    update public.cloud_entitlement_projection e
    set winback_email_at=coalesce(e.winback_email_at,v_now) where e.user_id=o.user_id;
  elsif o.marker_kind = 'abandoned' then
    update public.cloud_revolut_orders r
    set reminder_sent_at=coalesce(r.reminder_sent_at,v_now), reminder_claimed_at=null, updated_at=v_now
    where r.order_id=o.marker_reference and r.user_id=o.user_id;
  end if;

  update public.cloud_trial_reminder_deliveries d
  set delivered_at=coalesce(d.delivered_at,v_now)
  where d.email_delivery_id=o.id;
  update public.cloud_entitlement_projection e
  set trial_reminder_email_at=coalesce(e.trial_reminder_email_at,v_now)
  where exists (
    select 1 from public.cloud_trial_reminder_deliveries d
    where d.email_delivery_id=o.id and d.user_id=e.user_id and d.trial_ends_at=e.trial_ends_at
  );
  return true;
end
$function$
;
CREATE OR REPLACE FUNCTION public.fail_branded_email_delivery(p_id uuid, p_delivery_key text, p_lease_token uuid, p_http_status integer, p_error text, p_response jsonb DEFAULT '{}'::jsonb, p_retryable boolean DEFAULT true, p_retry_after_seconds integer DEFAULT NULL::integer, p_max_attempts integer DEFAULT 12)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt integer;
  v_terminal boolean;
  v_delay_seconds integer;
  v_changed integer;
begin
  select o.attempt_count into v_attempt
  from public.cloud_branded_email_outbox o
  where o.mail_provider='resend' and o.id = p_id
    and o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token
  for update;
  if not found then return 'lease_lost'; end if;

  v_terminal := not coalesce(p_retryable, false)
    or v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30));
  v_delay_seconds := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );

  update public.cloud_branded_email_outbox o
  set state = case when v_terminal then 'dead_letter' else 'pending' end,
      resend_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = left(coalesce(nullif(p_error, ''), 'delivery_failed'), 1000),
      dead_lettered_at = case when v_terminal then v_now else null end,
      next_attempt_at = case when v_terminal then o.next_attempt_at
                             else v_now + make_interval(secs => v_delay_seconds) end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.mail_provider='resend' and o.id = p_id
    and o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$
;
CREATE OR REPLACE FUNCTION public.fail_branded_email_delivery(p_id uuid, p_delivery_key text, p_lease_token uuid, p_http_status integer, p_error text, p_response jsonb DEFAULT '{}'::jsonb, p_retryable boolean DEFAULT true, p_retry_after_seconds integer DEFAULT NULL::integer, p_max_attempts integer DEFAULT 12, p_ambiguous boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  o record;
  v_delay integer;
  v_window_terminal boolean;
  v_terminal boolean;
begin
  select * into o from public.cloud_branded_email_outbox x
  where x.mail_provider='resend' and x.id=p_id and x.delivery_key=p_delivery_key
    and x.state='processing' and x.lease_token=p_lease_token for update;
  if not found then return 'lease_lost'; end if;
  v_delay := greatest(coalesce(p_retry_after_seconds,0),
    least(21600,round(30*power(2::numeric,greatest(o.attempt_count-1,0)))::integer)
      + floor(random()*16)::integer);
  v_window_terminal := coalesce(p_ambiguous,false)
    and o.transport_started_at is not null
    and v_now + make_interval(secs=>v_delay) >= o.transport_started_at + interval '23 hours';
  v_terminal := not coalesce(p_retryable,false)
    or o.attempt_count >= greatest(1,least(coalesce(p_max_attempts,12),30))
    or v_window_terminal;
  update public.cloud_branded_email_outbox x
  set state=case when v_terminal then 'dead_letter' else 'pending' end,
      resend_response=coalesce(p_response,'{}'::jsonb), last_http_status=p_http_status,
      last_error=case when v_window_terminal then 'ambiguous_delivery_after_idempotency_window'
        else left(coalesce(nullif(p_error,''),'delivery_failed'),1000) end,
      dead_lettered_at=case when v_terminal then v_now else null end,
      next_attempt_at=case when v_terminal then x.next_attempt_at else v_now+make_interval(secs=>v_delay) end,
      -- A retryable 401/403 proves the request was not accepted. Once the
      -- credential/configuration is repaired it receives a fresh idempotency
      -- window. Ambiguous transport outcomes retain the original timestamp.
      transport_started_at=case
        when coalesce(p_retryable,false) and not coalesce(p_ambiguous,false) then null
        else x.transport_started_at
      end,
      lease_token=null, lease_expires_at=null, updated_at=v_now
  where x.id=p_id and x.state='processing' and x.lease_token=p_lease_token;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$
;
CREATE OR REPLACE FUNCTION public.defer_branded_email_delivery(p_id uuid, p_delivery_key text, p_lease_token uuid, p_retry_after_seconds integer DEFAULT 60)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_changed integer;
begin
  update public.cloud_branded_email_outbox o
  set state='pending', attempt_count=greatest(0,o.attempt_count-1),
      transport_started_at=case when o.attempt_count<=1 then null else o.transport_started_at end,
      next_attempt_at=clock_timestamp()+make_interval(secs=>greatest(1,least(coalesce(p_retry_after_seconds,60),21600))),
      last_http_status=429, last_error='resend_team_rate_limited_before_send',
      resend_response='{"name":"team_rate_limited"}'::jsonb,
      lease_token=null, lease_expires_at=null, updated_at=clock_timestamp()
  where o.mail_provider='resend' and o.id=p_id and o.delivery_key=p_delivery_key
    and o.state='processing' and o.lease_token=p_lease_token;
  get diagnostics v_changed=row_count;
  return v_changed=1;
end
$function$
;
CREATE OR REPLACE FUNCTION public.authorize_branded_email_delivery_pre_behavioral(p_id uuid, p_delivery_key text, p_lease_token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  o record;
  v_allowed boolean := true;
begin
  select * into o from public.cloud_branded_email_outbox x
  where x.id = p_id and x.delivery_key = p_delivery_key
    and x.state = 'processing' and x.lease_token = p_lease_token
  for update;
  if not found then return false; end if;

  -- Existing security outbox rows have no lifecycle marker and remain eligible.
  if o.marker_kind is null then
    if exists (
      select 1 from public.cloud_trial_reminder_deliveries d
      join public.cloud_entitlement_projection e on e.user_id = d.user_id
      where d.email_delivery_id = o.id and d.delivered_at is null
        and e.status = 'trialing' and e.trial_ends_at = d.trial_ends_at
        and not exists (select 1 from public.admin_internal_accounts a where a.user_id = d.user_id)
    ) or not exists (
      select 1 from public.cloud_trial_reminder_deliveries d where d.email_delivery_id = o.id
    ) then
      v_allowed := true;
    else
      v_allowed := false;
    end if;
  elsif exists (select 1 from public.admin_internal_accounts a where a.user_id = o.user_id) then
    v_allowed := false;
  elsif o.is_marketing and not public.norva_marketing_email_allowed(o.user_id) then
    v_allowed := false;
  elsif o.marker_kind = 'welcome' then
    v_allowed := exists (
      select 1 where public.norva_signup_welcome_eligible(o.user_id)
    );
  elsif o.marker_kind = 'dunning' then
    v_allowed := exists (
      select 1 from public.cloud_entitlement_projection e
      where e.user_id = o.user_id and e.provider = 'revolut'
        and e.status = 'past_due' and coalesce(e.dunning_stage, 0) < o.marker_stage
    );
  elsif o.marker_kind = 'winback' then
    v_allowed := exists (
      select 1 from public.cloud_entitlement_projection e
      where e.user_id = o.user_id and e.status in ('expired', 'canceled', 'cancelled')
        and e.winback_email_at is null
    );
  elsif o.marker_kind = 'abandoned' then
    v_allowed := exists (
      select 1 from public.cloud_revolut_orders r
      left join public.cloud_entitlement_projection e on e.user_id = r.user_id
      where r.order_id = o.marker_reference and r.user_id = o.user_id
        and r.reminder_sent_at is null and r.finalized_at is null and r.superseded_at is null
        and upper(coalesce(r.state, 'PENDING')) in ('PENDING', 'PROCESSING')
        and not (
          coalesce(e.status, '') in ('trialing', 'active', 'cancelled_at_period_end')
          and (e.status <> 'trialing' or coalesce(e.trial_ends_at, '-infinity'::timestamptz) > clock_timestamp())
          and (e.status not in ('active', 'cancelled_at_period_end')
               or e.current_period_end is null or e.current_period_end > clock_timestamp())
        )
    );
  end if;

  if v_allowed then
    -- A database claim is only a lease. Start the provider idempotency window
    -- at the final authorization CAS immediately before network I/O.
    update public.cloud_branded_email_outbox x
    set transport_started_at = coalesce(x.transport_started_at, clock_timestamp()),
        updated_at = clock_timestamp()
    where x.id = p_id and x.delivery_key = p_delivery_key
      and x.state = 'processing' and x.lease_token = p_lease_token;
    return found;
  end if;
  update public.cloud_branded_email_outbox x
  set state = 'canceled', last_error = 'eligibility_or_consent_revoked_before_send',
      lease_token = null, lease_expires_at = null,
      recipient_email = null, request_reply_to = null, request_subject = null,
      request_html = null, request_text = null, request_headers = '{}'::jsonb,
      payload_scrubbed_at = clock_timestamp(), updated_at = clock_timestamp()
  where x.id = p_id and x.state = 'processing' and x.lease_token = p_lease_token;
  return false;
end
$function$
;
set norva.postal_install='full-v1-disabled';
\i /proof/migration.sql
