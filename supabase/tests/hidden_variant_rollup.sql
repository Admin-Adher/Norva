begin;
create temp table rollup_calls(id uuid);
create or replace function public.refresh_cloud_title_rollup(target_title_id uuid)
returns void language sql as $$ insert into pg_temp.rollup_calls values(target_title_id) $$;
create temp table variant_fixture(id int primary key,title_id uuid,user_id uuid,source_id uuid,generation_id uuid, playback_cost_score int, last_observed_ttff_ms int, created_at timestamptz, metadata jsonb);
create trigger rollup_fixture after insert or update or delete on variant_fixture
for each row execute function public.refresh_cloud_title_rollup_trigger();
do $test$
declare h public.cloud_source_catalog_heads%rowtype; hidden uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
begin
 select * into strict h from public.cloud_source_catalog_heads where active_generation_id is not null limit 1;
 insert into variant_fixture(id,title_id,user_id,source_id,generation_id) values(1,a,h.user_id,h.source_id,hidden);
 update variant_fixture set title_id=b where id=1;
 delete from variant_fixture where id=1;
 if (select count(*) from rollup_calls)<>0 then raise exception 'hidden writes refreshed visible rollup'; end if;
 insert into variant_fixture(id,title_id,user_id,source_id,generation_id) values(2,a,h.user_id,h.source_id,h.active_generation_id);
 insert into variant_fixture(id,title_id,user_id,source_id,generation_id) values(3,a,h.user_id,h.source_id,null);
 if (select count(*) from rollup_calls)<>2 then raise exception 'active or legacy insert skipped'; end if;
 update variant_fixture set title_id=b where id=2;
 if (select count(*) from rollup_calls)<>4 then raise exception 'visible title move not reconciled'; end if;
 update variant_fixture set generation_id=hidden where id=2;
 if (select count(*) from rollup_calls)<>5 then raise exception 'visible-to-hidden move skipped'; end if;
 update variant_fixture set generation_id=h.active_generation_id where id=2;
 if (select count(*) from rollup_calls)<>6 then raise exception 'hidden-to-visible move skipped'; end if;
 delete from variant_fixture where id=2;
 if (select count(*) from rollup_calls)<>7 then raise exception 'active delete skipped'; end if;
 insert into variant_fixture(id,title_id,user_id,source_id,generation_id) values(4,a,gen_random_uuid(),h.source_id,h.active_generation_id);
 if (select count(*) from rollup_calls)<>7 then raise exception 'other owner matched head'; end if;
 truncate rollup_calls;
 update variant_fixture set metadata='{"refreshed":true}' where id=3;
 update variant_fixture set title_id=title_id where id=3;
 if (select count(*) from rollup_calls)<>0 then raise exception 'irrelevant update recalculated rollup'; end if;
 update variant_fixture set playback_cost_score=10 where id=3;
 update variant_fixture set last_observed_ttff_ms=200 where id=3;
 update variant_fixture set created_at=now() where id=3;
 update variant_fixture set id=33 where id=3;
 if (select count(*) from rollup_calls)<>4 then raise exception 'ranking/identity update skipped'; end if;
 raise notice 'Hidden rollup and dependency regression passed';
end
$test$;
rollback;