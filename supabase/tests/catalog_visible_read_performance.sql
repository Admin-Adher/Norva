begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.no_plan();

select extensions.ok(
  to_regprocedure(
    'public.search_media_items(uuid,text,text,integer,boolean)'
  ) is not null,
  'the exact fuzzy-search overload exists'
);

select extensions.ok(
  to_regprocedure(
    'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'
  ) is not null,
  'the exact media-grid overload exists'
);

select extensions.ok(
  to_regprocedure(
    'public.norva_visible_catalog_exceeds(uuid,text,integer)'
  ) is not null,
  'the bounded visible-catalog probe exists'
);

select extensions.ok(
  position(
    'visible_sources as materialized'
    in pg_get_functiondef(
      'public.search_media_items(uuid,text,text,integer,boolean)'::regprocedure
    )
  ) > 0
  and position(
    'cloud_catalog_visible_sources'
    in pg_get_functiondef(
      'public.search_media_items(uuid,text,text,integer,boolean)'::regprocedure
    )
  ) > 0
  and position(
    'cloud_source_catalog_heads'
    in pg_get_functiondef(
      'public.search_media_items(uuid,text,text,integer,boolean)'::regprocedure
    )
  ) > 0
  and position(
    'active_generation_id'
    in pg_get_functiondef(
      'public.search_media_items(uuid,text,text,integer,boolean)'::regprocedure
    )
  ) > 0
  and position(
    'cloud_catalog_visible_media_items'
    in pg_get_functiondef(
      'public.search_media_items(uuid,text,text,integer,boolean)'::regprocedure
    )
  ) = 0,
  'fuzzy search snapshots visible sources once and preserves the generation fence'
);

select extensions.ok(
  position(
    'visible_sources as materialized'
    in pg_get_functiondef(
      'public.norva_visible_catalog_exceeds(uuid,text,integer)'::regprocedure
    )
  ) > 0
  and position(
    'cloud_catalog_visible_sources'
    in pg_get_functiondef(
      'public.norva_visible_catalog_exceeds(uuid,text,integer)'::regprocedure
    )
  ) > 0
  and position(
    'cloud_source_catalog_heads'
    in pg_get_functiondef(
      'public.norva_visible_catalog_exceeds(uuid,text,integer)'::regprocedure
    )
  ) > 0
  and position(
    'active_generation_id'
    in pg_get_functiondef(
      'public.norva_visible_catalog_exceeds(uuid,text,integer)'::regprocedure
    )
  ) > 0
  and position(
    'cloud_catalog_visible_media_items'
    in pg_get_functiondef(
      'public.norva_visible_catalog_exceeds(uuid,text,integer)'::regprocedure
    )
  ) = 0,
  'the strategy probe snapshots visible sources once and preserves the generation fence'
);

select extensions.ok(
  position(
    'visible_sources as materialized'
    in pg_get_functiondef(
      'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'::regprocedure
    )
  ) > 0
  and position(
    'cloud_catalog_visible_sources'
    in pg_get_functiondef(
      'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'::regprocedure
    )
  ) > 0
  and position(
    'cloud_source_catalog_heads'
    in pg_get_functiondef(
      'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'::regprocedure
    )
  ) > 0
  and position(
    'active_generation_id'
    in pg_get_functiondef(
      'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'::regprocedure
    )
  ) > 0
  and position(
    'cloud_catalog_visible_media_items'
    in pg_get_functiondef(
      'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'::regprocedure
    )
  ) = 0,
  'the media grid snapshots visible sources once and preserves the generation fence'
);

select extensions.ok(
  pg_get_functiondef(
    'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'::regprocedure
  ) !~* '[.]is_dedup_primary'
  and position(
    'norva_visible_catalog_exceeds'
    in pg_get_functiondef(
      'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'::regprocedure
    )
  ) > 0,
  'the media grid keeps visible-sibling deduplication and bounded large-catalog routing'
);

select extensions.is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc routine
    where routine.oid in (
      'public.search_media_items(uuid,text,text,integer,boolean)'::regprocedure,
      'public.norva_visible_catalog_exceeds(uuid,text,integer)'::regprocedure,
      'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)'::regprocedure
    )
      and routine.provolatile = 's'
  ),
  3,
  'all three read routines remain STABLE'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.search_media_items(uuid,text,text,integer,boolean)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.norva_visible_catalog_exceeds(uuid,text,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)',
    'EXECUTE'
  ),
  'service_role can execute every optimized catalogue read routine'
);

select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.search_media_items(uuid,text,text,integer,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.search_media_items(uuid,text,text,integer,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.norva_visible_catalog_exceeds(uuid,text,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.norva_visible_catalog_exceeds(uuid,text,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)',
    'EXECUTE'
  ),
  'anon and authenticated cannot execute optimized service-only catalogue reads'
);

set local role service_role;

select extensions.is(
  public.list_media_items_deduped(
    '92800000-0000-4000-8000-000000000001'::uuid,
    'movie', null, null, null, null, null, null, null,
    'default', 120, 0
  ),
  '{"films": 0, "items": [], "total": null}'::jsonb,
  'an account without visible sources keeps the empty media-grid response contract'
);

select extensions.is(
  public.norva_visible_catalog_exceeds(
    '92800000-0000-4000-8000-000000000001'::uuid,
    'movie',
    60000
  ),
  false,
  'an account without visible sources does not enter the large-catalog path'
);

select extensions.is(
  (
    select count(*)::integer
    from public.search_media_items(
      '92800000-0000-4000-8000-000000000001'::uuid,
      'movie',
      'nothing',
      24,
      true
    )
  ),
  0,
  'an account without visible sources returns no fuzzy-search rows'
);

reset role;

select * from extensions.finish();
rollback;
