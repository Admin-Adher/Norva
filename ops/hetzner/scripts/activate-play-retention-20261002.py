"""Operator gate for mobile campaigns, after the distributed-phone replay.

Default is read-only. --apply requires an accepted isolated receipt supplied
through --receipt, with confirmation before the retained access boundary.
No purchase receipt is copied to production; no entitlement is modified.
"""
import argparse, datetime, json, pathlib, subprocess

p = argparse.ArgumentParser()
p.add_argument('--apply', action='store_true')
p.add_argument('--receipt')
args = p.parse_args()

def run(cmd, data=None):
    return subprocess.run(cmd, input=data, text=True, capture_output=True, check=True).stdout.strip()

def sql(query, qa=False):
    return run(['docker','exec','-i','norva-play-retention-qa-db' if qa else 'norva-db',
                'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres' if qa else 'supabase_admin',
                '-d','norva_play_retention_qa' if qa else 'postgres'], query)

state = json.loads(sql("""select jsonb_build_object(
 'policy',(select to_jsonb(p) from public.cloud_play_retention_policy p),
 'sandboxEvents',(select count(*) from public.cloud_entitlement_events where payload->>'environment'='SANDBOX'),
 'cron',(select count(*) from cron.job where jobname='norva-play-retention' and active),
 'googleProjections',(select count(*) from public.cloud_entitlement_projection where provider='google_play'));"""))
assert state['sandboxEvents'] == 0 and state['cron'] == 1
for node in ['norva-edge-functions','norva-edge-functions-2']:
    info = json.loads(run(['docker','inspect',node]))[0]
    env = dict(x.split('=',1) for x in info['Config']['Env'] if '=' in x)
    assert info['State']['Running'] and env.get('NORVA_RC_ACCEPT_SANDBOX') == 'false'
    assert env.get('FCM_SERVICE_ACCOUNT')
print(json.dumps({'preflight':state,'applyRequested':args.apply}))
if args.apply:
    assert args.receipt and all(c.isalnum() or c=='-' for c in args.receipt)
    proof = json.loads(sql("""select coalesce(jsonb_agg(jsonb_build_object(
      'receipt',o.purchase_event,'acceptedAt',o.accepted_at,'accessUntil',o.access_until,
      'beforeExpiry',o.accepted_at<o.access_until,'environment',e.payload->>'environment',
      'storeAuthority',e.payload->'_norva'->'play_retention'->>'source',
      'accessPreserved',(e.payload->'_norva'->'play_retention'->>'accessUntil')::timestamptz>=o.access_until)),'[]'::jsonb)
      from public.cloud_play_retention_offers o join public.cloud_entitlement_events e
       on e.provider_event_id=o.purchase_event and e.user_id=o.user_id
      where o.state='accepted' and o.purchase_event='%s'
       and o.user_id='6055c1e8-9f4b-48a2-b9c4-2a08cdfcb05f';""" % args.receipt, qa=True))
    assert len(proof)==1 and proof[0]['beforeExpiry'] and proof[0]['environment']=='SANDBOX'
    assert proof[0]['storeAuthority']=='google_play_api' and proof[0]['accessPreserved'] is True
    folder = pathlib.Path('/home/adrien/.norva/commercial-closeout-20261002')
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = folder/'play-retention-policy-before.json'
    assert not backup.exists(), 'Inspect existing activation receipt instead of overwriting'
    backup.write_text(json.dumps(state)); backup.chmod(0o600)
    after = sql("""begin;
      lock table public.cloud_play_retention_policy in exclusive mode;
      do $$ begin
        if not exists(select 1 from public.cloud_play_retention_policy where singleton and not enabled and not communications_enabled)
          then raise exception 'Policy changed since preflight'; end if;
      end $$;
      update public.cloud_play_retention_policy set enabled=true,communications_enabled=true where singleton;
      select to_jsonb(p) from public.cloud_play_retention_policy p;
      commit;""")
    receipt={'activatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'policy':json.loads(after),'isolatedEvidence':proof[0],
             'productionSandboxAccepted':False}
    out=folder/'play-retention-activation.json'
    out.write_text(json.dumps(receipt,indent=2)); out.chmod(0o600)
    print(json.dumps(receipt))
