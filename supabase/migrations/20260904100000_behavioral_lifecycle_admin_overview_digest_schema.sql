-- Keep the admin overview executable with its deliberately empty search_path.
-- pgcrypto is installed in the `extensions` schema on self-hosted Norva, so an
-- unqualified digest() call is not resolvable from this SECURITY DEFINER RPC.

do $migration$
declare
  v_signature regprocedure := to_regprocedure(
    'public.admin_behavioral_lifecycle_overview(integer)'
  );
  v_definition text;
  v_fixed_definition text;
  v_target constant text := 'digest(x.actor_id::text, ''sha256'')';
  v_replacement constant text := 'extensions.digest(x.actor_id::text, ''sha256'')';
  v_occurrences integer;
begin
  if v_signature is null then
    raise exception 'behavioral lifecycle overview RPC is missing';
  end if;

  select pg_get_functiondef(v_signature)
  into v_definition;

  if position(v_replacement in v_definition) > 0 then
    return;
  end if;

  v_occurrences := (
    length(v_definition) - length(replace(v_definition, v_target, ''))
  ) / length(v_target);
  if v_occurrences <> 1 then
    raise exception 'behavioral lifecycle overview digest call drifted';
  end if;

  v_fixed_definition := replace(v_definition, v_target, v_replacement);
  execute v_fixed_definition;
end
$migration$;

revoke all on function public.admin_behavioral_lifecycle_overview(integer)
from public, anon, authenticated;
grant execute on function public.admin_behavioral_lifecycle_overview(integer)
to authenticated, service_role;

do $verification$
begin
  if position(
    'extensions.digest(x.actor_id::text, ''sha256'')'
    in pg_get_functiondef(
      'public.admin_behavioral_lifecycle_overview(integer)'::regprocedure
    )
  ) = 0 then
    raise exception 'behavioral lifecycle overview digest qualification failed';
  end if;
end
$verification$;

notify pgrst, 'reload schema';
