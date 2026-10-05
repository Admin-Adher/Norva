begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Read only. A subtitle job reserves its provider account, not every provider
-- configured by its owner. Unknown potentially-related jobs still fail closed.
create function public.catalog_source_account_pregen_active(p_user_id uuid,p_source_id uuid)
returns boolean language plpgsql stable security definer set search_path='' set jit=off as $f$
declare
 target_affinity text; related_owners uuid[]; related_keys text[];
 job record; candidate record; seen integer:=0; candidate_seen integer; related_count integer;
 matched boolean; admitted_at timestamptz;
begin
 perform public.norva_credential_require_service_role();
 if p_user_id is null or p_source_id is null then return true; end if;
 select a.affinity_hash into target_affinity
 from public.cloud_catalog_visible_sources s
 join public.cloud_source_catalog_heads h on h.source_id=s.id and h.user_id=s.user_id
   and h.active_generation_id is not null
 join public.cloud_source_provider_account_affinities a on a.source_id=s.id and a.user_id=s.user_id
 where s.id=p_source_id and s.user_id=p_user_id;
 if target_affinity is null then return true; end if;

 -- Include aliases/owners already bound to this exact account. Do not invent
 -- cross-host equivalence from a provider name or a provider-wide identity.
 select array_agg(distinct a.user_id),array_agg(distinct k.value),count(distinct a.source_id)
 into related_owners,related_keys,related_count
 from (select source_id,user_id from public.cloud_source_provider_account_affinities
       where affinity_hash=target_affinity limit 129) a
 left join public.catalog_source_provider_identities i on i.source_id=a.source_id and i.user_id=a.user_id
 cross join lateral unnest(array['source:'||a.source_id::text,i.identity_id::text,i.provider_key]) k(value)
 ;
 if related_count>128 then return true; end if;
 related_owners:=array_append(coalesce(related_owners,'{}'::uuid[]),p_user_id);

 for job in
  select g.claimed_by,g.provider_key,g.requested_at,g.resolved_at,g.enqueued_at
  from public.catalog_generated_subtitles g
  where g.status='processing' and g.updated_at>statement_timestamp()-interval '2 hours'
    and (g.claimed_by=any(related_owners) or g.provider_key=any(related_keys))
  limit 129
 loop
  seen:=seen+1;
  if seen>128 or job.claimed_by is null or nullif(job.provider_key,'') is null then return true; end if;
  admitted_at:=least(job.requested_at,job.resolved_at,job.enqueued_at);
  if admitted_at is null then return true; end if;
  matched:=false; candidate_seen:=0;
  -- A provider key may resolve to several sources. Every candidate must be
  -- current and provably outside the target account before this gate can open.
  for candidate in
   select a.affinity_hash,a.updated_at affinity_updated_at,
     v.id visible_source,h.active_generation_id,i.verified_at identity_verified_at,
     ('source:'||s.id::text=job.provider_key) source_key
   from public.cloud_sources s
   left join public.catalog_source_provider_identities i on i.source_id=s.id and i.user_id=s.user_id
   left join public.cloud_source_provider_account_affinities a on a.source_id=s.id and a.user_id=s.user_id
   left join public.cloud_catalog_visible_sources v on v.id=s.id and v.user_id=s.user_id
   left join public.cloud_source_catalog_heads h on h.source_id=s.id and h.user_id=s.user_id
   where s.user_id=job.claimed_by and
    (job.provider_key='source:'||s.id::text or job.provider_key=i.identity_id::text or job.provider_key=i.provider_key)
   limit 129
  loop
   candidate_seen:=candidate_seen+1;
   if candidate_seen>128 then return true; end if;
   matched:=true;
   if candidate.affinity_hash is null or candidate.visible_source is null
     or candidate.active_generation_id is null
     or (not candidate.source_key and candidate.identity_verified_at is null)
     or candidate.affinity_updated_at is null or candidate.affinity_updated_at>admitted_at
     or candidate.affinity_hash=target_affinity then return true; end if;
  end loop;
  if not matched then return true; end if;
 end loop;
 return false;
end $f$;

revoke all on function public.catalog_source_account_pregen_active(uuid,uuid) from public,anon,authenticated;
grant execute on function public.catalog_source_account_pregen_active(uuid,uuid) to service_role;
comment on function public.catalog_source_account_pregen_active(uuid,uuid) is
 'Read-only bounded pregen account guard; unknown relevant mappings fail closed. Existing provider activity, leases, and source fences remain mandatory.';
notify pgrst,'reload schema';
commit;
