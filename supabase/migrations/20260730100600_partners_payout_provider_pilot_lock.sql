-- Norva Partners - payout execution adapter lock for the initial pilot.
--
-- The only implemented execution, webhook and reconciliation path is
-- Airwallex. Keep dormant configurations for future adapters, but fail closed
-- if an operator tries to activate one before its own execution path exists.
--
-- Configurations remain route-scoped (country + currency), so several
-- Airwallex corridors can be active concurrently. At most one provider
-- configuration may be active for a given corridor. A future provider rollout
-- can reverse this policy explicitly by dropping this constraint and index in
-- a reviewed migration.

do $pilot_preflight$
begin
  if exists (
    select 1
    from affiliate_private.affiliate_payout_provider_configs config
    where config.status = 'active'
      and config.provider <> 'airwallex'
  ) then
    raise exception
      'disable non-Airwallex payout routes before installing the pilot lock'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_payout_provider_configs config
    where config.status = 'active'
    group by config.country_code, config.currency
    having count(*) > 1
  ) then
    raise exception
      'each payout corridor must have at most one active provider configuration'
      using errcode = 'P0001';
  end if;
end;
$pilot_preflight$;

alter table affiliate_private.affiliate_payout_provider_configs
  add constraint affiliate_payout_provider_configs_pilot_adapter
  check (
    status <> 'active'
    or provider = 'airwallex'
  )
  not valid;

alter table affiliate_private.affiliate_payout_provider_configs
  validate constraint affiliate_payout_provider_configs_pilot_adapter;

create unique index affiliate_payout_provider_configs_active_route_idx
  on affiliate_private.affiliate_payout_provider_configs (
    country_code,
    currency
  )
  where status = 'active';

comment on constraint
  affiliate_payout_provider_configs_pilot_adapter
  on affiliate_private.affiliate_payout_provider_configs
is
  'Pilot lock: only Airwallex has a complete payout execution adapter.';

comment on index
  affiliate_private.affiliate_payout_provider_configs_active_route_idx
is
  'At most one payout provider configuration can be active per corridor.';
