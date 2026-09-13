import ast,datetime,json,pathlib,re,tempfile,time,types,unittest
SOURCE=pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/scripts/recheck-legacy-language-tags-20260913.py'
def require(ok,code):
    if not ok:raise RuntimeError(code)
def load(names,extra):
    tree=ast.parse(SOURCE.read_text(encoding='utf-8'))
    code=ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[])
    scope={'require':require,'time':time,'json':json,'pilot':types.SimpleNamespace(datetime=datetime),**extra}
    exec(compile(code,str(SOURCE),'exec'),scope);return scope
class LegacyTagTests(unittest.TestCase):
    def test_selector_does_not_rewrite_or_classify_a_language(self):
        fn=load(['is_suspect'],{})['is_suspect'];record=[{'lang':'ki','index':1}]
        self.assertTrue(fn(record));self.assertEqual(record,[{'lang':'ki','index':1}])
        for value in (None,{},[],[{'lang':'en'}]):self.assertFalse(fn(value))
    def test_all_existing_jobs_and_evidence_are_protected(self):
        fn=load(['decision'],{})['decision']
        for state in ('failed','quarantined','verified','queued','running','expired','cancelled'):
            self.assertEqual(fn({'job':{'state':state}}),'existing_job_protected')
        self.assertEqual(fn({'verified':True}),'verified_preserved')
        self.assertEqual(fn({'retryAt':'2099-01-01T00:00:00Z'}),'retry_preserved')
        self.assertEqual(fn({'probeCircuitRetryAt':'2099'}),'provider_circuit_open')
    def run_step(self,root,after,fail=False):
        operations=[];files={};row={'sample':1,'original_tracks':[{'index':1,'lang':'ki'}]}
        before={'tracks':row['original_tracks']};values=iter([before,after])
        def probe(_):
            operations.append('probe')
            if fail:raise TimeoutError()
            return {'persisted':1,'attempted':1}
        pilot=types.SimpleNamespace(current=lambda _:next(values),controls=lambda:True,header_probe=probe,
            track_unknown=lambda t:t.get('lang') is None,profile_ready=lambda _:True,
            enqueue=lambda *_:operations.append('enqueue') or {'jobId':'new'},datetime=datetime)
        def save(name,data):
            require(name not in files,'duplicate_receipt');files[name]=data
        scope=load(['step','decision','is_suspect'],{'ROOT':root,'guard':lambda:{'rows':[row]},'pilot':pilot,'save':save,'print':lambda _:None})
        return lambda:scope['step'](1),operations,files
    def test_fresh_non_suspect_map_stops_at_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            run,ops,files=self.run_step(pathlib.Path(tmp),{'tracks':[{'index':1,'lang':'hi'}]})
            run();self.assertEqual(ops,['probe']);self.assertEqual(files['01-closed.private.json']['result'],'fresh_metadata')
            self.assertEqual(files['01-before.private.json']['tracks'][0]['lang'],'ki')
    def test_unchanged_suspect_uses_existing_strict_rpc(self):
        with tempfile.TemporaryDirectory() as tmp:
            run,ops,files=self.run_step(pathlib.Path(tmp),{'tracks':[{'index':1,'lang':'ki'}]})
            run();self.assertEqual(ops,['probe','enqueue']);self.assertIn('01-enqueue-intent.private.json',files)
    def test_uncertain_transport_gets_a_terminal_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            run,ops,files=self.run_step(pathlib.Path(tmp),{},True)
            with self.assertRaisesRegex(RuntimeError,'operation_failed_or_uncertain'):run()
            self.assertEqual(ops,['probe']);self.assertIn('01-failed.private.json',files)
    def test_prior_intent_prevents_replay(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);(root/'01-intent.private.json').touch()
            run,ops,_=self.run_step(root,{})
            with self.assertRaisesRegex(RuntimeError,'prior_intent_protected'):run()
            self.assertEqual(ops,[])
    def test_sql_selector_is_active_exact_file_and_no_prior_job(self):
        src=SOURCE.read_text(encoding='utf-8')
        for needle in ('h.active_generation_id','admin_internal_accounts','audio_lang_verified_at IS NULL',
            'NOT EXISTS(SELECT 1 FROM public.catalog_file_audio_validation_jobs','len(rows)<=18'):
            self.assertIn(needle,src)
        self.assertNotRegex(src,r'\b(?:UPDATE|DELETE|TRUNCATE)\s+public\.')
if __name__=='__main__':unittest.main()
