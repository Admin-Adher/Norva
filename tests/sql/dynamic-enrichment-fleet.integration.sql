-- Run against a migrated Norva database:
--   psql -v ON_ERROR_STOP=1 -f tests/sql/dynamic-enrichment-fleet.integration.sql
--
-- All queue mutations are rolled back. No edge/provider request is made.
-- Run only while norva-dynamic-enrichment-fleet is inactive: this transaction
-- deliberately owns the scheduler rows while it exercises claim/reclaim.

begin;

update public.catalog_enrichment_source_schedule
   set next_run_at = now() - interval '1 second',
       lease_until = null,
       claim_token = null;
delete from public.catalog_enrichment_dispatch_leases;

create temporary table fleet_first_claims as
select * from public.claim_catalog_enrichment_sources(4, 1200);

create temporary table fleet_overlapping_claims as
select * from public.claim_catalog_enrichment_sources(4, 1200);

do $assert$
begin
  if not exists (select 1 from fleet_first_claims) then
    raise exception 'fixture has no active movie source';
  end if;
  if exists (
    select 1
    from fleet_first_claims first_claim
    join fleet_overlapping_claims second_claim
      on second_claim.user_id = first_claim.user_id
  ) then
    raise exception 'overlapping claims acquired the same user lease';
  end if;
  if exists (
    select claim_token
    from (
      select claim_token from fleet_first_claims
      union all
      select claim_token from fleet_overlapping_claims
    ) all_claims
    group by claim_token
    having count(*) > 1
  ) then
    raise exception 'claim token was reused';
  end if;
  if exists (
    select 1
    from (
      select * from fleet_first_claims
      union all
      select * from fleet_overlapping_claims
    ) claim
    join public.cloud_sources source on source.id = claim.source_id
    where source.user_id <> claim.user_id
  ) then
    raise exception 'a claim was returned under the wrong source owner';
  end if;
  if exists (
    select identity.identity_id
    from (
      select * from fleet_first_claims
      union all
      select * from fleet_overlapping_claims
    ) claim
    join public.catalog_source_provider_identities identity
      on identity.source_id = claim.source_id
     and identity.user_id = claim.user_id
    group by identity.identity_id
    having count(*) > 1
  ) then
    raise exception 'overlapping calls acquired the same canonical provider';
  end if;
end
$assert$;

create temporary table fleet_target as
select * from fleet_first_claims order by source_id limit 1;

do $assert$
declare
  target fleet_target%rowtype;
  stale_accepted boolean;
  deferred boolean;
begin
  select * into strict target from fleet_target;

  select public.finish_catalog_enrichment_source(
    target.source_id,
    gen_random_uuid(),
    true,
    90,
    true,
    '{}'::jsonb
  ) into stale_accepted;
  if stale_accepted then
    raise exception 'stale completion token was accepted';
  end if;

  select public.finish_catalog_enrichment_source(
    target.source_id,
    target.claim_token,
    false,
    300,
    false,
    '{"error":"simulated ambiguous timeout"}'::jsonb
  ) into deferred;
  if not deferred then
    raise exception 'valid deferred completion was rejected';
  end if;
  if not exists (
    select 1
    from public.catalog_enrichment_source_schedule schedule
    where schedule.source_id = target.source_id
      and schedule.claim_token = target.claim_token
      and schedule.lease_until > now()
      and schedule.dispatch_count = target.dispatch_count + 1
  ) then
    raise exception 'ambiguous timeout released or failed to advance its lane';
  end if;
  if (
    select count(*)
    from public.catalog_enrichment_dispatch_leases lease
    where lease.claim_token = target.claim_token
      and lease.expires_at > now()
  ) <> 2 then
    raise exception 'global user/provider leases were not retained';
  end if;
end
$assert$;

update public.catalog_enrichment_source_schedule
   set next_run_at = now() - interval '1 second',
       lease_until = now() - interval '1 second'
 where source_id = (select source_id from fleet_target);
update public.catalog_enrichment_dispatch_leases
   set expires_at = now() - interval '1 second'
 where claim_token = (select claim_token from fleet_target);

-- Remove every unrelated due candidate. The next claim must be the expired
-- target itself, not merely some other source that happens to be due.
update public.catalog_enrichment_source_schedule
   set next_run_at = now() + interval '1 day'
 where source_id <> (select source_id from fleet_target);

create temporary table fleet_reclaimed as
select * from public.claim_catalog_enrichment_sources(1, 1200);

do $assert$
declare
  target fleet_target%rowtype;
  reclaimed fleet_reclaimed%rowtype;
begin
  select * into strict target from fleet_target;
  select * into strict reclaimed from fleet_reclaimed;
  if reclaimed.source_id <> target.source_id then
    raise exception 'a different due source masked the expired-target reclaim';
  end if;
  if reclaimed.claim_token = target.claim_token then
    raise exception 'expired target reused its stale claim token';
  end if;
  if reclaimed.user_id <> target.user_id then
    raise exception 'reclaimed target changed owner';
  end if;
  if (select count(*) from fleet_reclaimed) <> 1 then
    raise exception 'expired claim was not reclaimed';
  end if;
end
$assert$;

-- A dry final lane cannot sleep for six hours when an earlier lane in the
-- current sweep found work. Exercise the database-side cycle memory using the
-- freshly reclaimed token.
update public.catalog_enrichment_source_schedule
   set dispatch_count = 5,
       cycle_had_work = true
 where source_id = (select source_id from fleet_reclaimed);

do $assert$
declare
  reclaimed fleet_reclaimed%rowtype;
  accepted boolean;
begin
  select * into strict reclaimed from fleet_reclaimed;
  select public.finish_catalog_enrichment_source(
    reclaimed.source_id,
    reclaimed.claim_token,
    true,
    21600,
    true,
    '{"processed":0,"hasMore":false,"exhausted":true}'::jsonb
  ) into accepted;
  if not accepted then
    raise exception 'final-lane completion was rejected';
  end if;
  if not exists (
    select 1
    from public.catalog_enrichment_source_schedule schedule
    where schedule.source_id = reclaimed.source_id
      and schedule.next_run_at <= now() + interval '90 seconds'
      and schedule.cycle_had_work = false
      and schedule.claim_token is null
  ) then
    raise exception 'dry final lane slept despite prior cycle work';
  end if;
end
$assert$;

rollback;
