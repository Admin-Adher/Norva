do $$ begin
 if public.cloud_refresh_all_facet_summaries(10)<>1 then raise exception 'facet isolation failed';end if;
 if public.cloud_refresh_all_genre_rail_candidates(10)<>1 then raise exception 'genre isolation failed';end if;
 if public.norva_recover_source_delete_cleanups(10)<>1 then raise exception 'cleanup isolation failed';end if;
 perform public.prune_branded_email_outbox();
 if (select count(*) from public.cloud_branded_email_outbox where payload_scrubbed_at is not null)<>2 then
  raise exception 'both transports must scrub';end if;
 if (select count(*) from public.smoke_success)<>3 then raise exception 'successful owners lost';end if;
end $$;
-- Unexpected errors remain visible; no broad catch masks maintenance defects.
create or replace function public.norva_enqueue_source_delete_cleanup(uuid,uuid) returns boolean language plpgsql as $$
begin raise exception 'different lock fault' using errcode='55P03',detail='unexpected';end $$;
do $$ begin
 perform public.norva_recover_source_delete_cleanups(10);
 raise exception 'unexpected lock failure was swallowed';
exception when lock_not_available then null;
end $$;
create or replace function public.cloud_refresh_facet_summary(uuid,text) returns void language plpgsql as $$
begin raise exception 'different serialization fault' using errcode='40001',detail='unexpected';end $$;
do $$ begin
 perform public.cloud_refresh_all_facet_summaries(10);
 raise exception 'unexpected visibility failure was swallowed';
exception when serialization_failure then null;
end $$;
select 'maintenance retry isolation and Postal scrub passed' as result;
