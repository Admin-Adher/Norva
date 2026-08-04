-- Norva Partners: immutable, versioned release-approval registry.
--
-- A release gate is effective only while it is bound to an unexpired approval
-- package whose program and jurisdiction snapshots still match the database.
-- No approval is backfilled by this migration: every existing satisfied gate
-- becomes ineffective until an authorized AAL2 operator records real evidence.

alter default privileges in schema affiliate_private
  revoke execute on functions from public;

create or replace function
affiliate_private.valid_partners_approval_document_hashes(p_hashes jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_hashes is null or jsonb_typeof(p_hashes) <> 'object' then false
    else
      (
        select count(*) from jsonb_object_keys(p_hashes)
      ) between 1 and 64
      and not exists (
        select 1
        from jsonb_each(p_hashes) document(key, value)
        where document.key !~ '^[a-z][a-z0-9_]{2,63}$'
          or jsonb_typeof(document.value) <> 'string'
          or document.value #>> '{}' !~ '^[0-9a-f]{64}$'
          or document.value #>> '{}' = repeat('0', 64)
      )
      and (
        select count(*) = count(distinct document.value #>> '{}')
        from jsonb_each(p_hashes) document(key, value)
      )
  end;
$$;

create or replace function
affiliate_private.valid_partners_approval_jurisdiction_scope(p_scope jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_scope is null or jsonb_typeof(p_scope) <> 'array' then false
    else
      jsonb_array_length(p_scope) between 1 and 100
      and not exists (
        select 1
        from jsonb_array_elements(p_scope) scope(item)
        where case
          when jsonb_typeof(scope.item) <> 'object' then true
          else
            (
              select count(*) from jsonb_object_keys(scope.item)
            ) <> 3
            or not scope.item ?& array[
              'country_code',
              'subdivision_code',
              'policy_snapshot_sha256'
            ]::text[]
            or scope.item ->> 'country_code' !~ '^[A-Z]{2}$'
            or (
              jsonb_typeof(scope.item -> 'subdivision_code') <> 'null'
              and (
                scope.item ->> 'subdivision_code'
                  !~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$'
                or length(scope.item ->> 'subdivision_code') > 12
              )
            )
            or scope.item ->> 'policy_snapshot_sha256'
              !~ '^[0-9a-f]{64}$'
        end
      )
      and jsonb_array_length(p_scope) = (
        select count(distinct concat_ws(
          ':',
          scope.item ->> 'country_code',
          coalesce(scope.item ->> 'subdivision_code', '*')
        ))
        from jsonb_array_elements(p_scope) scope(item)
      )
  end;
$$;

create or replace function
affiliate_private.partners_approval_required_document_keys(p_gate_key text)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select array['approval_record', 'deployment_proof']::text[] || case p_gate_key
    when 'privacy_approved' then
      array[
        'dpia',
        'gdpr_self_assessment',
        'biometric_consent',
        'privacy_notice',
        'records_of_processing'
      ]
    when 'legal_and_tax_approved' then
      array['legal_tax_review', 'partners_terms']
    when 'individual_verification_coverage_confirmed' then
      array['kyc_certification']
    when 'individual_payout_coverage_confirmed' then
      array['payout_coverage_review']
    when 'country_policy_approved' then
      array['country_policy_review', 'payout_corridor_review']
    when 'financial_data_contract_approved' then
      array['financial_contract_test']
    when 'shadow_reconciliation_clean' then
      array['shadow_reconciliation_report']
    when 'backup_restore_verified' then
      array['restore_rehearsal_proof']
    when 'payout_execution_adapter_verified' then
      array['payout_execution_test']
    when 'manual_payout_workflow_verified' then
      array['manual_payout_runbook_test']
    when 'revolut_api_adapter_verified' then
      array['revolut_api_certification']
    when 'tv_relay_security_verified' then
      array['tv_relay_security_review']
    when 'general_release_approved' then
      array['release_readiness_report']
    else '{}'::text[]
  end;
$$;

create or replace function
affiliate_private.partners_approval_package_sha256(
  p_gate_key text,
  p_package_version integer,
  p_program_version_key text,
  p_program_snapshot_sha256 text,
  p_jurisdiction_scope jsonb,
  p_document_hashes jsonb,
  p_source_commit_sha text,
  p_deployment_environment text,
  p_deployment_key text,
  p_deployment_evidence_sha256 text,
  p_deployment_manifest_sha256 text,
  p_approved_by_pseudonym text,
  p_approved_at timestamptz,
  p_expires_at timestamptz,
  p_justification text
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select encode(
    extensions.digest(
      jsonb_build_object(
        'gate_key', p_gate_key,
        'package_version', p_package_version,
        'program_version_key', p_program_version_key,
        'program_snapshot_sha256', p_program_snapshot_sha256,
        'jurisdiction_scope', p_jurisdiction_scope,
        'document_hashes', p_document_hashes,
        'source_commit_sha', p_source_commit_sha,
        'deployment_environment', p_deployment_environment,
        'deployment_key', p_deployment_key,
        'deployment_evidence_sha256', p_deployment_evidence_sha256,
        'deployment_manifest_sha256', p_deployment_manifest_sha256,
        'approved_by_pseudonym', p_approved_by_pseudonym,
        'approved_at_epoch', extract(epoch from p_approved_at),
        'expires_at_epoch', extract(epoch from p_expires_at),
        'justification', p_justification
      )::text,
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function
affiliate_private.partners_deployment_manifest_sha256(
  p_deployment_environment text,
  p_manifest_version integer,
  p_source_commit_sha text,
  p_deployment_key text,
  p_deployment_evidence_sha256 text,
  p_document_hashes jsonb,
  p_registered_by_pseudonym text,
  p_registered_at timestamptz,
  p_justification text
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select encode(
    extensions.digest(
      jsonb_build_object(
        'deployment_environment', p_deployment_environment,
        'manifest_version', p_manifest_version,
        'source_commit_sha', p_source_commit_sha,
        'deployment_key', p_deployment_key,
        'deployment_evidence_sha256', p_deployment_evidence_sha256,
        'document_hashes', p_document_hashes,
        'registered_by_pseudonym', p_registered_by_pseudonym,
        'registered_at_epoch', extract(epoch from p_registered_at),
        'justification', p_justification
      )::text,
      'sha256'
    ),
    'hex'
  );
$$;

create table affiliate_private.affiliate_deployment_manifests (
  id                          uuid primary key default gen_random_uuid(),
  deployment_environment      text not null,
  manifest_version            integer not null,
  source_commit_sha           text not null,
  deployment_key              text not null,
  deployment_evidence_sha256  text not null,
  document_hashes             jsonb not null,
  manifest_sha256             text not null unique,
  registered_by_pseudonym     text not null,
  registered_at               timestamptz not null,
  justification               text not null,
  constraint affiliate_deployment_manifests_environment
    check (deployment_environment in ('preproduction', 'production')),
  constraint affiliate_deployment_manifests_version
    check (manifest_version between 1 and 2147483647),
  constraint affiliate_deployment_manifests_commit
    check (source_commit_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  constraint affiliate_deployment_manifests_key
    check (
      length(deployment_key) between 3 and 128
      and deployment_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]+$'
    ),
  constraint affiliate_deployment_manifests_evidence_hash
    check (deployment_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  constraint affiliate_deployment_manifests_documents
    check (
      affiliate_private.valid_partners_approval_document_hashes(
        document_hashes
      )
      and document_hashes ? 'deployment_proof'
    ),
  constraint affiliate_deployment_manifests_hash
    check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  constraint affiliate_deployment_manifests_actor
    check (registered_by_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_deployment_manifests_justification
    check (length(btrim(justification)) between 12 and 1000),
  constraint affiliate_deployment_manifests_environment_version
    unique (deployment_environment, manifest_version)
);

create table affiliate_private.affiliate_deployment_manifest_bindings (
  deployment_environment  text primary key,
  deployment_manifest_id  uuid not null unique
    references affiliate_private.affiliate_deployment_manifests(id)
    on delete restrict,
  bound_by_pseudonym       text not null,
  bound_at                 timestamptz not null,
  constraint affiliate_deployment_manifest_bindings_environment
    check (deployment_environment in ('preproduction', 'production')),
  constraint affiliate_deployment_manifest_bindings_actor
    check (bound_by_pseudonym ~ '^[0-9a-f]{64}$')
);

alter table affiliate_private.affiliate_deployment_manifests
  enable row level security;
alter table affiliate_private.affiliate_deployment_manifest_bindings
  enable row level security;
revoke all on table affiliate_private.affiliate_deployment_manifests
  from public, anon, authenticated, service_role;
revoke all on table
  affiliate_private.affiliate_deployment_manifest_bindings
  from public, anon, authenticated, service_role;

create or replace function
affiliate_private.guard_partners_deployment_manifest_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(
    current_setting('norva.partners_approval_control', true),
    ''
  ) <> 'deployment'
    or new.manifest_sha256 is distinct from
      affiliate_private.partners_deployment_manifest_sha256(
        new.deployment_environment,
        new.manifest_version,
        new.source_commit_sha,
        new.deployment_key,
        new.deployment_evidence_sha256,
        new.document_hashes,
        new.registered_by_pseudonym,
        new.registered_at,
        new.justification
      )
  then
    raise exception 'Partners deployment manifest integrity mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function
affiliate_private.reject_partners_deployment_manifest_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Partners deployment manifests are append-only'
    using errcode = '55000';
end;
$$;

create or replace function
affiliate_private.guard_partners_deployment_manifest_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(
    current_setting('norva.partners_approval_control', true),
    ''
  ) <> 'deployment'
  then
    raise exception 'Partners deployment bindings require the audited RPC'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if not exists (
    select 1
    from affiliate_private.affiliate_deployment_manifests manifest
    where manifest.id = new.deployment_manifest_id
      and manifest.deployment_environment = new.deployment_environment
      and manifest.registered_by_pseudonym = new.bound_by_pseudonym
      and manifest.registered_at = new.bound_at
  ) then
    raise exception 'Partners deployment binding integrity mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger affiliate_deployment_manifests_insert_guard
before insert on affiliate_private.affiliate_deployment_manifests
for each row execute function
  affiliate_private.guard_partners_deployment_manifest_insert();
create trigger affiliate_deployment_manifests_append_only
before update or delete on affiliate_private.affiliate_deployment_manifests
for each row execute function
  affiliate_private.reject_partners_deployment_manifest_mutation();
create trigger affiliate_deployment_manifest_bindings_guard
before insert or update or delete
on affiliate_private.affiliate_deployment_manifest_bindings
for each row execute function
  affiliate_private.guard_partners_deployment_manifest_binding();

create table affiliate_private.affiliate_approval_packages (
  id                           uuid primary key default gen_random_uuid(),
  gate_key                     text not null
    references affiliate_private.affiliate_release_gates(gate_key)
    on delete restrict,
  package_version              integer not null,
  program_version_id           uuid not null
    references affiliate_private.affiliate_program_versions(id)
    on delete restrict,
  deployment_manifest_id       uuid not null
    references affiliate_private.affiliate_deployment_manifests(id)
    on delete restrict,
  program_version_key          text not null,
  program_snapshot_sha256      text not null,
  jurisdiction_scope           jsonb not null,
  document_hashes              jsonb not null,
  source_commit_sha            text not null,
  deployment_environment       text not null,
  deployment_key               text not null,
  deployment_evidence_sha256   text not null,
  deployment_manifest_sha256   text not null,
  package_sha256               text not null unique,
  approved_by_pseudonym        text not null,
  approved_at                  timestamptz not null,
  expires_at                   timestamptz not null,
  justification                text not null,
  constraint affiliate_approval_packages_version
    check (package_version between 1 and 2147483647),
  constraint affiliate_approval_packages_program_key
    check (program_version_key ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  constraint affiliate_approval_packages_program_hash
    check (program_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  constraint affiliate_approval_packages_scope
    check (
      affiliate_private.valid_partners_approval_jurisdiction_scope(
        jurisdiction_scope
      )
    ),
  constraint affiliate_approval_packages_documents
    check (
      affiliate_private.valid_partners_approval_document_hashes(
        document_hashes
      )
    ),
  constraint affiliate_approval_packages_commit
    check (source_commit_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  constraint affiliate_approval_packages_environment
    check (deployment_environment in ('preproduction', 'production')),
  constraint affiliate_approval_packages_deployment_key
    check (
      length(deployment_key) between 3 and 128
      and deployment_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]+$'
    ),
  constraint affiliate_approval_packages_deployment_hash
    check (deployment_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  constraint affiliate_approval_packages_manifest_hash
    check (deployment_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  constraint affiliate_approval_packages_package_hash
    check (package_sha256 ~ '^[0-9a-f]{64}$'),
  constraint affiliate_approval_packages_actor
    check (approved_by_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_approval_packages_expiry
    check (expires_at > approved_at),
  constraint affiliate_approval_packages_justification
    check (length(btrim(justification)) between 12 and 1000),
  constraint affiliate_approval_packages_gate_version
    unique (gate_key, package_version)
);

create index affiliate_approval_packages_gate_idx
  on affiliate_private.affiliate_approval_packages (
    gate_key,
    package_version desc
  );

create table affiliate_private.affiliate_release_gate_approval_bindings (
  gate_key                    text primary key
    references affiliate_private.affiliate_release_gates(gate_key)
    on delete restrict,
  approval_package_id         uuid not null unique
    references affiliate_private.affiliate_approval_packages(id)
    on delete restrict,
  bound_by_pseudonym          text not null,
  bound_at                    timestamptz not null default now(),
  constraint affiliate_release_gate_approval_bindings_actor
    check (bound_by_pseudonym ~ '^[0-9a-f]{64}$')
);

alter table affiliate_private.affiliate_approval_packages
  enable row level security;
alter table affiliate_private.affiliate_release_gate_approval_bindings
  enable row level security;

revoke all on table affiliate_private.affiliate_approval_packages
  from public, anon, authenticated, service_role;
revoke all on table
  affiliate_private.affiliate_release_gate_approval_bindings
  from public, anon, authenticated, service_role;

create or replace function
affiliate_private.guard_partners_approval_package_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(
    current_setting('norva.partners_approval_control', true),
    ''
  ) <> 'approve'
  then
    raise exception 'Partners approval packages require the audited RPC'
      using errcode = '42501';
  end if;
  if not new.document_hashes ?&
      affiliate_private.partners_approval_required_document_keys(
        new.gate_key
      )
    or new.package_sha256 is distinct from
      affiliate_private.partners_approval_package_sha256(
        new.gate_key,
        new.package_version,
        new.program_version_key,
        new.program_snapshot_sha256,
        new.jurisdiction_scope,
        new.document_hashes,
        new.source_commit_sha,
        new.deployment_environment,
        new.deployment_key,
        new.deployment_evidence_sha256,
        new.deployment_manifest_sha256,
        new.approved_by_pseudonym,
        new.approved_at,
        new.expires_at,
        new.justification
      )
  then
    raise exception 'Partners approval package integrity mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function
affiliate_private.reject_partners_approval_package_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Partners approval packages are append-only'
    using errcode = '55000';
end;
$$;

create or replace function
affiliate_private.guard_partners_approval_binding_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(
    current_setting('norva.partners_approval_control', true),
    ''
  ) not in ('approve', 'revoke')
  then
    raise exception 'Partners approval bindings require the audited RPC'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if not exists (
    select 1
    from affiliate_private.affiliate_approval_packages package
    where package.id = new.approval_package_id
      and package.gate_key = new.gate_key
      and package.approved_by_pseudonym = new.bound_by_pseudonym
      and package.approved_at = new.bound_at
  ) then
    raise exception 'Partners approval binding integrity mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger affiliate_approval_packages_insert_guard
before insert on affiliate_private.affiliate_approval_packages
for each row execute function
  affiliate_private.guard_partners_approval_package_insert();

create trigger affiliate_approval_packages_append_only
before update or delete on affiliate_private.affiliate_approval_packages
for each row execute function
  affiliate_private.reject_partners_approval_package_mutation();

create trigger affiliate_release_gate_approval_bindings_guard
before insert or update or delete
on affiliate_private.affiliate_release_gate_approval_bindings
for each row execute function
  affiliate_private.guard_partners_approval_binding_mutation();

create or replace function
affiliate_private.partners_program_approval_snapshot_sha256(
  p_program_version_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(
    extensions.digest(
      jsonb_build_object(
        'version_key', program.version_key,
        'account_type', program.account_type,
        'commission_rate_bps', program.commission_rate_bps,
        'attribution_window_days', program.attribution_window_days,
        'maturation_days', program.maturation_days,
        'payout_thresholds', program.payout_thresholds,
        'threshold_reference_currency',
          program.threshold_reference_currency,
        'threshold_reference_minor', program.threshold_reference_minor,
        'payout_fee_policy', program.payout_fee_policy,
        'terms_version', program.terms_version,
        'disclosure_version', program.disclosure_version,
        'effective_from', program.effective_from,
        'effective_until', program.effective_until
      )::text,
      'sha256'
    ),
    'hex'
  )
  from affiliate_private.affiliate_program_versions program
  where program.id = p_program_version_id;
$$;

create or replace function
affiliate_private.partners_country_policy_approval_snapshot_sha256(
  p_country_policy_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(
    extensions.digest(
      jsonb_build_object(
        'program_version_key', program.version_key,
        'country_code', policy.country_code,
        'subdivision_code', policy.subdivision_code,
        'minimum_age', policy.minimum_age,
        'capacity_required', policy.capacity_required,
        'verification_level', policy.verification_level,
        'verification_provider', policy.verification_provider,
        'payout_currencies', policy.payout_currencies,
        'terms_version', policy.terms_version,
        'disclosure_version', policy.disclosure_version,
        'effective_from', policy.effective_from,
        'effective_until', policy.effective_until
      )::text,
      'sha256'
    ),
    'hex'
  )
  from affiliate_private.affiliate_country_policies policy
  join affiliate_private.affiliate_program_versions program
    on program.id = policy.program_version_id
  where policy.id = p_country_policy_id;
$$;

create or replace function
affiliate_private.partners_approval_package_is_current(
  p_approval_package_id uuid,
  p_gate_key text,
  p_deployment_environment text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      (p_gate_key is null or package.gate_key = p_gate_key)
      and package.deployment_environment = lower(
        btrim(coalesce(p_deployment_environment, ''))
      )
      and package.expires_at > statement_timestamp()
      and program.status in ('draft', 'active')
      and package.program_version_key = program.version_key
      and package.document_hashes ?&
        affiliate_private.partners_approval_required_document_keys(
          package.gate_key
        )
      and package.package_sha256 =
        affiliate_private.partners_approval_package_sha256(
          package.gate_key,
          package.package_version,
          package.program_version_key,
          package.program_snapshot_sha256,
          package.jurisdiction_scope,
          package.document_hashes,
          package.source_commit_sha,
          package.deployment_environment,
          package.deployment_key,
          package.deployment_evidence_sha256,
          package.deployment_manifest_sha256,
          package.approved_by_pseudonym,
          package.approved_at,
          package.expires_at,
          package.justification
        )
      and package.program_snapshot_sha256 =
        affiliate_private.partners_program_approval_snapshot_sha256(
          package.program_version_id
        )
      and package.deployment_manifest_sha256 = manifest.manifest_sha256
      and manifest.manifest_sha256 =
        affiliate_private.partners_deployment_manifest_sha256(
          manifest.deployment_environment,
          manifest.manifest_version,
          manifest.source_commit_sha,
          manifest.deployment_key,
          manifest.deployment_evidence_sha256,
          manifest.document_hashes,
          manifest.registered_by_pseudonym,
          manifest.registered_at,
          manifest.justification
        )
      and package.source_commit_sha = manifest.source_commit_sha
      and package.deployment_environment =
        manifest.deployment_environment
      and package.deployment_key = manifest.deployment_key
      and package.deployment_evidence_sha256 =
        manifest.deployment_evidence_sha256
      and manifest.document_hashes @> package.document_hashes
      and not exists (
        select 1
        from jsonb_array_elements(package.jurisdiction_scope) scope(item)
        left join affiliate_private.affiliate_country_policies policy
          on policy.program_version_id = package.program_version_id
          and policy.country_code = scope.item ->> 'country_code'
          and policy.subdivision_code is not distinct from
            nullif(scope.item ->> 'subdivision_code', '')
        where policy.id is null
          or scope.item ->> 'policy_snapshot_sha256' is distinct from
            affiliate_private.partners_country_policy_approval_snapshot_sha256(
              policy.id
            )
      )
      and not exists (
        select 1
        from affiliate_private.affiliate_country_policies policy
        where policy.program_version_id = package.program_version_id
          and policy.individual_available
          and not exists (
            select 1
            from jsonb_array_elements(package.jurisdiction_scope) scope(item)
            where scope.item ->> 'country_code' = policy.country_code
              and nullif(scope.item ->> 'subdivision_code', '')
                is not distinct from policy.subdivision_code
              and scope.item ->> 'policy_snapshot_sha256' =
                affiliate_private.partners_country_policy_approval_snapshot_sha256(
                  policy.id
                )
          )
      )
    from affiliate_private.affiliate_approval_packages package
    join affiliate_private.affiliate_program_versions program
      on program.id = package.program_version_id
    join affiliate_private.affiliate_deployment_manifests manifest
      on manifest.id = package.deployment_manifest_id
    join affiliate_private.affiliate_deployment_manifest_bindings
      manifest_binding
      on manifest_binding.deployment_environment =
        package.deployment_environment
      and manifest_binding.deployment_manifest_id = manifest.id
    where package.id = p_approval_package_id
  ), false);
$$;

create or replace function
affiliate_private.partners_approval_package_is_current(
  p_approval_package_id uuid,
  p_gate_key text default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select affiliate_private.partners_approval_package_is_current(
    p_approval_package_id,
    p_gate_key,
    'production'
  );
$$;

create or replace function
affiliate_private.partners_release_gate_approval_is_current(
  p_gate_key text,
  p_deployment_environment text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      gate.satisfied
      and package.gate_key = gate.gate_key
      and package.deployment_environment = lower(
        btrim(coalesce(p_deployment_environment, ''))
      )
      and (
        not exists (
          select 1
          from affiliate_private.affiliate_program_versions active_program
          where active_program.status = 'active'
            and active_program.effective_from <= statement_timestamp()
            and (
              active_program.effective_until is null
              or active_program.effective_until > statement_timestamp()
            )
        )
        or exists (
          select 1
          from affiliate_private.affiliate_program_versions active_program
          where active_program.id = package.program_version_id
            and active_program.status = 'active'
            and active_program.effective_from <= statement_timestamp()
            and (
              active_program.effective_until is null
              or active_program.effective_until > statement_timestamp()
            )
        )
      )
      and affiliate_private.partners_approval_package_is_current(
        package.id,
        gate.gate_key,
        p_deployment_environment
      )
    from affiliate_private.affiliate_release_gates gate
    join affiliate_private.affiliate_release_gate_approval_bindings binding
      on binding.gate_key = gate.gate_key
    join affiliate_private.affiliate_approval_packages package
      on package.id = binding.approval_package_id
    where gate.gate_key = p_gate_key
  ), false);
$$;

create or replace function
affiliate_private.partners_release_gate_approval_is_current(p_gate_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select affiliate_private.partners_release_gate_approval_is_current(
    p_gate_key,
    'production'
  );
$$;

create or replace function affiliate_private.release_gates_satisfied(
  p_gate_keys text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with requested as (
    select
      gate.gate_key,
      gate.satisfied,
      package.id as package_id,
      package.program_version_id
    from affiliate_private.affiliate_release_gates gate
    left join
      affiliate_private.affiliate_release_gate_approval_bindings binding
      on binding.gate_key = gate.gate_key
    left join affiliate_private.affiliate_approval_packages package
      on package.id = binding.approval_package_id
    where gate.gate_key = any (p_gate_keys)
  ), active_program as (
    select program.id
    from affiliate_private.affiliate_program_versions program
    where program.status = 'active'
      and program.effective_from <= statement_timestamp()
      and (
        program.effective_until is null
        or program.effective_until > statement_timestamp()
      )
  )
  select
    p_gate_keys is not null
    and cardinality(p_gate_keys) > 0
    and cardinality(p_gate_keys) = (
      select count(distinct requested.gate_key) from requested
    )
    and coalesce((
      select bool_and(
        requested.satisfied
        and requested.package_id is not null
        and affiliate_private.partners_approval_package_is_current(
          requested.package_id,
          requested.gate_key
        )
      )
      from requested
    ), false)
    and 1 = (
      select count(distinct requested.program_version_id)
      from requested
    )
    and (
      (select count(*) from active_program) = 0
      or (
        (select count(*) from active_program) = 1
        and (select requested.program_version_id from requested limit 1) =
          (select active_program.id from active_program limit 1)
      )
    );
$$;

create or replace function
affiliate_private.partners_approval_gate_covers_policy(
  p_gate_key text,
  p_program_version_id uuid,
  p_country_code text,
  p_subdivision_code text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      gate.satisfied
      and package.program_version_id = p_program_version_id
      and affiliate_private.partners_approval_package_is_current(
        package.id,
        gate.gate_key
      )
      and exists (
        select 1
        from jsonb_array_elements(package.jurisdiction_scope) scope(item)
        join affiliate_private.affiliate_country_policies policy
          on policy.program_version_id = package.program_version_id
          and policy.country_code = scope.item ->> 'country_code'
          and policy.subdivision_code is not distinct from
            nullif(scope.item ->> 'subdivision_code', '')
        where policy.country_code = p_country_code
          and policy.subdivision_code is not distinct from p_subdivision_code
          and scope.item ->> 'policy_snapshot_sha256' =
            affiliate_private.partners_country_policy_approval_snapshot_sha256(
              policy.id
            )
      )
    from affiliate_private.affiliate_release_gates gate
    join affiliate_private.affiliate_release_gate_approval_bindings binding
      on binding.gate_key = gate.gate_key
    join affiliate_private.affiliate_approval_packages package
      on package.id = binding.approval_package_id
    where gate.gate_key = p_gate_key
  ), false);
$$;

create or replace function
affiliate_private.admin_partners_deployment_manifest_register(
  p_deployment_environment text,
  p_source_commit_sha text,
  p_deployment_key text,
  p_deployment_evidence_sha256 text,
  p_document_hashes jsonb,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_environment text := lower(
    btrim(coalesce(p_deployment_environment, ''))
  );
  v_commit text := lower(btrim(coalesce(p_source_commit_sha, '')));
  v_deployment_key text := btrim(coalesce(p_deployment_key, ''));
  v_deployment_hash text := lower(
    btrim(coalesce(p_deployment_evidence_sha256, ''))
  );
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor_pseudonym text;
  v_registered_at timestamptz := clock_timestamp();
  v_version integer;
  v_manifest_hash text;
  v_manifest_id uuid;
  v_existing affiliate_private.affiliate_deployment_manifests%rowtype;
begin
  if not coalesce(public.is_admin(), false)
    or auth.uid() is null
    or not affiliate_private.partners_is_release_manager()
  then
    raise exception 'Partners release-manager role is required'
      using errcode = '42501';
  end if;
  perform affiliate_private.partners_require_aal2(
    'Partners deployment manifest registration'
  );

  if v_environment not in ('preproduction', 'production')
    or v_commit !~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
    or length(v_deployment_key) not between 3 and 128
    or v_deployment_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]+$'
    or v_deployment_hash !~ '^[0-9a-f]{64}$'
    or not affiliate_private.valid_partners_approval_document_hashes(
      p_document_hashes
    )
    or not p_document_hashes ? 'deployment_proof'
    or p_document_hashes ->> 'deployment_proof' <> v_deployment_hash
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid Partners deployment manifest'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:deployment-manifest:' || v_environment,
      0
    )
  );

  select manifest.*
  into v_existing
  from affiliate_private.affiliate_deployment_manifest_bindings binding
  join affiliate_private.affiliate_deployment_manifests manifest
    on manifest.id = binding.deployment_manifest_id
  where binding.deployment_environment = v_environment
    and manifest.source_commit_sha = v_commit
    and manifest.deployment_key = v_deployment_key
    and manifest.deployment_evidence_sha256 = v_deployment_hash
    and manifest.document_hashes = p_document_hashes;
  if found then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'deployment_manifest_unchanged',
      'deployment', jsonb_build_object(
        'environment', v_existing.deployment_environment,
        'manifest_version', v_existing.manifest_version,
        'manifest_sha256', v_existing.manifest_sha256,
        'source_commit_sha', v_existing.source_commit_sha,
        'deployment_key', v_existing.deployment_key,
        'deployment_evidence_sha256',
          v_existing.deployment_evidence_sha256,
        'document_keys', (
          select jsonb_agg(document.key order by document.key)
          from jsonb_each(v_existing.document_hashes) document(key, value)
        ),
        'registered_at', v_existing.registered_at
      )
    );
  end if;

  select coalesce(max(manifest.manifest_version), 0) + 1
  into v_version
  from affiliate_private.affiliate_deployment_manifests manifest
  where manifest.deployment_environment = v_environment;

  v_actor_pseudonym := affiliate_private.partners_admin_actor_pseudonym();
  v_manifest_hash :=
    affiliate_private.partners_deployment_manifest_sha256(
      v_environment,
      v_version,
      v_commit,
      v_deployment_key,
      v_deployment_hash,
      p_document_hashes,
      v_actor_pseudonym,
      v_registered_at,
      v_justification
    );
  perform set_config(
    'norva.partners_approval_control',
    'deployment',
    true
  );

  insert into affiliate_private.affiliate_deployment_manifests (
    deployment_environment,
    manifest_version,
    source_commit_sha,
    deployment_key,
    deployment_evidence_sha256,
    document_hashes,
    manifest_sha256,
    registered_by_pseudonym,
    registered_at,
    justification
  ) values (
    v_environment,
    v_version,
    v_commit,
    v_deployment_key,
    v_deployment_hash,
    p_document_hashes,
    v_manifest_hash,
    v_actor_pseudonym,
    v_registered_at,
    v_justification
  ) returning id into v_manifest_id;

  insert into affiliate_private.affiliate_deployment_manifest_bindings (
    deployment_environment,
    deployment_manifest_id,
    bound_by_pseudonym,
    bound_at
  ) values (
    v_environment,
    v_manifest_id,
    v_actor_pseudonym,
    v_registered_at
  )
  on conflict (deployment_environment) do update
  set
    deployment_manifest_id = excluded.deployment_manifest_id,
    bound_by_pseudonym = excluded.bound_by_pseudonym,
    bound_at = excluded.bound_at;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    before_state,
    after_state
  ) values (
    'deployment_manifest',
    v_environment,
    'deployment_manifest_registered',
    'admin',
    v_actor_pseudonym,
    v_justification,
    '{}'::jsonb,
    jsonb_build_object(
      'manifest_version', v_version,
      'manifest_sha256', v_manifest_hash,
      'source_commit_sha', v_commit,
      'deployment_key', v_deployment_key,
      'deployment_evidence_sha256', v_deployment_hash
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'deployment_manifest_registered',
    'deployment', jsonb_build_object(
      'environment', v_environment,
      'manifest_version', v_version,
      'manifest_sha256', v_manifest_hash,
      'source_commit_sha', v_commit,
      'deployment_key', v_deployment_key,
      'deployment_evidence_sha256', v_deployment_hash,
      'document_keys', (
        select jsonb_agg(document.key order by document.key)
        from jsonb_each(p_document_hashes) document(key, value)
      ),
      'registered_at', v_registered_at
    )
  );
end;
$$;

create or replace function public.admin_partners_deployment_manifest_register(
  p_deployment_environment text,
  p_source_commit_sha text,
  p_deployment_key text,
  p_deployment_evidence_sha256 text,
  p_document_hashes jsonb,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_deployment_manifest_register(
    p_deployment_environment,
    p_source_commit_sha,
    p_deployment_key,
    p_deployment_evidence_sha256,
    p_document_hashes,
    p_justification
  );
$$;

create or replace function
affiliate_private.admin_partners_release_gate_approve(
  p_gate_key text,
  p_program_version_key text,
  p_jurisdictions jsonb,
  p_document_hashes jsonb,
  p_source_commit_sha text,
  p_deployment_environment text,
  p_deployment_key text,
  p_deployment_evidence_sha256 text,
  p_expires_at timestamptz,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_gate text := lower(btrim(coalesce(p_gate_key, '')));
  v_program_key text := lower(btrim(coalesce(p_program_version_key, '')));
  v_commit text := lower(btrim(coalesce(p_source_commit_sha, '')));
  v_environment text := lower(
    btrim(coalesce(p_deployment_environment, ''))
  );
  v_deployment_key text := btrim(coalesce(p_deployment_key, ''));
  v_deployment_hash text := lower(
    btrim(coalesce(p_deployment_evidence_sha256, ''))
  );
  v_justification text := btrim(coalesce(p_justification, ''));
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_manifest affiliate_private.affiliate_deployment_manifests%rowtype;
  v_program_hash text;
  v_scope jsonb;
  v_scope_count integer;
  v_required_documents text[];
  v_missing_documents text[];
  v_actor uuid := auth.uid();
  v_actor_pseudonym text;
  v_version integer;
  v_approved_at timestamptz := clock_timestamp();
  v_package_hash text;
  v_package_id uuid;
  v_previous_package_hash text;
  v_previous_satisfied boolean;
  v_effective boolean;
begin
  if not coalesce(public.is_admin(), false) or v_actor is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  perform affiliate_private.partners_require_control_access(
    'set_gate',
    v_gate,
    true
  );
  perform affiliate_private.partners_require_aal2(
    'Partners approval package registration'
  );

  if v_gate = ''
    or v_program_key = ''
    or p_jurisdictions is null
    or jsonb_typeof(p_jurisdictions) <> 'array'
    or jsonb_array_length(p_jurisdictions) not between 1 and 100
    or not affiliate_private.valid_partners_approval_document_hashes(
      p_document_hashes
    )
    or v_commit !~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
    or v_environment not in ('preproduction', 'production')
    or length(v_deployment_key) not between 3 and 128
    or v_deployment_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]+$'
    or v_deployment_hash !~ '^[0-9a-f]{64}$'
    or p_document_hashes ->> 'deployment_proof' <> v_deployment_hash
    or p_expires_at is null
    or p_expires_at <= v_approved_at + interval '5 minutes'
    or p_expires_at > v_approved_at + interval '366 days'
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid Partners approval package'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_jurisdictions) scope(item)
    where case
      when jsonb_typeof(scope.item) <> 'object' then true
      else
        (
          select count(*) from jsonb_object_keys(scope.item)
        ) not between 1 and 2
        or not scope.item ? 'country_code'
        or exists (
          select 1
          from jsonb_object_keys(scope.item) keys(key_name)
          where keys.key_name not in ('country_code', 'subdivision_code')
        )
        or upper(btrim(scope.item ->> 'country_code')) !~ '^[A-Z]{2}$'
        or (
          scope.item ? 'subdivision_code'
          and jsonb_typeof(scope.item -> 'subdivision_code') <> 'null'
          and (
            upper(btrim(scope.item ->> 'subdivision_code'))
              !~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$'
            or length(upper(btrim(scope.item ->> 'subdivision_code'))) > 12
          )
        )
    end
  ) then
    raise exception 'invalid Partners approval jurisdiction scope'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:release-control', 0)
  );

  select manifest.*
  into v_manifest
  from affiliate_private.affiliate_deployment_manifest_bindings binding
  join affiliate_private.affiliate_deployment_manifests manifest
    on manifest.id = binding.deployment_manifest_id
  where binding.deployment_environment = v_environment
    and manifest.source_commit_sha = v_commit
    and manifest.deployment_key = v_deployment_key
    and manifest.deployment_evidence_sha256 = v_deployment_hash
    and manifest.document_hashes @> p_document_hashes
  for update of binding, manifest;
  if not found then
    raise exception
      'Partners approval package does not match the current deployment manifest'
      using errcode = '55000';
  end if;

  select gate.satisfied
  into v_previous_satisfied
  from affiliate_private.affiliate_release_gates gate
  where gate.gate_key = v_gate
  for update;
  if not found then
    raise exception 'unknown Partners release gate' using errcode = 'P0002';
  end if;

  select program.*
  into v_program
  from affiliate_private.affiliate_program_versions program
  where program.version_key = v_program_key
    and program.status in ('draft', 'active')
  for update;
  if not found then
    raise exception 'Partners program is unavailable'
      using errcode = 'P0002';
  end if;

  with requested as (
    select distinct
      upper(btrim(scope.item ->> 'country_code')) as country_code,
      nullif(
        upper(btrim(scope.item ->> 'subdivision_code')),
        ''
      ) as subdivision_code
    from jsonb_array_elements(p_jurisdictions) scope(item)
  ), resolved as (
    select
      policy.id,
      policy.country_code,
      policy.subdivision_code,
      affiliate_private.partners_country_policy_approval_snapshot_sha256(
        policy.id
      ) as policy_snapshot_sha256
    from requested
    join affiliate_private.affiliate_country_policies policy
      on policy.program_version_id = v_program.id
      and policy.country_code = requested.country_code
      and policy.subdivision_code is not distinct from
        requested.subdivision_code
  )
  select
    count(*),
    jsonb_agg(
      jsonb_build_object(
        'country_code', resolved.country_code,
        'subdivision_code', resolved.subdivision_code,
        'policy_snapshot_sha256', resolved.policy_snapshot_sha256
      )
      order by resolved.country_code, resolved.subdivision_code nulls first
    )
  into v_scope_count, v_scope
  from resolved;

  if v_scope_count <> jsonb_array_length(p_jurisdictions)
    or not affiliate_private.valid_partners_approval_jurisdiction_scope(v_scope)
  then
    raise exception 'Partners approval jurisdiction is unavailable or duplicated'
      using errcode = 'P0002';
  end if;

  v_required_documents :=
    affiliate_private.partners_approval_required_document_keys(v_gate);
  if cardinality(v_required_documents) <= 2 then
    raise exception 'unknown Partners approval document contract'
      using errcode = 'P0002';
  end if;

  select array_agg(required.key order by required.key)
  into v_missing_documents
  from unnest(v_required_documents) required(key)
  where not p_document_hashes ? required.key;
  if cardinality(v_missing_documents) > 0 then
    raise exception 'Partners approval package is missing required evidence: %',
      array_to_string(v_missing_documents, ',')
      using errcode = '22023';
  end if;

  v_program_hash :=
    affiliate_private.partners_program_approval_snapshot_sha256(v_program.id);
  if v_program_hash is null then
    raise exception 'Partners program snapshot is unavailable'
      using errcode = '55000';
  end if;

  select coalesce(max(package.package_version), 0) + 1
  into v_version
  from affiliate_private.affiliate_approval_packages package
  where package.gate_key = v_gate;

  v_actor_pseudonym := affiliate_private.partners_admin_actor_pseudonym();
  v_package_hash := affiliate_private.partners_approval_package_sha256(
    v_gate,
    v_version,
    v_program.version_key,
    v_program_hash,
    v_scope,
    p_document_hashes,
    v_commit,
    v_environment,
    v_deployment_key,
    v_deployment_hash,
    v_manifest.manifest_sha256,
    v_actor_pseudonym,
    v_approved_at,
    p_expires_at,
    v_justification
  );

  select package.package_sha256
  into v_previous_package_hash
  from affiliate_private.affiliate_release_gate_approval_bindings binding
  join affiliate_private.affiliate_approval_packages package
    on package.id = binding.approval_package_id
  where binding.gate_key = v_gate;

  perform set_config(
    'norva.partners_approval_control',
    'approve',
    true
  );

  insert into affiliate_private.affiliate_approval_packages (
    gate_key,
    package_version,
    program_version_id,
    deployment_manifest_id,
    program_version_key,
    program_snapshot_sha256,
    jurisdiction_scope,
    document_hashes,
    source_commit_sha,
    deployment_environment,
    deployment_key,
    deployment_evidence_sha256,
    deployment_manifest_sha256,
    package_sha256,
    approved_by_pseudonym,
    approved_at,
    expires_at,
    justification
  ) values (
    v_gate,
    v_version,
    v_program.id,
    v_manifest.id,
    v_program.version_key,
    v_program_hash,
    v_scope,
    p_document_hashes,
    v_commit,
    v_environment,
    v_deployment_key,
    v_deployment_hash,
    v_manifest.manifest_sha256,
    v_package_hash,
    v_actor_pseudonym,
    v_approved_at,
    p_expires_at,
    v_justification
  )
  returning id into v_package_id;

  insert into
    affiliate_private.affiliate_release_gate_approval_bindings (
      gate_key,
      approval_package_id,
      bound_by_pseudonym,
      bound_at
    )
  values (
    v_gate,
    v_package_id,
    v_actor_pseudonym,
    v_approved_at
  )
  on conflict (gate_key) do update
  set
    approval_package_id = excluded.approval_package_id,
    bound_by_pseudonym = excluded.bound_by_pseudonym,
    bound_at = excluded.bound_at;

  update affiliate_private.affiliate_release_gates
  set
    satisfied = true,
    satisfied_at = v_approved_at,
    updated_by_pseudonym = v_actor_pseudonym,
    updated_at = v_approved_at
  where gate_key = v_gate;

  v_effective :=
    affiliate_private.partners_release_gate_approval_is_current(
      v_gate,
      v_environment
    );
  if not v_effective then
    raise exception
      'Partners approval package is not effective for the requested environment'
      using errcode = '55000';
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    before_state,
    after_state
  ) values (
    'release_gate',
    v_gate,
    case
      when v_previous_satisfied then 'release_gate_approval_renewed'
      else 'release_gate_approved'
    end,
    'admin',
    v_actor_pseudonym,
    v_justification,
    jsonb_build_object(
      'satisfied', v_previous_satisfied,
      'approval_package_sha256', v_previous_package_hash
    ),
    jsonb_build_object(
      'satisfied', true,
      'approval_package_sha256', v_package_hash,
      'package_version', v_version,
      'program_version_key', v_program.version_key,
      'deployment_environment', v_environment,
      'deployment_manifest_sha256', v_manifest.manifest_sha256,
      'expires_at', p_expires_at
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', case
      when v_previous_satisfied then 'release_gate_approval_renewed'
      else 'release_gate_approved'
    end,
    'gate_key', v_gate,
    'satisfied', v_effective,
    'effective', v_effective,
    'recorded_satisfied', true,
    'approval', jsonb_build_object(
      'package_version', v_version,
      'package_sha256', v_package_hash,
      'program_version_key', v_program.version_key,
      'jurisdictions', (
        select jsonb_agg(
          jsonb_build_object(
            'country_code', scope.item ->> 'country_code',
            'subdivision_code', scope.item -> 'subdivision_code'
          )
          order by scope.item ->> 'country_code',
            scope.item ->> 'subdivision_code'
        )
        from jsonb_array_elements(v_scope) scope(item)
      ),
      'document_keys', (
        select jsonb_agg(document.key order by document.key)
        from jsonb_each(p_document_hashes) document(key, value)
      ),
      'source_commit_sha', v_commit,
      'deployment_environment', v_environment,
      'deployment_manifest_version', v_manifest.manifest_version,
      'deployment_manifest_sha256', v_manifest.manifest_sha256,
      'deployment_evidence_sha256', v_deployment_hash,
      'approved_at', v_approved_at,
      'expires_at', p_expires_at
    )
  );
end;
$$;

create or replace function public.admin_partners_release_gate_approve(
  p_gate_key text,
  p_program_version_key text,
  p_jurisdictions jsonb,
  p_document_hashes jsonb,
  p_source_commit_sha text,
  p_deployment_environment text,
  p_deployment_key text,
  p_deployment_evidence_sha256 text,
  p_expires_at timestamptz,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_release_gate_approve(
    p_gate_key,
    p_program_version_key,
    p_jurisdictions,
    p_document_hashes,
    p_source_commit_sha,
    p_deployment_environment,
    p_deployment_key,
    p_deployment_evidence_sha256,
    p_expires_at,
    p_justification
  );
$$;

create or replace function
affiliate_private.guard_partners_release_gate_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current boolean;
begin
  if new.satisfied then
    select coalesce((
      select
        package.gate_key = new.gate_key
        and affiliate_private.partners_approval_package_is_current(
          package.id,
          new.gate_key,
          package.deployment_environment
        )
        and (
          not exists (
            select 1
            from affiliate_private.affiliate_program_versions active_program
            where active_program.status = 'active'
              and active_program.effective_from <= clock_timestamp()
              and (
                active_program.effective_until is null
                or active_program.effective_until > clock_timestamp()
              )
          )
          or exists (
            select 1
            from affiliate_private.affiliate_program_versions active_program
            where active_program.id = package.program_version_id
              and active_program.status = 'active'
              and active_program.effective_from <= clock_timestamp()
              and (
                active_program.effective_until is null
                or active_program.effective_until > clock_timestamp()
              )
          )
        )
      from
        affiliate_private.affiliate_release_gate_approval_bindings binding
      join affiliate_private.affiliate_approval_packages package
        on package.id = binding.approval_package_id
      where binding.gate_key = new.gate_key
    ), false)
    into v_current;
    if not v_current then
      raise exception
        'Partners release gate requires a current immutable approval package'
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

create or replace function
affiliate_private.clear_partners_release_gate_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.satisfied and not new.satisfied then
    perform set_config(
      'norva.partners_approval_control',
      'revoke',
      true
    );
    delete from
      affiliate_private.affiliate_release_gate_approval_bindings binding
    where binding.gate_key = new.gate_key;
  end if;
  return null;
end;
$$;

create trigger affiliate_release_gates_approval_required
before insert or update of satisfied
on affiliate_private.affiliate_release_gates
for each row execute function
  affiliate_private.guard_partners_release_gate_approval();

create trigger affiliate_release_gates_approval_clear
after update of satisfied
on affiliate_private.affiliate_release_gates
for each row execute function
  affiliate_private.clear_partners_release_gate_approval();

create or replace function
affiliate_private.guard_partners_program_approved_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'draft' and new.status = 'active' then
    if not exists (
      select 1
      from affiliate_private.affiliate_release_gate_approval_bindings binding
      join affiliate_private.affiliate_approval_packages package
        on package.id = binding.approval_package_id
      where binding.gate_key = 'legal_and_tax_approved'
        and package.program_version_id = new.id
        and affiliate_private.partners_approval_package_is_current(
          package.id,
          binding.gate_key
        )
    ) or not exists (
      select 1
      from affiliate_private.affiliate_release_gate_approval_bindings binding
      join affiliate_private.affiliate_approval_packages package
        on package.id = binding.approval_package_id
      where binding.gate_key = 'privacy_approved'
        and package.program_version_id = new.id
        and affiliate_private.partners_approval_package_is_current(
          package.id,
          binding.gate_key
        )
    ) then
      raise exception 'program activation requires matching approval packages'
        using errcode = '55000';
    end if;
  end if;

  if (
    new.version_key is distinct from old.version_key
    or new.account_type is distinct from old.account_type
    or new.commission_rate_bps is distinct from old.commission_rate_bps
    or new.attribution_window_days is distinct from
      old.attribution_window_days
    or new.maturation_days is distinct from old.maturation_days
    or new.payout_thresholds is distinct from old.payout_thresholds
    or new.threshold_reference_currency is distinct from
      old.threshold_reference_currency
    or new.threshold_reference_minor is distinct from
      old.threshold_reference_minor
    or new.payout_fee_policy is distinct from old.payout_fee_policy
    or new.terms_version is distinct from old.terms_version
    or new.disclosure_version is distinct from old.disclosure_version
    or new.effective_from is distinct from old.effective_from
    or new.effective_until is distinct from old.effective_until
    or (
      new.status is distinct from old.status
      and not (old.status = 'draft' and new.status = 'active')
    )
  ) and exists (
    select 1
    from affiliate_private.affiliate_release_gates gate
    join affiliate_private.affiliate_release_gate_approval_bindings binding
      on binding.gate_key = gate.gate_key
    join affiliate_private.affiliate_approval_packages package
      on package.id = binding.approval_package_id
    where gate.satisfied
      and package.program_version_id = old.id
  ) then
    raise exception
      'revoke scoped Partners release gates before changing the program contract'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function
affiliate_private.guard_partners_country_policy_approved_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_program_id uuid := case
    when tg_op = 'INSERT' then new.program_version_id
    else old.program_version_id
  end;
  v_country text := case
    when tg_op = 'INSERT' then new.country_code
    else old.country_code
  end;
  v_subdivision text := case
    when tg_op = 'INSERT' then new.subdivision_code
    else old.subdivision_code
  end;
begin
  -- Availability is a release-authority mutation regardless of SQL role. This
  -- deliberately has no owner/service bypass: restore fixtures must restore or
  -- create the exact immutable packages before opening a jurisdiction.
  if new.individual_available
    and (tg_op = 'INSERT' or not old.individual_available)
  then
    if not affiliate_private.partners_approval_gate_covers_policy(
      'legal_and_tax_approved',
      new.program_version_id,
      new.country_code,
      new.subdivision_code
    ) or not affiliate_private.partners_approval_gate_covers_policy(
      'privacy_approved',
      new.program_version_id,
      new.country_code,
      new.subdivision_code
    ) or not affiliate_private.partners_approval_gate_covers_policy(
      'country_policy_approved',
      new.program_version_id,
      new.country_code,
      new.subdivision_code
    ) then
      raise exception
        'country policy availability requires matching approval packages'
        using errcode = '55000';
    end if;
  end if;

  if tg_op = 'UPDATE' and (
    new.program_version_id is distinct from old.program_version_id
    or new.country_code is distinct from old.country_code
    or new.subdivision_code is distinct from old.subdivision_code
    or new.minimum_age is distinct from old.minimum_age
    or new.capacity_required is distinct from old.capacity_required
    or new.verification_level is distinct from old.verification_level
    or new.verification_provider is distinct from old.verification_provider
    or new.payout_currencies is distinct from old.payout_currencies
    or new.terms_version is distinct from old.terms_version
    or new.disclosure_version is distinct from old.disclosure_version
    or new.effective_from is distinct from old.effective_from
    or new.effective_until is distinct from old.effective_until
  ) and exists (
    select 1
    from affiliate_private.affiliate_release_gates gate
    join affiliate_private.affiliate_release_gate_approval_bindings binding
      on binding.gate_key = gate.gate_key
    join affiliate_private.affiliate_approval_packages package
      on package.id = binding.approval_package_id
    cross join lateral jsonb_array_elements(
      package.jurisdiction_scope
    ) scope(item)
    where gate.satisfied
      and package.program_version_id = v_program_id
      and scope.item ->> 'country_code' = v_country
      and nullif(scope.item ->> 'subdivision_code', '')
        is not distinct from v_subdivision
  ) then
    raise exception
      'revoke scoped Partners release gates before changing the country policy'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger affiliate_program_versions_approved_scope
before update on affiliate_private.affiliate_program_versions
for each row execute function
  affiliate_private.guard_partners_program_approved_scope();

create trigger affiliate_country_policies_approved_scope
before insert or update on affiliate_private.affiliate_country_policies
for each row execute function
  affiliate_private.guard_partners_country_policy_approved_scope();

-- The documented P0 privacy assessment limits the supervised pilot to 50
-- simultaneously active members. Enforce that boundary in the database so no
-- Admin RPC, service role, restore fixture or concurrent transaction can race
-- past it.
create or replace function
affiliate_private.guard_partners_pilot_allowlist_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_count integer;
begin
  if new.status = 'active'
    and (new.expires_at is null or new.expires_at > statement_timestamp())
  then
    perform pg_advisory_xact_lock(
      hashtextextended('norva:partners:pilot-allowlist-limit', 0)
    );

    select count(*)::integer
    into v_active_count
    from affiliate_private.affiliate_pilot_allowlist allowlist_row
    where allowlist_row.status = 'active'
      and (
        allowlist_row.expires_at is null
        or allowlist_row.expires_at > statement_timestamp()
      )
      and allowlist_row.user_id is distinct from new.user_id;

    if v_active_count >= 50 then
      raise exception
        'Partners pilot allowlist is limited to 50 active members'
        using errcode = '54000';
    end if;
  end if;
  return new;
end;
$$;

create trigger affiliate_pilot_allowlist_limit
before insert or update of user_id, status, expires_at
on affiliate_private.affiliate_pilot_allowlist
for each row execute function
  affiliate_private.guard_partners_pilot_allowlist_limit();

-- The exceptional Didit certification window predates this registry. It must
-- consume effective evidence rather than the historical gate boolean: a stale,
-- expired or unbound Privacy row cannot authorize a provider certification.
create or replace function
affiliate_private.partners_assert_didit_certification_pre_gate()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_disabled_flag_count integer := 0;
begin
  perform 1
  from affiliate_private.affiliate_release_gates gate
  where gate.gate_key in (
    'privacy_approved',
    'individual_verification_coverage_confirmed'
  )
  for share;
  perform 1
  from public.admin_feature_flags flag
  where flag.key in (
    'partners_enabled',
    'partners_payouts_live',
    'partners_tv_relay_enabled',
    'partners_revolut_api_enabled'
  )
  for share;

  if not affiliate_private.partners_release_gate_approval_is_current(
    'privacy_approved',
    'preproduction'
  ) then
    raise exception 'Privacy approval is required for Didit certification'
      using errcode = 'P0001';
  end if;
  if affiliate_private.partners_release_gate_approval_is_current(
    'individual_verification_coverage_confirmed'
  ) then
    raise exception
      'Didit certification is available only before coverage approval'
      using errcode = 'P0001';
  end if;

  select count(*)
  into v_disabled_flag_count
  from public.admin_feature_flags flag
  where flag.key in (
      'partners_enabled',
      'partners_payouts_live',
      'partners_tv_relay_enabled',
      'partners_revolut_api_enabled'
    )
    and not flag.enabled;
  if v_disabled_flag_count <> 4 then
    raise exception
      'Didit certification requires all live Partners paths disabled'
      using errcode = 'P0001';
  end if;
end;
$$;

-- Keep the legacy private payout-status implementation intact for historical
-- contract tests, but make the public API consume effective registry truth.
-- The raw value is retained under an explicitly audit-only key.
create or replace function
affiliate_private.admin_partners_revolut_payout_status_approval_registry()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
  v_recorded boolean;
begin
  v_base := affiliate_private.admin_partners_revolut_payout_status();
  v_recorded := coalesce((
    select gate.satisfied
    from affiliate_private.affiliate_release_gates gate
    where gate.gate_key = 'revolut_api_adapter_verified'
  ), false);

  return jsonb_set(
    jsonb_set(
      v_base,
      '{api_adapter_verified}',
      to_jsonb(
        affiliate_private.partners_release_gate_approval_is_current(
          'revolut_api_adapter_verified'
        )
      ),
      true
    ),
    '{api_adapter_recorded_verified}',
    to_jsonb(v_recorded),
    true
  );
end;
$$;

create or replace function public.admin_partners_revolut_payout_status()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_payout_status_approval_registry();
$$;

alter function affiliate_private.admin_partners_configuration()
rename to admin_partners_configuration_pre_approval_registry_20260804;

create or replace function affiliate_private.admin_partners_configuration()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
  v_release_gates jsonb;
  v_deployment_manifests jsonb;
begin
  v_base :=
    affiliate_private.admin_partners_configuration_pre_approval_registry_20260804();

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', gate.gate_key,
        'satisfied',
          affiliate_private.partners_release_gate_approval_is_current(
            gate.gate_key
          ),
        'preproduction_satisfied',
          affiliate_private.partners_release_gate_approval_is_current(
            gate.gate_key,
            'preproduction'
          ),
        'recorded_satisfied', gate.satisfied,
        'updated_at', gate.updated_at,
        'approval_status', case
          when not gate.satisfied then 'not_satisfied'
          when package.id is null then 'missing'
          when package.expires_at <= statement_timestamp() then 'expired'
          when affiliate_private.partners_release_gate_approval_is_current(
            gate.gate_key
          ) then 'current'
          when affiliate_private.partners_release_gate_approval_is_current(
            gate.gate_key,
            'preproduction'
          ) then 'current_preproduction'
          else 'stale'
        end,
        'approval_provenance', case
          when package.id is null then null
          else jsonb_build_object(
            'package_version', package.package_version,
            'package_sha256', package.package_sha256,
            'program_version_key', package.program_version_key,
            'jurisdictions', (
              select jsonb_agg(
                jsonb_build_object(
                  'country_code', scope.item ->> 'country_code',
                  'subdivision_code', scope.item -> 'subdivision_code'
                )
                order by scope.item ->> 'country_code',
                  scope.item ->> 'subdivision_code'
              )
              from jsonb_array_elements(
                package.jurisdiction_scope
              ) scope(item)
            ),
            'document_keys', (
              select jsonb_agg(document.key order by document.key)
              from jsonb_each(package.document_hashes) document(key, value)
            ),
            'source_commit_sha', package.source_commit_sha,
            'deployment_environment', package.deployment_environment,
            'deployment_manifest_version', manifest.manifest_version,
            'deployment_manifest_sha256',
              package.deployment_manifest_sha256,
            'deployment_evidence_sha256',
              package.deployment_evidence_sha256,
            'approved_at', package.approved_at,
            'expires_at', package.expires_at
          )
        end
      )
      order by gate.gate_key
    ),
    '[]'::jsonb
  )
  into v_release_gates
  from affiliate_private.affiliate_release_gates gate
  left join
    affiliate_private.affiliate_release_gate_approval_bindings binding
    on binding.gate_key = gate.gate_key
  left join affiliate_private.affiliate_approval_packages package
    on package.id = binding.approval_package_id
  left join affiliate_private.affiliate_deployment_manifests manifest
    on manifest.id = package.deployment_manifest_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'deployment_environment', manifest.deployment_environment,
        'manifest_version', manifest.manifest_version,
        'manifest_sha256', manifest.manifest_sha256,
        'source_commit_sha', manifest.source_commit_sha,
        'deployment_key', manifest.deployment_key,
        'deployment_evidence_sha256',
          manifest.deployment_evidence_sha256,
        'document_keys', (
          select jsonb_agg(document.key order by document.key)
          from jsonb_each(manifest.document_hashes) document(key, value)
        ),
        'registered_at', manifest.registered_at
      )
      order by manifest.deployment_environment
    ),
    '[]'::jsonb
  )
  into v_deployment_manifests
  from affiliate_private.affiliate_deployment_manifest_bindings binding
  join affiliate_private.affiliate_deployment_manifests manifest
    on manifest.id = binding.deployment_manifest_id;

  return jsonb_set(
    jsonb_set(
      jsonb_set(v_base, '{schema_version}', '2'::jsonb, true),
      '{release_gates}',
      v_release_gates,
      true
    ),
    '{deployment_manifests}',
    v_deployment_manifests,
    true
  );
end;
$$;

create or replace function public.admin_partners_configuration()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_configuration();
$$;

-- Existing gate booleans deliberately remain recorded for audit continuity,
-- but they have no effective release authority without a matching package.

revoke all on function
  affiliate_private.valid_partners_approval_document_hashes(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.valid_partners_approval_jurisdiction_scope(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_approval_required_document_keys(text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_approval_package_sha256(
    text, integer, text, text, jsonb, jsonb, text, text, text, text,
    text, text, timestamptz, timestamptz, text
  ) from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_deployment_manifest_sha256(
    text, integer, text, text, text, jsonb, text, timestamptz, text
  ) from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_partners_deployment_manifest_insert()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.reject_partners_deployment_manifest_mutation()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_partners_deployment_manifest_binding()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_partners_approval_package_insert()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.reject_partners_approval_package_mutation()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_partners_approval_binding_mutation()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_program_approval_snapshot_sha256(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_country_policy_approval_snapshot_sha256(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_approval_package_is_current(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_approval_package_is_current(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_release_gate_approval_is_current(text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_release_gate_approval_is_current(text, text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_approval_gate_covers_policy(
    text, uuid, text, text
  ) from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_partners_release_gate_approval()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.clear_partners_release_gate_approval()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_partners_program_approved_scope()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_partners_country_policy_approved_scope()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_partners_pilot_allowlist_limit()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_assert_didit_certification_pre_gate()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_revolut_payout_status()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_revolut_payout_status_approval_registry()
  from public, anon, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_payout_status_approval_registry()
  to authenticated;
revoke all on function public.admin_partners_revolut_payout_status()
  from public, anon, service_role;
grant execute on function public.admin_partners_revolut_payout_status()
  to authenticated;
revoke all on function
  affiliate_private.admin_partners_configuration_pre_approval_registry_20260804()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_configuration()
  from public, anon, service_role;
grant execute on function
  affiliate_private.admin_partners_configuration()
  to authenticated;
revoke all on function public.admin_partners_configuration()
  from public, anon, service_role;
grant execute on function public.admin_partners_configuration()
  to authenticated;

revoke all on function
  affiliate_private.admin_partners_deployment_manifest_register(
    text, text, text, text, jsonb, text
  ) from public, anon, service_role;
grant execute on function
  affiliate_private.admin_partners_deployment_manifest_register(
    text, text, text, text, jsonb, text
  ) to authenticated;
revoke all on function public.admin_partners_deployment_manifest_register(
  text, text, text, text, jsonb, text
) from public, anon;
grant execute on function public.admin_partners_deployment_manifest_register(
  text, text, text, text, jsonb, text
) to authenticated;

revoke all on function
  affiliate_private.admin_partners_release_gate_approve(
    text, text, jsonb, jsonb, text, text, text, text,
    timestamptz, text
  ) from public, anon, service_role;
grant execute on function
  affiliate_private.admin_partners_release_gate_approve(
    text, text, jsonb, jsonb, text, text, text, text,
    timestamptz, text
  ) to authenticated;

revoke all on function public.admin_partners_release_gate_approve(
  text, text, jsonb, jsonb, text, text, text, text,
  timestamptz, text
) from public, anon;
grant execute on function public.admin_partners_release_gate_approve(
  text, text, jsonb, jsonb, text, text, text, text,
  timestamptz, text
) to authenticated;

comment on table affiliate_private.affiliate_approval_packages is
  'Append-only Partners release approvals, versioned per gate and scoped to one program, exact jurisdictions, evidence hashes, source commit and deployment proof.';
comment on table affiliate_private.affiliate_deployment_manifests is
  'Append-only deployment evidence manifests. The current environment binding is the authoritative commit and document boundary for Partners approvals.';
comment on function public.admin_partners_release_gate_approve(
  text, text, jsonb, jsonb, text, text, text, text,
  timestamptz, text
) is
  'Atomically records an immutable Partners approval package and activates or renews its gate after Admin capability, live AAL2, exact-scope and evidence-hash validation.';
