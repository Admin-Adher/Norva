-- Disposable database only. Auth schema is created by the real GoTrue image.
create or replace function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
grant usage on schema auth to anon,authenticated,service_role;
grant execute on function auth.uid() to public;
create function public.is_admin() returns boolean language sql stable as $$
 select coalesce(nullif(current_setting('norva.test_is_admin',true),''),'false')::boolean;
$$;
create table public.cloud_branded_email_outbox (
 id uuid primary key,delivery_key text unique,dedupe_key text,user_id uuid,
 flow text,state text,recipient_email text,request_from text,request_reply_to text,
 request_subject text,request_html text,request_text text,request_tags jsonb,
 next_attempt_at timestamptz,attempt_count integer default 0,request_headers jsonb default '{}',
 sent_at timestamptz,payload_scrubbed_at timestamptz,last_error text,updated_at timestamptz,
 check(state not in ('sent','canceled') or (recipient_email is null and request_reply_to is null and request_subject is null
  and request_html is null and request_text is null and request_headers='{}'))
);
create unique index on public.cloud_branded_email_outbox(dedupe_key) where dedupe_key is not null;
alter table public.cloud_branded_email_outbox enable row level security;
create table public.cloud_gateway_sessions(user_id uuid,updated_at timestamptz);
create table public.cloud_playback_sessions(user_id uuid,updated_at timestamptz,mode text);
create table public.cloud_entitlement_projection(user_id uuid,provider text,status text,current_period_end timestamptz);
create table public.cloud_revolut_customers(
 user_id uuid primary key,plan text,period text,amount_cents integer,base_amount_cents integer,promo_cycles_left integer,
 pending_plan text,pending_period text,pending_amount_cents integer,pending_effective_at timestamptz,pending_order_id text
);
create function public.admin_marketing_system_automations() returns jsonb language plpgsql security definer as $$
begin
 if not public.is_admin() then raise exception 'not authorized' using errcode='42501';end if;
 return jsonb_build_array(jsonb_build_object('id','existing-fixture'));
end $$;
revoke all on function public.admin_marketing_system_automations() from public,anon;
grant execute on function public.admin_marketing_system_automations() to authenticated,service_role;
