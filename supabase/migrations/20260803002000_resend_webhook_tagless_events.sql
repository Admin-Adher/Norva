-- Align the durable Resend RPC with the signed Edge admission contract.
-- Resend delivery events can omit tags even when the Management API retains
-- them. The verified Norva sender domain therefore remains mandatory, while an
-- absent app tag is accepted. Any explicit non-Norva app tag, including an
-- empty/null value, and every non-object tag payload remain fail-closed.

create or replace function public.norva_record_resend_email_event(
  p_event_id text,
  p_event_type text,
  p_provider_email_id text,
  p_occurred_at timestamptz,
  p_from_email text,
  p_to_emails text[],
  p_tags jsonb,
  p_diagnostic_data jsonb
) returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_inserted integer := 0;
  v_email text;
  v_reason text;
  v_to_emails text[] := array(
    select distinct lower(btrim(value))
    from unnest(coalesce(p_to_emails, '{}'::text[])) as value
    where length(lower(btrim(value))) between 3 and 320
      and position('@' in lower(btrim(value))) > 1
  );
  v_tags jsonb := case when jsonb_typeof(coalesce(p_tags, '{}'::jsonb)) = 'object'
    then coalesce(p_tags, '{}'::jsonb) else '{}'::jsonb end;
  v_diagnostic jsonb := case when jsonb_typeof(coalesce(p_diagnostic_data, '{}'::jsonb)) = 'object'
    then coalesce(p_diagnostic_data, '{}'::jsonb) else '{}'::jsonb end;
begin
  if jsonb_typeof(p_tags) is distinct from 'object'
     or lower(coalesce(p_from_email, '')) !~ '(^|<)[^<>@[:space:]]+@norva\.tv>?$'
     or (
       p_tags ? 'app'
       and coalesce(p_tags ->> 'app', '') <> 'norva'
     ) then
    raise exception 'foreign Resend event rejected';
  end if;

  if p_event_type <> all (array[
    'email.sent', 'email.delivered', 'email.delivery_delayed',
    'email.bounced', 'email.complained', 'email.failed',
    'email.suppressed', 'email.opened', 'email.clicked'
  ]) then
    raise exception 'unsupported Resend event type: %', p_event_type;
  end if;

  if nullif(btrim(coalesce(p_event_id, '')), '') is null
     or nullif(btrim(coalesce(p_provider_email_id, '')), '') is null
     or p_occurred_at is null then
    raise exception 'event id, provider email id and occurred_at are required';
  end if;

  insert into public.cloud_email_delivery_events (
    event_id, event_type, provider_email_id, occurred_at,
    from_email, to_emails, tags, diagnostic_data
  ) values (
    btrim(p_event_id), p_event_type, btrim(p_provider_email_id), p_occurred_at,
    nullif(btrim(coalesce(p_from_email, '')), ''), v_to_emails,
    v_tags, v_diagnostic
  )
  on conflict (event_id) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return false;
  end if;

  insert into public.cloud_email_delivery_status (
    provider_email_id, from_email, to_emails, tags,
    sent_at, delivered_at, delivery_delayed_at, bounced_at,
    complained_at, failed_at, suppressed_at, last_opened_at,
    last_clicked_at, latest_event_type, latest_event_at,
    latest_diagnostic_data
  ) values (
    btrim(p_provider_email_id), nullif(btrim(coalesce(p_from_email, '')), ''),
    v_to_emails, v_tags,
    case when p_event_type = 'email.sent' then p_occurred_at end,
    case when p_event_type = 'email.delivered' then p_occurred_at end,
    case when p_event_type = 'email.delivery_delayed' then p_occurred_at end,
    case when p_event_type = 'email.bounced' then p_occurred_at end,
    case when p_event_type = 'email.complained' then p_occurred_at end,
    case when p_event_type = 'email.failed' then p_occurred_at end,
    case when p_event_type = 'email.suppressed' then p_occurred_at end,
    case when p_event_type = 'email.opened' then p_occurred_at end,
    case when p_event_type = 'email.clicked' then p_occurred_at end,
    p_event_type, p_occurred_at, v_diagnostic
  )
  on conflict (provider_email_id) do update set
    from_email = case
      when excluded.latest_event_at >= cloud_email_delivery_status.latest_event_at
        then coalesce(excluded.from_email, cloud_email_delivery_status.from_email)
      else cloud_email_delivery_status.from_email end,
    to_emails = case
      when excluded.latest_event_at >= cloud_email_delivery_status.latest_event_at
        then excluded.to_emails else cloud_email_delivery_status.to_emails end,
    tags = cloud_email_delivery_status.tags || excluded.tags,
    sent_at = greatest(cloud_email_delivery_status.sent_at, excluded.sent_at),
    delivered_at = greatest(cloud_email_delivery_status.delivered_at, excluded.delivered_at),
    delivery_delayed_at = greatest(cloud_email_delivery_status.delivery_delayed_at, excluded.delivery_delayed_at),
    bounced_at = greatest(cloud_email_delivery_status.bounced_at, excluded.bounced_at),
    complained_at = greatest(cloud_email_delivery_status.complained_at, excluded.complained_at),
    failed_at = greatest(cloud_email_delivery_status.failed_at, excluded.failed_at),
    suppressed_at = greatest(cloud_email_delivery_status.suppressed_at, excluded.suppressed_at),
    last_opened_at = greatest(cloud_email_delivery_status.last_opened_at, excluded.last_opened_at),
    last_clicked_at = greatest(cloud_email_delivery_status.last_clicked_at, excluded.last_clicked_at),
    latest_event_type = case
      when excluded.latest_event_at >= cloud_email_delivery_status.latest_event_at
        then excluded.latest_event_type else cloud_email_delivery_status.latest_event_type end,
    latest_event_at = greatest(cloud_email_delivery_status.latest_event_at, excluded.latest_event_at),
    latest_diagnostic_data = case
      when excluded.latest_event_at >= cloud_email_delivery_status.latest_event_at
        then excluded.latest_diagnostic_data else cloud_email_delivery_status.latest_diagnostic_data end,
    updated_at = now();

  -- A bounce is suppressible only when Resend classified it Permanent.
  -- Transient/Undetermined bounces remain delivery telemetry. Complaints and
  -- provider suppressions are locally suppressible until operator resolution.
  if p_event_type = any (array['email.complained', 'email.suppressed'])
     or (p_event_type = 'email.bounced' and lower(coalesce(v_diagnostic ->> 'type', '')) = 'permanent') then
    v_reason := coalesce(
      nullif(v_diagnostic ->> 'type', ''),
      nullif(v_diagnostic ->> 'reason', ''),
      replace(p_event_type, 'email.', '')
    );

    foreach v_email in array v_to_emails loop
      insert into public.cloud_email_suppressions (
        email, reason, source_event_id, source_email_id,
        active, first_seen_at, last_seen_at, resolved_at
      ) values (
        v_email, left(v_reason, 200), btrim(p_event_id),
        btrim(p_provider_email_id), true, p_occurred_at, p_occurred_at, null
      )
      on conflict (email) do update set
        reason = excluded.reason,
        source_event_id = excluded.source_event_id,
        source_email_id = excluded.source_email_id,
        active = true,
        first_seen_at = least(cloud_email_suppressions.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(cloud_email_suppressions.last_seen_at, excluded.last_seen_at),
        resolved_at = null,
        updated_at = now();

      -- Deliverability and consent are different facts. A bounce/suppression
      -- blocks effective sends but does not rewrite the user's historical opt-in.
      -- A complaint is the one provider event that represents an explicit
      -- recipient rejection and therefore revokes marketing consent.
      if p_event_type = 'email.complained' then
        update public.cloud_marketing_email_preferences p
        set marketing_email_opt_in = false,
            unsubscribed_at = coalesce(p.unsubscribed_at, p_occurred_at),
            unsubscribed_source = left('resend_webhook:' || p_event_type, 200),
            updated_at = now()
        from auth.users u
        where p.user_id = u.id
          and lower(btrim(coalesce(u.email, ''))) = v_email
          and (
            p.marketing_email_opt_in
            or p.unsubscribed_at is null
            or p.unsubscribed_source is distinct from left('resend_webhook:' || p_event_type, 200)
          );
      end if;
    end loop;
  end if;

  return true;
end;
$function$;

revoke all on function public.norva_record_resend_email_event(
  text, text, text, timestamptz, text, text[], jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.norva_record_resend_email_event(
  text, text, text, timestamptz, text, text[], jsonb, jsonb
) to service_role;
