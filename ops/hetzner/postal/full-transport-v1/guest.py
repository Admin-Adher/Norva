#!/usr/bin/env python3
"""Forced private Postal operation, with durable API/DATA attempts and no shell API."""
import base64,fcntl,hashlib,ipaddress,json,os,re,smtplib,socket,ssl,subprocess,sys,time
from pathlib import Path
ROOT=Path('/var/lib/norva-postal-full-v1')
TAG=re.compile(r'norva-mail-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}')
CONTAINER='norva-postal-candidate-20260905-private-web-1'
def digest(v):return hashlib.sha256(v).hexdigest()
def save(path,value):
 with path.open('x')as f:os.chmod(path,0o600);json.dump(value,f);f.flush();os.fsync(f.fileno())
 fd=os.open(path.parent,os.O_RDONLY);os.fsync(fd);os.close(fd)
def policy():
 path=ROOT/'policy.json';st=path.stat()
 assert st.st_uid==0 and st.st_mode&0o077==0 and not path.is_symlink()
 return json.loads(path.read_text())
def allowed(recipient):
 p=policy();assert p.get('enabled') is True
 assert isinstance(recipient,str) and len(recipient)<=254 and re.fullmatch(r'[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+',recipient)
 if p.get('testRecipients') is not None:assert recipient in p['testRecipients']
 for other in ['auth-service-v1','branded-service-v1']:
  old=json.loads(Path('/var/lib/norva-postal-'+other+'/policy.json').read_text())
  assert not old.get('enabled') or old.get('expiresUnix',0)<=time.time()
def ruby(value):
 r=subprocess.run(['docker','exec','-i','-e','LOGGING_ENABLED=false',CONTAINER,'bundle','exec','rails','runner',
  '/runtime/full-transport-v1/postal.rb'],input=json.dumps(value).encode(),capture_output=True,timeout=45)
 if r.returncode or len(r.stdout)>700000:raise RuntimeError('private_postal_failed')
 return json.loads(r.stdout.decode().strip().splitlines()[-1])
def latest_result(k):
 paths=list((ROOT/'journal').glob(k+'.smtp-attempt-*.json'))
 if not paths:return {'state':'unknown','secure':False}
 n=max(int(p.stem.rsplit('-',1)[1])for p in paths)
 result=ROOT/'journal'/(k+'.smtp-result-'+str(n)+'.json')
 return json.loads(result.read_text()) if result.exists() else {'state':'unknown','secure':False}
def resolve_mx(domain,query=None):
 assert re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}',domain)
 # DNS stays on the filtered VM, not inside the isolated Postal container.
 query=query or (lambda args:subprocess.run(args,capture_output=True,timeout=5))
 for server in ['1.1.1.1','9.9.9.9']:
  r=query(['/usr/bin/dig','@'+server,'+time=2','+tries=1','+noall','+comments','+answer',domain,'MX'])
  text=r.stdout.decode('ascii',errors='strict')
  if r.returncode or len(text)>20000 or 'status: NOERROR'not in text:continue
  mx=[]
  for line in text.splitlines():
   parts=line.split()
   if len(parts)==6 and parts[2:4]==['IN','MX']:
    host=parts[5].rstrip('.').lower()
    if not host:raise ValueError('null_mx')
    if not re.fullmatch(r'[a-z0-9.-]{1,253}',host):raise ValueError('invalid_mx')
    mx.append({'host':host,'priority':int(parts[4])})
  return sorted(mx,key=lambda x:x['priority'])[:10] or [{'host':domain,'priority':0}]
 raise RuntimeError('mx_dns_unavailable')
def smtp_send(mime,recipient,return_path,mxes,deadline,connect=None,resolve=None,allow=None):
 connect=connect or smtplib.SMTP;resolve=resolve or socket.getaddrinfo;allow=allow or allowed
 result={'state':'retry','secure':False,'dataAttempted':False,'provedNoAcceptance':True}
 context=ssl.create_default_context();context.minimum_version=ssl.TLSVersion.TLSv1_2
 for mx in mxes[:3]:
  if time.time()>=deadline:break
  host=mx['host'].rstrip('.').lower()
  if not re.fullmatch(r'[a-z0-9.-]{1,253}',host) or host in ['postal.norva.tv','mx.postal.norva.tv']:continue
  addresses=resolve(host,25,socket.AF_INET,socket.SOCK_STREAM)
  for entry in addresses[:2]:
   ip=entry[4][0]
   if not ipaddress.ip_address(ip).is_global or ip=='157.180.96.159':continue
   smtp=None
   try:
    smtp=connect(timeout=min(12,max(1,deadline-time.time())),local_hostname='mx.postal.norva.tv')
    smtp.connect(ip,25)
    # Connect to the validated public IP, but verify the DNS MX hostname.
    smtp._host=host
    assert smtp.ehlo('mx.postal.norva.tv')[0]==250
    smtp.starttls(context=context);result['secure']=True
    assert smtp.ehlo('mx.postal.norva.tv')[0]==250
    allow(recipient);assert time.time()<deadline
    code,_=smtp.mail(return_path)
    if code!=250:
     result['state']='HardFail' if 500<=code<600 else 'retry';return result
    code,detail=smtp.rcpt(recipient)
    if code not in [250,251]:
     result['state']='HardFail' if 500<=code<600 else 'retry'
     result['recipientInvalid']=500<=code<600 and bool(re.search(rb'5\.1\.[01]',detail));return result
    result['dataAttempted']=True;result['provedNoAcceptance']=False
    code,_=smtp.data(mime)
    if code==250:result['state']='Sent'
    elif 400<=code<500:result.update(state='retry',provedNoAcceptance=True)
    elif 500<=code<600:result.update(state='HardFail',provedNoAcceptance=True)
    else:result['state']='unknown'
    return result
   except smtplib.SMTPDataError as error:
    # An explicit final 4xx/5xx is known non-acceptance, unlike a lost DATA reply.
    result.update(state='retry' if 400<=error.smtp_code<500 else 'HardFail',provedNoAcceptance=True)
    return result
   except Exception:
    if result['dataAttempted']:result.update(state='unknown',provedNoAcceptance=False);return result
   finally:
    if smtp:
     try:smtp.quit()
     except Exception:smtp.close()
 return result
def handle(v):
 mode=v.get('mode')
 if mode=='health':
  s=ruby({'mode':'health'});return {'ok':s.get('ok') is True,'enabled':policy().get('enabled')is True,
   'queued':s.get('queued'),'callbacks':s.get('callbacks'),'messages':s.get('messages'),'publicJwk':s.get('publicJwk')}
 if mode in ['feedback','ack']:
  if mode=='ack':assert TAG.fullmatch(v.get('tag','')) and isinstance(v.get('requestId'),int)
  return ruby(v)
 tag=v.get('tag','');assert TAG.fullmatch(tag);k=digest(tag.encode())
 if mode=='receipt':return latest_result(k)
 if mode in ['hold','find']:
  m=v['message'];recipient=m['to'];allowed(recipient)
  assert m['from']=='Norva <support@notify.norva.tv>'
  assert len(json.dumps(m).encode())<=390000
  wire={key:value for key,value in m.items() if key in ['from','to','reply_to','subject','html','text','headers']};wire['tag']=tag
  attempt=ROOT/'journal'/(k+'.api-attempt.json');held=ROOT/'journal'/(k+'.held.json')
  binding=digest(json.dumps(wire,sort_keys=True).encode())
  if attempt.exists():
   assert json.loads(attempt.read_text())['binding']==binding
   if held.exists():return json.loads(held.read_text())
   r=ruby({'mode':'find','tag':tag,'recipient':recipient})
   if r.get('held')is True:save(held,r)
   return r
  if mode=='find':return {'held':False,'uncertain':True}
  save(attempt,{'binding':binding,'created':time.time()})
  r=ruby({'mode':'hold','message':wire});assert r.get('held')is True
  save(held,r);return r
 if mode=='dispatch':
  recipient=v['recipient'];allowed(recipient);n=v['attempt']
  assert isinstance(n,int) and 1<=n<=12 and time.time()<v['expiresUnix']<=time.time()+95
  held=json.loads((ROOT/'journal'/(k+'.held.json')).read_text());assert held['messageId']==v['messageId']
  attempts=list((ROOT/'journal').glob(k+'.smtp-attempt-*.json'))
  if attempts:
   previous=max(int(p.stem.rsplit('-',1)[1])for p in attempts);old=latest_result(k)
   if old['state']=='Sent':return old
   if n==previous:return old
   assert n==previous+1 and old['state']=='retry' and old.get('provedNoAcceptance')is True
  # Attempts may start at two after recovering an API-side receipt; no prior
  # DATA is allowed to be skipped or overwritten when a journal exists.
  attempt=ROOT/'journal'/(k+'.smtp-attempt-'+str(n)+'.json')
  save(attempt,{'tag':tag,'messageId':v['messageId'],'at':time.time()})
  result={'state':'retry','secure':False,'dataAttempted':False,'provedNoAcceptance':True}
  try:
   raw=ruby({'mode':'mime','tag':tag,'messageId':v['messageId'],'recipient':recipient})
   mime=base64.b64decode(raw['raw'],validate=True)
   assert len(mime)<=524288 and b'DKIM-Signature:'in mime and raw['recipient']==recipient and tag.encode()in mime
   result=smtp_send(mime,recipient,raw['returnPath'],resolve_mx(recipient.rsplit('@',1)[1]),v['expiresUnix'])
  except Exception as e:result['errorClass']=type(e).__name__
  save(ROOT/'journal'/(k+'.smtp-result-'+str(n)+'.json'),result)
  try:ruby({'mode':'result','tag':tag,'messageId':v['messageId'],'recipient':recipient,
   'status':result['state'] if result['state']in ['Sent','HardFail']else'Held','secure':result['secure']})
  except Exception:result['postalReceiptPending']=True
  return result
 raise ValueError('mode_not_allowed')
def main():
 assert os.geteuid()==0 and socket.gethostname()=='norva-postal-offline'
 os.umask(0o077);raw=sys.stdin.buffer.read(700001);assert len(raw)<=700000
 with (ROOT/'lock').open('a')as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);print(json.dumps(handle(json.loads(raw))))
if __name__=='__main__':
 try:main()
 except Exception:print(json.dumps({'ok':False,'error':'private_sender_refused'}));sys.exit(1)
