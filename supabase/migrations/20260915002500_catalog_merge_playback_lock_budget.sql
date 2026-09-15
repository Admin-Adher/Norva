begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Candidate discovery must not keep source row locks for an entire 50-group
-- transaction. Only an individual, time-bounded worker calls the existing
-- validated merge. Playback authorization and its row locks are unchanged.
create table public.norva_catalog_tmdb_merge_queue (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_type text not null check (item_type in ('movie','series')),
  provider_tmdb_id text not null check (provider_tmdb_id ~ '^[1-9][0-9]*$'),
  state text not null default 'pending' check (state in ('pending','retry','done')),
  next_attempt_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_sqlstate text,
  last_result text,
  updated_at timestamptz not null default now(),
  primary key (user_id,item_type,provider_tmdb_id)
);
create index norva_catalog_tmdb_merge_queue_due_idx
  on public.norva_catalog_tmdb_merge_queue(next_attempt_at,user_id,item_type,provider_tmdb_id)
  where state in ('pending','retry');
alter table public.norva_catalog_tmdb_merge_queue enable row level security;
revoke all on public.norva_catalog_tmdb_merge_queue from public,anon,authenticated,service_role;
grant all on public.norva_catalog_tmdb_merge_queue to postgres,supabase_admin;

create function public.norva_queue_validated_tmdb_merges(p_limit integer default 300)
returns integer language plpgsql security invoker set search_path=''
set max_parallel_workers_per_gather=0 as $function$
declare v_queued integer;
begin
  if not pg_try_advisory_xact_lock(4200043) then return 0; end if;
  -- Same eligibility rules as the validated reconciler, but no calls to the
  -- merger, source FOR SHARE/UPDATE, ratings, variants or visibility writers.
  with membership as materialized (
    select distinct v.user_id,v.title_id from public.cloud_catalog_visible_title_variants v
    where v.item_type in ('movie','series')
  ), groups as (
    select t.user_id,t.item_type,t.provider_tmdb_id
    from membership m join public.cloud_titles t on t.id=m.title_id and t.user_id=m.user_id
    where t.provider_tmdb_id ~ '^[1-9][0-9]*$' and t.item_type in ('movie','series')
    group by t.user_id,t.item_type,t.provider_tmdb_id
    having count(*)>1 and count(distinct t.release_year)<=1
      and bool_and(t.match_status='provider_verified' and coalesce(t.metadata#>>'{tmdbValidation,valid}','false')='true')
  ), candidates as (
    select g.* from groups g
    left join public.norva_catalog_tmdb_merge_queue q using(user_id,item_type,provider_tmdb_id)
    where q.user_id is null or q.state='done'
    order by q.updated_at nulls first,g.user_id,g.item_type,g.provider_tmdb_id
    limit greatest(1,least(coalesce(p_limit,300),300))
  ) insert into public.norva_catalog_tmdb_merge_queue as q
    (user_id,item_type,provider_tmdb_id)
    select user_id,item_type,provider_tmdb_id from candidates
    on conflict(user_id,item_type,provider_tmdb_id) do update set
      state='pending',next_attempt_at=now(),last_sqlstate=null,last_result=null,updated_at=now()
      where q.state='done';
  get diagnostics v_queued=row_count;
  return v_queued;
end
$function$;
revoke all on function public.norva_queue_validated_tmdb_merges(integer) from public,anon,authenticated,service_role;
grant execute on function public.norva_queue_validated_tmdb_merges(integer) to postgres,supabase_admin;

create function public.norva_process_one_tmdb_merge()
returns jsonb language plpgsql security invoker set search_path=''
set max_parallel_workers_per_gather=0 as $function$
declare
  v_job public.norva_catalog_tmdb_merge_queue%rowtype;
  v_result jsonb; v_state text; v_sqlstate text;
  v_budget interval:=current_setting('statement_timeout')::interval;
begin
  -- SET in a function does not arm PostgreSQL's statement timer. The caller
  -- must set it before SELECT; fail closed for unbounded/manual callers.
  if v_budget<=interval '0' or v_budget>interval '3 seconds' then
    raise exception 'catalogue merge requires an external statement budget of at most 3 seconds'
      using errcode='22023';
  end if;
  select q.* into v_job from public.norva_catalog_tmdb_merge_queue q
    where q.state in ('pending','retry') and q.next_attempt_at<=now()
    order by q.next_attempt_at,q.user_id,q.item_type,q.provider_tmdb_id
    limit 1 for update skip locked;
  if not found then return jsonb_build_object('state','idle'); end if;

  -- A timeout rolls back this entire savepoint and releases every SOURCE lock
  -- acquired by the merge. The outer queue row alone remains locked briefly
  -- while recording a retry, so one expensive group cannot starve the queue.
  begin
    v_result:=public.norva_merge_validated_tmdb_group(v_job.user_id,v_job.item_type,v_job.provider_tmdb_id);
    v_state:=v_result->>'state';
    v_sqlstate:=v_result->>'sqlstate';
  exception when query_canceled then
    v_state:='timeout'; v_sqlstate:='57014';
  when others then
    get stacked diagnostics v_sqlstate=returned_sqlstate;
    v_state:='retry';
  end;

  update public.norva_catalog_tmdb_merge_queue q set
    state=case when v_state in ('merged','noop','review') then 'done' else 'retry' end,
    attempts=q.attempts+1,
    next_attempt_at=case when v_state in ('merged','noop','review') then now()
      else now()+interval '5 minutes' end,
    last_sqlstate=v_sqlstate,
    last_result=case when v_state in ('merged','noop','review','retry','timeout') then v_state else 'retry' end,
    updated_at=now()
    where q.user_id=v_job.user_id and q.item_type=v_job.item_type and q.provider_tmdb_id=v_job.provider_tmdb_id;
  return jsonb_build_object('state',coalesce(v_state,'retry'),'sqlstate',v_sqlstate);
end
$function$;
revoke all on function public.norva_process_one_tmdb_merge() from public,anon,authenticated,service_role;
grant execute on function public.norva_process_one_tmdb_merge() to postgres,supabase_admin;

-- pg_cron 1.6 supports second intervals. Discovery is still ten-minute work,
-- but up to 60 separate short merges replace the old 50-group transaction.
select cron.schedule('norva-catalog-tmdb-merge','7-59/10 * * * *',
  $$set statement_timeout='90s'; select public.norva_queue_validated_tmdb_merges(300);$$);
select cron.schedule('norva-catalog-tmdb-merge-one','10 seconds',
  $$set statement_timeout='3s'; select public.norva_process_one_tmdb_merge();$$);
notify pgrst,'reload schema';
commit;
