"""Encrypted off-server recovery export. Never prints email bodies or keys."""
import base64,hashlib,json,os,socket,subprocess,sys,time
from pathlib import Path
SOURCE=Path(__file__).resolve().parent;files={};mode=sys.argv[1]
def add(name,data):files[name]={'data':base64.b64encode(data).decode(),'sha256':hashlib.sha256(data).hexdigest()}
def run(a,data=None):
 r=subprocess.run(a,input=data,capture_output=True,timeout=120);assert r.returncode==0;return r.stdout
if mode=='--host':
 assert socket.gethostname()=='norva-db' and os.geteuid()==1000
 root=Path('/home/adrien/.norva/postal-full-service-v1')
 for p in (root/'private').iterdir():
  if p.is_file()and not p.is_symlink():add('private/'+p.name,p.read_bytes())
 # SQLite online backup API gives a consistent snapshot without copying WAL.
 code=b"import{DatabaseSync,backup}from'node:sqlite';import fs from'node:fs';const db=new DatabaseSync('/data/mail.sqlite');const p='/data/recovery-snapshot-'+Date.now()+'.sqlite';await backup(db,p);db.close();process.stdout.write(p);"
 name=run(['docker','exec','-i','norva-private-mail-v1','node','--input-type=module'],code).decode()
 p=root/'data'/Path(name).name;add('mail.sqlite',p.read_bytes())
 add('norva_postal_full.sql',run(['docker','exec','norva-db','pg_dump','-U','supabase_admin','-d','postgres','--schema=norva_postal_full','--no-owner']))
 image='norva-postal-branded-reviewed-base:20260906'
elif mode=='--guest':
 assert socket.gethostname()=='norva-postal-offline' and os.geteuid()==0
 root=Path('/var/lib/norva-postal-full-v1')
 for p in root.rglob('*'):
  if p.is_file()and not p.is_symlink():add('state/'+str(p.relative_to(root)),p.read_bytes())
 for n in ['signing.key','postal.yml','canary-credential.json']:
  add('postal-config/'+n,Path('/var/lib/docker/volumes/norva-postal-candidate-20260905_config/_data',n).read_bytes())
 # Existing Postal message identities, held state and delivery records accompany
 # the independent DATA journal. Credentials stay inside this encrypted export.
 db='norva-postal-candidate-20260905-db-1'
 info=json.loads(run(['docker','inspect',db]))[0];env=dict(x.split('=',1)for x in info['Config']['Env']if '='in x)
 if 'MARIADB_ROOT_PASSWORD_FILE' in env:
  command='MYSQL_PWD=$(cat "$MARIADB_ROOT_PASSWORD_FILE") exec mariadb-dump --user=root --all-databases --single-transaction --skip-lock-tables'
 else:
  key=next(k for k in ['MARIADB_ROOT_PASSWORD','MYSQL_ROOT_PASSWORD']if k in env)
  command='MYSQL_PWD="$'+key+'" exec mariadb-dump --user=root --all-databases --single-transaction --skip-lock-tables'
 add('postal-databases.sql',run(['docker','exec',db,'sh','-c',command]))
 image='norva-postal-offline/node:22'
else:raise RuntimeError('scope')
payload=json.dumps({'scope':'full'+mode,'at':time.time(),'files':files}).encode()
r=run(['docker','run','--rm','-i','--network','none','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m',
 '--mount','type=bind,src='+str(SOURCE)+',dst=/backup,readonly',image,'node','/backup/backup.mjs','--encrypt','/backup/recovery-public.pem'],payload)
p=SOURCE/('full'+mode+'-'+str(int(time.time()))+'.encrypted.json')
with p.open('xb')as f:os.chmod(p,0o600);f.write(r);f.flush();os.fsync(f.fileno())
print(json.dumps({'result':'FULL_ENCRYPTED_BACKUP_CREATED','scope':mode,'path':str(p),'files':len(files),'sha256':hashlib.sha256(r).hexdigest()}))
