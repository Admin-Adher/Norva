#!/usr/bin/env node

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const SERVER_NAME = 'norva-growth-readonly';
const SERVER_VERSION = '1.1.0';
const PROTOCOL_VERSION = '2025-06-18';
const TIMEZONE = 'Europe/Paris';
const MAX_OUTPUT_BYTES = 1_000_000;
const QUERY_TIMEOUT_MS = 15_000;

const PLATFORM_VALUES = new Set(['all', 'web', 'mobile_android', 'android_tv', 'unknown']);
const FILTER_KEYS = new Set(['lookback_days', 'country_code', 'platform']);

const FILTER_PROPERTIES = {
  lookback_days: {
    type: 'integer',
    minimum: 1,
    maximum: 365,
    default: 7,
    description: 'Nombre de jours calendaires, aujourd’hui inclus (fuseau Europe/Paris).',
  },
  country_code: {
    type: 'string',
    pattern: '^[A-Za-z]{2}$',
    description: 'Code pays ISO 3166-1 alpha-2. Omettre pour tous les pays.',
  },
  platform: {
    type: 'string',
    enum: [...PLATFORM_VALUES],
    default: 'all',
    description: 'Plateforme d’inscription. "all" n’applique aucun filtre.',
  },
};

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'norva_health_check',
    title: 'Norva Hetzner health check',
    description: 'Vérifie en lecture seule l’accès à PostgreSQL Hetzner et la fraîcheur des inscriptions, sans retourner de donnée personnelle.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'norva_get_growth_funnel',
    title: 'Norva cohort growth funnel',
    description: 'Retourne les agrégats inscription → essai → premier paiement après essai, l’état d’accès actuel et les taux de conversion par cohorte.',
    inputSchema: { type: 'object', properties: FILTER_PROPERTIES, additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'norva_get_daily_growth',
    title: 'Norva daily cohort growth',
    description: 'Ventile par jour d’inscription les inscriptions, essais, paiements après essai et accès actifs observés à l’instant de la requête.',
    inputSchema: { type: 'object', properties: FILTER_PROPERTIES, additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'norva_get_attribution_quality',
    title: 'Norva attribution quality',
    description: 'Mesure la couverture pays/plateforme et indique si une attribution Google Ads directe est techniquement disponible dans le schéma.',
    inputSchema: { type: 'object', properties: FILTER_PROPERTIES, additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'norva_get_source_connection_attempts',
    title: 'Norva source connection diagnostics',
    description: 'Retourne des agrégats anonymes sur les tentatives M3U/Xtream : domaine racine, forme de chemin, résultat et famille d’erreur. Aucun accès, URL complète, identifiant utilisateur ou hash individuel n’est retourné.',
    inputSchema: { type: 'object', properties: FILTER_PROPERTIES, additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]);

function assertPlainObject(value, label) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} doit être un objet JSON.`);
  }
  return value;
}

export function validateFilters(rawArgs = {}) {
  const args = assertPlainObject(rawArgs, 'Les arguments');
  for (const key of Object.keys(args)) {
    if (!FILTER_KEYS.has(key)) throw new Error(`Argument non pris en charge : ${key}`);
  }

  const lookbackDays = args.lookback_days ?? 7;
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 365) {
    throw new Error('lookback_days doit être un entier compris entre 1 et 365.');
  }

  let countryCode = null;
  if (args.country_code !== undefined && args.country_code !== null && args.country_code !== '') {
    if (typeof args.country_code !== 'string' || !/^[A-Za-z]{2}$/.test(args.country_code)) {
      throw new Error('country_code doit être un code ISO à deux lettres.');
    }
    countryCode = args.country_code.toUpperCase();
  }

  const platform = args.platform ?? 'all';
  if (typeof platform !== 'string' || !PLATFORM_VALUES.has(platform)) {
    throw new Error(`platform doit être l’une des valeurs suivantes : ${[...PLATFORM_VALUES].join(', ')}.`);
  }

  return Object.freeze({ lookbackDays, countryCode, platform });
}

function sqlFilterPredicates(filters) {
  const predicates = [];
  if (filters.countryCode) {
    predicates.push(`upper(coalesce(a.country_code, '')) = '${filters.countryCode}'`);
  }
  if (filters.platform !== 'all') {
    predicates.push(`coalesce(a.signup_platform, 'unknown') = '${filters.platform}'`);
  }
  return predicates.length ? `\n      AND ${predicates.join('\n      AND ')}` : '';
}

function sourceAttemptFilterPredicates(filters) {
  const predicates = [];
  if (filters.countryCode) {
    predicates.push(`upper(coalesce(a.country_code, '')) = '${filters.countryCode}'`);
  }
  if (filters.platform !== 'all') {
    predicates.push(`coalesce(a.platform, 'unknown') = '${filters.platform}'`);
  }
  return predicates.length ? `\n    AND ${predicates.join('\n    AND ')}` : '';
}

function cohortFunnelCtes(filters) {
  const startDayOffset = filters.lookbackDays - 1;
  const filterPredicates = sqlFilterPredicates(filters);

  return `
WITH cohort AS (
  SELECT
    a.user_id,
    a.signed_up_at,
    (a.signed_up_at AT TIME ZONE '${TIMEZONE}')::date AS signup_day,
    coalesce(upper(a.country_code), 'UNKNOWN') AS country_code,
    coalesce(a.signup_platform, 'unknown') AS signup_platform
  FROM public.cloud_signup_attribution a
  WHERE a.signed_up_at >= (
    ((now() AT TIME ZONE '${TIMEZONE}')::date - ${startDayOffset})::timestamp
      AT TIME ZONE '${TIMEZONE}'
  )${filterPredicates}
    AND NOT EXISTS (
      SELECT 1 FROM public.admin_internal_accounts i WHERE i.user_id = a.user_id
    )
),
post_trial_captured_payments AS (
  SELECT
    l.pi_id,
    l.user_id,
    l.provider,
    l.kind,
    l.amount AS amount_minor,
    upper(coalesce(l.currency, 'UNKNOWN')) AS currency,
    coalesce(l.updated_at, l.created_at) AS paid_at,
    row_number() OVER (
      PARTITION BY l.user_id
      ORDER BY coalesce(l.updated_at, l.created_at), l.pi_id
    ) AS capture_rank
  FROM public.cloud_billing_ledger l
  JOIN cohort c ON c.user_id = l.user_id
  JOIN public.cloud_entitlement_projection p ON p.user_id = l.user_id
  WHERE l.status = 'captured'
    AND l.kind IN ('first_charge', 'renewal')
    AND p.trial_consumed_at IS NOT NULL
    AND coalesce(l.updated_at, l.created_at) >= p.trial_consumed_at
),
first_post_trial_capture AS (
  SELECT pi_id, user_id, provider, kind, amount_minor, currency, paid_at
  FROM post_trial_captured_payments
  WHERE capture_rank = 1
),
trial_conversion_events AS (
  SELECT
    b.user_id,
    b.applied_at AS paid_at,
    b.amount_cents AS amount_minor,
    upper(coalesce(b.currency, 'UNKNOWN')) AS currency,
    'revolut'::text AS provider
  FROM public.cloud_revolut_billing_attempts b
  JOIN cohort c ON c.user_id = b.user_id
  WHERE b.kind = 'first_charge'
    AND b.status = 'completed'
    AND b.applied_at IS NOT NULL

  UNION ALL

  SELECT
    l.user_id,
    coalesce(l.updated_at, l.created_at) AS paid_at,
    l.amount AS amount_minor,
    upper(coalesce(l.currency, 'UNKNOWN')) AS currency,
    coalesce(l.provider, 'unknown') AS provider
  FROM public.cloud_billing_ledger l
  JOIN cohort c ON c.user_id = l.user_id
  JOIN public.cloud_entitlement_projection p ON p.user_id = l.user_id
  WHERE l.status = 'captured'
    AND p.trial_consumed_at IS NOT NULL
    AND coalesce(l.updated_at, l.created_at) >= p.trial_consumed_at
    AND (
      l.kind = 'first_charge'
      OR EXISTS (
        SELECT 1
        FROM first_post_trial_capture first_capture
        WHERE first_capture.pi_id = l.pi_id
          AND first_capture.kind = 'renewal'
          AND first_capture.provider IN (
            'revenuecat', 'google_play', 'apple_app_store', 'stripe', 'web'
          )
      )
    )
),
ranked_trial_conversions AS (
  SELECT
    t.*,
    row_number() OVER (
      PARTITION BY t.user_id
      ORDER BY t.paid_at, t.provider, t.currency
    ) AS conversion_rank
  FROM trial_conversion_events t
),
first_trial_conversion AS (
  SELECT user_id, paid_at, amount_minor, currency, provider
  FROM ranked_trial_conversions
  WHERE conversion_rank = 1
),
cancelled_users AS (
  SELECT DISTINCT e.user_id
  FROM public.cloud_entitlement_events e
  JOIN cohort c ON c.user_id = e.user_id
  WHERE e.event_type = 'CANCELLATION'
    AND coalesce(e.payload #>> '{_norva,projection_applied}', 'true') = 'true'
),
user_funnel AS (
  SELECT
    c.user_id,
    c.signed_up_at,
    c.signup_day,
    c.country_code,
    c.signup_platform,
    p.status AS entitlement_status,
    p.trial_consumed_at,
    p.trial_ends_at,
    (p.trial_consumed_at IS NOT NULL) AS trial_started,
    (p.trial_ends_at > now()) AS trial_current,
    (fc.user_id IS NOT NULL) AS paid_after_trial,
    fc.paid_at AS first_paid_after_trial_at,
    fc.amount_minor AS first_paid_amount_minor,
    fc.currency AS first_paid_currency,
    fc.provider AS first_paid_provider,
    (
      p.status IN ('active', 'trialing', 'grace', 'cancelled_at_period_end')
    ) AS entitled_now,
    (
      cu.user_id IS NOT NULL
      OR p.status IN ('cancelled', 'expired', 'revoked', 'refunded')
    ) AS cancelled_or_expired
  FROM cohort c
  LEFT JOIN public.cloud_entitlement_projection p ON p.user_id = c.user_id
  LEFT JOIN first_trial_conversion fc ON fc.user_id = c.user_id
  LEFT JOIN cancelled_users cu ON cu.user_id = c.user_id
)`;
}

function wrapReadOnlyQuery(body) {
  return `BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '8s';
${body.trim()}
COMMIT;`;
}

export function buildQuery(toolName, rawArgs = {}) {
  if (toolName === 'norva_health_check') {
    const args = assertPlainObject(rawArgs, 'Les arguments');
    if (Object.keys(args).length) throw new Error('norva_health_check n’accepte aucun argument.');
    return wrapReadOnlyQuery(`
SELECT json_build_object(
  'status', 'ok',
  'source', 'hetzner_postgresql',
  'read_only', true,
  'generated_at', now(),
  'timezone', '${TIMEZONE}',
  'signup_rows', count(*)::int,
  'latest_signup_at', max(signed_up_at)
)
FROM public.cloud_signup_attribution;`);
  }

  const filters = validateFilters(rawArgs);
  if (toolName === 'norva_get_source_connection_attempts') {
    const startDayOffset = filters.lookbackDays - 1;
    const filterPredicates = sourceAttemptFilterPredicates(filters);
    const filterJson = `json_build_object(
      'lookback_days', ${filters.lookbackDays},
      'country_code', ${filters.countryCode ? `'${filters.countryCode}'` : 'null'},
      'platform', '${filters.platform}',
      'timezone', '${TIMEZONE}'
    )`;
    return wrapReadOnlyQuery(`
WITH attempts AS (
  SELECT
    a.source_type,
    coalesce(a.domain_normalized, 'unknown') AS domain_normalized,
    a.host_hash,
    a.path_shape,
    a.outcome,
    a.http_status,
    a.failure_family,
    a.platform,
    coalesce(a.country_code, 'UNKNOWN') AS country_code,
    a.app_version,
    a.created_at
  FROM analytics_private.source_connection_attempts a
  WHERE a.created_at >= (
    ((now() AT TIME ZONE '${TIMEZONE}')::date - ${startDayOffset})::timestamp
      AT TIME ZONE '${TIMEZONE}'
  )${filterPredicates}
),
domain_rows AS (
  SELECT
    domain_normalized,
    count(*)::int AS attempts,
    count(*) FILTER (WHERE outcome = 'accepted')::int AS accepted,
    count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
    count(DISTINCT host_hash) FILTER (WHERE host_hash IS NOT NULL)::int AS distinct_host_groups,
    coalesce(round(100.0 * count(*) FILTER (WHERE outcome = 'accepted') / nullif(count(*), 0), 2), 0) AS acceptance_rate_pct
  FROM attempts
  GROUP BY domain_normalized
  ORDER BY attempts DESC, domain_normalized
  LIMIT 100
)
SELECT json_build_object(
  'generated_at', now(),
  'source', 'hetzner_postgresql',
  'read_only', true,
  'measurement_basis', 'identity_free_source_connection_attempts',
  'filters', ${filterJson},
  'privacy', json_build_object(
    'retention_days', 90,
    'country_basis', 'country captured at account signup, not request geolocation',
    'domain_basis', 'registrable/root domain only',
    'host_hashes_returned', false,
    'user_identifiers_stored_in_telemetry', false,
    'raw_urls_or_credentials_stored_in_telemetry', false
  ),
  'summary', json_build_object(
    'attempts', count(*)::int,
    'accepted', count(*) FILTER (WHERE outcome = 'accepted')::int,
    'failed', count(*) FILTER (WHERE outcome = 'failed')::int,
    'acceptance_rate_pct', coalesce(round(100.0 * count(*) FILTER (WHERE outcome = 'accepted') / nullif(count(*), 0), 2), 0)
  ),
  'by_domain', (select coalesce(json_agg(row_to_json(d)), '[]'::json) from domain_rows d),
  'by_connection_pattern', coalesce((
    select json_agg(row_to_json(r) order by r.attempts desc, r.domain_normalized, r.source_type, r.path_shape)
    from (
      select
        domain_normalized,
        source_type,
        path_shape,
        outcome,
        http_status,
        failure_family,
        count(*)::int AS attempts,
        count(DISTINCT host_hash) FILTER (WHERE host_hash IS NOT NULL)::int AS distinct_host_groups
      from attempts
      group by domain_normalized, source_type, path_shape, outcome, http_status, failure_family
      order by attempts desc, domain_normalized, source_type, path_shape
      limit 200
    ) r
  ), '[]'::json),
  'by_source_type', coalesce((
    select json_agg(row_to_json(r) order by r.attempts desc, r.source_type)
    from (
      select source_type, count(*)::int AS attempts,
        count(*) FILTER (WHERE outcome = 'accepted')::int AS accepted,
        count(*) FILTER (WHERE outcome = 'failed')::int AS failed
      from attempts group by source_type
    ) r
  ), '[]'::json),
  'by_path_shape', coalesce((
    select json_agg(row_to_json(r) order by r.attempts desc, r.path_shape)
    from (
      select path_shape, count(*)::int AS attempts,
        count(*) FILTER (WHERE outcome = 'accepted')::int AS accepted,
        count(*) FILTER (WHERE outcome = 'failed')::int AS failed
      from attempts group by path_shape
    ) r
  ), '[]'::json),
  'by_failure', coalesce((
    select json_agg(row_to_json(r) order by r.attempts desc, r.failure_family, r.http_status)
    from (
      select failure_family, http_status, count(*)::int AS attempts
      from attempts where outcome = 'failed'
      group by failure_family, http_status
    ) r
  ), '[]'::json),
  'by_status', coalesce((
    select json_agg(row_to_json(r) order by r.attempts desc, r.outcome, r.http_status)
    from (
      select outcome, http_status, count(*)::int AS attempts
      from attempts group by outcome, http_status
    ) r
  ), '[]'::json),
  'by_platform', coalesce((
    select json_agg(row_to_json(r) order by r.attempts desc, r.platform)
    from (select platform, count(*)::int AS attempts from attempts group by platform) r
  ), '[]'::json),
  'by_country', coalesce((
    select json_agg(row_to_json(r) order by r.attempts desc, r.country_code)
    from (select country_code, count(*)::int AS attempts from attempts group by country_code) r
  ), '[]'::json),
  'by_app_version', coalesce((
    select json_agg(row_to_json(r) order by r.attempts desc, r.platform, r.app_version)
    from (
      select platform, coalesce(app_version, 'unknown') AS app_version, count(*)::int AS attempts
      from attempts group by platform, coalesce(app_version, 'unknown')
    ) r
  ), '[]'::json),
  'by_day', coalesce((
    select json_agg(row_to_json(r) order by r.day)
    from (
      select (created_at AT TIME ZONE '${TIMEZONE}')::date AS day,
        count(*)::int AS attempts,
        count(*) FILTER (WHERE outcome = 'accepted')::int AS accepted,
        count(*) FILTER (WHERE outcome = 'failed')::int AS failed
      from attempts group by 1
    ) r
  ), '[]'::json)
)
FROM attempts;`);
  }

  const ctes = cohortFunnelCtes(filters);
  const filterJson = `json_build_object(
    'lookback_days', ${filters.lookbackDays},
    'country_code', ${filters.countryCode ? `'${filters.countryCode}'` : 'null'},
    'platform', '${filters.platform}',
    'timezone', '${TIMEZONE}'
  )`;

  if (toolName === 'norva_get_growth_funnel') {
    return wrapReadOnlyQuery(`
${ctes}
SELECT json_build_object(
  'generated_at', now(),
  'source', 'hetzner_postgresql',
  'read_only', true,
  'measurement_basis', 'signup_cohort_with_lifetime_outcomes_as_of_generated_at',
  'filters', ${filterJson},
  'funnel', json_build_object(
    'signups', count(*)::int,
    'trials_started', count(*) FILTER (WHERE trial_started)::int,
    'trials_current', count(*) FILTER (WHERE trial_current)::int,
    'paid_after_trial', count(*) FILTER (WHERE paid_after_trial)::int,
    'entitled_now', count(*) FILTER (WHERE entitled_now)::int,
    'cancelled_or_expired', count(*) FILTER (WHERE cancelled_or_expired)::int
  ),
  'rates_pct', json_build_object(
    'signup_to_trial', coalesce(round(100.0 * count(*) FILTER (WHERE trial_started) / nullif(count(*), 0), 2), 0),
    'trial_to_paid', coalesce(round(100.0 * count(*) FILTER (WHERE paid_after_trial) / nullif(count(*) FILTER (WHERE trial_started), 0), 2), 0),
    'signup_to_paid', coalesce(round(100.0 * count(*) FILTER (WHERE paid_after_trial) / nullif(count(*), 0), 2), 0)
  ),
  'first_post_trial_revenue_by_currency', (
    SELECT coalesce(json_agg(row_to_json(revenue_row) ORDER BY revenue_row.currency), '[]'::json)
    FROM (
      SELECT
        first_paid_currency AS currency,
        count(*)::int AS paying_users,
        sum(coalesce(first_paid_amount_minor, 0))::bigint AS amount_minor
      FROM user_funnel
      WHERE paid_after_trial
      GROUP BY first_paid_currency
    ) revenue_row
  ),
  'attribution', json_build_object(
    'mode', 'country_platform_time_correlation',
    'direct_google_ads_attribution_proven', false,
    'warning', 'No gclid, campaign id or Google Play install referrer is stored on signup attribution rows.'
  )
)
FROM user_funnel;`);
  }

  if (toolName === 'norva_get_daily_growth') {
    return wrapReadOnlyQuery(`
${ctes}
SELECT json_build_object(
  'generated_at', now(),
  'source', 'hetzner_postgresql',
  'read_only', true,
  'measurement_basis', 'grouped_by_signup_day_with_lifetime_outcomes_as_of_generated_at',
  'filters', ${filterJson},
  'days', coalesce((
    SELECT json_agg(row_to_json(day_row) ORDER BY day_row.signup_day)
    FROM (
      SELECT
        signup_day,
        count(*)::int AS signups,
        count(*) FILTER (WHERE trial_started)::int AS trials_started,
        count(*) FILTER (WHERE trial_current)::int AS trials_current,
        count(*) FILTER (WHERE paid_after_trial)::int AS paid_after_trial,
        count(*) FILTER (WHERE entitled_now)::int AS entitled_now,
        count(*) FILTER (WHERE cancelled_or_expired)::int AS cancelled_or_expired,
        coalesce(round(100.0 * count(*) FILTER (WHERE trial_started) / nullif(count(*), 0), 2), 0) AS signup_to_trial_pct,
        coalesce(round(100.0 * count(*) FILTER (WHERE paid_after_trial) / nullif(count(*), 0), 2), 0) AS signup_to_paid_pct
      FROM user_funnel
      GROUP BY signup_day
    ) day_row
  ), '[]'::json)
);`);
  }

  if (toolName === 'norva_get_attribution_quality') {
    const startDayOffset = filters.lookbackDays - 1;
    return wrapReadOnlyQuery(`
${ctes},
potential_ads_columns AS (
  SELECT column_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'cloud_signup_attribution'
    AND column_name IN (
      'gclid', 'gbraid', 'wbraid', 'utm_campaign', 'utm_source',
      'google_ads_campaign_id', 'google_play_install_referrer'
    )
),
window_auth_signups AS (
  SELECT u.id AS user_id
  FROM auth.users u
  WHERE u.created_at >= (
    ((now() AT TIME ZONE '${TIMEZONE}')::date - ${startDayOffset})::timestamp
      AT TIME ZONE '${TIMEZONE}'
  )
    AND NOT EXISTS (
      SELECT 1 FROM public.admin_internal_accounts i WHERE i.user_id = u.id
    )
),
window_attribution_users AS (
  SELECT DISTINCT a.user_id
  FROM public.cloud_signup_attribution a
  JOIN window_auth_signups u ON u.user_id = a.user_id
)
SELECT json_build_object(
  'generated_at', now(),
  'source', 'hetzner_postgresql',
  'read_only', true,
  'filters', ${filterJson},
  'cohort_rows', count(*)::int,
  'signup_attribution_capture', json_build_object(
    'auth_signups_in_window', (SELECT count(*)::int FROM window_auth_signups),
    'signups_with_attribution', (SELECT count(*)::int FROM window_attribution_users),
    'signups_without_attribution', (
      SELECT count(*)::int
      FROM window_auth_signups u
      WHERE NOT EXISTS (
        SELECT 1 FROM window_attribution_users a WHERE a.user_id = u.user_id
      )
    ),
    'coverage_pct', coalesce(round(
      100.0 * (SELECT count(*) FROM window_attribution_users)
      / nullif((SELECT count(*) FROM window_auth_signups), 0),
      2
    ), 0),
    'scope', 'all countries and platforms in the selected time window'
  ),
  'coverage', json_build_object(
    'country_known', count(*) FILTER (WHERE country_code <> 'UNKNOWN')::int,
    'country_missing', count(*) FILTER (WHERE country_code = 'UNKNOWN')::int,
    'platform_known', count(*) FILTER (WHERE signup_platform <> 'unknown')::int,
    'platform_missing', count(*) FILTER (WHERE signup_platform = 'unknown')::int
  ),
  'country_breakdown', (
    SELECT coalesce(json_agg(row_to_json(country_row) ORDER BY country_row.signups DESC, country_row.country_code), '[]'::json)
    FROM (
      SELECT country_code, count(*)::int AS signups
      FROM user_funnel
      GROUP BY country_code
    ) country_row
  ),
  'platform_breakdown', (
    SELECT coalesce(json_agg(row_to_json(platform_row) ORDER BY platform_row.signups DESC, platform_row.signup_platform), '[]'::json)
    FROM (
      SELECT signup_platform, count(*)::int AS signups
      FROM user_funnel
      GROUP BY signup_platform
    ) platform_row
  ),
  'direct_google_ads_attribution', json_build_object(
    'available', EXISTS (SELECT 1 FROM potential_ads_columns),
    'columns_present', (SELECT coalesce(json_agg(column_name ORDER BY column_name), '[]'::json) FROM potential_ads_columns),
    'current_interpretation', CASE
      WHEN EXISTS (SELECT 1 FROM potential_ads_columns)
        THEN 'Potential direct-attribution columns exist; population and integrity still require validation.'
      ELSE 'Only country/platform/time correlation is possible; Google Ads causality is not proven.'
    END,
    'recommended_future_capture', json_build_array(
      'Google Play Install Referrer', 'gclid/gbraid/wbraid when available', 'campaign id', 'ad group id'
    )
  )
)
FROM user_funnel;`);
  }

  throw new Error(`Outil inconnu : ${toolName}`);
}

function validateRuntimeConfig(env = process.env) {
  const config = {
    sshTarget: env.NORVA_HETZNER_SSH_TARGET ?? 'adrien@157.180.96.159',
    dbContainer: env.NORVA_HETZNER_DB_CONTAINER ?? 'norva-db',
    dbUser: env.NORVA_HETZNER_DB_USER ?? 'postgres',
    dbName: env.NORVA_HETZNER_DB_NAME ?? 'postgres',
  };

  if (!/^[A-Za-z0-9_.@:[\]-]+$/.test(config.sshTarget)) throw new Error('NORVA_HETZNER_SSH_TARGET invalide.');
  for (const [label, value] of Object.entries({
    NORVA_HETZNER_DB_CONTAINER: config.dbContainer,
    NORVA_HETZNER_DB_USER: config.dbUser,
    NORVA_HETZNER_DB_NAME: config.dbName,
  })) {
    if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`${label} invalide.`);
  }
  return config;
}

export function parsePsqlJson(stdout) {
  const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('PostgreSQL n’a retourné aucun résultat.');
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    throw new Error('La réponse PostgreSQL n’est pas un agrégat JSON valide.');
  }
}

export function runQuery(sql, env = process.env) {
  const config = validateRuntimeConfig(env);
  const remoteCommand = [
    'docker', 'exec', '-i', config.dbContainer,
    'psql', '-U', config.dbUser, '-d', config.dbName,
    '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  ].join(' ');

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      config.sshTarget,
      remoteCommand,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let finished = false;

    const finish = (callback) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      callback();
    };

    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('La requête Hetzner a dépassé 15 secondes.')));
    }, QUERY_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(() => reject(new Error('La réponse agrégée dépasse la limite autorisée.')));
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(() => reject(new Error(`Impossible de lancer SSH : ${error.message}`))));
    child.on('close', (code) => finish(() => {
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).at(-1) || `code ${code}`;
        reject(new Error(`Échec de la lecture Hetzner : ${detail}`));
        return;
      }
      try {
        resolve(parsePsqlJson(stdout));
      } catch (error) {
        reject(error);
      }
    }));

    child.stdin.end(`${sql}\n`, 'utf8');
  });
}

function successToolResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: false,
  };
}

function errorToolResult(error) {
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export async function handleRequest(message, queryRunner = runQuery) {
  const id = message?.id ?? null;
  const base = { jsonrpc: '2.0', id };

  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { ...base, error: { code: -32600, message: 'Invalid Request' } };
  }

  if (message.method === 'initialize') {
    return {
      ...base,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'Lecture seule sur PostgreSQL Hetzner. Résultats agrégés uniquement, sans identifiant utilisateur ni PII. Les diagnostics M3U/Xtream ne retournent jamais de hash individuel, URL, chemin, paramètre ou accès. Les inscriptions filtrées par pays/plateforme/période sont corrélées à Google Ads mais ne prouvent pas l’attribution tant qu’aucun identifiant de clic ou Install Referrer n’est capturé.',
      },
    };
  }

  if (message.method === 'ping') return { ...base, result: {} };
  if (message.method === 'tools/list') return { ...base, result: { tools: TOOL_DEFINITIONS } };

  if (message.method === 'tools/call') {
    const params = assertPlainObject(message.params, 'params');
    if (typeof params.name !== 'string') {
      return { ...base, result: errorToolResult(new Error('Le nom de l’outil est requis.')) };
    }
    try {
      const sql = buildQuery(params.name, params.arguments ?? {});
      const data = await queryRunner(sql);
      return { ...base, result: successToolResult(data) };
    } catch (error) {
      return { ...base, result: errorToolResult(error) };
    }
  }

  if (message.method.startsWith('notifications/')) return null;
  return { ...base, error: { code: -32601, message: 'Method not found' } };
}

export async function startServer() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      continue;
    }

    try {
      const response = await handleRequest(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      const response = {
        jsonrpc: '2.0',
        id: message?.id ?? null,
        error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' },
      };
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  startServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
