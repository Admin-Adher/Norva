import copy
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('operator', pathlib.Path(__file__).with_name('rollout-durable-idle-gateway.py'))
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)

class DurableHandoff(unittest.TestCase):
    def setUp(self):
        self.h = dict(transcribeQueueDepth=1, transcribeBusy=True, ocrQueueDepth=0, translateQueueDepth=0,
            activeSessions=2, storyboardDurability=dict(protocol=2, enabled=True, pending=1),
            languageForegroundWork=dict(protocol=1, busy=False, activeOperations=0, admissionChecks=0,
                pendingPriorityJobs=0, deferredBackgroundJobs=1))

    def test_only_deferred_coordinator_flag_changes(self):
        before = copy.deepcopy(self.h)
        result = operator.deferred_health(self.h, 1, True)
        self.assertEqual(self.h, before)
        self.assertEqual(result, {**before, 'transcribeBusy': False})
        self.assertEqual(result['activeSessions'], 2) # ordinary rollout still rejects viewers

    def test_rejects_active_unknown_or_unpersisted_work(self):
        for key in ('activeOperations', 'admissionChecks', 'pendingPriorityJobs'):
            h = copy.deepcopy(self.h); h['languageForegroundWork'][key] = 1
            with self.subTest(key=key), self.assertRaises(AssertionError):
                operator.deferred_health(h, 1, True)
        for count, persistent in ((0, True), (2, True), (True, True), (1, False)):
            with self.subTest(count=count, persistent=persistent), self.assertRaises(AssertionError):
                operator.deferred_health(self.h, count, persistent)
        h = copy.deepcopy(self.h); h['ocrQueueDepth'] = 1
        with self.assertRaises(AssertionError): operator.deferred_health(h, 1, True)

if __name__ == '__main__': unittest.main()
