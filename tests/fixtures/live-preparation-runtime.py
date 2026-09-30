import datetime,hashlib,hmac,http.server,json,os,pathlib,secrets,socketserver,subprocess,threading,time,urllib.request,urllib.error,uuid,base64
TOKEN=secrets.token_hex(32);counts={'open':0,'active':0};lock=threading.Lock()
class Source(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  with lock:counts['open']+=1;counts['active']+=1
  try:
   self.send_response(200);self.send_header('Content-Type','video/mp2t');self.end_headers()
   while True:self.wfile.write((b'\x47'+b'\xff'*187)*20);self.wfile.flush();time.sleep(.02)
  except (BrokenPipeError,ConnectionResetError):pass
  finally:
   with lock:counts['active']-=1
class Server(socketserver.ThreadingMixIn,http.server.HTTPServer):daemon_threads=True
server=Server(('127.0.0.1',19090),Source);threading.Thread(target=server.serve_forever,daemon=True).start()
env=dict(os.environ,GATEWAY_TOKEN=TOKEN,PORT='18080',OUTPUT_DIR='/tmp/hls',MEDIA_GATEWAY_VIDEO_ENCODER='software',INBAND_HEADER_PARSE='false',PROVIDER_SLOT_RELEASE_DELAY_MS='0')
log=open('/tmp/gateway.log','w+');gateway=subprocess.Popen(['node','/app/src/index.js'],env=env,stdout=log,stderr=subprocess.STDOUT)
def request(path,method='GET',body=None,timeout=12):
 req=urllib.request.Request('http://127.0.0.1:18080'+path,method=method,headers={'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'},data=json.dumps(body).encode() if body is not None else None)
 try:
  with urllib.request.urlopen(req,timeout=timeout) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
def wait(fn,seconds=5):
 end=time.monotonic()+seconds
 while not fn():
  if time.monotonic()>end:raise RuntimeError('bounded-wait-failed')
  time.sleep(.02)
def children():
 out=[]
 for p in pathlib.Path('/proc').iterdir():
  if p.name.isdigit():
   try:
    name=(p/'comm').read_text().strip()
    if name in ['ffmpeg','ffprobe']:out.append(name)
   except OSError:pass
 return out
result={'network':'none','source':'synthetic-loopback','cases':[]}
try:
 wait(lambda:gateway.poll() is not None or pathlib.Path('/tmp/hls').exists(),20)
 deadline=time.monotonic()+20
 while True:
  try:status,health=request('/health');break
  except Exception:
   if gateway.poll() is not None or time.monotonic()>deadline:raise RuntimeError('startup-failed')
   time.sleep(.1)
 _,generation=request('/playback-preparations/generation');gen=generation['generation'];owner=hashlib.sha256(b'qa').hexdigest();uid='qa';owner=hashlib.sha256(uid.encode()).hexdigest()
 def token(sid,generation=gen):
  claims={'v':1,'uid':uid,'sid':sid,'url':'http://127.0.0.1:19090/live/qa/qa/1.ts','exp':int(time.time())+60,'preparationProtocol':1,'preparationGatewayGeneration':generation}
  raw=json.dumps(claims).encode();b64=lambda v:base64.urlsafe_b64encode(v).decode().rstrip('=');return b64(raw)+'.'+b64(hmac.new(TOKEN.encode(),raw,hashlib.sha256).digest())
 sid=str(uuid.uuid4());tk=token(sid);reader={'done':False}
 def readraw():
  try:
   with urllib.request.urlopen('http://127.0.0.1:18080/raw/'+tk,timeout=15) as r:
    while r.read(1880):pass
  except Exception:pass
  finally:reader['done']=True
 threading.Thread(target=readraw,daemon=True).start();wait(lambda:counts['active']>0);time.sleep(.1);started=time.monotonic()
 status,closed=request('/playback-preparations/cancel','POST',{'ownerKey':owner,'playbackSessionId':sid,'generation':gen})
 wait(lambda:counts['active']==0 and reader['done']);_,health=request('/health')
 result['cases'].append({'case':'raw-cancel','status':status,'drained':closed.get('drained'),'elapsedMs':round((time.monotonic()-started)*1000),'activeSource':counts['active'],'readerDone':reader['done'],'rawPumpCount':health.get('rawPumpCount')})
 before=counts['open'];status,_=request('/raw/'+tk);result['cases'].append({'case':'raw-late-replay','status':status,'newSourceRequests':counts['open']-before})
 before=counts['open'];status,_=request('/subtitle/'+token(str(uuid.uuid4())));result['cases'].append({'case':'auxiliary-capability-denied','status':status,'newSourceRequests':counts['open']-before})
 sid=str(uuid.uuid4());body={'sourceUrl':'http://127.0.0.1:19090/live/qa/qa/1.ts','ownerKey':owner,'playbackSessionId':sid,'mode':'remux','playbackHint':{'streamType':'live','container':'ts'},'preparationProtocol':1,'preparationGatewayGeneration':gen,'preparationExpiresAt':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=180)).isoformat()};creation={}
 def create():
  try:creation['status'],_=request('/sessions','POST',body,timeout=30)
  except Exception:creation['status']='transport-error'
 thread=threading.Thread(target=create,daemon=True);thread.start();wait(lambda:counts['active']>0);wait(lambda:len(children())>0);started=time.monotonic();beforeChildren=children()
 status,closed=request('/playback-preparations/cancel','POST',{'ownerKey':owner,'playbackSessionId':sid,'generation':gen});thread.join(2);wait(lambda:counts['active']==0);_,health=request('/health')
 result['cases'].append({'case':'pending-hls-producer-cancel','status':status,'drained':closed.get('drained'),'postStatus':creation.get('status'),'childrenBefore':beforeChildren,'childrenAfter':children(),'elapsedMs':round((time.monotonic()-started)*1000),'activeSource':counts['active'],'health':{k:health.get(k) for k in ['activeSessions','rawPumpCount','viewerSessionStartupAdmissions','viewerStartupReservations','viewerSessionStartupWaiters']}})
 before=counts['open'];status,_=request('/sessions','POST',body);result['cases'].append({'case':'post-late-replay','status':status,'newSourceRequests':counts['open']-before})
 body['playbackSessionId']=str(uuid.uuid4());body['preparationGatewayGeneration']=str(uuid.uuid4());before=counts['open'];status,_=request('/sessions','POST',body);result['cases'].append({'case':'post-old-generation','status':status,'newSourceRequests':counts['open']-before})
except Exception as e:result['error']=type(e).__name__+':'+str(e)
finally:
 gateway.terminate()
 try:gateway.wait(timeout=5)
 except subprocess.TimeoutExpired:gateway.kill();gateway.wait(timeout=5)
 print(json.dumps(result))
 if result.get('error'):raise SystemExit(1)
 for case in result['cases']:
  if 'newSourceRequests' in case:assert case['newSourceRequests']==0
  if 'activeSource' in case:assert case['activeSource']==0
  if 'childrenAfter' in case:assert not case['childrenAfter']
  if case['case'].endswith('cancel'):
   assert case['status']==200 and case['drained'] is True
  if case['case']=='raw-cancel':assert case['readerDone'] and case['rawPumpCount']==0
  if 'health' in case:assert all(value==0 for value in case['health'].values())
  if case['case']=='cancel-ACK-then-actual-process-replacement':
   assert case['initialCancelStatus']==200 and case['initialDrained'] is True
   assert case['generationChanged'] and case['sourceRequests']==0 and not case['children']
   assert case['oldPostStatus']==400 and case['oldRawStatus']==409
   assert case['newCancelStatus']==202 and case['newDrained'] is False
