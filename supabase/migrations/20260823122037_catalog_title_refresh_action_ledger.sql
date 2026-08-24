begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

create table if not exists public.cloud_source_catalog_title_refresh_actions (
  refresh_run_id uuid not null,
  action_kind text not null,
  job_id uuid not null,
  transition_id uuid not null,
  user_id uuid not null,
  source_id uuid not null,
  generation_id uuid not null,
  baseline_count bigint not null,
  checkpoint_revision bigint,
  content_sha256 text,
  catalog_version bigint,
  category_count bigint,
  observed_count bigint,
  active_row_count bigint,
  pruned_count bigint,
  inventory_complete boolean not null default false,
  prune_complete boolean not null default false,
  prune_safe boolean not null default false,
  state text not null default 'started',
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (refresh_run_id,action_kind),
  unique (job_id,action_kind),
  constraint cloud_source_title_refresh_actions_kind_ck check (
    action_kind in ('live','vod','series')
  ),
  constraint cloud_source_title_refresh_actions_baseline_count_ck check (
    baseline_count >= 0
  ),
  constraint cloud_source_title_refresh_actions_category_count_ck check (
    category_count is null or category_count >= 0
  ),
  constraint cloud_source_title_refresh_actions_observed_count_ck check (
    observed_count is null or observed_count >= 0
  ),
  constraint cloud_source_title_refresh_actions_active_count_ck check (
    active_row_count is null or active_row_count >= 0
  ),
  constraint cloud_source_title_refresh_actions_pruned_count_ck check (
    pruned_count is null or pruned_count >= 0
  ),
  constraint cloud_source_title_refresh_actions_state_ck check (
    state in ('started','pruning','complete')
  ),
  constraint cloud_source_title_refresh_actions_complete_ck check (
    (
      state = 'started' and catalog_version is null
      and checkpoint_revision is null and content_sha256 is null
      and category_count is null and observed_count is null
      and active_row_count is null and pruned_count is null
      and not inventory_complete and not prune_complete and not prune_safe
      and completed_at is null
    ) or (
      state = 'pruning' and catalog_version is not null
      and checkpoint_revision is not null and content_sha256 is not null
      and category_count is not null and observed_count is not null
      and active_row_count is null and pruned_count is not null
      and inventory_complete and not prune_complete and prune_safe
      and completed_at is null
    ) or (
      state = 'complete' and catalog_version is not null
      and checkpoint_revision is not null and content_sha256 is not null
      and category_count is not null and observed_count is not null
      and active_row_count is not null and pruned_count is not null
      and inventory_complete and prune_complete and prune_safe
      and completed_at is not null
    )
  ),
  constraint cloud_source_title_refresh_actions_catalog_version_ck check (
    catalog_version is null or catalog_version >= 0
  ),
  constraint cloud_source_title_refresh_actions_checkpoint_revision_ck check (
    checkpoint_revision is null or checkpoint_revision >= 1
  ),
  constraint cloud_source_title_refresh_actions_content_sha256_ck check (
    content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint cloud_source_title_refresh_actions_job_fk
    foreign key (job_id)
    references public.cloud_source_credential_transition_jobs(id)
    on update cascade on delete restrict,
  constraint cloud_source_title_refresh_actions_generation_fk
    foreign key (source_id,generation_id)
    references public.cloud_source_catalog_generations(source_id,id)
    on update cascade on delete restrict,
  constraint cloud_source_title_refresh_actions_generation_owner_fk
    foreign key (user_id,generation_id)
    references public.cloud_source_catalog_generations(user_id,id)
    on update cascade on delete restrict,
  constraint cloud_source_title_refresh_actions_generation_transition_fk
    foreign key (generation_id,transition_id)
    references public.cloud_source_catalog_generations(id,transition_id)
    on update cascade on delete restrict,
  constraint cloud_source_title_refresh_actions_transition_fk
    foreign key (user_id,transition_id)
    references public.cloud_source_transitions(user_id,id)
    on update cascade on delete restrict
);

-- Repair only the known pre-publication draft shape.  A same-named drifted
-- constraint is left in place and rejected by the exact postcondition below.
do $upgrade$
begin
  alter table public.cloud_source_catalog_title_refresh_actions
    add column if not exists baseline_count bigint not null default 0,
    add column if not exists checkpoint_revision bigint,
    add column if not exists content_sha256 text,
    add column if not exists category_count bigint,
    add column if not exists state text not null default 'started';
  alter table public.cloud_source_catalog_title_refresh_actions
    alter column baseline_count drop default,
    alter column catalog_version drop not null,
    alter column observed_count drop not null,
    alter column active_row_count drop not null,
    alter column pruned_count drop not null,
    alter column completed_at drop not null,
    alter column inventory_complete set default false,
    alter column prune_complete set default false,
    alter column prune_safe set default false;
  if (
    select attribute.atttypid <> 'bigint'::regtype
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid =
        'public.cloud_source_catalog_title_refresh_actions'::regclass
      and attribute.attname = 'catalog_version'
      and attribute.attnum > 0 and not attribute.attisdropped
  ) then
    alter table public.cloud_source_catalog_title_refresh_actions
      drop constraint if exists
        cloud_source_catalog_title_refresh_actions_catalog_version_check;
    alter table public.cloud_source_catalog_title_refresh_actions
      drop constraint if exists
        cloud_source_title_refresh_actions_catalog_version_ck;
    alter table public.cloud_source_catalog_title_refresh_actions
      alter column catalog_version type bigint
      using catalog_version::bigint;
  end if;

  alter table public.cloud_source_catalog_title_refresh_actions
    drop constraint if exists
      cloud_source_catalog_title_refresh_actions_action_kind_check,
    drop constraint if exists
      cloud_source_catalog_title_refresh_actions_observed_count_check,
    drop constraint if exists
      cloud_source_catalog_title_refresh_actions_active_row_count_check,
    drop constraint if exists
      cloud_source_catalog_title_refresh_actions_pruned_count_check,
    drop constraint if exists cloud_source_title_refresh_actions_complete_ck,
    drop constraint if exists cloud_source_title_refresh_actions_catalog_version_ck,
    drop constraint if exists cloud_source_title_refresh_actions_kind_ck,
    drop constraint if exists cloud_source_title_refresh_actions_baseline_count_ck,
    drop constraint if exists cloud_source_title_refresh_actions_category_count_ck,
    drop constraint if exists cloud_source_title_refresh_actions_observed_count_ck,
    drop constraint if exists cloud_source_title_refresh_actions_active_count_ck,
    drop constraint if exists cloud_source_title_refresh_actions_pruned_count_ck,
    drop constraint if exists cloud_source_title_refresh_actions_checkpoint_revision_ck,
    drop constraint if exists cloud_source_title_refresh_actions_content_sha256_ck,
    drop constraint if exists cloud_source_title_refresh_actions_state_ck;
  alter table public.cloud_source_catalog_title_refresh_actions
    add constraint cloud_source_title_refresh_actions_kind_ck
      check (action_kind in ('live','vod','series')),
    add constraint cloud_source_title_refresh_actions_baseline_count_ck
      check (baseline_count >= 0),
    add constraint cloud_source_title_refresh_actions_category_count_ck
      check (category_count is null or category_count >= 0),
    add constraint cloud_source_title_refresh_actions_observed_count_ck
      check (observed_count is null or observed_count >= 0),
    add constraint cloud_source_title_refresh_actions_active_count_ck
      check (active_row_count is null or active_row_count >= 0),
    add constraint cloud_source_title_refresh_actions_pruned_count_ck
      check (pruned_count is null or pruned_count >= 0),
    add constraint cloud_source_title_refresh_actions_state_ck
      check (state in ('started','pruning','complete')),
    add constraint cloud_source_title_refresh_actions_catalog_version_ck
      check (catalog_version is null or catalog_version >= 0),
    add constraint cloud_source_title_refresh_actions_checkpoint_revision_ck
      check (checkpoint_revision is null or checkpoint_revision >= 1),
    add constraint cloud_source_title_refresh_actions_content_sha256_ck
      check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
    add constraint cloud_source_title_refresh_actions_complete_ck check (
      (
        state = 'started' and catalog_version is null
        and checkpoint_revision is null and content_sha256 is null
        and category_count is null and observed_count is null
        and active_row_count is null and pruned_count is null
        and not inventory_complete and not prune_complete and not prune_safe
        and completed_at is null
      ) or (
        state = 'pruning' and catalog_version is not null
        and checkpoint_revision is not null and content_sha256 is not null
        and category_count is not null and observed_count is not null
        and active_row_count is null and pruned_count is not null
        and inventory_complete and not prune_complete and prune_safe
        and completed_at is null
      ) or (
        state = 'complete' and catalog_version is not null
        and checkpoint_revision is not null and content_sha256 is not null
        and category_count is not null and observed_count is not null
        and active_row_count is not null and pruned_count is not null
        and inventory_complete and prune_complete and prune_safe
        and completed_at is not null
      )
    );
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_state
    where constraint_state.conrelid =
        'public.cloud_source_catalog_title_refresh_actions'::regclass
      and constraint_state.conname =
        'cloud_source_title_refresh_actions_generation_owner_fk'
  ) then
    alter table public.cloud_source_catalog_title_refresh_actions
      add constraint cloud_source_title_refresh_actions_generation_owner_fk
      foreign key (user_id,generation_id)
      references public.cloud_source_catalog_generations(user_id,id)
      on update cascade on delete restrict;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_state
    where constraint_state.conrelid =
        'public.cloud_source_catalog_title_refresh_actions'::regclass
      and constraint_state.conname =
        'cloud_source_title_refresh_actions_generation_transition_fk'
  ) then
    alter table public.cloud_source_catalog_title_refresh_actions
      add constraint cloud_source_title_refresh_actions_generation_transition_fk
      foreign key (generation_id,transition_id)
      references public.cloud_source_catalog_generations(id,transition_id)
      on update cascade on delete restrict;
  end if;
end
$upgrade$;

alter table public.cloud_source_catalog_title_refresh_actions
  enable row level security;
revoke all on table public.cloud_source_catalog_title_refresh_actions
from public,anon,authenticated,service_role;

-- A post-switch refresh may span thousands of provider pages.  Keep its
-- resumable cursor separate from the build-candidate progress schema: the two
-- protocols have different leases and accepting one shape in the other would
-- make a rolling deployment fail open.  The row is private; callers only see
-- it through the exact-lease SECURITY DEFINER RPC installed by 22040.
create or replace function public.norva_active_catalog_refresh_checkpoint_safe(
  p_progress jsonb
) returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $function$
declare
  v_key text;
  v_value bigint;
begin
  if p_progress is null or jsonb_typeof(p_progress) <> 'object'
     or octet_length(p_progress::text) > 8192
     or not p_progress ?& array[
       'version','catalogVersion','action','actionComplete','cursor','spoolToken',
       'contentSha256','processedCategories','processedItems',
       'observedItems','categoryCount'
     ]
     or (select count(*) from jsonb_object_keys(p_progress)) <> 11
     or jsonb_typeof(p_progress -> 'version') <> 'number'
     or p_progress ->> 'version' <> '1'
     or jsonb_typeof(p_progress -> 'catalogVersion') <> 'number'
     or jsonb_typeof(p_progress -> 'action') <> 'string'
     or jsonb_typeof(p_progress -> 'actionComplete') <> 'boolean'
     or p_progress ->> 'action' not in (
       'live_categories','vod_categories','series_categories',
       'live_streams','vod_streams','series_streams','complete'
     )
     or jsonb_typeof(p_progress -> 'cursor') <> 'string'
     or jsonb_typeof(p_progress -> 'spoolToken') <> 'string'
     or jsonb_typeof(p_progress -> 'contentSha256') <> 'string'
     or p_progress ->> 'contentSha256' !~ '^(|[0-9a-f]{64})$'
     or length(p_progress ->> 'cursor') > 2048
     or length(p_progress ->> 'spoolToken') > 2048
     or concat_ws('',p_progress ->> 'cursor',p_progress ->> 'spoolToken')
          ~* '[[:cntrl:]]|://|@|password|username|access_token|api_key'
     or jsonb_typeof(p_progress -> 'processedCategories') <> 'number'
     or jsonb_typeof(p_progress -> 'processedItems') <> 'number'
     or jsonb_typeof(p_progress -> 'observedItems') <> 'number'
     or jsonb_typeof(p_progress -> 'categoryCount') <> 'number'
     or p_progress ->> 'catalogVersion' !~ '^[0-9]{1,19}$'
     or p_progress ->> 'processedCategories' !~ '^[0-9]{1,19}$'
     or p_progress ->> 'processedItems' !~ '^[0-9]{1,19}$'
     or p_progress ->> 'observedItems' !~ '^[0-9]{1,19}$'
     or p_progress ->> 'categoryCount' !~ '^[0-9]{1,19}$'
     or (
       (p_progress ->> 'actionComplete')::boolean
       and (
          p_progress ->> 'cursor' <> ''
          or (
            p_progress ->> 'action' <> 'complete'
            and p_progress ->> 'spoolToken' = ''
          )
       )
     )
     or (
       p_progress ->> 'action' = 'complete'
       and (
         not (p_progress ->> 'actionComplete')::boolean
         or p_progress ->> 'spoolToken' <> ''
       )
     )
     or (
       p_progress ->> 'contentSha256' = ''
       and (
         (p_progress ->> 'actionComplete')::boolean
         or p_progress ->> 'cursor' <> ''
         or p_progress ->> 'spoolToken' <> ''
         or (p_progress ->> 'processedCategories')::bigint <> 0
         or (p_progress ->> 'processedItems')::bigint <> 0
         or (p_progress ->> 'observedItems')::bigint <> 0
         or (p_progress ->> 'categoryCount')::bigint <> 0
       )
     ) then
    return false;
  end if;
  foreach v_key in array array[
    'catalogVersion','processedCategories','processedItems',
    'observedItems','categoryCount'
  ] loop
    v_value := (p_progress ->> v_key)::bigint;
    if v_value < 0 then return false; end if;
  end loop;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end
$function$;

revoke all on function public.norva_active_catalog_refresh_checkpoint_safe(jsonb)
from public,anon,authenticated,service_role;

create table if not exists
public.cloud_source_catalog_title_refresh_checkpoints (
  job_id uuid primary key,
  refresh_run_id uuid not null unique,
  transition_id uuid not null,
  user_id uuid not null,
  source_id uuid not null,
  generation_id uuid not null,
  checkpoint_revision bigint not null check (checkpoint_revision >= 0),
  head_revision bigint not null check (head_revision >= 0),
  config_revision bigint not null check (config_revision >= 0),
  source_visibility_epoch bigint not null check (source_visibility_epoch >= 1),
  user_visibility_epoch bigint not null check (user_visibility_epoch >= 1),
  progress jsonb not null check (
    public.norva_active_catalog_refresh_checkpoint_safe(progress)
  ),
  requeued_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint cloud_source_title_refresh_checkpoints_job_fk
    foreign key (job_id)
    references public.cloud_source_credential_transition_jobs(id)
    on update cascade on delete restrict,
  constraint cloud_source_title_refresh_checkpoints_generation_fk
    foreign key (source_id,generation_id)
    references public.cloud_source_catalog_generations(source_id,id)
    on update cascade on delete restrict,
  constraint cloud_source_title_refresh_checkpoints_generation_owner_fk
    foreign key (user_id,generation_id)
    references public.cloud_source_catalog_generations(user_id,id)
    on update cascade on delete restrict,
  constraint cloud_source_title_refresh_checkpoints_generation_transition_fk
    foreign key (generation_id,transition_id)
    references public.cloud_source_catalog_generations(id,transition_id)
    on update cascade on delete restrict,
  constraint cloud_source_title_refresh_checkpoints_transition_fk
    foreign key (user_id,transition_id)
    references public.cloud_source_transitions(user_id,id)
    on update cascade on delete restrict
);

alter table public.cloud_source_catalog_title_refresh_checkpoints
  enable row level security;
revoke all on table public.cloud_source_catalog_title_refresh_checkpoints
from public,anon,authenticated,service_role;

do $assert$
declare
  v_column_count integer;
  v_exact_columns integer;
  v_constraints text[];
begin
  select count(*)::integer into v_column_count
  from pg_catalog.pg_attribute attribute
  where attribute.attrelid =
      'public.cloud_source_catalog_title_refresh_actions'::regclass
    and attribute.attnum > 0 and not attribute.attisdropped;
  select count(*)::integer into v_exact_columns
  from (
    values
      ('refresh_run_id'::name,'uuid'::regtype,true,false),
      ('action_kind'::name,'text'::regtype,true,false),
      ('job_id'::name,'uuid'::regtype,true,false),
      ('transition_id'::name,'uuid'::regtype,true,false),
      ('user_id'::name,'uuid'::regtype,true,false),
      ('source_id'::name,'uuid'::regtype,true,false),
      ('generation_id'::name,'uuid'::regtype,true,false),
      ('baseline_count'::name,'bigint'::regtype,true,false),
      ('checkpoint_revision'::name,'bigint'::regtype,false,false),
      ('content_sha256'::name,'text'::regtype,false,false),
      ('catalog_version'::name,'bigint'::regtype,false,false),
      ('category_count'::name,'bigint'::regtype,false,false),
      ('observed_count'::name,'bigint'::regtype,false,false),
      ('active_row_count'::name,'bigint'::regtype,false,false),
      ('pruned_count'::name,'bigint'::regtype,false,false),
      ('inventory_complete'::name,'boolean'::regtype,true,true),
      ('prune_complete'::name,'boolean'::regtype,true,true),
      ('prune_safe'::name,'boolean'::regtype,true,true),
      ('state'::name,'text'::regtype,true,true),
      ('completed_at'::name,'timestamptz'::regtype,false,false),
      ('created_at'::name,'timestamptz'::regtype,true,true)
  ) expected(attname,atttypid,attnotnull,atthasdef)
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid =
      'public.cloud_source_catalog_title_refresh_actions'::regclass
   and attribute.attname = expected.attname
   and attribute.atttypid = expected.atttypid
   and attribute.attnotnull = expected.attnotnull
   and attribute.atthasdef = expected.atthasdef
   and attribute.attnum > 0 and not attribute.attisdropped;
  select array_agg(
    lower(regexp_replace(pg_catalog.pg_get_constraintdef(
      constraint_state.oid,true
    ),'\s+','','g')) order by constraint_state.conname
  ) into v_constraints
  from pg_catalog.pg_constraint constraint_state
  where constraint_state.conrelid =
    'public.cloud_source_catalog_title_refresh_actions'::regclass;
  if v_column_count <> 21 or v_exact_columns <> 21
     or cardinality(v_constraints) <> 18
     or not coalesce((
       select class.relkind = 'r' and class.relrowsecurity
       from pg_catalog.pg_class class
       where class.oid =
         'public.cloud_source_catalog_title_refresh_actions'::regclass
     ),false)
     or not v_constraints @> array[
       'primarykey(refresh_run_id,action_kind)',
       'unique(job_id,action_kind)',
       'check(action_kind=any(array[''live''::text,''vod''::text,''series''::text]))',
       'check(baseline_count>=0)',
       'check(category_countisnullorcategory_count>=0)',
       'check(observed_countisnullorobserved_count>=0)',
       'check(active_row_countisnulloractive_row_count>=0)',
       'check(pruned_countisnullorpruned_count>=0)',
       'check(catalog_versionisnullorcatalog_version>=0)',
       'check(state=any(array[''started''::text,''pruning''::text,''complete''::text]))',
       'check(checkpoint_revisionisnullorcheckpoint_revision>=1)',
       'check(content_sha256isnullorcontent_sha256~''^[0-9a-f]{64}$''::text)',
       'check(state=''started''::textandcatalog_versionisnullandcheckpoint_revisionisnullandcontent_sha256isnullandcategory_countisnullandobserved_countisnullandactive_row_countisnullandpruned_countisnullandnotinventory_completeandnotprune_completeandnotprune_safeandcompleted_atisnullorstate=''pruning''::textandcatalog_versionisnotnullandcheckpoint_revisionisnotnullandcontent_sha256isnotnullandcategory_countisnotnullandobserved_countisnotnullandactive_row_countisnullandpruned_countisnotnullandinventory_completeandnotprune_completeandprune_safeandcompleted_atisnullorstate=''complete''::textandcatalog_versionisnotnullandcheckpoint_revisionisnotnullandcontent_sha256isnotnullandcategory_countisnotnullandobserved_countisnotnullandactive_row_countisnotnullandpruned_countisnotnullandinventory_completeandprune_completeandprune_safeandcompleted_atisnotnull)',
       'foreignkey(job_id)referencescloud_source_credential_transition_jobs(id)onupdatecascadeondeleterestrict',
       'foreignkey(source_id,generation_id)referencescloud_source_catalog_generations(source_id,id)onupdatecascadeondeleterestrict',
       'foreignkey(user_id,generation_id)referencescloud_source_catalog_generations(user_id,id)onupdatecascadeondeleterestrict',
       'foreignkey(generation_id,transition_id)referencescloud_source_catalog_generations(id,transition_id)onupdatecascadeondeleterestrict',
       'foreignkey(user_id,transition_id)referencescloud_source_transitions(user_id,id)onupdatecascadeondeleterestrict'
     ]::text[]
     or has_table_privilege(
       'service_role','public.cloud_source_catalog_title_refresh_actions','SELECT'
     )
     or has_table_privilege(
       'authenticated','public.cloud_source_catalog_title_refresh_actions','SELECT'
     ) then
    raise exception 'catalog title refresh action ledger drift'
      using errcode = '55000';
  end if;
end
$assert$;

do $checkpoint_assert$
declare
  v_column_count integer;
  v_exact_columns integer;
  v_constraints text[];
begin
  select count(*)::integer into v_column_count
  from pg_catalog.pg_attribute attribute
  where attribute.attrelid =
      'public.cloud_source_catalog_title_refresh_checkpoints'::regclass
    and attribute.attnum > 0 and not attribute.attisdropped;
  select count(*)::integer into v_exact_columns
  from (
    values
      ('job_id'::name,'uuid'::regtype,true,false),
      ('refresh_run_id'::name,'uuid'::regtype,true,false),
      ('transition_id'::name,'uuid'::regtype,true,false),
      ('user_id'::name,'uuid'::regtype,true,false),
      ('source_id'::name,'uuid'::regtype,true,false),
      ('generation_id'::name,'uuid'::regtype,true,false),
      ('checkpoint_revision'::name,'bigint'::regtype,true,false),
      ('head_revision'::name,'bigint'::regtype,true,false),
      ('config_revision'::name,'bigint'::regtype,true,false),
      ('source_visibility_epoch'::name,'bigint'::regtype,true,false),
      ('user_visibility_epoch'::name,'bigint'::regtype,true,false),
      ('progress'::name,'jsonb'::regtype,true,false),
      ('requeued_at'::name,'timestamptz'::regtype,false,false),
      ('created_at'::name,'timestamptz'::regtype,true,true),
      ('updated_at'::name,'timestamptz'::regtype,true,true)
  ) expected(attname,atttypid,attnotnull,atthasdef)
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid =
      'public.cloud_source_catalog_title_refresh_checkpoints'::regclass
   and attribute.attname = expected.attname
   and attribute.atttypid = expected.atttypid
   and attribute.attnotnull = expected.attnotnull
   and attribute.atthasdef = expected.atthasdef
   and attribute.attnum > 0 and not attribute.attisdropped;
  select array_agg(
    lower(regexp_replace(pg_catalog.pg_get_constraintdef(
      constraint_state.oid,true
    ),'\s+','','g')) order by constraint_state.conname
  ) into v_constraints
  from pg_catalog.pg_constraint constraint_state
  where constraint_state.conrelid =
    'public.cloud_source_catalog_title_refresh_checkpoints'::regclass;
  if v_column_count <> 15 or v_exact_columns <> 15
     or cardinality(v_constraints) <> 13
     or not coalesce((
       select class.relkind = 'r' and class.relrowsecurity
       from pg_catalog.pg_class class
       where class.oid =
         'public.cloud_source_catalog_title_refresh_checkpoints'::regclass
     ),false)
     or not v_constraints @> array[
       'primarykey(job_id)',
       'unique(refresh_run_id)',
       'check(checkpoint_revision>=0)',
       'check(head_revision>=0)',
       'check(config_revision>=0)',
       'check(source_visibility_epoch>=1)',
       'check(user_visibility_epoch>=1)',
       'check(norva_active_catalog_refresh_checkpoint_safe(progress))',
       'foreignkey(job_id)referencescloud_source_credential_transition_jobs(id)onupdatecascadeondeleterestrict',
       'foreignkey(source_id,generation_id)referencescloud_source_catalog_generations(source_id,id)onupdatecascadeondeleterestrict',
       'foreignkey(user_id,generation_id)referencescloud_source_catalog_generations(user_id,id)onupdatecascadeondeleterestrict',
       'foreignkey(generation_id,transition_id)referencescloud_source_catalog_generations(id,transition_id)onupdatecascadeondeleterestrict',
       'foreignkey(user_id,transition_id)referencescloud_source_transitions(user_id,id)onupdatecascadeondeleterestrict'
     ]::text[]
     or has_table_privilege(
       'service_role',
       'public.cloud_source_catalog_title_refresh_checkpoints','SELECT'
     )
     or has_table_privilege(
       'authenticated',
       'public.cloud_source_catalog_title_refresh_checkpoints','SELECT'
     ) then
    raise exception 'catalog title refresh checkpoint drift'
      using errcode = '55000';
  end if;
end
$checkpoint_assert$;

commit;
