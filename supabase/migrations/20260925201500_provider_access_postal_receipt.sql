begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

alter table public.cloud_provider_access_notifications
  drop constraint cloud_provider_access_notifications_completion_code_check;
alter table public.cloud_provider_access_notifications
  add constraint cloud_provider_access_notifications_completion_code_check
  check (completion_code is null or completion_code in (
    'RESEND_ACCEPTED','POSTAL_SMTP_SENT','FCM_ACCEPTED','NO_REGISTERED_TOKEN','IN_APP_DISMISSED'
  ));

create or replace function public.norva_complete_provider_access_notification(
  p_notification_id uuid, p_channel text, p_worker text,
  p_expected_lease_sequence bigint, p_completion_code text,
  p_provider_message_id text default null
) returns boolean language plpgsql security definer set search_path = ''
as $function$
declare
  v_delivery_key text;
  v_postal_sent boolean := false;
begin
  perform public.norva_provider_access_notification_flag_required(p_channel);
  if (p_channel = 'email' and p_completion_code not in ('RESEND_ACCEPTED','POSTAL_SMTP_SENT'))
     or (p_channel = 'push' and p_completion_code not in ('FCM_ACCEPTED','NO_REGISTERED_TOKEN'))
     or (p_completion_code in ('RESEND_ACCEPTED','POSTAL_SMTP_SENT','FCM_ACCEPTED')
       and nullif(btrim(coalesce(p_provider_message_id, '')), '') is null)
     or length(coalesce(p_provider_message_id, '')) > 240 then
    raise exception 'invalid Provider Access notification completion' using errcode = '22023';
  end if;

  if p_completion_code = 'POSTAL_SMTP_SENT' then
    select delivery_key into v_delivery_key
    from public.cloud_provider_access_notifications
    where id = p_notification_id and channel = p_channel
      and state = 'processing' and lease_owner = p_worker
      and lease_sequence = p_expected_lease_sequence
      and transport_started_at is not null;
    if v_delivery_key is null
       or pg_catalog.to_regprocedure('norva_postal_full.receipt_is_sent(text,text)') is null then
      return false;
    end if;
    -- Postal is deployed separately. Fail closed until its secure SMTP receipt
    -- exists for this exact durable delivery key; enqueue acceptance is insufficient.
    execute 'select norva_postal_full.receipt_is_sent($1,$2)'
      into v_postal_sent using p_provider_message_id, v_delivery_key;
    if v_postal_sent is distinct from true then return false; end if;
  end if;

  update public.cloud_provider_access_notifications notification
  set state = 'delivered', lease_owner = null, lease_expires_at = null,
      completion_code = p_completion_code,
      provider_message_id = nullif(left(btrim(coalesce(p_provider_message_id, '')), 240), ''),
      delivered_at = now(), last_error_code = null, updated_at = now()
  where notification.id = p_notification_id and notification.channel = p_channel
    and notification.state = 'processing' and notification.lease_owner = p_worker
    and notification.lease_sequence = p_expected_lease_sequence
    and notification.transport_started_at is not null;
  return found;
end
$function$;
revoke all on function public.norva_complete_provider_access_notification(uuid,text,text,bigint,text,text)
  from public, anon, authenticated;
grant execute on function public.norva_complete_provider_access_notification(uuid,text,text,bigint,text,text)
  to service_role;
commit;
