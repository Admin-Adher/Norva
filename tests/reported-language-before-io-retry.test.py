import importlib.util, pathlib, sys, types, unittest
try:
    import fcntl
except ModuleNotFoundError:
    sys.modules['fcntl'] = types.SimpleNamespace()
PATH = pathlib.Path(__file__).resolve().parents[1] / 'ops/hetzner/scripts/retry-reported-language-before-io-20260913.py'
spec = importlib.util.spec_from_file_location('retry', PATH)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class RetryTest(unittest.TestCase):
    def test_only_positive_zero_io_proof_allows_retry(self):
        self.assertTrue(module.safe_before_io({'result':'deferred','diagnostic':
            {'attempted':0,'persisted':0,'deferredBeforeIO':True,'reason':'provider-account-busy'}}))
        for data in (None, {}, {'attempted':1,'persisted':0,'deferredBeforeIO':True,'reason':'provider-account-busy'},
                     {'attempted':False,'persisted':0,'deferredBeforeIO':True,'reason':'provider-account-busy'},
                     {'attempted':0,'persisted':1,'deferredBeforeIO':True,'reason':'provider-account-busy'},
                     {'attempted':0,'persisted':0,'deferredBeforeIO':False,'reason':'provider-account-busy'}):
            self.assertFalse(module.safe_before_io({'result':'deferred','diagnostic':data}))

    def test_scoped_durable_guards_without_resets(self):
        source = PATH.read_text()
        for text in ("for sample in (1, 2)", "not any(old.ROOT.glob('*-failed.private.json'))",
                     "'retry_already_prepared'", 'old.guard()', "'rows': rows, 'protected': protected",
                     "operator.step(int(sys.argv[2]))", "old.ROOT / 'plan.private.json'"):
            self.assertIn(text,source)
        for text in ('unlink(', "'expiresAt':", 'UPDATE public.', 'DELETE FROM'):
            self.assertNotIn(text,source)

if __name__ == '__main__': unittest.main()
