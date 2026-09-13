import importlib.util, pathlib, sys, types, unittest

try:
    import fcntl
except ModuleNotFoundError:
    sys.modules['fcntl'] = types.SimpleNamespace()

PATH = pathlib.Path(__file__).resolve().parents[1] / 'ops/hetzner/scripts/retry-legacy-language-before-io-20260913.py'
spec = importlib.util.spec_from_file_location('retry_policy', PATH)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class BeforeIoRetryTest(unittest.TestCase):
    def receipt(self, **overrides):
        return {'result': 'deferred', 'diagnostic': {'attempted': 0, 'persisted': 0,
            'deferredBeforeIO': True, 'reason': 'provider-account-busy', **overrides}}

    def test_confirmed_zero_io_busy_only(self):
        self.assertTrue(policy.safe_before_io(self.receipt()))

    def test_attempted_or_persisted_never_retried(self):
        for value in (self.receipt(attempted=1), self.receipt(persisted=1)):
            self.assertFalse(policy.safe_before_io(value))

    def test_uncertain_or_other_block_not_retried(self):
        for value in (self.receipt(deferredBeforeIO=False), self.receipt(reason='timeout'),
                      self.receipt(attempted=False), self.receipt(persisted='0'), None, {}):
            self.assertFalse(policy.safe_before_io(value))

    def test_durable_terminal_outcomes_are_not_restarted(self):
        for result in ('queued', 'verified', 'failed', 'quarantined', 'enqueue_deferred'):
            self.assertFalse(policy.safe_before_io({**self.receipt(), 'result': result}))

    def test_preserves_original_plan_and_existing_guards(self):
        source = PATH.read_text()
        for fragment in ('operator.guard()', "operator.saved('01-closed.private.json')",
                         "'rows': [row]", 'operator.step(1)', "'retry_already_journaled'"):
            self.assertIn(fragment, source)
        self.assertNotIn('expiresAt=', source)
        self.assertNotIn('unlink(', source)
        self.assertNotIn('release_provider', source)


if __name__ == '__main__':
    unittest.main()
