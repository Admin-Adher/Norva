begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
create table if not exists public.cloud_catalog_generation_backfill_sources (
  source_id uuid primary key,
  user_id uuid not null,
  stage text not null default 'cloud_media_items' check (stage in (
    'cloud_media_items','cloud_title_variants','cloud_live_logical_channels',
    'cloud_live_variants','catalog_series_episode_memberships',
    'catalog_series_inventory_state','complete'
  )),
  state text not null default 'pending' check (state in ('pending','processing','complete','failed')),
  active_generation_id uuid,
  lease_owner text check (lease_owner is null or (btrim(lease_owner)<>'' and length(lease_owner)<=160)),
  lease_token uuid,
  lease_until timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 1000000),
  rows_backfilled bigint not null default 0 check (rows_backfilled>=0),
  last_batch_rows integer not null default 0 check (last_batch_rows>=0),
  last_error_code text check (last_error_code is null or last_error_code in ('parent_generation_missing','source_owner_mismatch','operator_retry')),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint cloud_catalog_generation_backfill_lease_ck check (
    (state='processing' and lease_owner is not null and lease_token is not null and lease_until is not null)
    or (state<>'processing' and lease_owner is null and lease_token is null and lease_until is null)
  ),
  constraint cloud_catalog_generation_backfill_terminal_ck check (
    (state='complete' and stage='complete' and completed_at is not null)
    or (state<>'complete' and completed_at is null)
  )
);
create index if not exists cloud_catalog_generation_backfill_claim_idx
  on public.cloud_catalog_generation_backfill_sources(state,lease_until,updated_at,source_id);
alter table public.cloud_catalog_generation_backfill_sources enable row level security;
revoke all on table public.cloud_catalog_generation_backfill_sources from public,anon,authenticated,service_role;
grant select on table public.cloud_catalog_generation_backfill_sources to service_role;
do $postcondition$
declare
  v_columns jsonb;
  v_index oid := pg_catalog.to_regclass('public.cloud_catalog_generation_backfill_claim_idx');
begin
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name',attribute_state.attname,'type',pg_catalog.format_type(attribute_state.atttypid,attribute_state.atttypmod),
      'notNull',attribute_state.attnotnull,'default',pg_catalog.pg_get_expr(default_state.adbin,default_state.adrelid)
    ) order by attribute_state.attnum) into v_columns
  from pg_catalog.pg_attribute attribute_state
  left join pg_catalog.pg_attrdef default_state on default_state.adrelid=attribute_state.attrelid and default_state.adnum=attribute_state.attnum
  where attribute_state.attrelid='public.cloud_catalog_generation_backfill_sources'::regclass and attribute_state.attnum>0 and not attribute_state.attisdropped;
  if v_columns is distinct from '[
    {"name":"source_id","type":"uuid","notNull":true,"default":null},
    {"name":"user_id","type":"uuid","notNull":true,"default":null},
    {"name":"stage","type":"text","notNull":true,"default":"''cloud_media_items''::text"},
    {"name":"state","type":"text","notNull":true,"default":"''pending''::text"},
    {"name":"active_generation_id","type":"uuid","notNull":false,"default":null},
    {"name":"lease_owner","type":"text","notNull":false,"default":null},
    {"name":"lease_token","type":"uuid","notNull":false,"default":null},
    {"name":"lease_until","type":"timestamp with time zone","notNull":false,"default":null},
    {"name":"attempt_count","type":"integer","notNull":true,"default":"0"},
    {"name":"rows_backfilled","type":"bigint","notNull":true,"default":"0"},
    {"name":"last_batch_rows","type":"integer","notNull":true,"default":"0"},
    {"name":"last_error_code","type":"text","notNull":false,"default":null},
    {"name":"completed_at","type":"timestamp with time zone","notNull":false,"default":null},
    {"name":"created_at","type":"timestamp with time zone","notNull":true,"default":"clock_timestamp()"},
    {"name":"updated_at","type":"timestamp with time zone","notNull":true,"default":"clock_timestamp()"}
  ]'::jsonb
     or not coalesce((select relkind='r' and relrowsecurity from pg_catalog.pg_class where oid='public.cloud_catalog_generation_backfill_sources'::regclass),false)
     or not has_table_privilege('service_role','public.cloud_catalog_generation_backfill_sources','SELECT')
     or has_table_privilege('service_role','public.cloud_catalog_generation_backfill_sources','INSERT,UPDATE,DELETE') then
    raise exception 'catalog generation backfill queue structural drift' using errcode='55000';
  end if;
  if exists (
    select 1 from (values
      ('cloud_catalog_generation_backfill_sources_pkey'::name,'PRIMARY KEY (source_id)'::text),
      ('cloud_catalog_generation_backfill_sources_stage_check'::name,'CHECK ((stage = ANY (ARRAY[''cloud_media_items''::text, ''cloud_title_variants''::text, ''cloud_live_logical_channels''::text, ''cloud_live_variants''::text, ''catalog_series_episode_memberships''::text, ''catalog_series_inventory_state''::text, ''complete''::text])))'::text),
      ('cloud_catalog_generation_backfill_sources_state_check'::name,'CHECK ((state = ANY (ARRAY[''pending''::text, ''processing''::text, ''complete''::text, ''failed''::text])))'::text),
      ('cloud_catalog_generation_backfill_sources_lease_owner_check'::name,'CHECK (((lease_owner IS NULL) OR ((btrim(lease_owner) <> ''''::text) AND (length(lease_owner) <= 160))))'::text),
      ('cloud_catalog_generation_backfill_sources_attempt_count_check'::name,'CHECK (((attempt_count >= 0) AND (attempt_count <= 1000000)))'::text),
      ('cloud_catalog_generation_backfill_sources_rows_backfilled_check'::name,'CHECK ((rows_backfilled >= 0))'::text),
      ('cloud_catalog_generation_backfill_sources_last_batch_rows_check'::name,'CHECK ((last_batch_rows >= 0))'::text),
      ('cloud_catalog_generation_backfill_sources_last_error_code_check'::name,'CHECK (((last_error_code IS NULL) OR (last_error_code = ANY (ARRAY[''parent_generation_missing''::text, ''source_owner_mismatch''::text, ''operator_retry''::text]))))'::text),
      ('cloud_catalog_generation_backfill_lease_ck'::name,'CHECK ((((state = ''processing''::text) AND (lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_until IS NOT NULL)) OR ((state <> ''processing''::text) AND (lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_until IS NULL))))'::text),
      ('cloud_catalog_generation_backfill_terminal_ck'::name,'CHECK ((((state = ''complete''::text) AND (stage = ''complete''::text) AND (completed_at IS NOT NULL)) OR ((state <> ''complete''::text) AND (completed_at IS NULL))))'::text)
    ) expected(constraint_name,constraint_definition)
    left join pg_catalog.pg_constraint constraint_state on constraint_state.conrelid='public.cloud_catalog_generation_backfill_sources'::regclass and constraint_state.conname=expected.constraint_name
    where constraint_state.oid is null or pg_catalog.pg_get_constraintdef(constraint_state.oid,false) is distinct from expected.constraint_definition
  ) or exists (
    select 1 from pg_catalog.pg_constraint constraint_state
    where constraint_state.conrelid='public.cloud_catalog_generation_backfill_sources'::regclass
      and constraint_state.conname not in (
        'cloud_catalog_generation_backfill_sources_pkey','cloud_catalog_generation_backfill_sources_stage_check','cloud_catalog_generation_backfill_sources_state_check',
        'cloud_catalog_generation_backfill_sources_lease_owner_check','cloud_catalog_generation_backfill_sources_attempt_count_check',
        'cloud_catalog_generation_backfill_sources_rows_backfilled_check','cloud_catalog_generation_backfill_sources_last_batch_rows_check',
        'cloud_catalog_generation_backfill_sources_last_error_code_check','cloud_catalog_generation_backfill_lease_ck','cloud_catalog_generation_backfill_terminal_ck',
        'cloud_catalog_generation_backfill_source_owner_fk','cloud_catalog_generation_backfill_generation_fk'
      )
  ) then raise exception 'catalog generation backfill queue constraint drift' using errcode='55000'; end if;
  if v_index is null or not exists (
    select 1 from pg_catalog.pg_index index_state
    join pg_catalog.pg_class index_class on index_class.oid=index_state.indexrelid
    join pg_catalog.pg_am access_method on access_method.oid=index_class.relam
    where index_state.indexrelid=v_index and index_state.indrelid='public.cloud_catalog_generation_backfill_sources'::regclass
      and index_class.relkind='i' and access_method.amname='btree'
      and not index_state.indisunique and index_state.indislive and index_state.indisvalid and index_state.indisready
      and index_state.indnkeyatts=4 and index_state.indnatts=4 and index_state.indexprs is null and index_state.indpred is null
      and coalesce(pg_catalog.cardinality(index_class.reloptions),0)=0
      and not exists (
        select 1 from pg_catalog.unnest(array['state','lease_until','updated_at','source_id']::name[]) with ordinality expected(column_name,ordinal)
        left join pg_catalog.pg_attribute attribute_state on attribute_state.attrelid=index_state.indrelid and attribute_state.attname=expected.column_name and not attribute_state.attisdropped
        left join pg_catalog.pg_opclass operator_class on operator_class.oid=index_state.indclass[expected.ordinal-1]
        where attribute_state.attnum is null or index_state.indkey[expected.ordinal-1]<>attribute_state.attnum
          or index_state.indcollation[expected.ordinal-1]<>attribute_state.attcollation or index_state.indoption[expected.ordinal-1]<>0
          or operator_class.oid is null or not operator_class.opcdefault or operator_class.opcmethod<>index_class.relam
      )
  ) then raise exception 'catalog generation backfill claim index drift' using errcode='55000'; end if;
end
$postcondition$;
commit;
