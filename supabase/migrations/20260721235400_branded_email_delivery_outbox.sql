-- Durable delivery for the database-originated transactional emails.
--
-- Security triggers and the provider-correct trial jobs historically called
-- norva_send_branded_email(), which queued an opaque pg_net request and then
-- forgot it. A network/provider error was invisible; worse, a trial reminder's
-- dedup row was committed even when no email ever reached Resend. This migration
-- keeps the seven-argument helper contract but changes its only side effect to a
-- transaction-local outbox INSERT. A dedicated Edge worker owns all network I/O,
-- leases, retries, Resend idempotency and dead-letter state.

-- ---------------------------------------------------------------------------
-- Premium multipart renderer. p_intro remains a trusted HTML fragment because
-- the email-change/device triggers already HTML-escape their dynamic values.
-- Every value used in an attribute, heading, CTA or footer is escaped here.
-- ---------------------------------------------------------------------------

create or replace function public.norva_branded_email_html(
  p_heading text,
  p_intro text,
  p_cta_label text default null,
  p_cta_url text default null,
  p_footer text default 'If you didn''t request this, please review your account security.'
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $function$
  select
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' ||
    '<meta name="viewport" content="width=device-width,initial-scale=1">' ||
    '<title>' || public.norva_html_escape(p_heading) || '</title></head>' ||
    '<body style="margin:0;padding:0;background:#0a0c11">' ||
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">' ||
      public.norva_html_escape(p_heading) || '</div>' ||
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c11">' ||
    '<tr><td align="center" style="padding:32px 16px">' ||
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' ||
      'style="max-width:480px;background:#11151d;border:1px solid #1f2733;border-radius:16px;overflow:hidden">' ||
    '<tr><td style="padding:32px 32px 8px;text-align:center">' ||
      '<img src="https://norva.tv/img/norva-app-icon.png" width="48" height="48" alt="Norva" style="border-radius:12px">' ||
      '<div style="color:#ffffff;font-family:Arial,sans-serif;font-size:22px;font-weight:700;margin-top:10px">Norva</div>' ||
    '</td></tr>' ||
    '<tr><td style="padding:18px 32px 6px;text-align:center">' ||
      '<h1 style="margin:0;color:#f8fafc;font-family:Arial,sans-serif;font-size:21px;font-weight:800">' ||
        public.norva_html_escape(p_heading) || '</h1></td></tr>' ||
    '<tr><td style="padding:10px 32px 22px;text-align:center;color:#aeb9cc;font-family:Arial,sans-serif;font-size:15px;line-height:1.6">' ||
      coalesce(p_intro, '') || '</td></tr>' ||
    case
      when nullif(btrim(p_cta_label), '') is not null
       and nullif(btrim(p_cta_url), '') is not null then
        '<tr><td align="center" style="padding:8px 32px 28px">' ||
        '<a href="' || public.norva_html_escape(p_cta_url) || '" ' ||
          'style="display:inline-block;background:#5b7cfa;color:#ffffff;font-family:Arial,sans-serif;font-weight:700;font-size:15px;text-decoration:none;padding:14px 30px;border-radius:10px">' ||
          public.norva_html_escape(p_cta_label) || '</a></td></tr>'
      else ''
    end ||
    '<tr><td style="padding:18px 32px 28px;border-top:1px solid #1f2733;color:#8490a6;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;text-align:center">' ||
      public.norva_html_escape(p_footer) || '</td></tr>' ||
    '</table><div style="color:#667085;font-family:Arial,sans-serif;font-size:11px;margin-top:16px">© Norva</div>' ||
    '</td></tr></table></body></html>'
$function$;

create or replace function public.norva_html_fragment_to_text(p_html text)
returns text
language sql
immutable
set search_path = pg_catalog
as $function$
  select btrim(
    regexp_replace(
      replace(replace(replace(replace(replace(replace(
        regexp_replace(
          regexp_replace(coalesce(p_html, ''), '<br[[:space:]]*/?>', E'\n', 'gi'),
          '<[^>]+>', ' ', 'g'
        ),
        '&nbsp;', ' '), '&quot;', '"'), '&#39;', ''''),
        '&lt;', '<'), '&gt;', '>'), '&amp;', '&'),
      '[[:blank:]]+', ' ', 'g'
    )
  )
$function$;

create or replace function public.norva_branded_email_text(
  p_heading text,
  p_intro text,
  p_cta_label text default null,
  p_cta_url text default null,
  p_footer text default 'If you didn''t request this, please review your account security.'
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $function$
  select public.norva_html_fragment_to_text(p_heading) || E'\n\n' ||
         public.norva_html_fragment_to_text(p_intro) ||
         case
           when nullif(btrim(p_cta_label), '') is not null
            and nullif(btrim(p_cta_url), '') is not null
             then E'\n\n' || public.norva_html_fragment_to_text(p_cta_label) || ': ' || btrim(p_cta_url)
           else ''
         end ||
         case
           when nullif(btrim(p_footer), '') is not null
             then E'\n\n' || public.norva_html_fragment_to_text(p_footer)
           else ''
         end
$function$;

create or replace function public.norva_infer_branded_email_flow(
  p_subject text,
  p_heading text
)
returns text
language sql
immutable
set search_path = pg_catalog
as $function$
  select case
    when coalesce(p_subject, '') ilike '%password%changed%'
      or coalesce(p_heading, '') ilike '%password%changed%'
      then 'security_password_changed'
    when coalesce(p_subject, '') ilike '%email%changed%'
      or coalesce(p_heading, '') ilike '%email%changed%'
      then 'security_email_changed'
    when coalesce(p_subject, '') ilike '%device%'
      or coalesce(p_heading, '') ilike '%device%'
      then 'security_new_device'
    when coalesce(p_subject, '') ilike '%trial%'
      or coalesce(p_heading, '') ilike '%trial%'
      then 'trial_ending'
    else 'branded_transactional'
  end
$function$;

-- ---------------------------------------------------------------------------
-- Immutable outbound requests + delivery state.
-- ---------------------------------------------------------------------------

create table if not exists public.cloud_branded_email_outbox (
  id                  uuid primary key,
  delivery_key        text not null unique,
  dedupe_key          text,
  user_id             uuid references auth.users(id) on delete set null,
  flow                text not null,
  state               text not null default 'pending'
                      check (state in ('pending', 'processing', 'sent', 'dead_letter')),
  recipient_email     text,
  request_from        text not null,
  request_reply_to    text not null,
  request_subject     text not null,
  request_html        text,
  request_text        text,
  request_tags        jsonb not null,
  attempt_count       integer not null default 0 check (attempt_count >= 0),
  next_attempt_at     timestamptz not null default now(),
  last_attempt_at     timestamptz,
  lease_token         uuid,
  lease_expires_at    timestamptz,
  resend_email_id     text,
  resend_response     jsonb,
  last_http_status    integer,
  last_error          text,
  sent_at             timestamptz,
  dead_lettered_at    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint cloud_branded_email_delivery_key_check
    check (delivery_key ~ '^norva-branded-[0-9a-f-]{36}$'),
  constraint cloud_branded_email_dedupe_key_check
    check (dedupe_key is null or dedupe_key ~ '^[a-z0-9:_-]{1,200}$'),
  constraint cloud_branded_email_flow_check
    check (flow ~ '^[a-z0-9_]{1,50}$'),
  constraint cloud_branded_email_tags_check check (
    jsonb_typeof(request_tags) = 'array'
    and jsonb_array_length(request_tags) = 3
    and jsonb_typeof(request_tags -> 0) = 'object'
    and request_tags -> 0 ->> 'name' = 'app'
    and request_tags -> 0 ->> 'value' = 'norva'
    and (request_tags -> 0) - 'name' - 'value' = '{}'::jsonb
    and jsonb_typeof(request_tags -> 1) = 'object'
    and request_tags -> 1 ->> 'name' = 'category'
    and request_tags -> 1 ->> 'value' = 'transactional'
    and (request_tags -> 1) - 'name' - 'value' = '{}'::jsonb
    and jsonb_typeof(request_tags -> 2) = 'object'
    and request_tags -> 2 ->> 'name' = 'flow'
    and request_tags -> 2 ->> 'value' = flow
    and (request_tags -> 2) - 'name' - 'value' = '{}'::jsonb
  ),
  constraint cloud_branded_email_lease_check check (
    (state = 'processing' and lease_token is not null and lease_expires_at is not null)
    or (state <> 'processing' and lease_token is null and lease_expires_at is null)
  ),
  constraint cloud_branded_email_terminal_check check (
    (state = 'sent' and sent_at is not null and dead_lettered_at is null)
    or (state = 'dead_letter' and sent_at is null and dead_lettered_at is not null)
    or (state not in ('sent', 'dead_letter') and sent_at is null and dead_lettered_at is null)
  ),
  constraint cloud_branded_email_payload_check check (
    (state = 'sent' and recipient_email is null and request_html is null and request_text is null)
    or
    (state <> 'sent' and recipient_email is not null and request_html is not null and request_text is not null)
  )
);

create unique index if not exists cloud_branded_email_dedupe_idx
  on public.cloud_branded_email_outbox (dedupe_key)
  where dedupe_key is not null;
create index if not exists cloud_branded_email_due_idx
  on public.cloud_branded_email_outbox (next_attempt_at, created_at)
  where state in ('pending', 'processing');
create index if not exists cloud_branded_email_dead_letter_idx
  on public.cloud_branded_email_outbox (dead_lettered_at desc)
  where state = 'dead_letter';

alter table public.cloud_branded_email_outbox enable row level security;
revoke all on table public.cloud_branded_email_outbox from public, anon, authenticated;
grant select, insert, update, delete on table public.cloud_branded_email_outbox to service_role;

comment on table public.cloud_branded_email_outbox is
  'Durable service-only outbox for DB-originated security and trial emails. Resend is called only by the branded-email Edge worker.';

create or replace function public.norva_enqueue_branded_email(
  p_to text,
  p_subject text,
  p_heading text,
  p_intro text,
  p_cta_label text,
  p_cta_url text,
  p_footer text,
  p_flow text,
  p_dedupe_key text default null,
  p_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_id uuid := gen_random_uuid();
  v_email text := lower(btrim(coalesce(p_to, '')));
  v_flow text := lower(btrim(coalesce(p_flow, '')));
  v_dedupe_key text := nullif(lower(btrim(p_dedupe_key)), '');
  v_existing uuid;
begin
  if v_email !~ '^[^@[:space:]<>]+@[^@[:space:]<>]+$'
     or length(v_email) > 320
     or nullif(btrim(p_subject), '') is null
     or length(p_subject) > 500
     or nullif(btrim(p_heading), '') is null
     or length(p_heading) > 500
     or nullif(btrim(p_intro), '') is null
     or length(p_intro) > 100000
     or v_flow !~ '^[a-z0-9_]{1,50}$'
     or (v_dedupe_key is not null and v_dedupe_key !~ '^[a-z0-9:_-]{1,200}$') then
    raise exception 'valid branded email payload is required';
  end if;

  insert into public.cloud_branded_email_outbox as o (
    id, delivery_key, dedupe_key, user_id, flow, state,
    recipient_email, request_from, request_reply_to, request_subject,
    request_html, request_text, request_tags, next_attempt_at
  ) values (
    v_id,
    'norva-branded-' || v_id::text,
    v_dedupe_key,
    p_user_id,
    v_flow,
    'pending',
    v_email,
    'Norva <noreply@norva.tv>',
    'support@norva.tv',
    btrim(p_subject),
    public.norva_branded_email_html(p_heading, p_intro, p_cta_label, p_cta_url, p_footer),
    public.norva_branded_email_text(p_heading, p_intro, p_cta_label, p_cta_url, p_footer),
    jsonb_build_array(
      jsonb_build_object('name', 'app', 'value', 'norva'),
      jsonb_build_object('name', 'category', 'value', 'transactional'),
      jsonb_build_object('name', 'flow', 'value', v_flow)
    ),
    clock_timestamp()
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning o.id into v_existing;

  if v_existing is null and v_dedupe_key is not null then
    select o.id into v_existing
    from public.cloud_branded_email_outbox o
    where o.dedupe_key = v_dedupe_key;
  end if;
  if v_existing is null then
    raise exception 'branded email enqueue failed';
  end if;
  return v_existing;
end
$function$;

-- Backward-compatible seven-argument API. Unlike the retired implementation,
-- this function performs no network I/O and does not swallow an outbox failure.
-- Existing trigger-level guards still protect the primary account operation.
create or replace function public.norva_send_branded_email(
  p_to text,
  p_subject text,
  p_heading text,
  p_intro text,
  p_cta_label text default null,
  p_cta_url text default null,
  p_footer text default 'If you didn''t request this, please review your account security.'
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  perform public.norva_enqueue_branded_email(
    p_to, p_subject, p_heading, p_intro, p_cta_label, p_cta_url, p_footer,
    public.norva_infer_branded_email_flow(p_subject, p_heading),
    null,
    null
  );
end
$function$;

revoke all on function public.norva_enqueue_branded_email(text,text,text,text,text,text,text,text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.norva_enqueue_branded_email(text,text,text,text,text,text,text,text,text,uuid)
  to service_role;
revoke all on function public.norva_send_branded_email(text,text,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.norva_send_branded_email(text,text,text,text,text,text,text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Security triggers now provide exact flow/user/dedup dimensions. Failures are
-- warnings rather than silent catches: they never block the password/email/device
-- operation, but remain visible in PostgreSQL logs.
-- ---------------------------------------------------------------------------

create or replace function public.norva_notify_password_changed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $function$
begin
  begin
    perform public.norva_enqueue_branded_email(
      new.email,
      'Your Norva password was changed',
      'Password changed',
      'The password on your Norva account was just changed. If this was you, no further action is needed.',
      'Go to my account',
      'https://norva.tv/account.html',
      'If you did NOT change your password, reset it from the app immediately and review your account.',
      'security_password_changed',
      'security_password_changed:' || encode(
        digest(new.id::text || ':' || coalesce(new.encrypted_password, ''), 'sha256'),
        'hex'
      ),
      new.id
    );
  exception when others then
    raise warning 'Norva password-change email enqueue failed: %', sqlerrm;
  end;
  return new;
end
$function$;

create or replace function public.norva_notify_email_changed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $function$
begin
  begin
    perform public.norva_enqueue_branded_email(
      old.email,
      'Your Norva email was changed',
      'Email address changed',
      'The email on your Norva account was changed to <strong style="color:#cdd9ff">' ||
        public.norva_html_escape(new.email) ||
        '</strong>. If this was you, no action is needed.',
      null,
      null,
      'If you did NOT request this change, contact support immediately — your account may be compromised.',
      'security_email_changed',
      'security_email_changed:' || encode(
        digest(
          new.id::text || ':' || coalesce(old.email, '') || ':' ||
          coalesce(new.email, '') || ':' || coalesce(new.updated_at::text, ''),
          'sha256'
        ),
        'hex'
      ),
      new.id
    );
  exception when others then
    raise warning 'Norva email-change notification enqueue failed: %', sqlerrm;
  end;
  return new;
end
$function$;

create or replace function public.norva_notify_new_device()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $function$
declare
  v_user_email text;
  v_device text;
begin
  begin
    select u.email into v_user_email from auth.users u where u.id = new.user_id;
    if v_user_email is null then return new; end if;
    v_device := public.norva_html_escape(
      coalesce(nullif(new.device_name, ''), new.device_type, 'a device')
    ) || case when coalesce(new.platform, '') <> ''
         then ' (' || public.norva_html_escape(new.platform) || ')'
         else '' end;

    perform public.norva_enqueue_branded_email(
      v_user_email,
      'New device connected to Norva',
      'New device connected',
      'A new device just connected to your Norva account: <strong style="color:#cdd9ff">' ||
        v_device || '</strong>.',
      null,
      null,
      'If this wasn''t you, change your password and remove the device from Settings.',
      'security_new_device',
      'security_new_device:' || encode(
        digest(new.user_id::text || ':' || new.id::text, 'sha256'),
        'hex'
      ),
      new.user_id
    );
  exception when others then
    raise warning 'Norva new-device email enqueue failed: %', sqlerrm;
  end;
  return new;
end
$function$;

revoke all on function public.norva_notify_password_changed(),
  public.norva_notify_email_changed(), public.norva_notify_new_device()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Trial reminder linkage. For future reminders, the dedup claim and outbox row
-- are committed together. A queue failure aborts this function's transaction,
-- so no cloud_trial_reminder_deliveries key can be burned without a durable job.
-- Existing pre-migration rows stay unlinked because their pg_net outcome is
-- unknowable and replaying them could duplicate a delivered reminder.
-- ---------------------------------------------------------------------------

alter table public.cloud_trial_reminder_deliveries
  add column if not exists email_delivery_id uuid
    references public.cloud_branded_email_outbox(id) on delete set null;

create unique index if not exists cloud_trial_reminder_email_delivery_idx
  on public.cloud_trial_reminder_deliveries (email_delivery_id)
  where email_delivery_id is not null;

create or replace function public.norva_send_trial_ending_reminders(p_days_before int)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $function$
declare
  r record;
  v_claimed_user_id uuid;
  v_delivery_id uuid;
  v_count integer := 0;
  v_when text;
  v_subject text;
  v_heading text;
  v_intro text;
  v_cta_label text;
  v_cta_url text;
  v_footer text;
  v_dedupe_key text;
begin
  if p_days_before not in (1, 3) then return 0; end if;

  -- Delivery no longer depends on the database Vault copy of the Resend key.
  -- Missing Edge transport leaves a visible pending row that can be drained once
  -- configuration is restored instead of consuming the reminder dedup key.
  v_when := case when p_days_before = 1 then 'tomorrow' else 'in 3 days' end;

  for r in
    select e.user_id, e.provider, e.trial_ends_at, u.email
    from public.cloud_entitlement_projection e
    join auth.users u on u.id = e.user_id
    where e.status = 'trialing'
      and e.provider in ('revolut', 'manual', 'system')
      and e.trial_ends_at is not null
      and (e.trial_ends_at at time zone 'UTC')::date =
          (clock_timestamp() at time zone 'UTC')::date + p_days_before
      and nullif(btrim(u.email::text), '') is not null
      and not exists (
        select 1 from public.admin_internal_accounts a where a.user_id = e.user_id
      )
    order by e.trial_ends_at, e.user_id
    for update of e skip locked
  loop
    v_claimed_user_id := null;
    insert into public.cloud_trial_reminder_deliveries (
      user_id, trial_ends_at, days_before, provider
    ) values (
      r.user_id, r.trial_ends_at, p_days_before, r.provider
    )
    on conflict (user_id, trial_ends_at, days_before) do nothing
    returning user_id into v_claimed_user_id;

    if v_claimed_user_id is null then continue; end if;

    if exists (
      select 1 from public.admin_internal_accounts a where a.user_id = r.user_id
    ) then
      delete from public.cloud_trial_reminder_deliveries d
      where d.user_id = r.user_id
        and d.trial_ends_at = r.trial_ends_at
        and d.days_before = p_days_before;
      continue;
    end if;

    update public.cloud_entitlement_projection e
    set trial_reminder_email_at = coalesce(e.trial_reminder_email_at, clock_timestamp())
    where e.user_id = r.user_id
      and e.status = 'trialing'
      and e.trial_ends_at = r.trial_ends_at;

    if r.provider = 'revolut' then
      v_subject := 'Your Norva free trial ends ' || v_when;
      v_heading := case when p_days_before = 1
        then 'Your trial ends tomorrow' else 'Your trial ends in 3 days' end;
      v_intro := 'Your Norva free trial ends ' || v_when ||
        '. Your subscription will renew automatically when the trial ends, so your access continues without interruption. ' ||
        'Nothing to do if you want to keep watching. You can cancel before renewal and you will not be charged.';
      v_cta_label := 'Manage my plan';
      v_cta_url := 'https://norva.tv/subscription.html';
      v_footer := 'Cancel anytime from Settings before the trial ends. Questions? support@norva.tv.';
    else
      v_subject := 'Your Norva trial access ends ' || v_when;
      v_heading := case when p_days_before = 1
        then 'Your trial access ends tomorrow' else 'Your trial access ends in 3 days' end;
      v_intro := 'Your Norva trial access ends ' || v_when ||
        '. This trial will not renew automatically and no automatic charge will be made. ' ||
        'Choose a plan if you would like to keep watching after it ends.';
      v_cta_label := 'See plans';
      v_cta_url := 'https://norva.tv/subscribe.html';
      v_footer := 'No automatic charge will be made for this trial. Questions? support@norva.tv.';
    end if;

    v_dedupe_key := 'trial_ending:' || encode(
      digest(
        r.user_id::text || ':' || r.trial_ends_at::text || ':' || p_days_before::text,
        'sha256'
      ),
      'hex'
    );
    v_delivery_id := public.norva_enqueue_branded_email(
      r.email::text,
      v_subject,
      v_heading,
      v_intro,
      v_cta_label,
      v_cta_url,
      v_footer,
      'trial_ending',
      v_dedupe_key,
      r.user_id
    );

    update public.cloud_trial_reminder_deliveries d
    set email_delivery_id = v_delivery_id
    where d.user_id = r.user_id
      and d.trial_ends_at = r.trial_ends_at
      and d.days_before = p_days_before;
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$function$;

revoke all on function public.norva_send_trial_ending_reminders(int)
  from public, anon, authenticated;
grant execute on function public.norva_send_trial_ending_reminders(int)
  to service_role;

-- ---------------------------------------------------------------------------
-- Worker lease/CAS API. Expired processing leases are replayable with the same
-- delivery_key inside Resend's 24-hour idempotency window. An expired lease
-- older than 23 hours is quarantined instead of risking a duplicate send.
-- Only an explicit provider failure or expired ambiguity may dead-letter a row.
-- ---------------------------------------------------------------------------

create or replace function public.claim_branded_email_deliveries(
  p_batch integer default 10,
  p_lease_seconds integer default 90,
  p_max_attempts integer default 12
)
returns table (
  id uuid,
  delivery_key text,
  lease_token uuid,
  flow text,
  recipient_email text,
  request_from text,
  request_reply_to text,
  request_subject text,
  request_html text,
  request_text text,
  request_tags jsonb,
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_batch integer := greatest(1, least(coalesce(p_batch, 10), 50));
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 90), 600));
  v_max_attempts integer := greatest(1, least(coalesce(p_max_attempts, 12), 30));
begin
  update public.cloud_branded_email_outbox o
  set state = 'dead_letter',
      dead_lettered_at = v_now,
      last_error = 'ambiguous_delivery_after_idempotency_window',
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.state = 'processing'
    and o.lease_expires_at <= v_now
    and o.last_attempt_at <= v_now - interval '23 hours';

  return query
  with due as (
    select o.id
    from public.cloud_branded_email_outbox o
    where o.next_attempt_at <= v_now
      and (
        (o.state = 'pending' and o.attempt_count < v_max_attempts)
        or (o.state = 'processing' and o.lease_expires_at <= v_now)
      )
    order by o.next_attempt_at, o.created_at
    limit v_batch
    for update skip locked
  ), claimed as (
    update public.cloud_branded_email_outbox o
    set state = 'processing',
        lease_token = gen_random_uuid(),
        lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
        attempt_count = o.attempt_count + 1,
        last_attempt_at = v_now,
        updated_at = v_now
    from due
    where o.id = due.id
    returning o.*
  )
  select c.id, c.delivery_key, c.lease_token, c.flow,
         c.recipient_email, c.request_from, c.request_reply_to,
         c.request_subject, c.request_html, c.request_text,
         c.request_tags, c.attempt_count
  from claimed c
  order by c.next_attempt_at, c.created_at;
end
$function$;

create or replace function public.complete_branded_email_delivery(
  p_id uuid,
  p_delivery_key text,
  p_lease_token uuid,
  p_resend_email_id text,
  p_http_status integer,
  p_response jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_changed integer;
begin
  if p_http_status not between 200 and 299
     or nullif(btrim(p_resend_email_id), '') is null then
    raise exception 'successful Resend status and email id are required';
  end if;

  update public.cloud_branded_email_outbox o
  set state = 'sent',
      resend_email_id = btrim(p_resend_email_id),
      resend_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = null,
      sent_at = clock_timestamp(),
      dead_lettered_at = null,
      lease_token = null,
      lease_expires_at = null,
      next_attempt_at = clock_timestamp(),
      -- Minimize recipient/content immediately after provider acceptance. The
      -- Resend webhook ledger owns downstream delivery telemetry.
      recipient_email = null,
      request_html = null,
      request_text = null,
      updated_at = clock_timestamp()
  where o.id = p_id
    and o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$;

create or replace function public.fail_branded_email_delivery(
  p_id uuid,
  p_delivery_key text,
  p_lease_token uuid,
  p_http_status integer,
  p_error text,
  p_response jsonb default '{}'::jsonb,
  p_retryable boolean default true,
  p_retry_after_seconds integer default null,
  p_max_attempts integer default 12
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt integer;
  v_terminal boolean;
  v_delay_seconds integer;
  v_changed integer;
begin
  select o.attempt_count into v_attempt
  from public.cloud_branded_email_outbox o
  where o.id = p_id
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
  where o.id = p_id
    and o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$;

create or replace function public.requeue_branded_email_delivery(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_changed integer;
begin
  update public.cloud_branded_email_outbox o
  set state = 'pending',
      attempt_count = 0,
      next_attempt_at = clock_timestamp(),
      last_error = null,
      last_http_status = null,
      resend_response = null,
      dead_lettered_at = null,
      lease_token = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  where o.id = p_id
    and o.state = 'dead_letter'
    and o.last_error is distinct from 'ambiguous_delivery_after_idempotency_window';
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$;

create or replace function public.branded_email_delivery_health()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select jsonb_build_object(
    'pending', count(*) filter (where state = 'pending'),
    'processing', count(*) filter (where state = 'processing'),
    'dead_letter', count(*) filter (where state = 'dead_letter'),
    'sent_24h', count(*) filter (where state = 'sent' and sent_at >= now() - interval '24 hours'),
    'oldest_due_at', min(next_attempt_at) filter (where state = 'pending'),
    'last_sent_at', max(sent_at)
  )
  from public.cloud_branded_email_outbox
$function$;

create or replace function public.prune_branded_email_outbox()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_deleted integer;
begin
  delete from public.cloud_branded_email_outbox o
  where (o.state = 'sent' and o.sent_at < now() - interval '90 days')
     or (o.state = 'dead_letter' and o.dead_lettered_at < now() - interval '90 days');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;

revoke all on function public.claim_branded_email_deliveries(integer,integer,integer),
  public.complete_branded_email_delivery(uuid,text,uuid,text,integer,jsonb),
  public.fail_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer),
  public.requeue_branded_email_delivery(uuid),
  public.branded_email_delivery_health(),
  public.prune_branded_email_outbox()
  from public, anon, authenticated;
grant execute on function public.claim_branded_email_deliveries(integer,integer,integer),
  public.complete_branded_email_delivery(uuid,text,uuid,text,integer,jsonb),
  public.fail_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer),
  public.requeue_branded_email_delivery(uuid),
  public.branded_email_delivery_health(),
  public.prune_branded_email_outbox()
  to service_role;

-- Dedicated minutely worker; pg_net only wakes the authenticated Edge endpoint.
-- It never calls Resend directly and therefore carries no provider response gap.
do $cron_setup$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron')
     and exists (select 1 from pg_namespace where nspname = 'net') then
    perform cron.schedule(
      'norva-branded-email-delivery',
      '* * * * *',
      $cron$
        select net.http_post(
          url := 'https://api.norva.tv/functions/v1/norva-branded-email-worker/cron/drain',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (
              select decrypted_secret from vault.decrypted_secrets
              where name = 'norva_cron_shared_secret'
            )
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        )
        where exists (
          select 1 from public.cloud_branded_email_outbox o
          where o.next_attempt_at <= now()
            and (
              o.state = 'pending'
              or (o.state = 'processing' and o.lease_expires_at <= now())
            )
        );
      $cron$
    );
    perform cron.schedule(
      'norva-branded-email-prune',
      '20 4 * * *',
      'select public.prune_branded_email_outbox();'
    );
  end if;
exception when undefined_table or invalid_schema_name or insufficient_privilege then
  raise notice 'branded email crons unavailable; register the worker externally';
end
$cron_setup$;

notify pgrst, 'reload schema';
