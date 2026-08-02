-- Align future database-originated transactional mail with Norva's verified,
-- monitored support identity. Existing outbox rows remain immutable and keep
-- the sender frozen when they were enqueued.

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
    'Norva <support@norva.tv>',
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

revoke all on function public.norva_enqueue_branded_email(text,text,text,text,text,text,text,text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.norva_enqueue_branded_email(text,text,text,text,text,text,text,text,text,uuid)
  to service_role;

comment on function public.norva_enqueue_branded_email(text,text,text,text,text,text,text,text,text,uuid) is
  'Freezes a validated multipart transactional email in the durable outbox using the canonical support sender.';
