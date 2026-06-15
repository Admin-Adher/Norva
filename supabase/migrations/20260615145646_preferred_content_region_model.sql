alter table public.cloud_profiles
  add column if not exists preferred_content_region text,
  add column if not exists preferred_content_region_confirmed_at timestamptz,
  add column if not exists content_region_taxonomy_version text not null default 'v1';

comment on column public.cloud_profiles.preferred_content_region is
  'User-confirmed catalog taxonomy key, e.g. FR, US, IN, MAGHREB, INTERNATIONAL. Weak signals such as IP or browser locale must not write this column.';

comment on column public.cloud_profiles.preferred_content_region_confirmed_at is
  'Timestamp of the explicit user confirmation for preferred_content_region.';

comment on column public.cloud_profiles.content_region_taxonomy_version is
  'Catalog region taxonomy version used to interpret preferred_content_region.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'cloud_profiles_preferred_content_region_format'
      and conrelid = 'public.cloud_profiles'::regclass
  ) then
    alter table public.cloud_profiles
      add constraint cloud_profiles_preferred_content_region_format
      check (
        preferred_content_region is null
        or preferred_content_region ~ '^[A-Z][A-Z0-9_]{1,31}$'
      );
  end if;
end $$;
