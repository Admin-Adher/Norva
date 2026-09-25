"""Idle-only storyboard image/config rollout; dry run by default, private rollback receipt."""
import argparse, copy, datetime, hashlib, http.client, json, os, pathlib, re, socket, subprocess, time, urllib.request

NODES={'norva-media-gateway':8081,'norva-resume-cache-pilot-20260916':18086}
ENV_KEYS={'STORYBOARD_PRIVATE_DIR','STORYBOARD_DURABLE_SOURCE_IDS','STORYBOARD_DURABLE_ROLLOUT_BPS'}
class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout);self.sock.connect('/var/run/docker.sock')
def docker(method,route,body=None):
    c=DockerConnection('localhost',timeout=40)
    try:
        c.request(method,route,None if body is None else json.dumps(body),{'Content-Type':'application/json'})
        r=c.getresponse();raw=r.read()
        if r.status>=400:raise RuntimeError('docker_api_'+str(r.status))
        return json.loads(raw) if raw else None
    finally:c.close()
def inspect(name):return docker('GET','/containers/'+name+'/json')
def clone(original):
    c=copy.deepcopy(original['Config']);c.pop('Hostname',None)
    c['HostConfig']=copy.deepcopy(original['HostConfig'])
    fields=('IPAMConfig','Links','Aliases','DriverOpts','GwPriority')
    c['NetworkingConfig']={'EndpointsConfig':{n:{k:v[k] for k in fields if v.get(k) is not None}
        for n,v in original['NetworkSettings']['Networks'].items()}}
    return c
def fingerprint(c):
    c=copy.deepcopy(c);c.pop('Hostname',None)
    c['HostConfig']['OomKillDisable']=bool(c['HostConfig'].get('OomKillDisable'))
    return hashlib.sha256(json.dumps(c,sort_keys=True).encode()).hexdigest()
def environment(c):return dict(s.split('=',1) for s in c['Config']['Env'])
def prepared(original,image,bps,sources):
    assert re.fullmatch(r'sha256:[a-f0-9]{64}',image),'invalid_image'
    assert type(bps) is int and 0<=bps<=10000,'invalid_rollout'
    assert len(sources)<=1000 and all(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',s) for s in sources),'invalid_sources'
    name=original['Name'].lstrip('/')
    directory='/var/lib/norva-storyboards/durable' if name=='norva-media-gateway' else '/tmp/resume-pilot/storyboards'
    assert any(m.get('RW') is True and directory.startswith(m['Destination'].rstrip('/')+'/') for m in original['Mounts']),'persistent_mount_missing'
    c=clone(original);c['Image']=image
    env=environment(original);old=dict(env)
    env.update(STORYBOARD_PRIVATE_DIR=directory,STORYBOARD_DURABLE_SOURCE_IDS=','.join(sources),STORYBOARD_DURABLE_ROLLOUT_BPS=str(bps))
    assert {k:v for k,v in old.items() if k not in ENV_KEYS}=={k:v for k,v in env.items() if k not in ENV_KEYS}
    c['Env']=[k+'='+v for k,v in env.items()]
    return c
def health(name,original,debug=False):
    r=urllib.request.Request('http://127.0.0.1:'+str(NODES[name])+('/debug/sessions' if debug else '/health'))
    if debug:r.add_header('Authorization','Bearer '+environment(original)['GATEWAY_TOKEN'])
    with urllib.request.urlopen(r,timeout=10) as response:return json.load(response)
def idle(name,original):
    current=inspect(name)
    assert current['Id']==original['Id'] and fingerprint(clone(current))==fingerprint(clone(original)),'runtime_drift'
    h=health(name,original);assert h.get('ok') and h.get('version')==169,'unexpected_health'
    for k in ('activeSessions','rawPumpCount','viewerSessionStartupAdmissions','viewerStartupReservations',
        'viewerSessionStartupWaiters','viewerSessionStartupLockCount','backgroundCpuProcessCount',
        'whisperInferenceActive','argosInferenceActive','activeStrictLidBrokers','transcribeQueueDepth','ocrQueueDepth','translateQueueDepth'):
        assert type(h.get(k)) is int and h[k]==0,'busy_or_unknown_'+k
    for k in ('transcribeBusy','ocrBusy','translateBusy','lidBenchmarkBusy'):
        assert h.get(k) is False,'busy_or_unknown_'+k
    assert h.get('videoEncoderCapacity',{}).get('active')==0,'encoder_active'
    assert health(name,original,True).get('sessions')==[],'viewer_sessions_active'
    q="select count(*) from cloud_playback_sessions where status in ('ready','pending','active') and superseded_at is null and expires_at>now();"
    count=subprocess.check_output(['docker','exec','norva-db','psql','-X','-q','-At','-U','supabase_admin','-d','postgres','-c',q],text=True).strip()
    assert count=='0','cloud_playback_active'
    return h
def verify(name,expected,bps,sources):
    for _ in range(30):
        current=inspect(name)
        assert fingerprint(clone(current))==fingerprint(expected),'replacement_configuration_drift'
        try:
            h=health(name,current);s=h['storyboardDurability']
            assert h['ok'] and h['version']==169 and s['protocol']==2
            assert s['enabled']==bool(bps or sources) and s['rolloutBasisPoints']==bps and s['selectedSources']==len(set(sources))
            assert h['privateResumeHlsCache']['enabled'] and h['sharedMediaCache']['enabled'] and h['videoEncoder']['ready']
            return h
        except (OSError,ValueError,KeyError,AssertionError):time.sleep(1)
    raise RuntimeError('replacement_health_failed')
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('node',choices=NODES)
    p.add_argument('--image',required=True);p.add_argument('--base-image',required=True)
    p.add_argument('--basis-points',required=True,type=int);p.add_argument('--sources',default='')
    p.add_argument('--apply',action='store_true');a=p.parse_args();os.umask(0o077)
    original=inspect(a.node);assert original['Image']==a.base_image,'base_image_changed'
    candidate=docker('GET','/images/'+a.image+'/json')
    revision=candidate['Config'].get('Labels',{}).get('org.opencontainers.image.revision','')
    assert re.fullmatch(r'[a-f0-9]{40}',revision),'unversioned_image'
    sources=[s.strip() for s in a.sources.split(',') if s.strip()]
    c=prepared(original,a.image,a.basis_points,sources)
    c['Labels']=dict(c.get('Labels') or {});c['Labels']['org.opencontainers.image.revision']=revision
    idle(a.node,original)
    report={'node':a.node,'image':a.image,'revision':revision,'basisPoints':a.basis_points,'selectedSources':len(sources),'applied':False}
    if not a.apply:print(json.dumps(report));return
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    r=pathlib.Path('/home/adrien/.norva/storyboard-global-20260925/rollouts')/stamp;r.mkdir(parents=True,mode=0o700)
    c['Labels']['norva.storyboardDeployment']=stamp
    (r/'original.private.json').write_text(json.dumps(original));(r/'replacement.private.json').write_text(json.dumps(c))
    report['receipt']=str(r);backup=a.node+'-before-storyboards-'+stamp;replacement=None;stopped=False;renamed=False
    try:
        idle(a.node,original)
        docker('POST','/containers/'+original['Id']+'/stop?t=25');stopped=not inspect(original['Id'])['State']['Running'];assert stopped
        docker('POST','/containers/'+original['Id']+'/rename?name='+backup);renamed=inspect(original['Id'])['Name']=='/'+backup;assert renamed
        result=docker('POST','/containers/create?name='+a.node,c);replacement=result['Id']
        docker('POST','/containers/'+replacement+'/start');verify(a.node,c,a.basis_points,sources)
        report.update(applied=True,healthy=True,backup=backup)
    except Exception:
        # Reconcile observed state even when stop/rename/create timed out after
        # succeeding. Flags set only after HTTP acknowledgement are insufficient.
        try:current=inspect(a.node)
        except Exception:current=None
        if current and current['Id']!=original['Id']:
            assert current['Config'].get('Labels',{}).get('norva.storyboardDeployment')==stamp and fingerprint(clone(current))==fingerprint(c),'unknown_replacement_requires_reconciliation'
            if current['State']['Running']:idle(a.node,current)
            docker('DELETE','/containers/'+current['Id']+'?force=true')
        previous=inspect(original['Id'])
        assert previous['Name'] in ('/'+a.node,'/'+backup),'original_identity_drift'
        if previous['Name']!='/'+a.node:docker('POST','/containers/'+original['Id']+'/rename?name='+a.node)
        if not previous['State']['Running']:docker('POST','/containers/'+original['Id']+'/start')
        report['rolledBack']=True
        raise
    finally:
        (r/'result.json').write_text(json.dumps(report));print(json.dumps(report))
if __name__=='__main__':main()
