-- Norva Partners: privacy-preserving referral visibility for the member
-- dashboard. The public contract deliberately exposes neither an auth user id,
-- a complete e-mail address nor a payment identifier. A strictly masked e-mail
-- hint is derived inside the private projection so a partner can recognise an
-- existing contact without receiving a contact directory. Each referred account
-- also receives a stable display number and an opaque public key.

create or replace function
affiliate_private.partners_service_referral_visibility(
  p_user_id uuid,
  p_limit integer,
  p_cursor text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account_id uuid;
  v_total integer := 0;
  v_items jsonb := '[]'::jsonb;
  v_cursor_number numeric := null;
  v_has_more boolean := false;
  v_last_label bigint := null;
begin
  if p_user_id is null
    or p_limit is null
    or p_limit < 1
    or p_limit > 50
    or (
      p_cursor is not null
      and p_cursor !~ '^referral_[0-9]{20}$'
    ) then
    raise exception 'invalid Partners referral visibility request'
      using errcode = '22023';
  end if;

  if p_cursor is not null then
    v_cursor_number := substring(p_cursor from 10)::numeric;
  end if;

  select account.id
  into v_account_id
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed'
  order by account.created_at desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'total', 0,
      'items', '[]'::jsonb,
      'next_cursor', null
    );
  end if;

  select count(*)::integer
  into v_total
  from affiliate_private.affiliate_attributions attribution
  where attribution.referrer_account_id = v_account_id;

  with numbered as materialized (
    select
      attribution.id,
      attribution.referred_user_id,
      attribution.status as attribution_status,
      attribution.attributed_at,
      row_number() over (
        order by attribution.created_at, attribution.id
      )::bigint as referral_number
    from affiliate_private.affiliate_attributions attribution
    where attribution.referrer_account_id = v_account_id
  ), candidates as materialized (
    select numbered.*
    from numbered
    where v_cursor_number is null
      or numbered.referral_number < v_cursor_number
    order by numbered.referral_number desc
    limit p_limit + 1
  ), page as materialized (
    select candidates.*
    from candidates
    order by candidates.referral_number desc
    limit p_limit
  ), projected as (
    select
      'ref_' || left(
        encode(
          extensions.digest(
            'norva-partners-referral-visible:v1:' || page.id::text,
            'sha256'
          ),
          'hex'
        ),
        24
      ) as public_key,
      page.referral_number,
      case
        when email_parts.local_part is null then null
        else
          case
            when length(email_parts.local_part) >= 5 then
              left(email_parts.local_part, 2) || repeat('•', 4)
                || right(email_parts.local_part, 2)
            when length(email_parts.local_part) >= 3 then
              left(email_parts.local_part, 1) || repeat('•', 2)
                || right(email_parts.local_part, 1)
            else left(email_parts.local_part, 1) || repeat('•', 2)
          end
          || '@'
          || case
            when length(email_parts.domain_stem) >= 5 then
              left(email_parts.domain_stem, 2) || repeat('•', 4)
                || right(email_parts.domain_stem, 2)
            when length(email_parts.domain_stem) >= 3 then
              left(email_parts.domain_stem, 1) || repeat('•', 2)
                || right(email_parts.domain_stem, 1)
            else left(email_parts.domain_stem, 1) || repeat('•', 2)
          end
          || '.' || email_parts.top_level_domain
      end as masked_email,
      case
        when page.attribution_status in ('held', 'blocked') then 'held'
        when page.attribution_status = 'reversed' then 'reversed'
        when exists (
          select 1
          from affiliate_private.affiliate_commission_entries accrual
          where accrual.attribution_id = page.id
            and accrual.entry_kind = 'accrual'
            and not exists (
              select 1
              from affiliate_private.affiliate_commission_entries terminal
              where terminal.related_entry_id = accrual.id
                and terminal.entry_kind in (
                  'release', 'reversal', 'manual_reversal'
                )
            )
        ) then 'commission_pending'
        when latest_resolution.entry_kind in ('release', 'reinstatement')
          then 'commission_validated'
        when latest_resolution.entry_kind in ('reversal', 'manual_reversal')
          then 'reversed'
        when exists (
          select 1
          from affiliate_private.affiliate_financial_facts fact
          where fact.attribution_id = page.id
            and fact.environment = 'production'
            and fact.facts_status = 'complete'
            and fact.event_type in ('capture', 'renewal')
        ) then 'payment_recorded'
        else 'signed_up'
      end as public_status,
      page.attributed_at,
      (
        select min(fact.occurred_at)
        from affiliate_private.affiliate_financial_facts fact
        where fact.attribution_id = page.id
          and fact.environment = 'production'
          and fact.facts_status = 'complete'
          and fact.event_type in ('capture', 'renewal')
      ) as first_eligible_payment_at,
      (
        select min(accrual.matures_at)
        from affiliate_private.affiliate_commission_entries accrual
        where accrual.attribution_id = page.id
          and accrual.entry_kind = 'accrual'
          and not exists (
            select 1
            from affiliate_private.affiliate_commission_entries terminal
            where terminal.related_entry_id = accrual.id
              and terminal.entry_kind in (
                'release', 'reversal', 'manual_reversal'
              )
          )
      ) as next_maturation_at
    from page
    left join auth.users referred_user
      on referred_user.id = page.referred_user_id
    left join lateral (
      select
        split_part(normalized.normalized_email, '@', 1) as local_part,
        left(
          split_part(normalized.normalized_email, '@', 2),
          length(split_part(normalized.normalized_email, '@', 2))
            - strpos(
              reverse(split_part(normalized.normalized_email, '@', 2)),
              '.'
            )
        ) as domain_stem,
        right(
          split_part(normalized.normalized_email, '@', 2),
          strpos(
            reverse(split_part(normalized.normalized_email, '@', 2)),
            '.'
          ) - 1
        ) as top_level_domain
      from (
        select lower(btrim(referred_user.email)) as normalized_email
      ) normalized
      where referred_user.email is not null
        and length(normalized.normalized_email) <= 254
        and normalized.normalized_email
          ~ '^[a-z0-9.!#$%&*+/=?^_{}|~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$'
    ) email_parts on true
    left join lateral (
      select entry.entry_kind
      from affiliate_private.affiliate_commission_entries entry
      where entry.attribution_id = page.id
        and entry.entry_kind in (
          'release', 'reinstatement', 'reversal', 'manual_reversal'
        )
      order by entry.sequence_no desc
      limit 1
    ) latest_resolution on true
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', projected.public_key,
        'label_number', projected.referral_number,
        'masked_email', projected.masked_email,
        'status', projected.public_status,
        'attributed_at', projected.attributed_at,
        'first_eligible_payment_at',
          projected.first_eligible_payment_at,
        'next_maturation_at', projected.next_maturation_at
      )
      order by projected.referral_number desc
    ),
    '[]'::jsonb
  )
  into v_items
  from projected;

  with numbered as materialized (
    select row_number() over (
      order by attribution.created_at, attribution.id
    )::bigint as referral_number
    from affiliate_private.affiliate_attributions attribution
    where attribution.referrer_account_id = v_account_id
  ), candidates as materialized (
    select numbered.referral_number
    from numbered
    where v_cursor_number is null
      or numbered.referral_number < v_cursor_number
    order by numbered.referral_number desc
    limit p_limit + 1
  )
  select
    count(*) > p_limit,
    min(referral_number) filter (where ordinal <= p_limit)
  into v_has_more, v_last_label
  from (
    select
      candidates.referral_number,
      row_number() over (order by candidates.referral_number desc) as ordinal
    from candidates
  ) bounded;

  return jsonb_build_object(
    'total', v_total,
    'items', v_items,
    'next_cursor', case
      when v_has_more and v_last_label is not null then
        'referral_' || lpad(v_last_label::text, 20, '0')
      else null
    end
  );
end;
$$;

-- Preserve the creator role as owner. A cross-role OWNER change would require
-- unnecessary SET ROLE authority in disposable databases without strengthening
-- the service-role-only execution boundary.
revoke all on function
  affiliate_private.partners_service_referral_visibility(uuid, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_referral_visibility(uuid, integer, text)
  to service_role;

create or replace function public.partners_service_referral_visibility(
  p_user_id uuid,
  p_limit integer,
  p_cursor text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_referral_visibility(
    p_user_id,
    p_limit,
    p_cursor
  );
$$;

revoke all on function public.partners_service_referral_visibility(
  uuid, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_referral_visibility(
  uuid, integer, text
) to service_role;

create or replace function public.partners_service_dashboard_v2(
  p_user_id uuid,
  p_history_limit integer,
  p_history_cursor text,
  p_history_status text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_dashboard_v2(
    p_user_id,
    p_history_limit,
    p_history_cursor,
    p_history_status
  ) || jsonb_build_object(
    'referrals',
    affiliate_private.partners_service_referral_visibility(
      p_user_id,
      20,
      null
    )
  );
$$;

revoke all on function public.partners_service_dashboard_v2(
  uuid, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_dashboard_v2(
  uuid, integer, text, text
) to service_role;
