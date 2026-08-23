begin;
set local lock_timeout='2s';
set local statement_timeout='15s';

create table if not exists public.cloud_source_provider_account_affinity_rollout (
  singleton boolean primary key default true check (singleton),
  phase text not null default 'pending'
    check (phase in ('pending','running','complete')),
  source_cursor uuid,
  inspected_sources bigint not null default 0 check (inspected_sources >= 0),
  affinity_rows_inserted bigint not null default 0 check (affinity_rows_inserted >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.cloud_source_provider_account_affinity_rollout(singleton)
values (true) on conflict (singleton) do nothing;
alter table public.cloud_source_provider_account_affinity_rollout enable row level security;
revoke all on table public.cloud_source_provider_account_affinity_rollout
  from public,anon,authenticated,service_role;
grant select on table public.cloud_source_provider_account_affinity_rollout
  to service_role;

-- Fence a concurrent OFF -> ON writer before publishing the stronger function
-- body.  If one is already in flight the bounded lock timeout aborts this unit
-- unchanged; after the lock, every future writer executes the affinity gate.
lock table public.admin_feature_flags in share row exclusive mode;

create or replace function public.norva_provider_access_feature_activation_guard()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_foundation_complete boolean;
  v_affinity_complete boolean;
  v_catalog_contracted boolean;
begin
  if new.key in (
       'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
       'provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled',
       'provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
     ) and new.enabled and (tg_op='INSERT' or not old.enabled) then
    select rollout.phase='complete' and rollout.completed_at is not null
      into v_foundation_complete
    from public.cloud_provider_access_foundation_rollout rollout
    where rollout.singleton;
    select rollout.phase='complete' and rollout.completed_at is not null
      into v_affinity_complete
    from public.cloud_source_provider_account_affinity_rollout rollout
    where rollout.singleton;
    if not coalesce(v_foundation_complete,false)
       or exists (
         select 1 from public.cloud_sources source
         left join public.cloud_source_lifecycle lifecycle
           on lifecycle.source_id=source.id and lifecycle.user_id=source.user_id
         left join public.cloud_source_provider_access access_state
           on access_state.source_id=source.id and access_state.user_id=source.user_id
         left join public.cloud_user_catalog_visibility_epochs epoch
           on epoch.user_id=source.user_id
         where lifecycle.source_id is null or access_state.source_id is null
            or epoch.user_id is null
       ) then
      raise exception 'provider access foundation backfill must be complete before activation'
        using errcode='55000',detail='reason=foundation_backfill_incomplete';
    end if;
    if not coalesce(v_affinity_complete,false)
       or exists (
         select 1 from public.provider_account_activity activity
         where activity.account_key !~ '^[0-9a-f]{64}$'
       )
       or not exists (
         select 1 from pg_catalog.pg_constraint constraint_state
         where constraint_state.conrelid='public.provider_account_activity'::regclass
           and constraint_state.conname='provider_account_activity_opaque_key_ck'
           and constraint_state.contype='c' and constraint_state.convalidated
       ) then
      raise exception 'provider account affinity rollout must be complete before activation'
        using errcode='55000',detail='reason=provider_account_affinity_backfill_incomplete';
    end if;
    if new.key in (
         'provider_credential_transition_v1_enabled',
         'provider_replacement_v1_enabled'
       ) then
      select rollout.phase='contracted' and rollout.contracted_at is not null
        into v_catalog_contracted
      from public.cloud_catalog_generation_rollout rollout
      where rollout.singleton;
      if not coalesce(v_catalog_contracted,false) then
        raise exception 'catalog generation rollout must be contracted before activation'
          using errcode='55000',detail='reason=catalog_generation_rollout_not_contracted';
      end if;
    end if;
  end if;
  return new;
end
$function$;

update public.admin_feature_flags
set enabled=false,updated_at=clock_timestamp(),
    updated_by='migration:provider_account_affinity_rollout_gate'
where key in (
  'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
  'provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled',
  'provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
);

do $postcondition$
declare
  v_columns jsonb;
  v_constraints text[];
begin
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name',attribute_state.attname,
      'type',pg_catalog.format_type(attribute_state.atttypid,attribute_state.atttypmod),
      'notNull',attribute_state.attnotnull,
      'default',pg_catalog.pg_get_expr(default_state.adbin,default_state.adrelid)
    ) order by attribute_state.attnum)
    into v_columns
  from pg_catalog.pg_attribute attribute_state
  left join pg_catalog.pg_attrdef default_state
    on default_state.adrelid=attribute_state.attrelid
   and default_state.adnum=attribute_state.attnum
  where attribute_state.attrelid='public.cloud_source_provider_account_affinity_rollout'::regclass
    and attribute_state.attnum>0 and not attribute_state.attisdropped;
  select pg_catalog.array_agg(pg_catalog.pg_get_constraintdef(constraint_state.oid,false)
      order by pg_catalog.pg_get_constraintdef(constraint_state.oid,false))
    into v_constraints
  from pg_catalog.pg_constraint constraint_state
  where constraint_state.conrelid='public.cloud_source_provider_account_affinity_rollout'::regclass;
  if v_columns is distinct from '[
      {"name":"singleton","type":"boolean","notNull":true,"default":"true"},
      {"name":"phase","type":"text","notNull":true,"default":"''pending''::text"},
      {"name":"source_cursor","type":"uuid","notNull":false,"default":null},
      {"name":"inspected_sources","type":"bigint","notNull":true,"default":"0"},
      {"name":"affinity_rows_inserted","type":"bigint","notNull":true,"default":"0"},
      {"name":"started_at","type":"timestamp with time zone","notNull":false,"default":null},
      {"name":"completed_at","type":"timestamp with time zone","notNull":false,"default":null},
      {"name":"updated_at","type":"timestamp with time zone","notNull":true,"default":"clock_timestamp()"}
    ]'::jsonb
     or v_constraints is distinct from array[
       'CHECK ((affinity_rows_inserted >= 0))',
       'CHECK ((inspected_sources >= 0))',
       'CHECK ((phase = ANY (ARRAY[''pending''::text, ''running''::text, ''complete''::text])))',
       'CHECK (singleton)',
       'PRIMARY KEY (singleton)'
     ]::text[]
     or not coalesce((select table_state.relkind='r' and table_state.relrowsecurity
       and not table_state.relforcerowsecurity
       from pg_catalog.pg_class table_state
       where table_state.oid='public.cloud_source_provider_account_affinity_rollout'::regclass),false)
     or not has_table_privilege('service_role','public.cloud_source_provider_account_affinity_rollout','SELECT')
     or has_table_privilege('service_role','public.cloud_source_provider_account_affinity_rollout','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('anon','public.cloud_source_provider_account_affinity_rollout','SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('authenticated','public.cloud_source_provider_account_affinity_rollout','SELECT,INSERT,UPDATE,DELETE')
     or (select count(*)<>6 or coalesce(bool_or(enabled),false)
         from public.admin_feature_flags where key in (
           'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
           'provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled',
           'provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
         ))
     or not public.norva_provider_access_foundation_trigger_is_exact(
       'public.admin_feature_flags','trg_provider_access_feature_activation_guard',
       'public.norva_provider_access_feature_activation_guard()'::regprocedure,23
     ) then
    raise exception 'provider account affinity rollout activation gate drift' using errcode='55000';
  end if;
end
$postcondition$;
commit;
