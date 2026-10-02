-- Disposable database only; never run this fixture in production.
create table public.cloud_catalog_facet_summary(user_id uuid,item_type text,refreshed_at timestamptz,
 genre_rail_visibility_epoch bigint,genre_rail_refreshed_at timestamptz);
create table public.cloud_catalog_visible_title_variants(user_id uuid,item_type text);
create table public.cloud_user_catalog_visibility_epochs(user_id uuid,visibility_epoch bigint);
create table public.cloud_sources(id uuid,user_id uuid,deleted_at timestamptz,provider_deletion_pending boolean);
create table public.cloud_source_lifecycle(source_id uuid,user_id uuid,lifecycle_state text,catalog_visibility text,purge_after timestamptz);
create table public.smoke_success(kind text);
create table public.cloud_branded_email_outbox(state text,dead_lettered_at timestamptz,payload_scrubbed_at timestamptz,
 recipient_email text,request_reply_to text,request_subject text,request_html text,request_text text,
 request_headers jsonb,resend_response jsonb,postal_response jsonb,updated_at timestamptz,sent_at timestamptz,
 mail_provider text,resend_email_id text,postal_message_id bigint,
 check ((mail_provider='resend' and postal_message_id is null and postal_response is null)
 or (mail_provider='postal' and resend_email_id is null and resend_response is null)));
create function public.cloud_refresh_facet_summary(uuid,text) returns void language plpgsql as $$
begin
 if $1='00000000-0000-0000-0000-000000000001' then
  raise exception 'visibility retry' using errcode='40001',detail='reason=catalog_visibility_changed';
 end if;
 insert into public.smoke_success values ('facet');
end $$;
create function public.cloud_refresh_genre_rail_candidates(uuid,text) returns void language plpgsql as $$
begin
 if $1='00000000-0000-0000-0000-000000000001' then
  raise exception 'visibility retry' using errcode='40001',detail='reason=catalog_visibility_changed';
 end if;
 insert into public.smoke_success values ('genre');
end $$;
create function public.norva_enqueue_source_delete_cleanup(uuid,uuid) returns boolean language plpgsql as $$
begin
 if $1='00000000-0000-0000-0000-000000000001' then
  raise exception 'transition retry' using errcode='55P03',detail='reason=account_transition_active';
 end if;
 insert into public.smoke_success values ('cleanup');return true;
end $$;
insert into public.cloud_catalog_facet_summary select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 'movie',now()-interval '1 day',null,null from generate_series(1,2)n;
insert into public.cloud_sources select user_id,user_id,now()-interval '1 day',false from public.cloud_catalog_facet_summary;
insert into public.cloud_source_lifecycle select id,user_id,'purge_pending','hidden',now()-interval '1 day' from public.cloud_sources;
insert into public.cloud_branded_email_outbox(state,dead_lettered_at,mail_provider,resend_response,postal_response)
 values ('dead_letter',now()-interval '15 days','postal',null,'{"private":"scrub"}'),
 ('dead_letter',now()-interval '15 days','resend','{"private":"scrub"}',null);
-- Install the production function definitions, then the migration, before
-- running ops_maintenance_retry_assert.sql in this same disposable database.
