import copy, importlib.util, pathlib, sys, types, unittest
try:
    import fcntl
except ModuleNotFoundError:
    sys.modules['fcntl'] = types.SimpleNamespace()

PATH = pathlib.Path(__file__).resolve().parents[1] / 'ops/hetzner/scripts/continue-reported-language-tags-20260913.py'
spec = importlib.util.spec_from_file_location('continuation', PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ContinuationTest(unittest.TestCase):
    def setUp(self):
        self.probe = {'attempted': 1, 'persisted': 1}
        self.after = {'tracks': [{'index': 1, 'lang': 'or'}], 'observedFingerprint': 'bound',
                      'observedAt': 'same-time', 'profile': {'audioTracks': [{'index': 1, 'language': 'or'}]}}
        self.current = copy.deepcopy(self.after)

    def check(self):
        return module.reconciled_probe(self.probe, self.after, self.current, lambda t: t.get('lang') in (None, 'und'))

    def test_fresh_rare_tag_is_preserved_not_a_blacklist(self):
        self.assertTrue(self.check())

    def test_partial_uncertain_or_unbound_probe_is_refused(self):
        for key, value in (('attempted', 0), ('persisted', 0), ('attempted', True)):
            with self.subTest(key=key, value=value):
                self.setUp(); self.probe[key] = value; self.assertFalse(self.check())
        for key in ('tracks', 'observedFingerprint'):
            self.setUp(); self.after[key] = None; self.assertFalse(self.check())

    def test_any_job_or_changed_profile_is_protected(self):
        for state in ('queued', 'completed', 'failed', 'quarantined'):
            self.setUp(); self.current['job'] = {'state': state}; self.assertFalse(self.check())
        for key in ('tracks', 'profile', 'observedFingerprint', 'observedAt'):
            self.setUp(); self.current[key] = 'changed'; self.assertFalse(self.check())

    def test_unknown_file_is_not_reconciled_as_tagged(self):
        self.after['tracks'] = [{'index': 1, 'lang': 'und'}]
        self.current = copy.deepcopy(self.after)
        self.assertFalse(self.check())

    def test_preserves_expiry_receipts_and_never_retries_first_file(self):
        source = PATH.read_text()
        for text in ("plan['rows'][1:]", "'rows': rows, 'protected': protected", '*-failed.private.json',
                     "operator.is_suspect = lambda tracks: False", 'old.pilot.profile_ready(current)',
                     'operator.step(int(sys.argv[2]))', "old.ROOT / 'plan.private.json'"):
            self.assertIn(text, source)
        for text in ('unlink(', "'expiresAt':", 'UPDATE public.', 'DELETE FROM'):
            self.assertNotIn(text, source)


if __name__ == '__main__':
    unittest.main()
