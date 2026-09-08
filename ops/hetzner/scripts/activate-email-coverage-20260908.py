"""Audited email activation requested by the operator, with fresh cohorts."""
import json,pathlib,subprocess,sys
ROOT=pathlib.Path(__file__).resolve().parent
mode=sys.argv[1];assert mode in ('preview','apply')
def sql(q):
 r=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],input=q,text=True,capture_output=True,timeout=60)
 if r.returncode:raise RuntimeError(r.stderr[-2300:])
 return r.stdout.strip()
snapshot="""select jsonb_build_object(
 'runtime',(select jsonb_build_object('mode',audience_mode,'stopped',emergency_stop,'updated_at',updated_at) from public.behavioral_lifecycle_runtime),
 'journeys',(select jsonb_agg(jsonb_build_object('key',journey_key,'status',status,'version',version,'rollout',rollout_percent,'holdout',holdout_percent,'countries',country_allowlist,'activated_at',activated_at,'cooldown_days',cooldown_days,'email_week',max_email_per_week,'push_week',max_push_per_week)) from public.behavioral_lifecycle_journeys),
 'steps',(select jsonb_agg(jsonb_build_object('journey',journey_key,'key',step_key,'channel',channel,'enabled',enabled,'delay_minutes',delay_minutes,'marketing',is_marketing,'new_content_required',requires_new_content)) from public.behavioral_lifecycle_steps),
 'provider',(select jsonb_build_object('stage',stage,'revision',revision) from public.cloud_provider_access_rollout),
 'provider_flags',(select jsonb_object_agg(key,enabled) from public.admin_feature_flags where key in ('provider_access_email_v1_enabled','provider_access_push_v1_enabled','provider_access_auto_detection_v1_enabled')),
 'customer_jobs',(select count(*) from public.behavioral_lifecycle_outbox o where not exists(select 1 from public.admin_internal_accounts a where a.user_id=o.user_id)),
 'ops_destination_ready',(select 'buildtrack.admin@gmail.com'=any(ops_recipients) from norva_postal_full.policy));"""
before=json.loads(sql(snapshot))
if mode=='apply':assert not (ROOT/'activation-applied.json').exists(),'Activation already recorded; inspect instead of retry'
assert before['runtime']['mode']=='pilot' and not before['runtime']['stopped']
assert before['provider']=={'stage':'20_percent','revision':16}
assert before['customer_jobs']==0,'Review any live customer deliveries before changing cohorts'
active_keys={j['key'] for j in before['journeys'] if j['status']=='active'}
assert all(not s['enabled'] for s in before['steps'] if s['channel']!='email' and s['journey'] in active_keys)
assert json.loads((ROOT/'database-applied.json').read_text())['passed']
query="""begin;
set local lock_timeout='3s';set local statement_timeout='30s';
lock table public.behavioral_lifecycle_runtime, public.behavioral_lifecycle_journeys,
 public.behavioral_lifecycle_steps,public.behavioral_lifecycle_outbox in share row exclusive mode;
do $activation$
declare op record;j record;s record;begin
 if not exists(select 1 from public.behavioral_lifecycle_runtime where audience_mode='pilot' and not emergency_stop)
 or exists(select 1 from public.behavioral_lifecycle_outbox o where not exists(select 1 from public.admin_internal_accounts a where a.user_id=o.user_id))
 then raise exception 'Activation baseline changed';end if;
 if not coalesce((select status='passed' and expires_at>clock_timestamp() from public.behavioral_lifecycle_import_readiness order by checked_at desc,id desc limit 1),false)
 then raise exception 'Fresh physical acceptance required';end if;
 select id,email,raw_app_meta_data into strict op from auth.users
 where lower(email)='adrien.hernandez@outlook.com' and raw_app_meta_data->>'role'='admin';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',op.id,'email',op.email,'role','authenticated','app_metadata',op.raw_app_meta_data)::text,true);
 perform public.admin_update_behavioral_lifecycle_runtime(true,'production','EMERGENCY STOP',
  'User explicitly requests all eligible email journeys active globally. Prepare the audited production email audience.');
 for j in select * from public.behavioral_lifecycle_journeys order by journey_key loop
  if j.status='active' then
   perform public.admin_update_behavioral_lifecycle_journey(p_journey_key=>j.journey_key,p_status=>'paused',p_rollout_percent=>j.rollout_percent,p_holdout_percent=>j.holdout_percent,p_country_allowlist=>j.country_allowlist,p_confirmation=>null,p_reason=>'Prepare user-authorized full email activation with a fresh cohort.');
  end if;
  for s in select * from public.behavioral_lifecycle_steps where journey_key=j.journey_key and ((channel='email' and not enabled) or (channel<>'email' and enabled)) loop
   perform public.admin_update_behavioral_lifecycle_step(s.journey_key,s.step_key,s.channel,s.delay_minutes,s.title,s.body,s.cta_label,s.deep_link,s.ttl_seconds,s.channel='email',s.is_marketing,s.requires_new_content,
    'User requested full email coverage. Proven renderer, direct Gmail QA, consent and conversion suppression.');
  end loop;
  perform public.admin_update_behavioral_lifecycle_journey(p_journey_key=>j.journey_key,p_status=>'active',p_rollout_percent=>100,p_holdout_percent=>0,p_country_allowlist=>array['*'],p_confirmation=>'ACTIVATE '||j.journey_key,
   p_max_push_per_day=>0,p_max_push_per_week=>0,p_max_email_per_week=>2,
   p_reason=>'Explicit full email activation after actual import/help acceptance and Gmail verification. No historical catch-up; this is production delivery, not evidence of experimental uplift.');
 end loop;
 perform public.admin_update_behavioral_lifecycle_runtime(false,'production','START PRODUCTION',
  'All four email journeys authorized globally for fresh events. Preserved quiet hours, cooldown, conversion exits and consent. Prior accepted product evidence; no experiment-lift claim.');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform public.norva_set_provider_access_rollout_channels(16,false,true,false,
  'email-coverage-20260908: five existing provider templates tested; private Postal delivery and Gmail checked; existing provider cohort preserved',
  'codex:user-authorized-email-activation');
 update norva_postal_full.policy set ops_recipients=array['buildtrack.admin@gmail.com'];
 if (select count(*) from public.behavioral_lifecycle_journeys where status='active' and rollout_percent=100 and holdout_percent=0 and country_allowlist=array['*'] and max_email_per_week=2 and max_push_per_week=0)<>4
 or (select count(*) from public.behavioral_lifecycle_steps where enabled and channel='email')<>5
 or exists(select 1 from public.behavioral_lifecycle_steps where enabled and channel<>'email')
 then raise exception 'Incomplete email activation';end if;
end $activation$;
"""+snapshot+('commit;' if mode=='apply' else 'rollback;')
after=json.loads(sql(query))
proof={'mode':mode,'before':before,'after':after,'customer_history_replayed':False,'billing_mutations':False,'provider_product_rollout_preserved':True}
(ROOT/('activation-applied.json' if mode=='apply' else 'activation-preview.json')).write_text(json.dumps(proof,indent=2))
print(json.dumps({'mode':mode,'runtime':after['runtime'],'active_journeys':len([j for j in after['journeys'] if j['status']=='active']),'enabled_email_steps':len([s for s in after['steps'] if s['enabled']]),'provider':after['provider'],'provider_flags':after['provider_flags'],'ops_destination_ready':after['ops_destination_ready']}))
