"""Apply the proven presentation function transactionally, preserving its ACL."""
import hashlib,json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parent
def sql(q):
 p=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-At','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],input=q,text=True,capture_output=True,timeout=40)
 if p.returncode:raise RuntimeError(p.stderr[-1200:])
 return p.stdout
q="select pg_get_functiondef(p.oid)||';' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname='norva_branded_email_html';"
backup=root/'branded-email-before.sql'
assert not backup.exists(),'Migration already started; inspect before retry'
old=sql(q);assert 'CREATE OR REPLACE FUNCTION public.norva_branded_email_html(' in old
backup.write_text(old)
aclq="select json_build_array(proowner,proacl,prosecdef) from pg_proc where oid='public.norva_branded_email_html(text,text,text,text,text)'::regprocedure;"
acl=sql(aclq)
print(sql('begin;'+(root/'premium-email-ui.sql').read_text()+(root/'premium-email-ui-proof.sql').read_text()+'commit;').strip())
assert sql(aclq)==acl,'Function ACL changed'
proof={'deployed':True,'aclPreserved':True,'functionSha256':hashlib.sha256(sql(q).encode()).hexdigest()}
(root/'database-ui-proof.json').write_text(json.dumps(proof))
print(json.dumps(proof))
