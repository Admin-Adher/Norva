\set ON_ERROR_STOP on
\if :{?fixture_transition_id}
\else
  \echo 'fixture_transition_id is required'
  \quit
\endif

-- Consumes a committed READY_TO_SWITCH fixture produced by the enriched
-- provider_replacement_candidate_builder.sql. A and B each contain distinct
-- movie, series and live markers written under their real generation fences.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
create extension if not exists pgtap with schema extensions;
select extensions.plan(38);

create temporary table phase5_surface_ctx(
  key text primary key,value text not null
) on commit drop;
grant all on phase5_surface_ctx to authenticated,service_role;
insert into phase5_surface_ctx(key,value)
select 'transition_id',transition.id::text
from public.cloud_source_transitions transition
where transition.id=:'fixture_transition_id'::uuid
union all select 'user_id',transition.user_id::text
from public.cloud_source_transitions transition
where transition.id=:'fixture_transition_id'::uuid
union all select 'old_source_id',transition.old_source_id::text
from public.cloud_source_transitions transition
where transition.id=:'fixture_transition_id'::uuid
union all select 'candidate_source_id',transition.candidate_source_id::text
from public.cloud_source_transitions transition
where transition.id=:'fixture_transition_id'::uuid;

-- Production catalog views are intentionally not granted directly to browser
-- roles. These transaction-local, owner-scoped wrappers exercise the exact
-- production projections without widening their durable ACL.
create function pg_temp.norva_test_phase5_visible_sources()
returns setof public.cloud_catalog_visible_sources
language sql security definer set search_path='' as $function$
  select source.* from public.cloud_catalog_visible_sources source
  where source.user_id=(select value::uuid from pg_temp.phase5_surface_ctx where key='user_id')
$function$;
create function pg_temp.norva_test_phase5_visible_media_items()
returns setof public.cloud_catalog_visible_media_items
language sql security definer set search_path='' as $function$
  select item.* from public.cloud_catalog_visible_media_items item
  where item.user_id=(select value::uuid from pg_temp.phase5_surface_ctx where key='user_id')
$function$;
create function pg_temp.norva_test_phase5_management_sources()
returns setof public.cloud_source_management_sources
language sql security definer set search_path='' as $function$
  select source.* from public.cloud_source_management_sources source
  where source.user_id=(select value::uuid from pg_temp.phase5_surface_ctx where key='user_id')
$function$;
create function pg_temp.norva_test_phase5_visible_favorites()
returns setof public.cloud_catalog_visible_favorites
language sql security definer set search_path='' as $function$
  select favorite.* from public.cloud_catalog_visible_favorites favorite
  where favorite.user_id=(select value::uuid from pg_temp.phase5_surface_ctx where key='user_id')
$function$;
create function pg_temp.norva_test_phase5_visible_history()
returns setof public.cloud_catalog_visible_watch_history
language sql security definer set search_path='' as $function$
  select history.* from public.cloud_catalog_visible_watch_history history
  where history.user_id=(select value::uuid from pg_temp.phase5_surface_ctx where key='user_id')
$function$;
revoke all on function pg_temp.norva_test_phase5_visible_sources(),
  pg_temp.norva_test_phase5_visible_media_items(),
  pg_temp.norva_test_phase5_management_sources(),
  pg_temp.norva_test_phase5_visible_favorites(),
  pg_temp.norva_test_phase5_visible_history() from public;
grant execute on function pg_temp.norva_test_phase5_visible_sources(),
  pg_temp.norva_test_phase5_visible_media_items(),
  pg_temp.norva_test_phase5_management_sources(),
  pg_temp.norva_test_phase5_visible_favorites(),
  pg_temp.norva_test_phase5_visible_history() to authenticated,service_role;
create temporary view phase5_visible_sources as
select source.* from pg_temp.norva_test_phase5_visible_sources() source;
create temporary view phase5_visible_media_items as
select item.* from pg_temp.norva_test_phase5_visible_media_items() item;
create temporary view phase5_management_sources as
select source.* from pg_temp.norva_test_phase5_management_sources() source;
create temporary view phase5_visible_favorites as
select favorite.* from pg_temp.norva_test_phase5_visible_favorites() favorite;
create temporary view phase5_visible_history as
select history.* from pg_temp.norva_test_phase5_visible_history() history;
grant select on phase5_visible_sources,phase5_visible_media_items,
  phase5_management_sources,phase5_visible_favorites,phase5_visible_history
  to authenticated,service_role;

insert into public.cloud_favorites(
  user_id,source_id,item_type,item_id,item_name,item_meta
) values (
  (select value::uuid from phase5_surface_ctx where key='user_id'),
  (select value::uuid from phase5_surface_ctx where key='old_source_id'),
  'movie','a-history','A favorite','{"phase5":"A"}'::jsonb
);
insert into public.cloud_watch_history(
  user_id,source_id,item_type,item_id,item_name,
  progress_seconds,duration_seconds,data
) values (
  (select value::uuid from phase5_surface_ctx where key='user_id'),
  (select value::uuid from phase5_surface_ctx where key='old_source_id'),
  'movie','a-history','A history',120,600,'{"phase5":"A"}'::jsonb
);

select set_config('request.jwt.claims',jsonb_build_object(
  'sub',(select value from phase5_surface_ctx where key='user_id'),
  'role','authenticated')::text,true);
select set_config('request.jwt.claim.sub',
  (select value from phase5_surface_ctx where key='user_id'),true);
select set_config('request.jwt.claim.role','authenticated',true);
set local role authenticated;

select extensions.is(
  (select count(*)::integer from phase5_visible_sources),1,
  'before switch exactly one source is user-visible');
select extensions.is(
  (select id from phase5_visible_sources),
  (select value::uuid from phase5_surface_ctx where key='old_source_id'),
  'before switch A is the visible source');
select extensions.is(
  (select count(*)::integer from phase5_visible_media_items),3,
  'before switch only the three A surface markers are visible');
select extensions.is(
  (select count(*)::integer from phase5_visible_media_items
   where item_type='movie'),1,'Movies reads one A marker');
select extensions.is(
  (select count(*)::integer from phase5_visible_media_items
   where item_type='series'),1,'Series reads one A marker');
select extensions.is(
  (select count(*)::integer from phase5_visible_media_items
   where item_type='live'),1,'Live TV reads one A marker');
select extensions.is(
  (select count(*)::integer from phase5_visible_media_items
   where source_id=(select value::uuid from phase5_surface_ctx where key='candidate_source_id')),
  0,'staging B is absent from every media projection');
select extensions.is((select count(*)::integer from phase5_visible_favorites),1,
  'A favorite is visible before replacement');
select extensions.is((select count(*)::integer from phase5_visible_history),1,
  'A history is visible before replacement');
select extensions.is(public.norva_source_catalog_visible(
  (select value::uuid from phase5_surface_ctx where key='old_source_id'),
  (select value::uuid from phase5_surface_ctx where key='user_id')),true,
  'player gate admits A before switch');
select extensions.is(public.norva_source_catalog_visible(
  (select value::uuid from phase5_surface_ctx where key='candidate_source_id'),
  (select value::uuid from phase5_surface_ctx where key='user_id')),false,
  'player gate rejects staging B before switch');
select extensions.is(
  (select id from phase5_management_sources),
  (select value::uuid from phase5_surface_ctx where key='old_source_id'),
  'Settings/source picker excludes staging B');
insert into phase5_surface_ctx(key,value)
select 'token_before',public.norva_catalog_cache_epoch_v2(
  (select value::uuid from phase5_surface_ctx where key='user_id'))->>'cacheEpoch';

reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claim.role','service_role',true);
set local role service_role;
insert into phase5_surface_ctx(key,value)
select 'promotion_result',public.norva_promote_source_replacement_v3(
  transition.id,transition.user_id,'phase5-cross-surface-promotion',
  transition.expected_source_revision,
  coalesce(transition.promotion_expected_transition_revision,transition.revision),
  head.head_revision
)::text
from public.cloud_source_transitions transition
join public.cloud_source_catalog_heads head
  on head.source_id=transition.candidate_source_id and head.user_id=transition.user_id
where transition.id=(select value::uuid from phase5_surface_ctx where key='transition_id');
select extensions.is(
  (select value::jsonb->>'state' from phase5_surface_ctx where key='promotion_result'),
  'COMPLETED','atomic promotion reaches COMPLETED');

reset role;
select set_config('request.jwt.claims',jsonb_build_object(
  'sub',(select value from phase5_surface_ctx where key='user_id'),
  'role','authenticated')::text,true);
select set_config('request.jwt.claim.sub',
  (select value from phase5_surface_ctx where key='user_id'),true);
select set_config('request.jwt.claim.role','authenticated',true);
set local role authenticated;
insert into phase5_surface_ctx(key,value)
select 'token_after_promotion',public.norva_catalog_cache_epoch_v2(
  (select value::uuid from phase5_surface_ctx where key='user_id'))->>'cacheEpoch';
select extensions.isnt(
  (select value from phase5_surface_ctx where key='token_after_promotion'),
  (select value from phase5_surface_ctx where key='token_before'),
  'promotion changes the exact v2 cache token');
select extensions.is(
  (select count(*)::integer from phase5_visible_sources),1,
  'after promotion exactly one source remains visible');
select extensions.is(
  (select id from phase5_visible_sources),
  (select value::uuid from phase5_surface_ctx where key='candidate_source_id'),
  'after promotion B is the visible source');
select extensions.is(
  (select count(*)::integer from phase5_visible_media_items),3,
  'after promotion only the three B surface markers are visible');
select extensions.is((select count(*)::integer
  from phase5_visible_media_items where item_type='movie'),1,
  'Movies switches atomically from A to B');
select extensions.is((select count(*)::integer
  from phase5_visible_media_items where item_type='series'),1,
  'Series switches atomically from A to B');
select extensions.is((select count(*)::integer
  from phase5_visible_media_items where item_type='live'),1,
  'Live TV switches atomically from A to B');
select extensions.is((select count(*)::integer
  from phase5_visible_media_items
  where source_id=(select value::uuid from phase5_surface_ctx where key='old_source_id')),
  0,'A is absent from user-facing catalog projections after promotion');
select extensions.is((select count(*)::integer from phase5_visible_favorites),0,
  'provider-scoped A favorite is hidden rather than rebound unsafely to B');
select extensions.is((select count(*)::integer from phase5_visible_history),0,
  'provider-scoped A history is hidden rather than rebound unsafely to B');
select extensions.is(public.norva_source_catalog_visible(
  (select value::uuid from phase5_surface_ctx where key='old_source_id'),
  (select value::uuid from phase5_surface_ctx where key='user_id')),false,
  'player gate rejects A after promotion');
select extensions.is(public.norva_source_catalog_visible(
  (select value::uuid from phase5_surface_ctx where key='candidate_source_id'),
  (select value::uuid from phase5_surface_ctx where key='user_id')),true,
  'player gate admits B after promotion');
select extensions.ok(
  (select count(*)=2 and count(*) filter(where catalog_visible)=1
     and min(id::text) filter(where catalog_visible)=
       (select value from phase5_surface_ctx where key='candidate_source_id')
   from phase5_management_sources),
  'Settings retains rollback A while only B is catalog-visible to source pickers');

reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claim.role','service_role',true);
set local role service_role;
select extensions.is((select count(*)::integer from public.cloud_favorites
  where user_id=(select value::uuid from phase5_surface_ctx where key='user_id')),1,
  'A favorite remains durable during the rollback window');
select extensions.is((select count(*)::integer from public.cloud_watch_history
  where user_id=(select value::uuid from phase5_surface_ctx where key='user_id')),1,
  'A history remains durable during the rollback window');
insert into phase5_surface_ctx(key,value)
select 'rollback_result',public.norva_rollback_source_replacement(
  transition.id,transition.user_id,'phase5-cross-surface-worker',
  'phase5-cross-surface-rollback',repeat('e',64),transition.revision,
  lifecycle.config_revision
)::text
from public.cloud_source_transitions transition
join public.cloud_source_lifecycle lifecycle
  on lifecycle.source_id=transition.candidate_source_id
 and lifecycle.user_id=transition.user_id
where transition.id=(select value::uuid from phase5_surface_ctx where key='transition_id');
select extensions.is(
  (select value::jsonb->>'state' from phase5_surface_ctx where key='rollback_result'),
  'COMPLETED','rollback reaches one durable compensating transition');

reset role;
select set_config('request.jwt.claims',jsonb_build_object(
  'sub',(select value from phase5_surface_ctx where key='user_id'),
  'role','authenticated')::text,true);
select set_config('request.jwt.claim.sub',
  (select value from phase5_surface_ctx where key='user_id'),true);
select set_config('request.jwt.claim.role','authenticated',true);
set local role authenticated;
insert into phase5_surface_ctx(key,value)
select 'token_after_rollback',public.norva_catalog_cache_epoch_v2(
  (select value::uuid from phase5_surface_ctx where key='user_id'))->>'cacheEpoch';
select extensions.isnt(
  (select value from phase5_surface_ctx where key='token_after_rollback'),
  (select value from phase5_surface_ctx where key='token_after_promotion'),
  'rollback advances the exact v2 cache token again');
select extensions.is((select count(*)::integer
  from phase5_visible_sources),1,
  'rollback still exposes exactly one source');
select extensions.is((select id from phase5_visible_sources),
  (select value::uuid from phase5_surface_ctx where key='old_source_id'),
  'rollback restores A without A+B');
select extensions.is((select count(*)::integer
  from phase5_visible_media_items),3,
  'rollback restores all three A surface markers');
select extensions.is((select count(*)::integer from phase5_visible_favorites),1,
  'rollback restores the preserved A favorite');
select extensions.is((select count(*)::integer from phase5_visible_history),1,
  'rollback restores the preserved A history');
select extensions.is(public.norva_source_catalog_visible(
  (select value::uuid from phase5_surface_ctx where key='old_source_id'),
  (select value::uuid from phase5_surface_ctx where key='user_id')),true,
  'player gate restores A after rollback');
select extensions.is(public.norva_source_catalog_visible(
  (select value::uuid from phase5_surface_ctx where key='candidate_source_id'),
  (select value::uuid from phase5_surface_ctx where key='user_id')),false,
  'player gate rejects retired B after rollback');
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claim.role','service_role',true);
set local role service_role;
select extensions.is((select count(*)::integer
  from public.cloud_source_transitions reversal
  where reversal.reversal_of_transition_id=
    (select value::uuid from phase5_surface_ctx where key='transition_id')),1,
  'rollback creates exactly one compensating transition');

select * from extensions.finish();
rollback;
