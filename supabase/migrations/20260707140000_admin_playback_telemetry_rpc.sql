-- Admin-wide playback telemetry RPC (the AdminPage "Télémétrie" panel).
--
-- The norva-playback /telemetry/summary endpoint is PER-USER (filters user_id =
-- caller). For sizing the media fleet the founder needs the GLOBAL picture. This
-- admin-gated RPC aggregates cloud_playback_events across ALL users into the mode /
-- surface / codec split + the media-cost-tier shares (docs §9.8/§10). Same admin-gate
-- + RPC pattern as admin_overview(). Read-only; bounded window.

create or replace function public.admin_playback_telemetry(p_days integer default 30)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  days  integer := greatest(1, least(coalesce(p_days, 30), 90));
  since timestamptz := now() - make_interval(days => days);
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return (
    with ev as (
      select
        coalesce(nullif(playback_mode, ''), 'unknown') as mode,
        coalesce(metadata->>'clientSurface', metadata->>'client_surface', metadata->>'surface', 'unknown') as surface,
        coalesce(metadata->>'container', metadata->>'videoCodec', metadata->>'video_codec', metadata->>'codec', 'unknown') as codec
      from public.cloud_playback_events
      where created_at > since
    )
    select jsonb_build_object(
      'window', jsonb_build_object('days', days, 'total_events', (select count(*) from ev)),
      'by_mode',    coalesce((select jsonb_object_agg(mode, n)    from (select mode, count(*) n    from ev group by 1) x), '{}'::jsonb),
      'by_surface', coalesce((select jsonb_object_agg(surface, n) from (select surface, count(*) n from ev group by 1) x), '{}'::jsonb),
      'by_codec',   coalesce((select jsonb_object_agg(codec, n)   from (select codec, count(*) n   from ev group by 1) x), '{}'::jsonb),
      -- Cost tiers over the 4 REAL playback modes (docs §9.8): transcode = Railway/GEX44
      -- FFmpeg (metered egress + CPU), engine = raw byte-pipe (metered egress, no CPU),
      -- relay = Cloudflare (cheap), direct = native (free). Session pseudo-modes excluded.
      'cost_shares', coalesce((
        select jsonb_build_object(
          'sample',    count(*),
          'transcode', round(count(*) filter (where mode = 'transcode')::numeric / nullif(count(*), 0), 3),
          'engine',    round(count(*) filter (where mode = 'engine')::numeric    / nullif(count(*), 0), 3),
          'relay',     round(count(*) filter (where mode = 'relay')::numeric      / nullif(count(*), 0), 3),
          'direct',    round(count(*) filter (where mode = 'direct')::numeric     / nullif(count(*), 0), 3),
          'metered',   round(count(*) filter (where mode in ('transcode','engine'))::numeric / nullif(count(*), 0), 3)
        )
        from ev where mode in ('direct', 'relay', 'engine', 'transcode')
      ), jsonb_build_object('sample', 0)),
      'surface_shares', coalesce((
        select jsonb_build_object(
          'sample',  count(*),
          'browser', round(count(*) filter (where surface in ('web','mobile-web','pwa'))::numeric / nullif(count(*), 0), 3),
          'native',  round(count(*) filter (where surface = 'android-tv')::numeric / nullif(count(*), 0), 3)
        )
        from ev where surface <> 'unknown'
      ), jsonb_build_object('sample', 0))
    )
  );
end;
$function$;

grant execute on function public.admin_playback_telemetry(integer) to authenticated;
