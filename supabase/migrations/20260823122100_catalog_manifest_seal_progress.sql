begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- A metadata flag on the new generation control table is the write fence for
-- a resumable manifest snapshot.  Catalog statement triggers CAS this flag;
-- an update that began before the fence either finishes first (and changes the
-- expected revision) or rolls its whole statement back after the fence wins.
alter table public.cloud_source_catalog_generations
  add column if not exists manifest_sealing boolean not null default false;

do $column_postcondition$
declare
  v_attribute pg_attribute%rowtype;
begin
  select attribute_state.* into v_attribute
  from pg_attribute attribute_state
  where attribute_state.attrelid =
      'public.cloud_source_catalog_generations'::regclass
    and attribute_state.attname = 'manifest_sealing'
    and not attribute_state.attisdropped;
  if not found
     or v_attribute.atttypid <> 'boolean'::regtype
     or v_attribute.atttypmod <> -1
     or not v_attribute.attnotnull
     or v_attribute.attgenerated <> ''
     or v_attribute.attidentity <> ''
     or pg_get_expr(
       (select default_state.adbin
        from pg_attrdef default_state
        where default_state.adrelid = v_attribute.attrelid
          and default_state.adnum = v_attribute.attnum),
       v_attribute.attrelid
     ) <> 'false' then
    raise exception 'catalog generation manifest fence column drift'
      using errcode = '55000';
  end if;
end
$column_postcondition$;

create table if not exists public.cloud_source_catalog_manifest_seal_progress (
  generation_id uuid primary key,
  user_id uuid not null,
  source_id uuid not null,
  seal_transition_id uuid not null,
  seal_role text not null check (seal_role in ('candidate','previous')),
  phase text not null default 'media_items' check (
    phase in (
      'media_items','title_variants','live_channels','live_variants',
      'episode_memberships','series_inventory','complete'
    )
  ),
  cursor_a text,
  cursor_b text,
  cursor_c text,
  cursor_id uuid,
  media_items_count bigint not null default 0 check (media_items_count >= 0),
  title_variants_count bigint not null default 0 check (title_variants_count >= 0),
  live_channels_count bigint not null default 0 check (live_channels_count >= 0),
  live_variants_count bigint not null default 0 check (live_variants_count >= 0),
  episode_memberships_count bigint not null default 0
    check (episode_memberships_count >= 0),
  series_inventory_count bigint not null default 0
    check (series_inventory_count >= 0),
  live_items_count bigint not null default 0 check (live_items_count >= 0),
  movie_items_count bigint not null default 0 check (movie_items_count >= 0),
  series_items_count bigint not null default 0 check (series_items_count >= 0),
  lane_sum_0 numeric not null default 0,
  lane_sum_1 numeric not null default 0,
  lane_sum_2 numeric not null default 0,
  lane_sum_3 numeric not null default 0,
  lane_xor_0 bigint not null default 0,
  lane_xor_1 bigint not null default 0,
  lane_xor_2 bigint not null default 0,
  lane_xor_3 bigint not null default 0,
  identity_sample jsonb not null default '[]'::jsonb check (
    jsonb_typeof(identity_sample) = 'array'
    and jsonb_array_length(identity_sample) <= 256
    and octet_length(identity_sample::text) <= 65536
  ),
  -- Private bounded raw sample used only while sealing.  Durable generation
  -- evidence keeps hashes and booleans, never provider external identifiers.
  strong_identity_sample text[] not null default '{}'::text[] check (
    cardinality(strong_identity_sample) <= 256
    and octet_length(strong_identity_sample::text) <= 65536
  ),
  snapshot_revision bigint not null check (snapshot_revision >= 0),
  processed_rows bigint not null default 0 check (processed_rows >= 0),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (seal_transition_id, seal_role),
  constraint cloud_source_manifest_progress_generation_owner_fk
    foreign key (user_id, generation_id)
    references public.cloud_source_catalog_generations(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_manifest_progress_generation_source_fk
    foreign key (source_id, generation_id)
    references public.cloud_source_catalog_generations(source_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_manifest_progress_transition_owner_fk
    foreign key (user_id, seal_transition_id)
    references public.cloud_source_transitions(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_manifest_progress_complete_ck check (
    (phase = 'complete') = (completed_at is not null)
  )
);

-- Rerunnable upgrade for databases that compiled an earlier draft of this
-- not-yet-published migration during local verification.
alter table public.cloud_source_catalog_manifest_seal_progress
  add column if not exists strong_identity_sample text[] not null
  default '{}'::text[] check (
    cardinality(strong_identity_sample) <= 256
    and octet_length(strong_identity_sample::text) <= 65536
  );

alter table public.cloud_source_catalog_manifest_seal_progress
  enable row level security;
revoke all on table public.cloud_source_catalog_manifest_seal_progress
from public, anon, authenticated, service_role;

do $table_postcondition$
begin
  if not exists (
       select 1 from pg_class class_state
       where class_state.oid =
         'public.cloud_source_catalog_manifest_seal_progress'::regclass
         and class_state.relkind = 'r'
         and class_state.relrowsecurity
     )
     or coalesce(has_table_privilege(
       'anon','public.cloud_source_catalog_manifest_seal_progress','SELECT'
     ), false)
     or coalesce(has_table_privilege(
       'authenticated','public.cloud_source_catalog_manifest_seal_progress','SELECT'
     ), false)
     or coalesce(has_table_privilege(
       'service_role','public.cloud_source_catalog_manifest_seal_progress','SELECT'
     ), false)
     or (select count(*) from information_schema.columns
         where table_schema = 'public'
           and table_name = 'cloud_source_catalog_manifest_seal_progress') <> 34
     or (select count(*) from pg_constraint
         where conrelid =
           'public.cloud_source_catalog_manifest_seal_progress'::regclass
           and contype in ('p','u','f','c')) <> 21 then
    raise exception 'catalog manifest seal progress schema or ACL drift'
      using errcode = '55000';
  end if;
end
$table_postcondition$;

commit;
