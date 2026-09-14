"""Offline validation of the six-file adapter; private runtime is never loaded."""
import ast, copy, importlib.util, pathlib, tempfile, types, unittest
from unittest import mock
ROOT=pathlib.Path(__file__).resolve().parents[2]
PATH=ROOT/'ops/hetzner/scripts/deploy-unknown-first-language-edge.py'
spec=importlib.util.spec_from_file_location('owned_edge_under_test',PATH)
op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op)

class EdgeBindingTests(unittest.TestCase):
    def setUp(self):
        self.cfg={'schema':1,'commit':'a'*40,'sqlCommit':op.SQL_COMMIT,
          'edgeFiles':{name:[old,'b'*64] for name,old in op.BASE_HASHES.items()}}
    def test_exact_six_paths(self):
        self.assertEqual(op.validate(self.cfg),self.cfg)
        self.assertEqual(len(op.LIMITS),6)
        self.assertEqual(set(op.LIMITS),set(op.BASE_HASHES))
        self.assertEqual([p for p,h in op.BASE_HASHES.items() if h is None],['_shared/owned-provider-language-declarations.mjs'])
    def test_rejects_unreviewed_baseline(self):
        for key in self.cfg['edgeFiles']:
            cfg=copy.deepcopy(self.cfg);cfg['edgeFiles'][key][0]='c'*64
            with self.assertRaisesRegex(RuntimeError,'audited_baseline'):op.validate(cfg)
    def test_rejects_missing_extra_traversal_and_wrong_candidate(self):
        cases=[]
        cfg=copy.deepcopy(self.cfg);cfg['edgeFiles'].pop('norva-catalog/index.ts');cases.append(cfg)
        cfg=copy.deepcopy(self.cfg);cfg['edgeFiles']['../../other']=[None,'b'*64];cases.append(cfg)
        cfg=copy.deepcopy(self.cfg);cfg['edgeFiles']['norva-catalog/index.ts'][1]='bad';cases.append(cfg)
        cfg=copy.deepcopy(self.cfg);cfg['edgeFiles']['norva-catalog/index.ts'][1]=op.BASE_HASHES['norva-catalog/index.ts'];cases.append(cfg)
        for cfg in cases:
            with self.assertRaises(RuntimeError):op.validate(cfg)
    def test_rejects_sql_commit_drift(self):
        self.cfg['sqlCommit']='c'*40
        with self.assertRaisesRegex(RuntimeError,'release_binding'):op.validate(self.cfg)
    def test_adapter_preserves_guard_lifecycle(self):
        names=['stage','activate','recover','run','status','payload','stage_tree','verify_only_sql','main']
        lifecycle={name:object() for name in names}
        module=types.SimpleNamespace(**lifecycle,initialize=mock.Mock(),import_health=mock.Mock(),validate_files=mock.Mock())
        op.adapt(module,self.cfg,object())
        for name,value in lifecycle.items():self.assertIs(getattr(module,name),value)
        self.assertEqual(module.ADDED_FILES,frozenset(['_shared/owned-provider-language-declarations.mjs']))
        with mock.patch.object(op,'read',return_value=self.cfg):module.configure()
        self.assertEqual(module.FILES,self.cfg['edgeFiles']);module.validate_files.assert_called_once()
    def test_sql_snapshot_is_read_only_and_requires_prerequisites(self):
        signatures=[{'signature':name,'private':True,'hash':'d'*64} for name in op.EXTRA_SIGNATURES]
        surface={'tablePrivate':True,'viewPrivate':True,'rls':True,'viewOptions':['security_invoker=true']}
        import json
        sql=types.SimpleNamespace(bind=lambda:{'commit':op.SQL_COMMIT},definitions=lambda:[],state=lambda:{'metadataEnabled':False},
            query=mock.Mock(side_effect=[json.dumps(signatures),json.dumps(surface)]))
        def evidence(root,name):
            return {'commit':op.SQL_COMMIT,'functions':[]} if root==op.SQL_ROOT else {
                'commit':op.LEGACY_COMMIT,'verified':True,'functions':[{'signature':name,'sha256':'d'*64} for name in op.LEGACY_SIGNATURES]}
        with mock.patch.object(op,'read',side_effect=evidence):
            self.assertEqual(op.sql_snapshot(sql)['surface'],surface)
        for call in sql.query.call_args_list:
            self.assertEqual(len(call.args),1);self.assertEqual(call.kwargs,{})
    def test_enabled_switch_is_rejected_before_deployment(self):
        sql=types.SimpleNamespace(bind=lambda:{'commit':op.SQL_COMMIT},definitions=lambda:[],state=lambda:{'metadataEnabled':True},query=mock.Mock())
        with mock.patch.object(op,'read',return_value={'commit':op.SQL_COMMIT,'functions':[]}):
            with self.assertRaisesRegex(RuntimeError,'metadata_switch'):op.sql_snapshot(sql)
        sql.query.assert_not_called()
    def test_adapter_has_no_mutating_transport_or_idle_override(self):
        source=PATH.read_text();tree=ast.parse(source)
        attrs=[node.attr for node in ast.walk(tree) if isinstance(node,ast.Attribute) and isinstance(node.ctx,ast.Store)]
        for name in ['idle','activate','run','watch','launch','controls','alter_crons']:self.assertNotIn(name,attrs)
        self.assertNotIn('write=True',source);self.assertNotIn('docker_api(',source)
        self.assertIn("method='OPTIONS'",source)
    def test_failed_unactivated_drain_uses_pinned_no_container_closer(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(op,'ROOT',pathlib.Path(temp)):
            upstream=mock.Mock();closer=types.SimpleNamespace(close=mock.Mock())
            module=types.SimpleNamespace(initialize=mock.Mock(),import_health=mock.Mock(),recover=upstream,
                base=types.SimpleNamespace(SERVICES=('edge-a','edge-b')))
            op.adapt(module,self.cfg,object(),closer)
            plan={'commit':self.cfg['commit']}
            # A normal recovery still uses the original idle/retained guard.
            module.recover(plan);upstream.assert_called_once_with(plan);closer.close.assert_not_called()
            (op.ROOT/'failed.private.json').touch();module.recover(plan)
            closer.close.assert_called_once_with(module)
            # Any activation receipt forces the complete original recovery.
            (op.ROOT/'edge-a-receipt.private.json').touch();module.recover(plan)
            self.assertEqual(upstream.call_count,2);self.assertEqual(closer.close.call_count,1)

if __name__=='__main__':unittest.main()
