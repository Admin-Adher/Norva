-- Email-only producers. They never charge, expire, cancel or renew an entitlement.
set lock_timeout='3s';
set statement_timeout='30s';

create function public.norva_billing_email_cycle_key(p_period_end timestamptz,p_trial_end timestamptz)
returns text language sql immutable set search_path='pg_catalog' as $$
 select floor(extract(epoch from coalesce(p_period_end,p_trial_end))*1000)::bigint::text;
$$;
revoke all on function public.norva_billing_email_cycle_key(timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.norva_billing_email_cycle_key(timestamptz,timestamptz) to service_role;

create function public.norva_pending_dunning_emails(p_limit integer default 100)
returns table(user_id uuid,stage integer,cycle_key text)
language plpgsql security definer set search_path='pg_catalog' as $$
begin
 if p_limit not between 1 and 100 then raise exception 'invalid email batch';end if;
 return query select e.user_id,coalesce(e.dunning_stage,0)::integer+1,
   public.norva_billing_email_cycle_key(e.current_period_end,e.trial_ends_at)
 from public.cloud_entitlement_projection e join auth.users u on u.id=e.user_id
 where e.provider='revolut' and e.status='past_due'
   and coalesce(e.dunning_stage,0) between 0 and 2
   and (e.dunning_last_at is null or e.dunning_last_at<now()-interval '24 hours')
   and coalesce(e.current_period_end,e.trial_ends_at) is not null
   and u.email_confirmed_at is not null and nullif(btrim(u.email),'') is not null
   and not exists(select 1 from public.admin_internal_accounts a where a.user_id=e.user_id)
 order by e.dunning_last_at nulls first,e.user_id limit p_limit;
end $$;
revoke all on function public.norva_pending_dunning_emails(integer) from public,anon,authenticated;
grant execute on function public.norva_pending_dunning_emails(integer) to service_role;

create function public.norva_pending_renewal_emails(p_limit integer default 100)
returns table(user_id uuid,renews_at timestamptz,cycle_key text)
language plpgsql security definer set search_path='pg_catalog' as $$
begin
 if p_limit not between 1 and 100 then raise exception 'invalid email batch';end if;
 return query select e.user_id,e.current_period_end,
   public.norva_billing_email_cycle_key(e.current_period_end,null)
 from public.cloud_entitlement_projection e
 join public.cloud_revolut_customers c on c.user_id=e.user_id
 join auth.users u on u.id=e.user_id
 where e.provider='revolut' and e.status='active'
   and c.period in ('monthly','annual') and c.amount_cents between 1 and 9999999
   and nullif(c.payment_method_id,'') is not null and nullif(c.revolut_customer_id,'') is not null
   and e.current_period_end>now()
   and e.current_period_end<=now()+case c.period when 'annual' then interval '7 days' else interval '3 days' end
   and u.email_confirmed_at is not null and nullif(btrim(u.email),'') is not null
   and not exists(select 1 from public.admin_internal_accounts a where a.user_id=e.user_id)
   and not exists(select 1 from public.cloud_branded_email_outbox o
     where o.dedupe_key='lifecycle:renewal:'||e.user_id||':'||public.norva_billing_email_cycle_key(e.current_period_end,null))
 order by e.current_period_end,e.user_id limit p_limit;
end $$;
revoke all on function public.norva_pending_renewal_emails(integer) from public,anon,authenticated;
grant execute on function public.norva_pending_renewal_emails(integer) to service_role;

-- Rechecked at both Edge authorization and private-worker SMTP authorization.
-- An older queued cycle cannot update or notify a newer billing cycle.
create function public.norva_billing_notice_allowed(p_id uuid)
returns boolean language plpgsql stable security definer set search_path='pg_catalog' as $$
declare o record;
begin
 select * into o from public.cloud_branded_email_outbox where id=p_id;
 if not found then return false;end if;
 if o.marker_kind is distinct from 'dunning' and o.flow<>'renewal_upcoming' then return true;end if;
 if exists(select 1 from public.admin_internal_accounts a where a.user_id=o.user_id)
   or not exists(select 1 from auth.users u where u.id=o.user_id and u.email_confirmed_at is not null
     and lower(u.email)=lower(o.recipient_email)) then return false;end if;
 if o.marker_kind='dunning' then
   return exists(select 1 from public.cloud_entitlement_projection e
     where e.user_id=o.user_id and e.provider='revolut' and e.status='past_due'
       and o.marker_stage=coalesce(e.dunning_stage,0)+1 and o.marker_stage between 1 and 3
       and (e.dunning_last_at is null or e.dunning_last_at<now()-interval '24 hours')
       and o.marker_reference=public.norva_billing_email_cycle_key(e.current_period_end,e.trial_ends_at));
 end if;
 return o.marker_kind='billing_event' and exists(
   select 1 from public.cloud_entitlement_projection e
   join public.cloud_revolut_customers c on c.user_id=e.user_id
   where e.user_id=o.user_id and e.provider='revolut' and e.status='active'
     and c.period in ('monthly','annual') and c.amount_cents between 1 and 9999999
     and nullif(c.payment_method_id,'') is not null and nullif(c.revolut_customer_id,'') is not null
     and e.current_period_end>now()
     and e.current_period_end<=now()+case c.period when 'annual' then interval '7 days' else interval '3 days' end
     and o.marker_reference=public.norva_billing_email_cycle_key(e.current_period_end,null));
end $$;
revoke all on function public.norva_billing_notice_allowed(uuid) from public,anon,authenticated;
grant execute on function public.norva_billing_notice_allowed(uuid) to service_role;

-- Preserve all mature transport, behavioral, trial, consent and lease branches.
-- Each replacement must match exactly once or deployment stops atomically.
do $guards$
declare spec record;definition text;
begin
 for spec in select * from (values
  ('norva_postal_full.branded_allowed(uuid)',
   'return v_allowed;end',
   'return v_allowed and public.norva_billing_notice_allowed(p_id);end'),
  ('public.authorize_branded_email_delivery_pre_behavioral(uuid,text,uuid)',
   '  if v_allowed then',
   E'  v_allowed := v_allowed and public.norva_billing_notice_allowed(p_id);\n  if v_allowed then'),
  ('public.complete_postal_branded_email_delivery(uuid,text,uuid,text,integer,jsonb)',
   'where e.user_id=o.user_id and e.status=''past_due'';',
   'where e.user_id=o.user_id and e.provider=''revolut'' and e.status=''past_due'' and o.marker_reference=public.norva_billing_email_cycle_key(e.current_period_end,e.trial_ends_at);'),
  ('public.complete_branded_email_delivery(uuid,text,uuid,text,integer,jsonb)',
   'where e.user_id=o.user_id and e.status=''past_due'';',
   'where e.user_id = o.user_id and e.provider = ''revolut'' and e.status = ''past_due'' and o.marker_reference=public.norva_billing_email_cycle_key(e.current_period_end,e.trial_ends_at);')
 ) as patches(signature,needle,replacement)
 loop
  definition:=pg_get_functiondef(to_regprocedure(spec.signature));
  if definition is null or (length(definition)-length(replace(definition,spec.needle,'')))/length(spec.needle)<>1 then
   raise exception 'billing email authorization baseline changed: %',spec.signature;
  end if;
  execute replace(definition,spec.needle,spec.replacement);
 end loop;
end $guards$;
