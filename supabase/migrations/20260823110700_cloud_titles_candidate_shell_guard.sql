begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

alter table public.cloud_titles
  add column if not exists candidate_shell_token uuid;

create or replace function public.norva_cloud_title_candidate_shell_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.candidate_shell_token is not null
       and nullif(
         current_setting('norva.catalog_candidate_title_write', true), ''
       ) is null then
      raise exception 'candidate title shell token requires a leased projection'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- Any UPDATE is an adoption/mutation proof, even if every business column is
  -- byte-identical or an updated_at trigger uses an older transaction now().
  -- Promotion also clears the token before materialising the terminal payload.
  if old.candidate_shell_token is not null then
    new.candidate_shell_token := null;
  elsif new.candidate_shell_token is not null then
    raise exception 'candidate title shell token cannot be installed by update'
      using errcode = '42501';
  end if;
  return new;
end
$function$;

revoke all on function public.norva_cloud_title_candidate_shell_guard()
from public, anon, authenticated, service_role;

create or replace trigger trg_cloud_titles_candidate_shell_guard
before insert or update on public.cloud_titles
for each row execute function public.norva_cloud_title_candidate_shell_guard();

do $assert$
begin
  if not exists (
    select 1
    from pg_attribute attribute
    where attribute.attrelid = 'public.cloud_titles'::regclass
      and attribute.attname = 'candidate_shell_token'
      and attribute.atttypid = 'uuid'::regtype
      and attribute.attnum > 0
      and not attribute.attisdropped
      and not attribute.attnotnull
      and not attribute.atthasdef
  ) or not exists (
    select 1
    from pg_trigger trigger
    where trigger.tgrelid = 'public.cloud_titles'::regclass
      and trigger.tgname = 'trg_cloud_titles_candidate_shell_guard'
      and not trigger.tgisinternal
      and trigger.tgenabled = 'O'
      and trigger.tgtype = 23
      and cardinality(trigger.tgattr::smallint[]) = 0
      and trigger.tgfoid =
        'public.norva_cloud_title_candidate_shell_guard()'::regprocedure
  ) then
    raise exception 'cloud_titles candidate shell guard drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
