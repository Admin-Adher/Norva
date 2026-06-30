-- Phase 3c: candidate titles for the nightly AI-subtitle pre-generation (transcribe-whitelist).
-- Hot titles lacking an extractable TEXT subtitle: recently played (≤21d → priority 0) + new-release
-- films (priority 1), played-first. Applied live earlier via apply_migration; committed here so the
-- function is in version control (it was missing from the repo, an audit finding).
create or replace function public.whitelist_subtitle_candidates(p_user uuid, p_limit integer default 20)
returns table(title_id uuid, priority integer)
language sql
stable
as $function$
  with played as (
    select distinct v.title_id
    from public.cloud_playback_events e
    join public.cloud_title_variants v
      on v.source_id = e.source_id and v.external_id = e.item_id and v.item_type = e.item_type
    where e.user_id = p_user
      and e.event_type in ('play_started', 'first_frame')
      and e.created_at > now() - interval '21 days'
      and v.title_id is not null
  )
  select t.id as title_id,
         (case when p.title_id is not null then 0 else 1 end) as priority
  from public.cloud_titles t
  left join played p on p.title_id = t.id
  where t.user_id = p_user
    and t.default_variant_id is not null
    and not (coalesce(t.subtitle_tracks, '[]'::jsonb) @> '[{"extractable": true}]'::jsonb)
    and (
      p.title_id is not null
      or (
        t.item_type = 'movie'
        and t.release_year is not null
        and t.release_year >= (extract(year from now())::int - 1)
        and t.subtitle_probed_at is not null
      )
    )
  order by priority asc, t.updated_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$function$;

revoke all on function public.whitelist_subtitle_candidates(uuid, integer) from public;
grant execute on function public.whitelist_subtitle_candidates(uuid, integer) to service_role;
