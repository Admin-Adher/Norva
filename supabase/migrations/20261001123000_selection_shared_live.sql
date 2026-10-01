begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
create table public.selection_shared_live_channels (
 release_id uuid not null references public.selection_shared_releases(id) on delete cascade,
 logical_id text not null,payload jsonb not null,primary key(release_id,logical_id)
);
create table public.selection_shared_live_variants (
 release_id uuid not null references public.selection_shared_releases(id) on delete cascade,
 logical_id text not null,external_id text not null,payload jsonb not null,primary key(release_id,external_id),
 foreign key(release_id,logical_id) references public.selection_shared_live_channels(release_id,logical_id)
);
alter table public.selection_shared_live_channels enable row level security;
alter table public.selection_shared_live_variants enable row level security;
revoke all on public.selection_shared_live_channels,public.selection_shared_live_variants from public,anon,authenticated;
grant select on public.selection_shared_live_channels,public.selection_shared_live_variants to service_role;

create function public.norva_selection_shared_publish_guard() returns trigger language plpgsql set search_path='' as $f$
begin
 if old.published_at is not null then raise exception 'Published Selection releases are immutable' using errcode='PT409'; end if;
 if new.published_at is not null and (select count(*) from public.selection_shared_live_variants where release_id=new.id)
   <>coalesce((new.counts->>'live')::int,0) then raise exception 'Selection live projection incomplete' using errcode='PT409'; end if;
 return new;
end
$f$;
create trigger selection_shared_publish_guard before update on public.selection_shared_releases
for each row execute function public.norva_selection_shared_publish_guard();

create function public.norva_selection_shared_live_variant(p_value jsonb,p_source uuid,p_generation uuid)
returns jsonb language sql immutable set search_path='' as $f$
 select (p_value-'user_id'-'title_id'-'logical_channel_id')||jsonb_build_object(
  'id',public.norva_selection_shared_uuid('live-variant:'||p_source::text||':'||p_generation::text||':'||(p_value->>'external_id')),
  'source_id',p_source,'sourceId',p_source,
  'media_item_id',public.norva_selection_shared_uuid('media:'||p_source::text||':'||p_generation::text||':live:'||(p_value->>'external_id')),
  'mediaItemId',public.norva_selection_shared_uuid('media:'||p_source::text||':'||p_generation::text||':live:'||(p_value->>'external_id')))
$f$;

create function public.norva_seed_selection_shared_live(p_release_id uuid,p_channels jsonb,p_variants jsonb)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare expected integer; found_count integer;
begin
 perform public.norva_credential_require_service_role();
 perform 1 from public.selection_shared_releases where id=p_release_id and published_at is null for update;
 if not found then raise exception 'Unpublished release required' using errcode='PT409'; end if;
 if jsonb_typeof(p_channels) is distinct from 'array' or jsonb_typeof(p_variants) is distinct from 'array'
   or jsonb_array_length(p_channels)>500 or jsonb_array_length(p_variants)>1000 then
   raise exception 'Bounded public live projection required' using errcode='22023'; end if;
 select count(*) into expected from public.selection_shared_media where release_id=p_release_id and item_type='live';
 select count(distinct v->>'external_id') into found_count from jsonb_array_elements(p_variants) v
 join public.selection_shared_media m on m.release_id=p_release_id and m.item_type='live' and m.external_id=v->>'external_id'
   and m.playback_hint->>'targetUrl'=v->'playback_hint'->>'targetUrl';
 if found_count<>expected or found_count<>jsonb_array_length(p_variants) then
   raise exception 'Live projection does not match public manifest' using errcode='22023'; end if;
 insert into public.selection_shared_live_channels(release_id,logical_id,payload)
 select p_release_id,c->>'logical_id',c-'user_id'-'source_id'-'synced_at' from jsonb_array_elements(p_channels) c;
 insert into public.selection_shared_live_variants(release_id,logical_id,external_id,payload)
 select p_release_id,v->>'logical_id',v->>'external_id',v-'user_id'-'source_id'-'synced_at' from jsonb_array_elements(p_variants) v;
 return jsonb_build_object('channels',jsonb_array_length(p_channels),'variants',found_count);
end
$f$;

create or replace view public.cloud_catalog_visible_live_logical_channels with(security_invoker=true,security_barrier=true) as
WITH visible_sources AS MATERIALIZED (
         SELECT cloud_catalog_visible_sources.id,
            cloud_catalog_visible_sources.user_id
           FROM cloud_catalog_visible_sources
        )
 SELECT channel.id,
    channel.user_id,
    channel.source_id,
    channel.logical_id,
    channel.logical_key,
    channel.title,
    channel.lcn,
    channel.section,
    channel.category_id,
    channel.category_name,
    channel.poster_url,
    channel.stream_icon,
    channel.default_stream_id,
    channel.variant_count,
    channel.default_variant,
    channel.variant_preview,
    channel.playback_hint,
    channel.metadata,
    channel.synced_at,
    channel.created_at,
    channel.updated_at,
    channel.generation_id,
    channel.ingest_job_id,
    channel.ingest_attempt,
    channel.ingest_lease_owner,
    channel.write_head_revision,
    channel.write_config_revision,
    channel.write_source_visibility_epoch,
    channel.write_user_visibility_epoch,
    channel.projection_refresh_run_id
   FROM cloud_live_logical_channels channel
     JOIN visible_sources source ON source.id = channel.source_id AND source.user_id = channel.user_id
     LEFT JOIN cloud_source_catalog_heads head ON head.source_id = channel.source_id AND head.user_id = channel.user_id
  WHERE channel.generation_id IS NULL OR head.active_generation_id = channel.generation_id
union all select
 public.norva_selection_shared_uuid('live-channel:'||e.source_id::text||':'||e.generation_id::text||':'||g.logical_id) as id,
 e.user_id as user_id,
 e.source_id as source_id,
 t.logical_id as logical_id,
 t.logical_key as logical_key,
 t.title as title,
 t.lcn as lcn,
 t.section as section,
 t.category_id as category_id,
 t.category_name as category_name,
 t.poster_url as poster_url,
 t.stream_icon as stream_icon,
 t.default_stream_id as default_stream_id,
 t.variant_count as variant_count,
 public.norva_selection_shared_live_variant(t.default_variant,e.source_id,e.generation_id) as default_variant,
 (select coalesce(jsonb_agg(public.norva_selection_shared_live_variant(x,e.source_id,e.generation_id)),'[]') from jsonb_array_elements(t.variant_preview) x) as variant_preview,
 t.playback_hint as playback_hint,
 t.metadata as metadata,
 e.created_at as synced_at,
 e.created_at as created_at,
 r.published_at as updated_at,
 e.generation_id as generation_id,
 null::uuid as ingest_job_id,
 null::integer as ingest_attempt,
 null::text as ingest_lease_owner,
 null::bigint as write_head_revision,
 null::bigint as write_config_revision,
 null::bigint as write_source_visibility_epoch,
 null::bigint as write_user_visibility_epoch,
 null::uuid as projection_refresh_run_id
from public.selection_shared_visible_enrollments e
join public.selection_shared_releases r on r.id=e.release_id
join public.selection_shared_live_channels g on g.release_id=e.release_id
cross join lateral jsonb_populate_record(null::public.cloud_live_logical_channels,g.payload) t
where not exists(select 1 from public.cloud_live_logical_channels owned where owned.user_id=e.user_id and owned.source_id=e.source_id and owned.generation_id=e.generation_id and owned.logical_id=g.logical_id);
create or replace view public.cloud_catalog_visible_live_variants with(security_invoker=true,security_barrier=true) as
SELECT variant.id,
    variant.user_id,
    variant.source_id,
    variant.logical_channel_id,
    variant.logical_id,
    variant.media_item_id,
    variant.stream_id,
    variant.external_id,
    variant.label,
    variant.rank,
    variant.health_rank,
    variant.title,
    variant.raw_title,
    variant.category_id,
    variant.category_name,
    variant.poster_url,
    variant.stream_icon,
    variant.playback_hint,
    variant.metadata,
    variant.container_extension,
    variant.synced_at,
    variant.created_at,
    variant.updated_at,
    variant.generation_id,
    variant.ingest_job_id,
    variant.ingest_attempt,
    variant.ingest_lease_owner,
    variant.write_head_revision,
    variant.write_config_revision,
    variant.write_source_visibility_epoch,
    variant.write_user_visibility_epoch
   FROM cloud_live_variants variant
     JOIN cloud_catalog_visible_sources source ON source.id = variant.source_id AND source.user_id = variant.user_id
     LEFT JOIN cloud_source_catalog_heads head ON head.source_id = variant.source_id AND head.user_id = variant.user_id
  WHERE variant.generation_id IS NULL OR head.active_generation_id = variant.generation_id
union all select
 public.norva_selection_shared_uuid('live-variant:'||e.source_id::text||':'||e.generation_id::text||':'||g.external_id) as id,
 e.user_id as user_id,
 e.source_id as source_id,
 public.norva_selection_shared_uuid('live-channel:'||e.source_id::text||':'||e.generation_id::text||':'||g.logical_id) as logical_channel_id,
 t.logical_id as logical_id,
 public.norva_selection_shared_uuid('media:'||e.source_id::text||':'||e.generation_id::text||':live:'||g.external_id) as media_item_id,
 t.stream_id as stream_id,
 t.external_id as external_id,
 t.label as label,
 t.rank as rank,
 t.health_rank as health_rank,
 t.title as title,
 t.raw_title as raw_title,
 t.category_id as category_id,
 t.category_name as category_name,
 t.poster_url as poster_url,
 t.stream_icon as stream_icon,
 t.playback_hint as playback_hint,
 t.metadata as metadata,
 t.container_extension as container_extension,
 e.created_at as synced_at,
 e.created_at as created_at,
 r.published_at as updated_at,
 e.generation_id as generation_id,
 null::uuid as ingest_job_id,
 null::integer as ingest_attempt,
 null::text as ingest_lease_owner,
 null::bigint as write_head_revision,
 null::bigint as write_config_revision,
 null::bigint as write_source_visibility_epoch,
 null::bigint as write_user_visibility_epoch
from public.selection_shared_visible_enrollments e
join public.selection_shared_releases r on r.id=e.release_id
join public.selection_shared_live_variants g on g.release_id=e.release_id
cross join lateral jsonb_populate_record(null::public.cloud_live_variants,g.payload) t
where not exists(select 1 from public.cloud_live_variants owned where owned.user_id=e.user_id and owned.source_id=e.source_id and owned.generation_id=e.generation_id and owned.external_id=g.external_id);


revoke all on function public.norva_seed_selection_shared_live(uuid,jsonb,jsonb),
 public.norva_selection_shared_live_variant(jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.norva_seed_selection_shared_live(uuid,jsonb,jsonb),
 public.norva_selection_shared_live_variant(jsonb,uuid,uuid) to service_role;
commit;
