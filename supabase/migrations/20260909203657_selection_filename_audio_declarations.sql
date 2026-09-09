begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- A supplier filename declaration participates in catalogue facets only.
-- It must never be persisted as an observed track or a verification result.
create or replace function public.selection_provider_audio_language(p_metadata jsonb, p_external_id text)
returns text language sql immutable security invoker set search_path = '' as $function$
  select case
    when p_metadata ->> 'discoveryFeed' = 'babuperumana-vod'
      and p_metadata ->> 'selectionVodGroup' ~ '^Movies / (Telugu|Tamil|Malayalam|Hindi|Kannada|English)( / (19|20)[0-9]{2})?$'
    then case split_part(p_metadata ->> 'selectionVodGroup', ' / ', 2)
      when 'Telugu' then 'te' when 'Tamil' then 'ta' when 'Malayalam' then 'ml'
      when 'Hindi' then 'hi' when 'Kannada' then 'kn' when 'English' then 'en' end
    when p_external_id ~ '^norva-selection:movie:[a-f0-9]{64}$'
      and p_metadata ->> 'discoveryFeed' in ('herbert-tested-vod','klysmgt-tested-vod','sandro-tested-vod')
      and p_metadata #> '{selectionFilenameAudio,version}' = '1'::jsonb
      and p_metadata #>> '{selectionFilenameAudio,language}' in
        ('es','pt','fr','en','de','it','nl','ja','ko','zh','ar','ru','tr','hi','te','ta','ml','kn','bn','fil','id')
      and p_metadata #>> '{selectionFilenameAudio,urlSha256}' ~ '^[a-f0-9]{64}$'
      and p_metadata #>> '{selectionFilenameAudio,urlSha256}' = p_metadata #>> '{selectionPlaybackValidation,urlSha256}'
    then p_metadata #>> '{selectionFilenameAudio,language}'
  end
  where p_external_id ~ '^norva-selection:(movie|series):[a-f0-9]{64}$'
    and p_metadata ->> 'selectionRevision' = 'selection-vod-20260906-v1'
$function$;
revoke all on function public.selection_provider_audio_language(jsonb, text) from public, anon, authenticated;
grant execute on function public.selection_provider_audio_language(jsonb, text) to service_role;

-- Audited immutable snapshot: exact file id, feed and URL hash. No media URL
-- is published in this migration. New imports derive the same field in code.
create temporary table selection_filename_audio_seed on commit drop as
select * from jsonb_to_recordset($seeds$[{"external_id":"norva-selection:movie:de14e6f0c1a9999fed8f61ca44cb88ef7e1238e85f22e4883e8738d8e625e461","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"f3a3afcbaa881e8b6e1cdd8d06c2b5d9ba44be0cdd95b4693e88ab543cbe1f99"},{"external_id":"norva-selection:movie:f571a56253f11ca998b2bc0e6ec096297841ec6af5ef943d0b5de85cdb4a18e8","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"93f16389c1f25d7a7ec099ca17d009f09ca5bba3a87c5b2cfa3fa29e1b6b4853"},{"external_id":"norva-selection:movie:885cff278b3a9db67e4d39dd2608a9e33c42dcb917569d14ce4c76c69db8f322","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"3cb156118971592b3f7a964fda3e27bd1b12955cb912cbc2a18b22cf4d92b8e1"},{"external_id":"norva-selection:movie:e540bab2d0d383c3a395dce4bb6293ad732ac52848fc9d6aa1d3f6f82674e14b","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"1c62a7453f84853f07468915e4f6d34091588623d3afffc8d922a5745a3a741c"},{"external_id":"norva-selection:movie:730b0ed3bf8a8f76df58dbfabdf08621fab38cda4ff012b86708232b7c2091ec","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"a1ac1d12a0a1a5f4fb0c218317b8caa8744b5a8c105d6e835a6bc10a5927c87e"},{"external_id":"norva-selection:movie:69326912e4e25d516b0b6c1c801e58fef4308490cd2872d0ae6cb3b5ed5f626b","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"fbfa62cc685e8ca6a2cbd42a95686cacb32c81cc5391d2d84eebe522a94f9c96"},{"external_id":"norva-selection:movie:a3f82da5983a477726af9a6e880f18b26d5710e3eea3c8db8e47be0929bee4cb","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"7fa3a2399fab2989dcffb7640635ef6c5a2862cb2eb7559219bd312b14eb9f80"},{"external_id":"norva-selection:movie:5445c3357e7b8b02922a809323687091515833433682792ec688837707543148","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"47e4c3836980c60ebfe91dae0b96c9b576d54c75b20b1747b138ffe3b0daa5b4"},{"external_id":"norva-selection:movie:cb5d73d0dad4641d00b87b24a667a7b0c50c51b955ed6374ecd4ccad49d910f8","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"022f0c3db027fa5977b76d1a3a23adaa3133ee96c032f0b2056a73d98f330924"},{"external_id":"norva-selection:movie:7952dee854ef53758245f6c62de59ff7978145e53f0cb29436a730d836185864","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"6c58d2adb8c7dd6fe5d021ad84a8f730102f2ef5bc7472707e2eebacd7cc8262"},{"external_id":"norva-selection:movie:5d2c6f929270178f14ed0eed7660073124b7dafa52b9da01a358d44c71a174b9","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"7913e8ff877fd8cfd8fa44ba2e75ce1e0b394e9cdbaf65238c0d98dbcdc702d1"},{"external_id":"norva-selection:movie:a4b28ddb51882b5e68526ddfe9668f7fd08cdedb9eeb8dfe13820ae5cbc63c79","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"e62bf1c8c349ffadda7e5ec30c7d2f483feced5a4de57bc4b52b0e2857bec3c7"},{"external_id":"norva-selection:movie:d11ff739c8011f7d4ee3d87dfeffd7d9539865716457346df22519fdeb62adeb","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"da0f6b18283b7f832a3004a9477a36696d30baa01feee5699e4e8c84b7556268"},{"external_id":"norva-selection:movie:8d0e6198afe3fb080f65026d14ca5e61f03ae4e3b3e0c3cdbad73ecc3adaae24","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"c13357c6a954da478a4bae5ba11fb6dc2a96f1be5e1ca1a36d303f356e33923d"},{"external_id":"norva-selection:movie:d045a09ef108b6232326d872e106f49a1b20ff7b26edc320c9818de7e43efa17","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"5bc0bb00e650a487cab81335169da1e01cf84e54e4692fd2105b1e437b4415db"},{"external_id":"norva-selection:movie:d81591bed61aa1766f72a42b8dcc80687817e061719354cd2a7755566f624346","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"863c9b977daadebe19b37221ec83a769c94f7329928a4e335993a85eff65234a"},{"external_id":"norva-selection:movie:9fcd4d6451f50857ce853913aef74ba3c197292313d80cc49d0ebf59f8aa8be4","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"9864a7042dabcf590b4de7a4dd1ae57d20bf791637cb6b64818b304439586d8c"},{"external_id":"norva-selection:movie:f67553b6fa07ab8a46e28ba40b1c4383fc1da276be853276e5369e1f48675058","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"9c28c1d02678e29aae0c303fe2ff7872b881a66f87e44af1dc74e44329181971"},{"external_id":"norva-selection:movie:c2daf9bf686f86f9ad1065c0221fd95364e4cad9621646e507161412501e2ef8","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"55fbf129afc2bf9baaf5fd51f8acfa4f35f25c02f02694c2a8eceaae2c2b3882"},{"external_id":"norva-selection:movie:50fc7f361d1dcb8c172dc33b1438b6d00941462f7ad00b05a0129fe7014dfd17","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"52dbd3ae6c93f7073e4de2eab1cb5997efbcd448ebf0b2ca56ed6e0ffd9e9450"},{"external_id":"norva-selection:movie:b82b4af99192ae6cba2134c82e7fdcb4900889e142eca9ec4f9adc47083a3757","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"00e5901647c36e700bec690564fde8708ad39c7eab4e852c0d54bef585ddc74d"},{"external_id":"norva-selection:movie:7311f252391132d9370c4c5979f1df9175be8960f368d12812add11f71703dab","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"3fdc89f699a5a724050d3d0315dfce26f7cf9ebe21c36692f530a8a7a5b3350c"},{"external_id":"norva-selection:movie:f263b61b9c13a4f624988d6289e0cfe97bf2155a916f904b087c8b4d4c0b6bbf","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"1787f05a0a94988c19432f5256200056ea7556f2f6dad0fcb9c76c0be5ac4e92"},{"external_id":"norva-selection:movie:30d7977480084d958a5e86f34a7cf7183fce0581e1b0f7d740a7de56ce900805","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"481ec02ee8efd1fac5603fa7964f878ea606f8ab8e171dbbd7c83e5d289aad56"},{"external_id":"norva-selection:movie:079200e6a93fa6a731f5888e54b3c4a7a0e25ad76548c3d50f1cea78e45b3c7d","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"d350e3714ee5d85b2de51a5a7d296cea7f10c89a3d07d2bcc4e368567fd49820"},{"external_id":"norva-selection:movie:cdaea7a81d4ffbad58cf2eee271fb2dadfe1abce05c12ad8daff4c41014a3499","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"87f6a2c65a905c18d76287423603d9769387f7882125bcc5b336f30834259670"},{"external_id":"norva-selection:movie:4d945c0c1051909d64e40f9cd7c20cc740a3afc182d3d0f3198b639744e43ea8","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"68ad02f340109096ec6d261e04dfaa08a6755cac0f3d92cc918aa39fb715a02f"},{"external_id":"norva-selection:movie:f7d0dfd6a6eaa06a56a47262696c16d65b69feb47bf9c5abd3e0cda5884b45d2","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"a4f66f90257d0a481d8cbdcad46d92c1687cd7cdb5ef3ef6ffc9319d2c6b91dc"},{"external_id":"norva-selection:movie:8d00d0bd8067e858c65c2a8ba5afa8b597e36b5b20b4c4ac0ab87e1e10029e63","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"01484f3aca48b2e0213279815bf35f47042017292642aae45df6793135875f60"},{"external_id":"norva-selection:movie:201b983342ec1850311ad3382018f4d9703b57b69e0b3e6a459240bbbc137bf6","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"71c17eed42ebc21b580549fa98c641cefe1f27bdb93831e12d6ba73025177542"},{"external_id":"norva-selection:movie:e62c5110a1d7a583111d91088bacf97eb914929ccfb5081b69d8f436bd649d69","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"5853ca13cf9379762afc57dc3d7ad4adef919a3b0f5f64fe13aa7bb0b7a3b65d"},{"external_id":"norva-selection:movie:c19d1156775c840432b0433b581fd7193a1aa34159462a64379c40eefa31e06f","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"1ecbf1a6685ecd3e491cb7359a65d10728bb277ff86cff669ee88a73bee39db9"},{"external_id":"norva-selection:movie:19360aa63c06c249e8b89ca77efba6f7ea60b99a2f8d52f5394e795f7022465b","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"112d7608d20d2994da63f5fb4a6737f17741c06f940a36421440878b0778fb73"},{"external_id":"norva-selection:movie:011451ff6bdbc6071eae86cef9d6ee33f5235507e2388f07aa979c51629cc628","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"04d1267c075039d09bf32d41ae1ffd825bcb356f9732d8ff81905d8b28a4729c"},{"external_id":"norva-selection:movie:2fe279360a34b0919357a799a5a58ffae328bfe86c2cd74f9360aff23920459e","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"42cfe2993f8b96163f5e2575723eddd2b6bf41b215d83d21bb6d2c14681e6088"},{"external_id":"norva-selection:movie:317ce283c8f2f47c3105e32c8a25ba919ec84f94adc27c1f09723874eb5e47cd","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"cd8379d0eacd01092ae01ebbe99be4770cc1b88d8c1753d2da9782d889d2564d"},{"external_id":"norva-selection:movie:356b0e1073c07766bf2198dc0807850a7ec9b2354e02fa7fdede421da22f1ede","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"90c9bffb292c4e1749f360f2bed72351458caf4f74daf34b1c2b1d15dcfdfd7e"},{"external_id":"norva-selection:movie:7a962cfe53e960cd662e74a10f965cdd60cbee4da71fac88ef09c4d20219ab51","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"75fdc5a1c048d6d73c3ec0a9d0cf8d073dae2e8c08df6b2efa55758f1c0a3a8f"},{"external_id":"norva-selection:movie:53f0efbb310a1a9d25895b80e957f32b5941ca026beb8028f3cf98b3e5bfc720","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"a9c732134d4bfb603edfb28f4081edf5ad5473473533301d8d88a2eb8ceeafc1"},{"external_id":"norva-selection:movie:ab0c45f3ea319c8ac4113c9048ff4bd01317a83c4ee558e5fc255d0bf1285f60","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"c5000f6d97490ccc174c28d1279d0ec629ef3fc03839a06b90c65756a93443f6"},{"external_id":"norva-selection:movie:682adb29d55a4e2c3faa9f859f3ea4ca02c1653f21cefe1cbb8a7f6862c11b58","feed_id":"klysmgt-tested-vod","version":1,"language":"es","urlSha256":"09ed299b275e7526d5c34b386fd4cdc181034c9607b937f6b32edd1300945c84"}]$seeds$::jsonb)
  as seed(external_id text,feed_id text,version integer,language text,"urlSha256" text);
create temporary table selection_filename_audio_changed_users(user_id uuid primary key) on commit drop;
-- Resolve visibility once, then update this bounded set by primary key. A
-- correlated visibility-view read for every variant is prohibitively costly.
create temporary table selection_filename_audio_candidates on commit drop as
select visible.id,visible.media_item_id,visible.user_id,visible.source_id,visible.generation_id
from public.cloud_catalog_visible_title_variants visible
join selection_filename_audio_seed seed on seed.external_id=visible.external_id
where visible.item_type='movie';
create unique index on selection_filename_audio_candidates(id);
create index on selection_filename_audio_candidates(media_item_id);
analyze selection_filename_audio_seed;
analyze selection_filename_audio_candidates;
-- Use the same generation and visibility proof as normal catalogue writers.
-- A concurrent removal/re-enrolment must never receive a stale declaration.
-- Temporary privileged routine: uses the existing guarded writer protocol,
-- without granting direct mutation rights on catalogue-head tables.
create function pg_temp.norva_backfill_filename_audio()
returns void language plpgsql security definer set search_path = '' as $backfill$
declare v_owner record; v_snapshot jsonb;
begin
  perform public.norva_credential_require_service_role();
  for v_owner in
    select distinct candidate.user_id,candidate.source_id
    from pg_temp.selection_filename_audio_candidates candidate
    order by candidate.user_id,candidate.source_id
  loop
    perform 1 from public.cloud_sources source where source.id=v_owner.source_id and source.user_id=v_owner.user_id for share;
    perform 1 from public.cloud_source_catalog_heads head
      join public.cloud_source_lifecycle lifecycle on lifecycle.user_id=head.user_id and lifecycle.source_id=head.source_id
      where head.source_id=v_owner.source_id and head.user_id=v_owner.user_id for share of head,lifecycle;
    perform 1 from public.cloud_user_catalog_visibility_epochs epoch where epoch.user_id=v_owner.user_id for share;
    v_snapshot:=public.norva_get_catalog_write_snapshot(v_owner.source_id,v_owner.user_id);
    if (v_snapshot->>'isCatalogVisible')::boolean is distinct from true then continue; end if;
    perform public.norva_set_catalog_delete_proof(v_owner.source_id,v_owner.user_id,
      (v_snapshot->>'generationId')::uuid,(v_snapshot->>'headRevision')::bigint,
      (v_snapshot->>'configRevision')::bigint,(v_snapshot->>'sourceVisibilityEpoch')::bigint,
      (v_snapshot->>'userVisibilityEpoch')::bigint);
with changed as (
  update public.cloud_media_items media
  set write_head_revision=(v_snapshot->>'headRevision')::bigint,
    write_config_revision=(v_snapshot->>'configRevision')::bigint,
    write_source_visibility_epoch=(v_snapshot->>'sourceVisibilityEpoch')::bigint,
    write_user_visibility_epoch=(v_snapshot->>'userVisibilityEpoch')::bigint,
    metadata = media.metadata || jsonb_build_object('selectionFilenameAudio',
    jsonb_build_object('version',1,'language',seed.language,'urlSha256',seed."urlSha256"))
  from pg_temp.selection_filename_audio_seed seed
  where media.user_id=v_owner.user_id and media.source_id=v_owner.source_id
    and media.generation_id=(v_snapshot->>'generationId')::uuid and media.external_id=seed.external_id and media.item_type='movie'
    and media.metadata->>'selectionRevision'='selection-vod-20260906-v1'
    and media.metadata->>'discoveryFeed'=seed.feed_id
    and media.metadata#>>'{selectionPlaybackValidation,urlSha256}'=seed."urlSha256"
    and encode(sha256(convert_to(media.playback_hint->>'targetUrl','UTF8')),'hex')=seed."urlSha256"
    and exists(select 1 from pg_temp.selection_filename_audio_candidates visible
      where visible.media_item_id=media.id and visible.user_id=media.user_id and visible.source_id=media.source_id)
    and media.metadata->'selectionFilenameAudio' is distinct from
      jsonb_build_object('version',1,'language',seed.language,'urlSha256',seed."urlSha256")
  returning media.user_id
)
insert into pg_temp.selection_filename_audio_changed_users select distinct user_id from changed on conflict do nothing;
with changed as (
  update public.cloud_title_variants variant
  set write_head_revision=(v_snapshot->>'headRevision')::bigint,
    write_config_revision=(v_snapshot->>'configRevision')::bigint,
    write_source_visibility_epoch=(v_snapshot->>'sourceVisibilityEpoch')::bigint,
    write_user_visibility_epoch=(v_snapshot->>'userVisibilityEpoch')::bigint,
    metadata = variant.metadata || jsonb_build_object('selectionFilenameAudio',media.metadata->'selectionFilenameAudio')
  from public.cloud_media_items media, pg_temp.selection_filename_audio_seed seed
  where variant.user_id=v_owner.user_id and variant.source_id=v_owner.source_id
    and variant.generation_id=(v_snapshot->>'generationId')::uuid and variant.media_item_id=media.id and variant.user_id=media.user_id and variant.source_id=media.source_id
    and variant.external_id=seed.external_id and variant.item_type='movie'
    and media.metadata->>'discoveryFeed'=seed.feed_id
    and public.selection_provider_audio_language(media.metadata,media.external_id)=seed.language
    and encode(sha256(convert_to(variant.playback_hint->>'targetUrl','UTF8')),'hex')=seed."urlSha256"
    and variant.metadata#>>'{selectionPlaybackValidation,urlSha256}'=seed."urlSha256"
    and exists(select 1 from pg_temp.selection_filename_audio_candidates visible where visible.id=variant.id)
    and variant.metadata->'selectionFilenameAudio' is distinct from media.metadata->'selectionFilenameAudio'
  returning variant.user_id
)
insert into pg_temp.selection_filename_audio_changed_users select distinct user_id from changed on conflict do nothing;

  end loop;
-- Invalidate filtered pagination and cached cards once per affected owner.
  perform public.norva_bump_user_catalog_visibility_epoch(user_id) from pg_temp.selection_filename_audio_changed_users;
end
$backfill$;
revoke all on function pg_temp.norva_backfill_filename_audio() from public,anon,authenticated;
grant execute on function pg_temp.norva_backfill_filename_audio() to service_role;
set local role service_role;
select pg_temp.norva_backfill_filename_audio();
reset role;
drop function pg_temp.norva_backfill_filename_audio();


notify pgrst, 'reload schema';
commit;
