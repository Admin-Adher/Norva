import hashlib,json,os,shutil,socket,subprocess,sys
from pathlib import Path
SOURCE=Path(__file__).resolve().parent
ROOT=Path('/var/lib/norva-postal-full-v1');LIB=Path('/usr/local/lib/norva-postal/full-transport-v1');RUBY=Path('/usr/local/lib/norva-postal/durable-guest-v1/full-transport-v1')
def main():
 assert os.geteuid()==0 and socket.gethostname()=='norva-postal-offline' and sys.argv[1:]==['--install-disabled']
 manifest=json.loads((SOURCE/'manifest.json').read_text())
 for n in ['guest.py','postal.rb','install-guest.py']:assert hashlib.sha256((SOURCE/n).read_bytes()).hexdigest()==manifest[n]
 assert not ROOT.exists() and not LIB.exists() and not RUBY.exists()
 key=(SOURCE/'runner.pub').read_text().strip();assert key.startswith('ssh-ed25519 ') and len(key.split())==3 and '\n'not in key and '"'not in key
 for name in ['auth-service-v1','branded-service-v1']:
  old=json.loads(Path('/var/lib/norva-postal-'+name+'/policy.json').read_text());assert not old['enabled']
 for p in [ROOT,ROOT/'journal',LIB,RUBY]:p.mkdir(mode=0o700 if p in [ROOT,ROOT/'journal'] else 0o755)
 for p in [LIB,RUBY]:os.chmod(p,0o755)
 shutil.copyfile(SOURCE/'guest.py',LIB/'guest.py');os.chmod(LIB/'guest.py',0o555)
 shutil.copyfile(SOURCE/'postal.rb',RUBY/'postal.rb');os.chmod(RUBY/'postal.rb',0o444)
 (ROOT/'policy.json').write_text(json.dumps({'enabled':False,'testRecipients':['buildtrack.admin@gmail.com','projethorizon2030@gmail.com']}));os.chmod(ROOT/'policy.json',0o600)
 authfile=Path('/home/postaladmin/.ssh/authorized_keys');before=authfile.read_bytes();assert key.split()[1]not in before.decode()
 (ROOT/'authorized_keys.before').write_bytes(before)
 with authfile.open('a')as f:f.write(('\n'if not before.endswith(b'\n')else'')+'restrict,command="sudo -n /usr/bin/python3 -I '+str(LIB/'guest.py')+'" '+key+'\n');f.flush();os.fsync(f.fileno())
 r=subprocess.run(['python3','-I',str(LIB/'guest.py')],input=b'{"mode":"health"}',capture_output=True,timeout=55)
 assert r.returncode==0,r.stderr.decode()[:200]
 status=json.loads(r.stdout);assert status['ok'] and not status['enabled']
 (ROOT/'installed.json').write_text(json.dumps({'manifest':manifest,'enabled':False}))
 print(json.dumps({'result':'FULL_GUEST_INSTALLED_DISABLED','health':status,'emailSent':False}))
if __name__=='__main__':
 os.umask(0o077)
 try:main()
 except Exception as e:print(json.dumps({'result':'FULL_GUEST_INSTALL_REFUSED','errorClass':type(e).__name__,'detailsSuppressed':True}));sys.exit(1)
