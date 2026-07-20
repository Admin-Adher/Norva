-- Final database guard for the LID canary.
--
-- A few historical probe rows contain both `lang` and `language`. One field can
-- be empty while the other already contains a real language. The cascade RPC
-- must never replace that known value, even if an older caller inspected only
-- the empty field.

begin;

create or replace function public.guard_lid_cascade_known_audio_tracks()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_old_track jsonb;
  v_new_track jsonb;
  v_stream_index integer;
  v_old_known text[];
  v_new_known text[];
begin
  if coalesce(new.audio_lang_verification->>'method', '') <> 'lid-cascade-v1' then
    return new;
  end if;

  for v_old_track in
    select track
    from jsonb_array_elements(
      case
        when jsonb_typeof(old.audio_tracks) = 'array' then old.audio_tracks
        else '[]'::jsonb
      end
    ) tracks(track)
  loop
    if coalesce(v_old_track->>'index', '') !~ '^[0-9]+$' then
      continue;
    end if;
    v_stream_index := (v_old_track->>'index')::integer;

    select coalesce(array_agg(distinct code order by code), '{}'::text[])
      into v_old_known
    from unnest(array[
      lower(nullif(btrim(v_old_track->>'lang'), '')),
      lower(nullif(btrim(v_old_track->>'language'), ''))
    ]) codes(code)
    where code ~ '^[a-z]{2,3}$'
      and code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar');

    if cardinality(v_old_known) = 0 then
      continue;
    end if;

    v_new_track := null;
    select track
      into v_new_track
    from jsonb_array_elements(
      case
        when jsonb_typeof(new.audio_tracks) = 'array' then new.audio_tracks
        else '[]'::jsonb
      end
    ) tracks(track)
    where coalesce(track->>'index', '') ~ '^[0-9]+$'
      and (track->>'index')::integer = v_stream_index
    limit 1;

    if v_new_track is null then
      raise exception 'LID cascade cannot remove a known audio track'
        using errcode = '55000';
    end if;

    select coalesce(array_agg(distinct code order by code), '{}'::text[])
      into v_new_known
    from unnest(array[
      lower(nullif(btrim(v_new_track->>'lang'), '')),
      lower(nullif(btrim(v_new_track->>'language'), ''))
    ]) codes(code)
    where code ~ '^[a-z]{2,3}$'
      and code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar');

    if not v_old_known <@ v_new_known then
      raise exception 'LID cascade cannot replace a known audio language'
        using errcode = '55000';
    end if;
  end loop;

  return new;
end
$function$;

revoke all on function public.guard_lid_cascade_known_audio_tracks()
  from public, anon, authenticated;

drop trigger if exists trg_guard_lid_cascade_known_audio_tracks
  on public.catalog_file_tracks;
create trigger trg_guard_lid_cascade_known_audio_tracks
before update of audio_tracks, audio_lang_verification
on public.catalog_file_tracks
for each row execute function public.guard_lid_cascade_known_audio_tracks();

commit;
