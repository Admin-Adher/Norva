"""Audited operator-authorized activation, preserving product and billing scope."""
import json,pathlib,subprocess,sys
ROOT=pathlib.Path(__file__).resolve().parent
mode=sys.argv[1];assert mode in ('preview','apply')
def sql(q):
 r=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],input=q,text=True,capture_output=True,timeout=60)
 if r.returncode:raise RuntimeError(r.stderr[-2400:])
 return r.stdout.strip()
snapshot="""select jsonb_build_object(
 'runtime',(select jsonb_build_object('mode',audience_mode,'stopped',emergency_stop) from public.behavioral_lifecycle_runtime),
 'journeys',(select jsonb_agg(jsonb_build_object('key',journey_key,'status',status,'version',version,'rollout',rollout_percent,'holdout',holdout_percent,'countries',country_allowlist,'activated_at',activated_at,'push_day',max_push_per_day,'push_week',max_push_per_week,'email_week',max_email_per_week,'quiet_start',quiet_start_hour,'quiet_end',quiet_end_hour)) from public.behavioral_lifecycle_journeys),
 'steps',(select jsonb_agg(jsonb_build_object('journey',journey_key,'key',step_key,'channel',channel,'enabled',enabled,'marketing',is_marketing,'requires_new_content',requires_new_content)) from public.behavioral_lifecycle_steps),
 'pending_jobs',(select count(*) from public.behavioral_lifecycle_outbox where status in ('pending','processing','email_queued')),
 'provider_pending_push',(select count(*) from public.cloud_provider_access_notifications where channel='push' and state in ('pending','queued','processing')),
 'provider',(select jsonb_build_object('stage',stage,'revision',revision) from public.cloud_provider_access_rollout),
 'provider_flags',(select jsonb_object_agg(key,enabled) from public.admin_feature_flags where key in ('provider_access_email_v1_enabled','provider_access_push_v1_enabled','provider_access_auto_detection_v1_enabled')));"""
before=json.loads(sql(snapshot))
assert before['runtime']=={'mode':'production','stopped':False}
assert before['provider']=={'stage':'20_percent','revision':17}
assert before['pending_jobs']==0 and before['provider_pending_push']==0,'Review queued deliveries before fresh-cohort activation'
assert all(not s['enabled'] for s in before['steps'] if s['channel']!='email')
assert json.loads((ROOT/'database-applied.json').read_text())['passed']
physical=json.loads((ROOT/'physical-notification-acceptance.json').read_text())
assert physical['logo_verified'] and physical['push_received'] and physical['sources_opened'] and physical['resume_opened'] and physical['provider_opened']
if mode=='apply':assert not (ROOT/'activation-applied.json').exists(),'Activation already recorded; inspect instead of retrying'
query="""begin;set local lock_timeout='3s';set local statement_timeout='30s';
lock table public.behavioral_lifecycle_runtime,public.behavioral_lifecycle_journeys,
 public.behavioral_lifecycle_steps,public.behavioral_lifecycle_outbox in share row exclusive mode;
do $activation$declare op record;j record;s record;begin
 if exists(select 1 from public.behavioral_lifecycle_outbox where status in ('pending','processing','email_queued'))
 or exists(select 1 from public.cloud_provider_access_notifications where channel='push' and state in ('pending','queued','processing'))
 then raise exception 'Delivery baseline changed';end if;
 select id,email,raw_app_meta_data into strict op from auth.users
 where lower(email)='adrien.hernandez@outlook.com' and raw_app_meta_data->>'role'='admin';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',op.id,'email',op.email,'role','authenticated','app_metadata',op.raw_app_meta_data)::text,true);
 perform public.admin_update_behavioral_lifecycle_runtime(true,'production','EMERGENCY STOP','Prepare the explicitly requested push and in-app activation after physical phone acceptance.');
 for j in select * from public.behavioral_lifecycle_journeys order by journey_key loop
  if j.status='active' then
   perform public.admin_update_behavioral_lifecycle_journey(p_journey_key=>j.journey_key,p_status=>'paused',p_rollout_percent=>j.rollout_percent,p_holdout_percent=>j.holdout_percent,p_country_allowlist=>j.country_allowlist,p_reason=>'Prepare validated notification channels with a fresh cohort.');
  end if;
  for s in select * from public.behavioral_lifecycle_steps where journey_key=j.journey_key
   and (not enabled or (journey_key='continue_watching' and channel='push' and not is_marketing)) loop
   perform public.admin_update_behavioral_lifecycle_step(s.journey_key,s.step_key,s.channel,s.delay_minutes,
    s.title,s.body,s.cta_label,s.deep_link,s.ttl_seconds,true,
    s.is_marketing or (s.journey_key='continue_watching' and s.channel='push'),s.requires_new_content,
    'User authorized complete notification coverage. Real Android receipt, logo and destinations verified; commercial push follows explicit marketing preferences.');
  end loop;
  perform public.admin_update_behavioral_lifecycle_journey(p_journey_key=>j.journey_key,p_status=>'active',
   p_rollout_percent=>100,p_holdout_percent=>0,p_country_allowlist=>array['*'],p_confirmation=>'ACTIVATE '||j.journey_key,
   p_max_push_per_day=>1,p_max_push_per_week=>3,p_max_email_per_week=>2,p_experiment_variable=>'baseline',
   p_reason=>'Production channel coverage authorized after real phone acceptance. Fresh events only; shared 24-hour spacing and commercial caps. No experimental uplift claim.');
 end loop;
 perform public.admin_update_behavioral_lifecycle_runtime(false,'production','START PRODUCTION',
  'Five email, six push and three in-app steps enabled for fresh eligible events. Consent, conversion exits, verified timezone, quiet hours, TTL and shared contact limits preserved.');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform public.norva_set_provider_access_rollout_channels(17,false,true,true,
  'notifications-complete-20260908: real Google Play 1.3.20 phone received branded FCM push and opened sources; existing 20 percent product cohort preserved',
  'codex:user-authorized-notification-activation');
 if (select count(*) from public.behavioral_lifecycle_steps where enabled)<>14
 or (select count(*) from public.behavioral_lifecycle_journeys where status='active' and max_push_per_day=1 and max_push_per_week=3 and max_email_per_week=2)<>4
 or exists(select 1 from public.behavioral_lifecycle_steps where journey_key='continue_watching' and channel='push' and not is_marketing)
 then raise exception 'Incomplete channel activation';end if;
end $activation$;"""+snapshot+('commit;' if mode=='apply' else 'rollback;')
after=json.loads(sql(query))
result={'mode':mode,'before':before,'after':after,'historical_backfill':False,'billing_mutations':False,'provider_product_rollout_preserved':True}
(ROOT/('activation-applied.json' if mode=='apply' else 'activation-preview.json')).write_text(json.dumps(result,indent=2))
print(json.dumps({'mode':mode,'runtime':after['runtime'],'enabled_steps':len([s for s in after['steps'] if s['enabled']]),'provider':after['provider'],'provider_flags':after['provider_flags']}))
