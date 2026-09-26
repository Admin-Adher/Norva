select public.yield_assert((select hash=md5(pg_get_functiondef(
 'public.provider_account_busy_for_foreground_validation(text)'::regprocedure)) from public.yield_proof_baseline),'foreground_function_unchanged');
select public.yield_assert(not public.provider_account_busy_for_catalog_refresh('fixture.invalid/account'),'baseline_catalogue_not_blocked');
select public.yield_assert(public.provider_account_busy_for_foreground_validation('fixture.invalid/account'),'foreground_grace_still_blocks_audio');
select public.yield_assert(not has_function_privilege('authenticated','public.request_language_validation_catalog_yield(uuid,text,text)','EXECUTE'),'caller_cannot_request_priority');
select public.yield_assert(not has_table_privilege('authenticated','public.provider_catalog_yield_requests','SELECT'),'priority_not_public');
select public.yield_assert(has_function_privilege('service_role','public.request_language_validation_catalog_yield(uuid,text,text)','EXECUTE'),'worker_allowed');

select public.yield_assert(not public.request_language_validation_catalog_yield('00000000-0000-0000-0000-000000000001','stale-worker','fixture.invalid/account'),'stale_worker_rejected');
select public.yield_assert(not public.request_language_validation_catalog_yield('00000000-0000-0000-0000-000000000001','worker-a',''),'empty_account_rejected');
select public.yield_assert(public.request_language_validation_catalog_yield('00000000-0000-0000-0000-000000000001','worker-a','fixture.invalid/account'),'valid_waiter');
select public.yield_assert(public.provider_account_busy_for_catalog_refresh('fixture.invalid/account'),'new_catalogue_work_yields');
select public.yield_assert(public.provider_account_busy_for_catalog_refresh(encode(extensions.digest('fixture.invalid/account','sha256'),'hex')),'hashed_reader_yields');
select public.yield_assert(not public.provider_account_busy_for_catalog_refresh('other.invalid/account'),'other_account_unaffected');
select public.yield_assert(public.provider_account_busy_for_foreground_validation('fixture.invalid/account'),'yield_does_not_bypass_grace');
select public.yield_assert((select kind='catalog-refresh' from public.provider_account_activity),'activity_not_downgraded');
select public.yield_assert((select expires_at<=clock_timestamp()+interval '90 seconds' and window_until<=clock_timestamp()+interval '10 minutes' from public.provider_catalog_yield_requests),'bounded_hold');

create temp table original_window as select window_until from public.provider_catalog_yield_requests;
select public.yield_assert(public.request_language_validation_catalog_yield('00000000-0000-0000-0000-000000000002','worker-b','fixture.invalid/account'),'another_waiter_same_account');
select public.yield_assert((select count(*)=1 from public.provider_catalog_yield_requests),'one_window_per_account');
select public.yield_assert((select h.window_until=o.window_until from public.provider_catalog_yield_requests h cross join original_window o),'another_job_cannot_extend_maximum');

update public.provider_catalog_yield_requests set expires_at=clock_timestamp()-interval '1 second';
select public.yield_assert(not public.provider_account_busy_for_catalog_refresh('fixture.invalid/account'),'dead_worker_expires');
select public.yield_assert(public.request_language_validation_catalog_yield('00000000-0000-0000-0000-000000000002','worker-b','fixture.invalid/account'),'live_worker_renews');
update public.catalog_file_audio_validation_jobs set state='cancelled' where lease_owner='worker-b';
select public.yield_assert(not public.provider_account_busy_for_catalog_refresh('fixture.invalid/account'),'cancelled_job_releases_priority');
select public.yield_assert(not public.request_language_validation_catalog_yield('00000000-0000-0000-0000-000000000002','worker-b','fixture.invalid/account'),'cancelled_worker_cannot_renew');
update public.catalog_file_audio_validation_jobs set state='running',quarantined_at=clock_timestamp() where lease_owner='worker-b';
select public.yield_assert(not public.provider_account_busy_for_catalog_refresh('fixture.invalid/account'),'quarantine_releases_priority');
update public.catalog_file_audio_validation_jobs set quarantined_at=null,lease_expires_at=clock_timestamp()-interval '1 second' where lease_owner='worker-b';
select public.yield_assert(not public.request_language_validation_catalog_yield('00000000-0000-0000-0000-000000000002','worker-b','fixture.invalid/account'),'expired_worker_cannot_renew');

update public.provider_catalog_yield_requests set window_until=clock_timestamp()-interval '1 minute',expires_at=clock_timestamp()-interval '1 minute';
select public.yield_assert(not public.request_language_validation_catalog_yield('00000000-0000-0000-0000-000000000001','worker-a','fixture.invalid/account'),'maximum_window_has_cooldown');
select public.yield_assert(not public.provider_account_busy_for_catalog_refresh('fixture.invalid/account'),'catalogue_can_run_during_cooldown');
update public.provider_catalog_yield_requests set window_until=clock_timestamp()-interval '3 minutes';
select public.yield_assert(public.request_language_validation_catalog_yield('00000000-0000-0000-0000-000000000001','worker-a','fixture.invalid/account'),'priority_rearms_after_cooldown');

-- Real/unknown foreground activity always blocks catalogue work even without a waiter.
delete from public.provider_catalog_yield_requests;
update public.provider_account_activity set kind='playback';
select public.yield_assert(public.provider_account_busy_for_catalog_refresh('fixture.invalid/account'),'playback_still_wins');
update public.provider_account_activity set kind=null;
select public.yield_assert(public.provider_account_busy_for_catalog_refresh('fixture.invalid/account'),'unknown_activity_fails_closed');
select count(*) as passed_checks from public.yield_proof_checks;
