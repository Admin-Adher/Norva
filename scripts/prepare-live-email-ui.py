"""Overlay presentation only onto inspected live modules; retain live transport code."""
import hashlib,json,pathlib,sys
repo=pathlib.Path(__file__).resolve().parents[1]
root=pathlib.Path(sys.argv[1]);baseline=root/'live-ui-baseline';out=root/'email-ui-candidate'
regions={
 '_shared/lifecycle-email.ts':('function shell(', 'function transactionalFooter('),
 '_shared/import-email.ts':('function shell(', 'function greetHtml('),
 'norva-auth-email/index.ts':('function shell(', 'function renderHtml('),
 'norva-auth-challenge/index.ts':('      html:', '      text:'),
 'norva-support/index.ts':('function shell(', 'type SupportMailDirection'),
 'norva-account-delete/index.ts':('function renderAccountDeleted(', 'interface DeletionDeliveryClaim'),
 'norva-provider-access-notify/index.ts':('function emailHtml(', 'function emailText('),
}
def sha(s):return hashlib.sha256(s.encode()).hexdigest()
manifest={}
for rel,markers in regions.items():
 live=(baseline/rel).read_text(encoding='utf-8');local=(repo/'supabase/functions'/rel).read_text(encoding='utf-8')
 start,end=markers
 assert live.count(start)==local.count(start)==1
 a,b=live.index(start),live.index(end,live.index(start));c,d=local.index(start),local.index(end,local.index(start))
 prefix=local.splitlines(True)[0];assert prefix.startswith('import { renderEmailFrame }')
 candidate=prefix+live[:a]+local[c:d]+live[b:]
 assert candidate[len(prefix):a+len(prefix)]==live[:a] and candidate.endswith(live[b:])
 dest=out/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(candidate,encoding='utf-8',newline='\n')
 manifest[rel]={'before':sha(live),'after':sha(candidate)}
for rel in ['_shared/subtitle-ready-email.ts','_shared/email-frame.ts']:
 candidate=(repo/'supabase/functions'/rel).read_text(encoding='utf-8')
 old=(baseline/rel).read_text(encoding='utf-8') if (baseline/rel).exists() else None
 dest=out/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(candidate,encoding='utf-8',newline='\n')
 manifest[rel]={'before':sha(old) if old is not None else None,'after':sha(candidate)}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps({'modules':len(manifest),'transportPreserved':True,'path':str(out)}))
