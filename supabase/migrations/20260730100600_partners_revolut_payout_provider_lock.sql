-- Norva Partners - Revolut-only initial payout corridor lock.
--
-- This repository has no deployed Partners payout history. The first rollout
-- therefore starts directly with Revolut and rejects every other active rail.

do $pilot_preflight$
begin
  if exists (
    select 1
    from affiliate_private.affiliate_payout_provider_configs config
    where config.status = 'active'
      and config.provider <> 'revolut'
  ) then
    raise exception
      'disable non-Revolut payout routes before installing the pilot lock'
      using errcode = 'P0001';
  end if;
end;
$pilot_preflight$;

alter table affiliate_private.affiliate_payout_provider_configs
  add constraint affiliate_payout_provider_configs_pilot_adapter
  check (
    status <> 'active'
    or provider = 'revolut'
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
  'The initial production payout rail is Revolut only.';

comment on index
  affiliate_private.affiliate_payout_provider_configs_active_route_idx
is
  'At most one active payout provider may own a country-currency corridor.';
