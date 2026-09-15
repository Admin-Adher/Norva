-- Disposable DB only. The real migration is applied unchanged after this
-- minimal fixture; cron records commands without scheduling production work.
create schema auth;
create table auth.users(id uuid primary key);
insert into auth.users values ('00000000-0000-0000-0000-000000000001');
create schema cron;
create table cron.job(jobid serial primary key,jobname text,schedule text,command text,
  username text not null default current_user,active boolean not null default true,unique(jobname,username));
create function cron.schedule(text,text,text) returns bigint language sql as $$
  insert into cron.job(jobname,schedule,command) values($1,$2,$3)
  on conflict(jobname,username) do update set schedule=$2,command=$3 returning jobid;
$$;
create function cron.alter_job(job_id bigint,schedule text default null,command text default null,
  database text default null,username text default null,active boolean default null)
returns void language sql as $$
  update cron.job set schedule=coalesce($2,cron.job.schedule),command=coalesce($3,cron.job.command),
    username=coalesce($5,cron.job.username),active=coalesce($6,cron.job.active) where jobid=$1;
$$;
insert into cron.job(jobname,schedule,command,username) values
 ('norva-catalog-tmdb-merge','7-59/10 * * * *','legacy canonicalization','supabase_admin');
create table public.cloud_sources(id integer primary key,value integer not null default 0);
insert into public.cloud_sources(id) values(1);
create table public.cloud_titles(id uuid primary key,user_id uuid,item_type text,
  provider_tmdb_id text,release_year integer,match_status text,metadata jsonb);
create table public.cloud_catalog_visible_title_variants(user_id uuid,title_id uuid,item_type text);
create function public.norva_merge_validated_tmdb_group(uuid,text,text) returns jsonb
language plpgsql as $$
begin
  perform 1 from public.cloud_sources where id=1 for share;
  if $3='90' then
    update public.cloud_sources set value=value+1 where id=1;
    perform pg_sleep(10);
  elsif $3='92' then
    raise exception 'fixture conflict' using errcode='PT409';
  elsif $3='93' then return jsonb_build_object('state','noop');
  elsif $3='94' then return jsonb_build_object('state','review');
  end if;
  return jsonb_build_object('state','merged');
end $$;
