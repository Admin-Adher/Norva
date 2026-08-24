\set ON_ERROR_STOP on
begin;
set local "request.jwt.claim.role" = 'service_role';
insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  'd0000000-0000-0000-0000-000000000089','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','product-delete-089@invalid.test','not-used',clock_timestamp(),
  '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp()
);
insert into public.cloud_profiles(id,display_name) values
  ('d0000000-0000-0000-0000-000000000089','product reaper fixture');
insert into public.cloud_account_deletion_workflows(user_id,state,revision) values
  ('d0000000-0000-0000-0000-000000000089','purging_product',0);

-- One relation at a time.  Signup triggers may add more than the profile and
-- preference rows, so convergence is asserted from the durable state rather
-- than a brittle fixed relation count.
do $drain$
declare v_revision bigint; v_state text; v_steps integer := 0;
begin
  loop
    select revision,state into v_revision,v_state
    from public.cloud_account_deletion_workflows
    where user_id='d0000000-0000-0000-0000-000000000089';
    exit when v_state='ready_to_finalize';
    perform public.norva_purge_account_deletion_product_batch(
      'd0000000-0000-0000-0000-000000000089',v_revision,10
    );
    v_steps := v_steps + 1;
    if v_steps > 80 then raise exception 'product reaper did not converge'; end if;
  end loop;
end
$drain$;
do $assert$
begin
  if exists (select 1 from public.cloud_profiles where id='d0000000-0000-0000-0000-000000000089')
     or exists (select 1 from public.cloud_marketing_email_preferences where user_id='d0000000-0000-0000-0000-000000000089')
     or not exists (select 1 from public.cloud_account_deletion_workflows
                    where user_id='d0000000-0000-0000-0000-000000000089'
                      and state='ready_to_finalize') then
    raise exception 'account deletion product reaper contract failed';
  end if;
end
$assert$;
rollback;
