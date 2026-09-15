-- Disposable DB only. The real migration is applied unchanged after this
-- minimal fixture; cron records commands without scheduling production work.
create schema auth;
create table auth.users(id uuid primary key);
insert into auth.users values ('00000000-0000-0000-0000-000000000001');
create schema cron;
create table cron.job(jobid serial primary key,jobname text unique,schedule text,command text);
create function cron.schedule(text,text,text) returns bigint language sql as $$
  insert into cron.job(jobname,schedule,command) values($1,$2,$3)
  on conflict(jobname) do update set schedule=$2,command=$3 returning jobid;
$$;
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
