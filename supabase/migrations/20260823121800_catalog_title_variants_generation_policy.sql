begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

drop policy if exists "cloud_title_variants_owner_select"
  on public.cloud_title_variants;
create policy "cloud_title_variants_owner_select"
on public.cloud_title_variants for select to authenticated
using (
  user_id = (select auth.uid())
  and public.norva_source_catalog_visible(source_id, user_id)
  and (
    generation_id is null
    or exists (
      select 1
      from public.cloud_source_catalog_heads head
      where head.source_id = cloud_title_variants.source_id
        and head.user_id = cloud_title_variants.user_id
        and head.active_generation_id = cloud_title_variants.generation_id
    )
  )
);

do $assert$
begin
  if not public.norva_provider_access_foundation_policy_is_exact(
    'public.cloud_title_variants',
    'cloud_title_variants_owner_select',
    'r',
    '6fb18d8e1523e102028fb85c6bdbf749980ec42b1558070600d83f572ddd7322',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  ) then
    raise exception 'cloud_title_variants generation policy drift'
      using errcode = '55000';
  end if;
end
$assert$;
commit;
