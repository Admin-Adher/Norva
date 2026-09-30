begin;
set local request.jwt.claim.role='service_role';
set local lock_timeout='3s';
do $test$
declare owner_id uuid; other_id uuid; before_epoch bigint; after_epoch bigint; detail text; first_expiry timestamptz; next_expiry timestamptz;
begin
 select user_id into strict owner_id from cloud_source_credential_transition_jobs where id=current_setting('norva.test_job_id')::uuid;
 select visibility_epoch into before_epoch from cloud_user_catalog_visibility_epochs where user_id=owner_id;
 if not public.norva_request_catalog_reader_window(owner_id) then raise exception 'active refresh not yielded'; end if;
 select visibility_epoch into after_epoch from cloud_user_catalog_visibility_epochs where user_id=owner_id;
 if before_epoch<>after_epoch then raise exception 'reader window changed catalogue epoch'; end if;
 select expires_at into first_expiry from cloud_catalog_reader_windows where user_id=owner_id;
 perform public.norva_request_catalog_reader_window(owner_id);
 select expires_at into next_expiry from cloud_catalog_reader_windows where user_id=owner_id;
 if next_expiry<>first_expiry then raise exception 'repeated reads extended the bounded window'; end if;
 begin
  perform public.norva_assert_catalog_writer_window(owner_id);
  raise exception 'writer admitted during reader retry';
 exception when sqlstate 'PT409' then
  get stacked diagnostics detail=pg_exception_detail;
  if detail<>'reason=catalog_reader_priority' then raise; end if;
 end;
 select id into strict other_id from auth.users u where u.id<>owner_id and not exists(select 1 from cloud_source_credential_transition_jobs j where j.user_id=u.id and j.job_kind='post_switch_verify' and j.state in ('pending','processing')) limit 1;
 if public.norva_request_catalog_reader_window(other_id) then raise exception 'unrelated owner delayed'; end if;
 perform public.norva_assert_catalog_writer_window(other_id);
 update cloud_catalog_reader_windows set expires_at=clock_timestamp()-interval '1 second' where user_id=owner_id;
 perform public.norva_assert_catalog_writer_window(owner_id);
 perform public.norva_request_catalog_reader_window(owner_id);
 select expires_at into next_expiry from cloud_catalog_reader_windows where user_id=owner_id;
 if next_expiry<=clock_timestamp() then raise exception 'expired window was not renewed'; end if;
 if has_function_privilege('anon','public.norva_request_catalog_reader_window(uuid)','execute') or has_function_privilege('authenticated','public.norva_request_catalog_reader_window(uuid)','execute') or not has_function_privilege('service_role','public.norva_request_catalog_reader_window(uuid)','execute') or has_table_privilege('service_role','public.cloud_catalog_reader_windows','select') then raise exception 'reader window permissions invalid'; end if;
 raise notice 'Reader window blocks owner writes, expires, isolates other owners and preserves epoch';
end $test$;
rollback;
