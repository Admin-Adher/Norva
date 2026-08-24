begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

drop policy if exists "cloud_titles_owner_select" on public.cloud_titles;
create policy "cloud_titles_owner_select"
on public.cloud_titles for select to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.cloud_title_variants variant
    left join public.cloud_source_catalog_heads head
      on head.source_id = variant.source_id
     and head.user_id = variant.user_id
    where variant.title_id = cloud_titles.id
      and variant.user_id = cloud_titles.user_id
      and public.norva_source_catalog_visible(variant.source_id, variant.user_id)
      and (
        variant.generation_id is null
        or head.active_generation_id = variant.generation_id
      )
  )
);

do $assert$
begin
  if not public.norva_provider_access_foundation_policy_is_exact(
    'public.cloud_titles',
    'cloud_titles_owner_select',
    'r',
    '7fa98f6653a7a17970a9435b8179765b120d04fb2bf4155f1fc9e23271cc7110',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  ) then
    raise exception 'cloud_titles generation policy drift'
      using errcode = '55000';
  end if;
end
$assert$;
commit;
