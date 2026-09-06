import importlib.util,smtplib,socket,time,unittest,os,sys,types
if os.name=='nt':sys.modules['fcntl']=types.SimpleNamespace() # SMTP-only unit tests; no filesystem lock is invoked.
from pathlib import Path
spec=importlib.util.spec_from_file_location('sender',Path(__file__).resolve().parents[1]/'ops/hetzner/postal/full-transport-v1/guest.py')
sender=importlib.util.module_from_spec(spec);spec.loader.exec_module(sender)
class Fake:
 calls=[];mode='sent'
 def __init__(self,**kwargs):self.calls.append('init')
 def connect(self,*args):self.calls.append('connect')
 def ehlo(self,*args):return (250,b'ok')
 def starttls(self,context):
  self.calls.append('tls');assert context.check_hostname
  if self.mode=='tls_error':raise OSError('verify failed')
 def mail(self,*args):self.calls.append('mail');return (250,b'ok')
 def rcpt(self,*args):
  self.calls.append('rcpt');return (550,b'5.1.1 invalid')if self.mode=='recipient_bad'else(250,b'ok')
 def data(self,*args):
  self.calls.append('data')
  if self.mode=='lost_reply':raise OSError('reply lost')
  return {'sent':(250,b'ok'),'temporary':(451,b'4.7.1 later'),'permanent':(554,b'no')}[self.mode]
 def quit(self):raise OSError('quit reply lost')
 def close(self):pass
def resolve(*args):return[(socket.AF_INET,socket.SOCK_STREAM,0,'',('8.8.8.8',25))]
class Tests(unittest.TestCase):
 def test_mx_resolution_uses_vm_dns_and_priority(self):
  def query(args):
   self.assertEqual(args[0],'/usr/bin/dig');self.assertIn('@1.1.1.1',args)
   return types.SimpleNamespace(returncode=0,stdout=b';; ->>HEADER<<- status: NOERROR\ngmail.com. 10 IN MX 20 alt.example.test.\ngmail.com. 10 IN MX 10 mx.example.test.\n')
  self.assertEqual(sender.resolve_mx('gmail.com',query)[0]['host'],'mx.example.test')
 def test_null_mx_refused_without_implicit_fallback(self):
  def query(args):return types.SimpleNamespace(returncode=0,stdout=b';; status: NOERROR\nexample.test. 10 IN MX 0 .\n')
  with self.assertRaisesRegex(ValueError,'null_mx'):sender.resolve_mx('example.test',query)
 def test_dns_failure_is_not_implicit_mx(self):
  def query(args):return types.SimpleNamespace(returncode=0,stdout=b';; status: SERVFAIL\n')
  with self.assertRaisesRegex(RuntimeError,'mx_dns_unavailable'):sender.resolve_mx('example.test',query)
 def go(self,mode,ipResolve=resolve):
  Fake.mode=mode;Fake.calls=[]
  return sender.smtp_send(b'message','test@example.test','bounce@notify.norva.tv',[{'host':'mx.example.test'}],time.time()+30,connect=Fake,resolve=ipResolve,allow=lambda x:None)
 def test_accepted_survives_quit_disconnect(self):
  r=self.go('sent');self.assertEqual(r['state'],'Sent');self.assertTrue(r['secure']);self.assertEqual(Fake.calls.count('data'),1)
 def test_no_plaintext_fallback(self):
  r=self.go('tls_error');self.assertNotIn('data',Fake.calls);self.assertNotEqual(r['state'],'Sent')
 def test_lost_data_reply_is_never_known_retry(self):
  r=self.go('lost_reply');self.assertEqual(r['state'],'unknown');self.assertFalse(r['provedNoAcceptance'])
 def test_explicit_4xx_is_bounded_safe_retry(self):
  r=self.go('temporary');self.assertEqual(r['state'],'retry');self.assertTrue(r['provedNoAcceptance'])
 def test_explicit_permanent_recipient_never_sends_data(self):
  r=self.go('recipient_bad');self.assertEqual(r['state'],'HardFail');self.assertTrue(r['recipientInvalid']);self.assertNotIn('data',Fake.calls)
 def test_private_address_never_connected(self):
  for ip in ['127.0.0.1','10.0.0.1','169.254.169.254','157.180.96.159','192.168.1.1']:
   self.go('sent',lambda *args:[(socket.AF_INET,socket.SOCK_STREAM,0,'',(ip,25))]);self.assertEqual(Fake.calls,[])
 def test_permission_recheck_precedes_smtp_envelope(self):
  Fake.mode='sent';Fake.calls=[]
  def deny(_):raise RuntimeError('revoked')
  sender.smtp_send(b'x','t@example.test','bounce@notify.norva.tv',[{'host':'mx.example.test'}],time.time()+30,connect=Fake,resolve=resolve,allow=deny)
  self.assertNotIn('mail',Fake.calls);self.assertNotIn('data',Fake.calls)
if __name__=='__main__':unittest.main()
