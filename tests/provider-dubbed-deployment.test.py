"""Exercise the new adapter functions without importing live deployment tools."""
import ast,io,json,pathlib,tarfile,tempfile,time,types,unittest
SOURCE=pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/scripts/deploy-provider-dubbed-20260913.py'
def require(ok,code):
    if not ok:raise RuntimeError(code)
def functions(names,context):
    tree=ast.parse(SOURCE.read_text(encoding='utf-8'))
    code=ast.Module(body=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names],type_ignores=[])
    namespace={'require':require,'json':json,'re':__import__('re'),'tarfile':tarfile,'time':time,**context}
    exec(compile(code,str(SOURCE),'exec'),namespace);return namespace
class DeploymentTests(unittest.TestCase):
    def test_source_requires_live_baseline_and_one_generated_parser(self):
        f=functions(['source_delta'],{})['source_delta']
        new=b'function normalizeProviderDubbedCategory(value) {}\nvalue = normalizeProviderDubbedCategory(value);'
        self.assertEqual(f(b'old\r\n',b'old\n',new),new)
        for live,old,candidate in [(b'drift',b'old\n',new),(b'old',b'old',new+new),(b'old',b'old',b'other')]:
            with self.assertRaises(RuntimeError):f(live,old,candidate)
    def test_archive_refuses_other_paths_and_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);f=functions(['payload'],{'ROOT':root,'FILE':'_shared/provider-catalog-language.mjs'})['payload']
            for name,kind,success in [('supabase/functions/_shared/provider-catalog-language.mjs',tarfile.REGTYPE,True),
                ('supabase/functions/norva-playback/index.ts',tarfile.REGTYPE,False),('../escape',tarfile.REGTYPE,False),
                ('supabase/functions/_shared/provider-catalog-language.mjs',tarfile.SYMTYPE,False)]:
                with tarfile.open(root/'candidate.tar','w') as out:
                    entry=tarfile.TarInfo(name);entry.type=kind;entry.size=4 if kind==tarfile.REGTYPE else 0
                    out.addfile(entry,io.BytesIO(b'test') if entry.size else None)
                if success:self.assertEqual(f('candidate'),b'test')
                else:
                    with self.assertRaises(RuntimeError):f('candidate')
    def test_recovery_checks_real_sql_state_after_uncertain_apply(self):
        for installed in [False,True]:
            actions=[];before=[{'signature':'old','definition':'old'}];rows=before+[{'signature':'helper','definition':'new'}] if installed else before
            with tempfile.TemporaryDirectory() as tmp:
                base=types.SimpleNamespace(process_alive=lambda _:False,idle=lambda:None,invariant=lambda _:None,SERVICES=(),
                    core=types.SimpleNamespace(base=types.SimpleNamespace(r=types.SimpleNamespace(alter_crons=lambda *_:actions.append('restore'),crons=lambda:[1]))))
                f=functions(['recover','definition_map'],{'ROOT':pathlib.Path(tmp),'base':base,'definitions':lambda:rows,
                    'verify_sql':lambda:actions.append('verify'),'save':lambda name,data:actions.append(data)})['recover']
                f({'sqlBefore':before,'crons':[1]})
                self.assertEqual(actions[-1]['sqlApplied'],installed)
                self.assertEqual('verify' in actions,installed)
                self.assertIn('restore',actions)
    def test_recovery_never_replaces_a_live_runner(self):
        base=types.SimpleNamespace(process_alive=lambda _:True)
        with self.assertRaisesRegex(RuntimeError,'runner_still_active'):
            functions(['recover'],{'base':base})['recover']({})
    def test_backfill_is_only_a_locked_sparse_hint_projection(self):
        tree=ast.parse(SOURCE.read_text(encoding='utf-8'));node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='backfill')
        query=next(n.value for n in ast.walk(node) if isinstance(n,ast.Constant) and isinstance(n.value,str) and 'WITH candidates' in n.value)
        self.assertIn('LIMIT 500 FOR SHARE OF v',query)
        self.assertIn('ON CONFLICT(variant_id) DO NOTHING',query)
        self.assertIn('v.user_id,v.title_id,v.source_id,v.item_type',query)
        self.assertIn('INSERT INTO public.cloud_catalog_provider_language_hints',query)
        self.assertNotIn('UPDATE ',query);self.assertNotIn('DELETE ',query)
        self.assertNotIn('catalog_file_audio_validation_jobs',query)
if __name__=='__main__':unittest.main()
