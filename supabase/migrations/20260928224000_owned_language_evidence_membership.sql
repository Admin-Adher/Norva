begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- The scoped evidence is materialized once, but a correlated CTE scan still
-- rechecks every episode for every candidate series. An uncorrelated IN set
-- permits a hashed subplan. v.id is the joined variant primary key (non-null).
-- Excluding null evidence IDs preserves NOT EXISTS semantics defensively.
do $migration$
declare definition text; pattern text; revised text;
begin
 definition:=pg_get_functiondef('public.cloud_catalog_owned_audio_declarations_scoped(uuid,uuid,text)'::regprocedure);
 pattern:='NOT \(EXISTS \( SELECT 1\s+FROM scoped_episode_evidence e\(title_id, variant_id, language\)\s+WHERE e.variant_id = v.id\)\)';
 if (select count(*) from regexp_matches(definition,pattern,'g'))<>1 then
   raise exception 'Scoped evidence exclusion drift';
 end if;
 revised:=regexp_replace(definition,pattern,
   'NOT (v.id IN (SELECT e.variant_id FROM scoped_episode_evidence e WHERE e.variant_id IS NOT NULL))');
 execute revised;
end $migration$;
-- All ownership, generation, declaration and exact-observation fences remain.
-- No feature flags or execution permissions change.
commit;
