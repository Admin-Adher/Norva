-- A progressively available catalogue is already usable, even while its
-- remaining titles/channels are materialized. Do not ask that owner to fix an
-- unresolved import when another enabled source already serves the catalogue.
-- This only suppresses reminders; it grants no catalogue or account access.
set lock_timeout = '3s';
set statement_timeout = '30s';

do $patch$
declare
  v_definition text;
  v_body text;
  v_anchor text := E'and coalesce(src.enabled, true) and src.sync_status = ''ready''\n          )\n          and (\n            s.import_issue_origin';
  v_replacement text := E'and coalesce(src.enabled, true)\n              and (\n                src.sync_status = ''ready''\n                or (\n                  src.sync_status = ''syncing''\n                  and src.sync_error is null\n                  and src.config_hint @> ''{"syncProgress":{"usable":true,"browseReady":true}}''::jsonb\n                )\n              )\n          )\n          and (\n            s.import_issue_origin';
begin
  select replace(pg_get_functiondef(p.oid), chr(13), ''),
    replace(p.prosrc, chr(13), '')
  into strict v_definition, v_body
  from pg_proc p
  where p.oid = 'public.norva_behavioral_state_relevant(uuid,text,timestamptz)'::regprocedure;
  if md5(v_body) <> 'a8b3029892b553d3f1331ade56e9cb36'
    or length(v_definition) - length(replace(v_definition, v_anchor, '')) <> length(v_anchor)
  then
    raise exception 'Unexpected import-reminder relevance baseline';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end;
$patch$;

-- A heartbeat for an existing source is not a new connection attempt. Keep
-- the failed attempt's format so its help link cannot silently change from
-- M3U to Xtream while an unrelated source is finishing in the background.
do $patch$
declare
  v_definition text;
  v_body text;
  v_anchor text := E'last_source_type = coalesce(\n          case when new.source_type in (''m3u'', ''xtream'') then new.source_type else null end,\n          public.behavioral_lifecycle_user_state.last_source_type\n        ),';
  v_replacement text := E'last_source_type = case\n          when public.behavioral_lifecycle_user_state.import_issue_started_at is not null\n            and not v_failure_transition and not v_import_success_transition\n          then public.behavioral_lifecycle_user_state.last_source_type\n          else coalesce(\n            case when new.source_type in (''m3u'', ''xtream'') then new.source_type else null end,\n            public.behavioral_lifecycle_user_state.last_source_type\n          )\n        end,';
begin
  select replace(pg_get_functiondef(p.oid), chr(13), ''),
    replace(p.prosrc, chr(13), '')
  into strict v_definition, v_body
  from pg_proc p
  where p.oid = 'public.norva_sync_behavioral_source_state()'::regprocedure;
  if md5(v_body) <> '9a5609cfe6d70cb4dbaf23680d95e3c4'
    or length(v_definition) - length(replace(v_definition, v_anchor, '')) <> length(v_anchor)
  then
    raise exception 'Unexpected import-context projection baseline';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end;
$patch$;
