-- Norva Partners: authoritative Web/Revolut tax components.
--
-- Revolut's order amount is authoritative gross money but does not separate
-- indirect tax. This versioned registry makes that separation explicit. The P0
-- seed is deliberately limited to the internally approved French pilot. Every
-- unsupported country, stale policy, unknown card country or inconsistent
-- reversal fails closed as an incomplete financial fact.

alter default privileges in schema affiliate_private
  revoke execute on functions from public;

create table affiliate_private.affiliate_web_tax_policies (
  id                     uuid primary key default gen_random_uuid(),
  policy_key             text not null unique,
  status                 text not null default 'draft',
  country_code           text not null,
  currency               text not null,
  currency_exponent      integer not null,
  calculation_mode       text not null,
  tax_rate_bps           integer not null,
  effective_from         timestamptz not null,
  effective_until        timestamptz not null,
  evidence_key           text not null,
  evidence_sha256        text not null,
  approved_by_role       text not null,
  external_review        boolean not null default false,
  created_at             timestamptz not null default now(),
  constraint affiliate_web_tax_policies_key
    check (policy_key ~ '^wtp_[a-z0-9][a-z0-9._-]{2,63}$'),
  constraint affiliate_web_tax_policies_status
    check (status in ('draft', 'active', 'retired')),
  constraint affiliate_web_tax_policies_country
    check (country_code ~ '^[A-Z]{2}$'),
  constraint affiliate_web_tax_policies_currency
    check (currency ~ '^[A-Z]{3}$' and currency_exponent between 0 and 6),
  constraint affiliate_web_tax_policies_mode
    check (calculation_mode in ('gross_is_net', 'tax_inclusive_bps')),
  constraint affiliate_web_tax_policies_rate
    check (
      tax_rate_bps between 0 and 10000
      and (calculation_mode <> 'gross_is_net' or tax_rate_bps = 0)
    ),
  constraint affiliate_web_tax_policies_window
    check (
      effective_until > effective_from
      and effective_until <= effective_from + interval '90 days'
    ),
  constraint affiliate_web_tax_policies_evidence
    check (
      evidence_key ~ '^[a-z0-9][a-z0-9._:-]{7,127}$'
      and evidence_sha256 ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_web_tax_policies_approval
    check (approved_by_role = 'accountable_owner')
);

create unique index affiliate_web_tax_policies_active_scope_idx
  on affiliate_private.affiliate_web_tax_policies (
    country_code,
    currency,
    currency_exponent
  ) where status = 'active';

alter table affiliate_private.affiliate_web_tax_policies enable row level security;
revoke all on table affiliate_private.affiliate_web_tax_policies
  from public, anon, authenticated, service_role;

create trigger affiliate_web_tax_policies_append_only
before update or delete on affiliate_private.affiliate_web_tax_policies
for each row execute function affiliate_private.reject_partners_finance_mutation();

insert into affiliate_private.affiliate_web_tax_policies (
  policy_key,
  status,
  country_code,
  currency,
  currency_exponent,
  calculation_mode,
  tax_rate_bps,
  effective_from,
  effective_until,
  evidence_key,
  evidence_sha256,
  approved_by_role,
  external_review
)
values (
  'wtp_fr_usd_owner_v1',
  'active',
  'FR',
  'USD',
  2,
  'gross_is_net',
  0,
  '2026-08-05T00:00:00Z'::timestamptz,
  '2026-11-03T00:00:00Z'::timestamptz,
  'partners-tax-operating-policy-2026-08-05-v2',
  '2d63bea3bba420065eb930b6729f53fca257d4307be1bb524caf18174952c261',
  'accountable_owner',
  false
);

create or replace function affiliate_private.partners_worker_web_tax_resolve(
  p_user_id uuid,
  p_event_type text,
  p_environment text,
  p_currency text,
  p_currency_exponent integer,
  p_gross_minor bigint,
  p_parent_transaction_hash text,
  p_observed_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event_type text := lower(btrim(coalesce(p_event_type, '')));
  v_environment text := lower(btrim(coalesce(p_environment, '')));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_parent_hash text := nullif(
    lower(btrim(coalesce(p_parent_transaction_hash, ''))), ''
  );
  v_country text;
  v_policy affiliate_private.affiliate_web_tax_policies%rowtype;
  v_origin affiliate_private.affiliate_financial_facts%rowtype;
  v_prior_gross bigint := 0;
  v_prior_tax bigint := 0;
  v_cumulative_gross bigint;
  v_cumulative_tax bigint;
  v_tax bigint;
  v_eligible bigint;
begin
  if p_user_id is null
    or v_event_type not in ('capture', 'renewal', 'refund', 'chargeback')
    or v_environment not in ('production', 'sandbox')
    or v_currency !~ '^[A-Z]{3}$'
    or p_currency_exponent is null
    or p_currency_exponent not between 0 and 6
    or p_gross_minor is null
    or p_gross_minor not between 0 and 9007199254740991
    or p_observed_at is null
    or p_observed_at > now() + interval '5 minutes'
    or p_observed_at < now() - interval '2 years'
    or (v_event_type in ('capture', 'renewal') and v_parent_hash is not null)
    or (v_event_type in ('refund', 'chargeback')
      and (v_parent_hash is null or v_parent_hash !~ '^[0-9a-f]{64}$'))
  then
    raise exception 'invalid Web tax resolution request' using errcode = '22023';
  end if;

  if v_event_type in ('refund', 'chargeback') then
    select fact.* into v_origin
    from affiliate_private.affiliate_financial_facts fact
    where fact.environment = v_environment
      and fact.rail = 'web'
      and fact.transaction_hash = v_parent_hash
      and fact.event_type in ('capture', 'renewal')
      and fact.referred_user_id = p_user_id
    order by fact.created_at
    limit 1;
    if not found or v_origin.facts_status <> 'complete' then
      return jsonb_build_object(
        'schema_version', 1,
        'action', 'web_tax_resolved',
        'status', 'incomplete',
        'reason', 'origin_financial_fact_unavailable',
        'financial', null,
        'policy', null
      );
    end if;
    if v_origin.currency <> v_currency
      or v_origin.currency_exponent <> p_currency_exponent
      or v_origin.gross_minor is null
      or v_origin.tax_minor is null
      or v_origin.gross_minor = 0
    then
      return jsonb_build_object(
        'schema_version', 1,
        'action', 'web_tax_resolved',
        'status', 'incomplete',
        'reason', 'origin_financial_fact_inconsistent',
        'financial', null,
        'policy', null
      );
    end if;
    select
      coalesce(sum(fact.gross_minor), 0)::bigint,
      coalesce(sum(fact.tax_minor), 0)::bigint
    into v_prior_gross, v_prior_tax
    from affiliate_private.affiliate_financial_facts fact
    where fact.environment = v_origin.environment
      and fact.rail = 'web'
      and fact.parent_transaction_hash = v_parent_hash
      and fact.event_type in ('refund', 'chargeback')
      and fact.facts_status = 'complete';
    if v_prior_gross + p_gross_minor > v_origin.gross_minor then
      return jsonb_build_object(
        'schema_version', 1,
        'action', 'web_tax_resolved',
        'status', 'incomplete',
        'reason', 'reversal_exceeds_origin',
        'financial', null,
        'policy', null
      );
    end if;
    v_cumulative_gross := v_prior_gross + p_gross_minor;
    v_cumulative_tax := floor(
      v_cumulative_gross::numeric * v_origin.tax_minor::numeric
        / v_origin.gross_minor::numeric
    )::bigint;
    v_tax := greatest(v_cumulative_tax - v_prior_tax, 0);
    v_eligible := p_gross_minor - v_tax;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'web_tax_resolved',
      'status', 'complete',
      'reason', null,
      'financial', jsonb_build_object(
        'currency', v_currency,
        'currency_exponent', p_currency_exponent,
        'gross_minor', p_gross_minor,
        'discount_minor', 0,
        'tax_minor', v_tax,
        'eligible_minor', v_eligible
      ),
      'policy', jsonb_build_object(
        'policy_key', 'origin:' || v_origin.fact_key,
        'country_code', null,
        'calculation_mode', 'origin_proportional_allocation',
        'tax_rate_bps', null,
        'evidence_sha256', null,
        'effective_until', null
      )
    );
  end if;

  select coalesce(
    (
      select customer.card_country
      from public.cloud_revolut_customers customer
      where customer.user_id = p_user_id
        and customer.card_country ~ '^[A-Z]{2}$'
    ),
    (
      select projection.country_code
      from public.cloud_entitlement_projection projection
      where projection.user_id = p_user_id
        and projection.country_source = 'card'
        and projection.country_code ~ '^[A-Z]{2}$'
    )
  ) into v_country;
  if v_country is null then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'web_tax_resolved',
      'status', 'incomplete',
      'reason', 'authoritative_country_unavailable',
      'financial', null,
      'policy', null
    );
  end if;

  select policy.* into v_policy
  from affiliate_private.affiliate_web_tax_policies policy
  where policy.status = 'active'
    and policy.country_code = v_country
    and policy.currency = v_currency
    and policy.currency_exponent = p_currency_exponent
    and policy.effective_from <= p_observed_at
    and policy.effective_until > p_observed_at
  order by policy.effective_from desc
  limit 1;
  if not found then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'web_tax_resolved',
      'status', 'incomplete',
      'reason', 'tax_policy_unavailable',
      'financial', null,
      'policy', null
    );
  end if;

  if v_policy.calculation_mode = 'gross_is_net' then
    v_tax := 0;
  else
    v_tax := p_gross_minor - floor(
      p_gross_minor::numeric * 10000::numeric
        / (10000 + v_policy.tax_rate_bps)::numeric
    )::bigint;
  end if;
  v_eligible := p_gross_minor - v_tax;
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'web_tax_resolved',
    'status', 'complete',
    'reason', null,
    'financial', jsonb_build_object(
      'currency', v_currency,
      'currency_exponent', p_currency_exponent,
      'gross_minor', p_gross_minor,
      'discount_minor', 0,
      'tax_minor', v_tax,
      'eligible_minor', v_eligible
    ),
    'policy', jsonb_build_object(
      'policy_key', v_policy.policy_key,
      'country_code', v_policy.country_code,
      'calculation_mode', v_policy.calculation_mode,
      'tax_rate_bps', v_policy.tax_rate_bps,
      'evidence_sha256', v_policy.evidence_sha256,
      'effective_until', v_policy.effective_until
    )
  );
end;
$$;

create or replace function public.partners_worker_web_tax_resolve(
  p_user_id uuid,
  p_event_type text,
  p_environment text,
  p_currency text,
  p_currency_exponent integer,
  p_gross_minor bigint,
  p_parent_transaction_hash text,
  p_observed_at timestamptz
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select affiliate_private.partners_worker_web_tax_resolve(
    p_user_id,
    p_event_type,
    p_environment,
    p_currency,
    p_currency_exponent,
    p_gross_minor,
    p_parent_transaction_hash,
    p_observed_at
  );
$$;

revoke all on function affiliate_private.partners_worker_web_tax_resolve(
  uuid,text,text,text,integer,bigint,text,timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.partners_worker_web_tax_resolve(
  uuid,text,text,text,integer,bigint,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.partners_worker_web_tax_resolve(
  uuid,text,text,text,integer,bigint,text,timestamptz
) to service_role;

comment on table affiliate_private.affiliate_web_tax_policies is
  'Append-only, time-bounded Web commission tax contract. No active policy means no complete commission fact.';
comment on function public.partners_worker_web_tax_resolve(
  uuid,text,text,text,integer,bigint,text,timestamptz
) is
  'Service-only exact tax/eligible resolver for Revolut captures and lineage-safe reversals.';
