begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

insert into public.admin_feature_flags(key,enabled) values('language_exact_file_admission_enabled',false)
on conflict(key) do nothing;
create function public.catalog_language_exact_file_admission_enabled()
returns boolean language sql stable security definer set search_path='' as $f$
  select public.catalog_language_capture_pipeline_enabled() and public.catalog_language_metadata_lane_enabled()
    and exists(select 1 from public.admin_feature_flags where key='language_exact_file_admission_enabled' and enabled)
$f$;

-- Shared exact-file deduplication and mono-account exclusion are separate keys.
-- Never coalesce different credentials, relabel one account, or select another
-- account to bypass an existing circuit. All callers still revalidate access.
create table public.provider_exact_file_probe_leases (
  identity_key text not null check(length(identity_key) between 1 and 300),
  item_type text not null check(item_type in ('movie','episode')),
  external_id text not null check(length(external_id) between 1 and 300),
  provider_account_hash text not null check(provider_account_hash ~ '^[a-f0-9]{64}$'),
  lease_owner text not null check(length(lease_owner) between 1 and 200),
  expires_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key(identity_key,item_type,external_id),
  unique(provider_account_hash)
);
alter table public.provider_exact_file_probe_leases enable row level security;
alter table public.provider_exact_file_probe_leases force row level security;
revoke all on public.provider_exact_file_probe_leases from public,anon,authenticated,service_role;
grant select on public.provider_exact_file_probe_leases to service_role;
create index provider_exact_file_probe_identity_expiry_idx on public.provider_exact_file_probe_leases(identity_key,expires_at);

create function public.claim_provider_exact_file_probe(p_identity_key text,p_item_type text,p_external_id text,
  p_provider_account_hash text,p_lease_owner text,p_ttl_seconds integer default 150)
returns boolean language plpgsql volatile security definer set search_path='' as $f$
declare v_now timestamptz; v_expiry timestamptz; v_claimed boolean:=false;
begin
  perform public.norva_credential_require_service_role();
  if not public.catalog_language_exact_file_admission_enabled()
    or coalesce(length(btrim(p_identity_key)),0) not between 1 and 300
    or coalesce(length(btrim(p_external_id)),0) not between 1 and 300
    or p_item_type is null or p_item_type not in ('movie','episode')
    or coalesce(p_provider_account_hash,'') !~ '^[a-f0-9]{64}$'
    or coalesce(length(btrim(p_lease_owner)),0) not between 1 and 200 then return false; end if;
  -- Same lock order as foreground playback and capture handoff.
  perform pg_advisory_xact_lock(hashtextextended('provider-session:'||p_provider_account_hash,0));
  perform pg_advisory_xact_lock(hashtextextended('provider-file-admission:'||btrim(p_identity_key),0));
  v_now:=clock_timestamp();
  select expires_at into v_expiry from public.provider_account_language_validation_leases
    where provider_account_hash=p_provider_account_hash and lease_owner=p_lease_owner and expires_at>v_now;
  if not found then return false; end if;
  if exists(select 1 from public.cloud_playback_sessions where provider_account_hash=p_provider_account_hash
      and status in ('pending','ready') and expires_at>v_now)
    or exists(select 1 from public.provider_file_probe_leases where identity_key=btrim(p_identity_key) and expires_at>v_now)
    then return false; end if;
  -- Only stale rows conflicting with this exact file/account are reclaimable.
  delete from public.provider_exact_file_probe_leases where expires_at<=v_now
    and ((identity_key=btrim(p_identity_key) and item_type=p_item_type and external_id=btrim(p_external_id))
      or provider_account_hash=p_provider_account_hash);
  if exists(select 1 from public.provider_exact_file_probe_leases where expires_at>v_now and
      ((identity_key=btrim(p_identity_key) and item_type=p_item_type and external_id=btrim(p_external_id))
        or provider_account_hash=p_provider_account_hash)
      and (lease_owner<>p_lease_owner or provider_account_hash<>p_provider_account_hash
        or identity_key<>btrim(p_identity_key) or item_type<>p_item_type or external_id<>btrim(p_external_id))) then return false; end if;
  insert into public.provider_exact_file_probe_leases as lease(identity_key,item_type,external_id,provider_account_hash,lease_owner,expires_at)
    values(btrim(p_identity_key),p_item_type,btrim(p_external_id),p_provider_account_hash,p_lease_owner,
      least(v_expiry,v_now+make_interval(secs=>greatest(30,least(900,coalesce(p_ttl_seconds,150))))))
  on conflict(identity_key,item_type,external_id) do update set expires_at=excluded.expires_at,updated_at=v_now
    where lease.lease_owner=excluded.lease_owner and lease.provider_account_hash=excluded.provider_account_hash
  returning true into v_claimed;
  return coalesce(v_claimed,false);
end $f$;

create function public.release_provider_exact_file_probe(p_identity_key text,p_item_type text,p_external_id text,p_lease_owner text)
returns boolean language plpgsql volatile security definer set search_path='' as $f$
begin
  perform public.norva_credential_require_service_role();
  delete from public.provider_exact_file_probe_leases where identity_key=p_identity_key and item_type=p_item_type
    and external_id=p_external_id and lease_owner=p_lease_owner;
  return found;
end $f$;

-- Rolling deployments cannot let an older identity-wide crawler bypass the new
-- exact-file claims. Both sides serialize their admission under the same brief
-- transaction lock; it is NOT held across network I/O or model execution.
do $patch$
declare d text; old text; replacement text;
begin
  d:=pg_get_functiondef('public.claim_provider_file_probe(text,text,integer)'::regprocedure);
  old:=$old$  insert into public.provider_file_probe_leases as lease ($old$;
  if (length(d)-length(replace(d,old,'')))/length(old)<>1 then raise exception 'Legacy probe claim drifted'; end if;
  replacement:=$new$  perform pg_advisory_xact_lock(hashtextextended('provider-file-admission:'||btrim(p_identity_key),0));
  if exists(select 1 from public.provider_exact_file_probe_leases
    where identity_key=btrim(p_identity_key) and expires_at>clock_timestamp()) then return false; end if;

$new$||old;
  execute replace(d,old,replacement);

  d:=pg_get_functiondef('public.checkpoint_catalog_file_audio_capture(uuid,text,integer,integer,text,text,text,timestamptz,text,text,uuid)'::regprocedure);
  old:=$old$or not exists(select 1 from public.provider_file_probe_leases
        where identity_key=j.identity_key and lease_owner=p_provider_lease_owner and expires_at>v_now)$old$;
  if (length(d)-length(replace(d,old,'')))/length(old)<>1 then raise exception 'Capture lease handoff drifted'; end if;
  d:=replace(d,old,$new$or not (exists(select 1 from public.provider_file_probe_leases
        where identity_key=j.identity_key and lease_owner=p_provider_lease_owner and expires_at>v_now)
      or exists(select 1 from public.provider_exact_file_probe_leases where identity_key=j.identity_key
        and item_type=j.item_type and external_id=j.external_id and provider_account_hash=p_provider_account_hash
        and lease_owner=p_provider_lease_owner and expires_at>v_now))$new$);
  old:=$old$    delete from public.provider_file_probe_leases where identity_key=j.identity_key and lease_owner=p_provider_lease_owner;$old$;
  if (length(d)-length(replace(d,old,'')))/length(old)<>1 then raise exception 'Capture release handoff drifted'; end if;
  execute replace(d,old,old||E'\n'||$new$    delete from public.provider_exact_file_probe_leases where identity_key=j.identity_key
      and item_type=j.item_type and external_id=j.external_id and provider_account_hash=p_provider_account_hash
      and lease_owner=p_provider_lease_owner;$new$);

  -- The old dispatcher emitted only one source per shared provider identity.
  -- Expose one candidate per distinct source only in the new mode. This is a
  -- scheduling hint, never an account authorization: the real account lease
  -- rejects sources that happen to share credentials before any provider I/O.
  d:=pg_get_functiondef('public.list_due_catalog_file_audio_validation_jobs(integer)'::regprocedure);
  old:='partition by j.identity_key order by';
  if (length(d)-length(replace(d,old,'')))/length(old)<>1 then raise exception 'Due-file partition drifted'; end if;
  d:=replace(d,old,'partition by j.identity_key,(case when public.catalog_language_exact_file_admission_enabled() then j.source_id else null end) order by');
  old:='where active.identity_key=j.identity_key and active.state';
  if (length(d)-length(replace(d,old,'')))/length(old)<>1 then raise exception 'Due-file active-source guard drifted'; end if;
  execute replace(d,old,'where active.identity_key=j.identity_key and (not public.catalog_language_exact_file_admission_enabled() or active.source_id=j.source_id) and active.state');
end $patch$;

revoke all on function public.catalog_language_exact_file_admission_enabled(),
  public.claim_provider_exact_file_probe(text,text,text,text,text,integer),
  public.release_provider_exact_file_probe(text,text,text,text) from public,anon,authenticated;
grant execute on function public.catalog_language_exact_file_admission_enabled(),
  public.claim_provider_exact_file_probe(text,text,text,text,text,integer),
  public.release_provider_exact_file_probe(text,text,text,text) to service_role;
notify pgrst,'reload schema';
commit;
