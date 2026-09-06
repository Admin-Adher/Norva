-- One existing email, not an extra reminder: +24h without a usable push,
-- otherwise no earlier than +72h. Recheck at render, enqueue and final SMTP.
-- Rollout stays dormant. The private Postal spool must retain this particular
-- flow for 72h so a push granted after enqueue cannot expire its J+3 fallback.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

lock table public.behavioral_lifecycle_runtime,
  public.behavioral_lifecycle_journeys,
  public.behavioral_lifecycle_steps in share row exclusive mode;

do $guard$
begin
  if not exists (select 1 from public.behavioral_lifecycle_runtime
      where emergency_stop and audience_mode = 'internal_test')
    or (select count(*) from public.behavioral_lifecycle_journeys) <> 4
    or exists (select 1 from public.behavioral_lifecycle_journeys
      where status <> 'draft' or rollout_percent <> 0 or activated_at is not null)
    or exists (select 1 from public.behavioral_lifecycle_outbox)
    or not exists (select 1 from public.behavioral_lifecycle_steps
      where journey_key = 'no_source' and step_key = 'day_three_email'
        and channel = 'email' and delay_minutes = 4320 and ttl_seconds = 259200)
    or to_regprocedure('norva_postal_full.behavioral_email_not_before(uuid,timestamptz)') is not null
  then
    raise exception 'conditional email requires the reviewed dormant baseline';
  end if;
end;
$guard$;

-- Not a Data API endpoint. INVOKER is sufficient because only the existing
-- owner-run authorization functions call it; no new role receives execution.
create function norva_postal_full.behavioral_email_not_before(
  p_delivery_id uuid, p_now timestamptz
) returns timestamptz
language sql stable security invoker set search_path = pg_catalog
as $function$
  select coalesce((
    select case
      when p_now is null then 'infinity'::timestamptz
      when o.journey_key = 'no_source' and o.step_key = 'day_three_email'
          and o.channel = 'email' then greatest(p_now, o.triggered_at +
        case when exists (
          -- Exactly the eligibility predicate used by the push authorizer.
          -- Permission/freshness is availability, not proof of reception.
          select 1 from public.cloud_push_tokens t where t.user_id = o.user_id
            and t.permission_state = 'granted'
            and t.last_seen_at >= p_now - interval '45 days'
        ) then interval '3 days' else interval '1 day' end)
      else p_now end
    from public.behavioral_lifecycle_outbox o where o.id = p_delivery_id
  ), 'infinity'::timestamptz)
$function$;
revoke all on function norva_postal_full.behavioral_email_not_before(uuid,timestamptz)
  from public, anon, authenticated, service_role, norva_postal_full_worker;
comment on function norva_postal_full.behavioral_email_not_before(uuid,timestamptz) is
  'Internal owner-only cadence: one no-source email, +24h without fresh granted push or +72h with it; never authorizes business eligibility.';

-- A real private-spool receipt, not just a caller-supplied HTTP status, permits
-- this specific email to wait beyond the inherited Resend 23h window. Unknown
-- SMTP outcomes and all other flows keep their existing quarantine rules.
create function norva_postal_full.behavioral_pending_window(p_email_id uuid,p_now timestamptz)
returns boolean language sql stable security invoker set search_path=pg_catalog
as $function$
 select exists (
   select 1 from public.cloud_branded_email_outbox e
   join public.behavioral_lifecycle_outbox b on b.email_outbox_id=e.id
   where e.id=p_email_id and e.mail_provider='postal' and e.flow='behavioral_no_source'
     and b.journey_key='no_source' and b.step_key='day_three_email' and b.channel='email'
     and b.status='email_queued' and b.expires_at>p_now
     and e.transport_started_at>p_now-interval '72 hours'
     and exists(select 1 from norva_postal_full.receipts r where r.delivery_key=e.delivery_key
       and r.recipient=e.recipient_email and not r.auth and r.flow=e.flow and r.state in ('pending','sent'))
 );
$function$;
revoke all on function norva_postal_full.behavioral_pending_window(uuid,timestamptz)
  from public,anon,authenticated,service_role,norva_postal_full_worker;

create function norva_postal_full.defer_behavioral_pending(
  p_id uuid,p_key text,p_lease uuid,p_status integer,p_response jsonb
) returns boolean language plpgsql security invoker set search_path=pg_catalog
as $function$
declare v_now timestamptz:=clock_timestamp(); o record; b record;
begin
 if p_status is distinct from 425 or p_response->>'name' is distinct from 'postal_pending'
   or p_response->>'provider' is distinct from 'postal' then return false; end if;
 select * into o from public.cloud_branded_email_outbox e where e.id=p_id and e.delivery_key=p_key
   and e.state='processing' and e.lease_token=p_lease for update;
 if not found or not norva_postal_full.behavioral_pending_window(o.id,v_now) then return false; end if;
 select * into b from public.behavioral_lifecycle_outbox where email_outbox_id=o.id;
 update public.cloud_branded_email_outbox set state='pending',attempt_count=greatest(0,attempt_count-1),
   next_attempt_at=greatest(v_now+interval '1 minute',norva_postal_full.behavioral_email_not_before(b.id,v_now)),
   last_http_status=425,last_error='postal_behavioral_pending',postal_response=p_response,
   lease_token=null,lease_expires_at=null,updated_at=v_now where id=o.id;
 -- Keep the original idempotency/transport timestamp; do not reset the clock.
 return true;
end;
$function$;
revoke all on function norva_postal_full.defer_behavioral_pending(uuid,text,uuid,integer,jsonb)
  from public,anon,authenticated,service_role,norva_postal_full_worker;

-- Patch only these exact reviewed bodies. Preserve all signatures, ownership,
-- grants, consent, conversion, frequency, quiet-hour and other-mail branches.
do $patch$
declare
  r record;
  v_definition text;
  v_body text;
begin
  for r in select * from (values
    ('public.norva_enqueue_behavioral_email(uuid,uuid,text,text,text,text,text,text,jsonb,jsonb)',
     'ad99a5876b06ace08de2a2fc369acecc',
     E'public.norva_behavioral_next_allowed_at(\n    v_now,',
     E'public.norva_behavioral_next_allowed_at(\n    norva_postal_full.behavioral_email_not_before(o.id, v_now),'),
    ('public.norva_authorize_behavioral_email_enqueue(uuid,uuid)',
     'd5a738b7e153e94ec19c1e895808e851',
     E'public.norva_behavioral_next_allowed_at(\n    v_now,',
     E'public.norva_behavioral_next_allowed_at(\n    norva_postal_full.behavioral_email_not_before(o.id, v_now),'),
    ('public.authorize_branded_email_delivery(uuid,text,uuid)',
     '5b6c2a5d3c5da60d85b38c473108c803',
     E'public.norva_behavioral_next_allowed_at(\n      v_now,',
     E'public.norva_behavioral_next_allowed_at(\n      norva_postal_full.behavioral_email_not_before(o.id, v_now),'),
    ('norva_postal_full.eligibility(text,text,boolean,text)',
     '922eb19c0675faaace892e5a02765dd2',
     'public.norva_behavioral_next_allowed_at(v_now,s.timezone',
     'public.norva_behavioral_next_allowed_at(norva_postal_full.behavioral_email_not_before(b.id,v_now),s.timezone'),
    ('public.claim_postal_branded_email_deliveries(integer,integer,integer)',
     '4205c4b0fd3d216c4dcb6ab041e3429c',
     'and o.transport_started_at <= v_now - interval ''23 hours'';',
     'and o.transport_started_at <= v_now - interval ''23 hours'' and not norva_postal_full.behavioral_pending_window(o.id,v_now);'),
    ('public.fail_postal_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer)',
     'bddbbe8a0c4b641d584fec5ae0f702d3',
     'if not found then return ''lease_lost''; end if;',
     'if not found then return ''lease_lost''; end if; if norva_postal_full.defer_behavioral_pending(p_id,p_delivery_key,p_lease_token,p_http_status,p_response) then return ''retry_scheduled''; end if;'),
    ('public.fail_postal_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer,boolean)',
     'd71671ed5fa554e5ec409a1871a03de6',
     'if not found then return ''lease_lost''; end if;',
     'if not found then return ''lease_lost''; end if; if norva_postal_full.defer_behavioral_pending(p_id,p_delivery_key,p_lease_token,p_http_status,p_response) then return ''retry_scheduled''; end if;')
  ) as changes(signature, expected_md5, anchor, replacement)
  loop
    select replace(p.prosrc, chr(13), ''),
      replace(pg_get_functiondef(p.oid), chr(13), '')
      into strict v_body, v_definition from pg_proc p
      where p.oid = r.signature::regprocedure;
    if md5(v_body) <> r.expected_md5
      or (length(v_definition) - length(replace(v_definition, r.anchor, '')))
        <> length(r.anchor) then
      raise exception 'conditional email function baseline mismatch: %', r.signature;
    end if;
    v_definition := replace(v_definition, r.anchor, r.replacement);
    if r.signature like 'public.claim_postal_%' then
      v_definition := replace(v_definition,
        '(o.transport_started_at is null or o.transport_started_at > v_now - interval ''23 hours'')',
        '(o.transport_started_at is null or o.transport_started_at > v_now - interval ''23 hours'' or norva_postal_full.behavioral_pending_window(o.id,v_now))');
    end if;
    if r.signature like 'public.norva_%' then
      -- Cadence is not an error. Do not misreport a 48h wait as quiet hours.
      v_definition := replace(v_definition,
        'then ''quiet_hours'' else ''frequency_capped'' end',
        'then case when norva_postal_full.behavioral_email_not_before(o.id, v_now) > v_now + interval ''1 second'' then null else ''quiet_hours'' end else ''frequency_capped'' end');
    elsif r.signature like 'public.authorize_%' then
      v_definition := replace(v_definition,
        '''behavioral_quiet_hours_or_frequency_cap''',
        '''behavioral_cadence_quiet_hours_or_frequency_cap''');
    end if;
    execute v_definition;
  end loop;
end;
$patch$;

update public.behavioral_lifecycle_steps
  set delay_minutes = 1440, updated_at = clock_timestamp()
  where journey_key = 'no_source' and step_key = 'day_three_email';
-- Keep the immutable step key for idempotency and the J+3 option. Neither
-- treatment/holdout assignments nor experiment activation are changed.
commit;
