"""Offline checks for the one-shot approved interruption; no Docker/network."""
import ast
import copy
import datetime
import importlib.util
import json
import pathlib
import re
import tempfile
import types
import unittest
from unittest.mock import Mock

OPS = pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/scripts'
SOURCE = OPS/'deploy-admission-subtitle-maintenance-20260913.py'
spec = importlib.util.spec_from_file_location('previous_maintenance_tests', OPS/'test-enrichment-maintenance-20260912.py')
previous = importlib.util.module_from_spec(spec); spec.loader.exec_module(previous)


def functions(names, namespace):
    nodes = [node for node in ast.parse(SOURCE.read_text()).body if isinstance(node, ast.FunctionDef) and node.name in names]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), 'exec'), namespace)
    return namespace


class ScopedMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.rows = previous.jobs()
        self.ns = {'require':previous.require, 'copy':copy, 'datetime':datetime,
            're':re, 'UUID':re.compile(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}')}
        functions({'approved_subset','bind_scope','guard_health','literal','cancellation_sql'}, self.ns)
        self.receipt = [{'jobId':row['job_id'],'kind':row['kind'],'createdAt':row['created_at']} for row in self.rows]

    def test_old_receipt_not_current_queue_is_the_authority(self):
        self.ns['bind_scope'](self.rows, self.receipt)
        for field in ('job_id','kind','created_at'):
            changed = copy.deepcopy(self.rows); changed[0][field] = 'unexpected'
            with self.assertRaises((RuntimeError, ValueError)):
                self.ns['bind_scope'](changed, self.receipt)

    def test_new_missing_or_changed_jobs_fail_closed(self):
        for rows in (self.rows[:1], self.rows+[dict(self.rows[0],job_id='other')]):
            with self.assertRaises(RuntimeError):
                self.ns['approved_subset'](rows, self.rows)
        for field in ('identity_hash','kind','created_at'):
            changed = copy.deepcopy(self.rows); changed[0][field] = 'other'
            with self.assertRaises(RuntimeError):
                self.ns['approved_subset'](changed, self.rows)

    def test_completed_jobs_are_excluded(self):
        rows = copy.deepcopy(self.rows); rows[0]['status'] = 'ready'
        self.assertEqual(self.ns['approved_subset'](rows,self.rows),rows[1:])

    def test_all_other_live_activity_still_blocks(self):
        guards = previous.MaintenanceTests(); guards.setUp()
        self.ns['gw'] = guards.ns['gw']
        health = {**previous.baseline_health(),'activeViewerSubtitleOperations':0,
            'pendingViewerSubtitleOperations':0,'argosInferenceActive':0}
        self.ns['guard_health'](health, self.rows)
        for key in ('activeSessions','activeStrictLidBrokers','backgroundCpuProcessCount',
            'rawPumpCount','viewerStartupReservations','viewerSessionStartupAdmissions','ocrQueueDepth',
            'translateQueueDepth','activeViewerSubtitleOperations','pendingViewerSubtitleOperations','argosInferenceActive'):
            with self.assertRaises(RuntimeError):
                self.ns['guard_health']({**health,key:1},self.rows)
        for key,value in (('transcribeQueueDepth',0),('transcribeQueueDepth',3),('whisperInferenceActive',2),
            ('backgroundWhisperInferenceActive',0),('transcribeBusy',False)):
            with self.assertRaises(RuntimeError):
                self.ns['guard_health']({**health,key:value},self.rows)

    def test_sql_is_atomic_and_keeps_partial_data(self):
        self.ns['REASON'] = 'maintenance'
        query = self.ns['cancellation_sql'](self.rows)
        self.assertTrue(query.startswith('BEGIN;')); self.assertTrue(query.endswith('COMMIT;'))
        self.assertEqual(query.count('FOR UPDATE'),2)
        self.assertEqual(query.count('UPDATE public.catalog_generated_subtitles'),2)
        for forbidden in ('DELETE','TRUNCATE','vtt=','vtt =','segments=','audio_sec=','job_id=NULL'):
            self.assertNotIn(forbidden,query)
        rows = copy.deepcopy(self.rows); rows[0]['status']='ready'
        query = self.ns['cancellation_sql'](rows)
        self.assertNotIn(rows[0]['job_id'],query)

    def test_stop_is_required_before_any_database_write(self):
        writes=[]
        ns=functions({'cancel_stopped'},{'require':previous.require,
            'gw':types.SimpleNamespace(inspect=lambda _:{'State':{'Running':True}}),
            'sql':lambda *_,**__:writes.append(True)})
        with self.assertRaisesRegex(RuntimeError,'subtitle_coordinator_still_running'):
            ns['cancel_stopped']({'gatewayId':'owned'})
        self.assertEqual(writes,[])

    def test_cancellation_failure_still_restores_stopped_owned_service(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); (root/'receipt.private.json').write_text('{}')
            original={'Id':'old','State':{'Running':False}}
            candidate={'Id':'new','State':{'Running':False}}
            plan={'original':original}; receipt={'candidateContainer':'new'}; events=[]
            def saved(name):
                return {'plan.private.json':plan,'receipt.private.json':receipt,'subtitle-authorization.private.json':{}}[name]
            def failed_cancel(_):
                events.append('cancel'); raise RuntimeError('injected_cancel_failure')
            ns=functions({'recover'},{'require':previous.require,'ROOT':root,'invariant':lambda _:None,
                'op':types.SimpleNamespace(saved=saved,SERVICE='gateway',edge=types.SimpleNamespace(restore=lambda *_:events.append('restore'))),
                'gw':types.SimpleNamespace(inspect=lambda name:original if name=='old' else candidate,
                    docker_api=lambda *_:[{'Id':'old','Names':['/gateway']}]),
                'cancel_stopped':failed_cancel,'ordinary_recover':lambda:events.append('ordinary')})
            with self.assertRaisesRegex(RuntimeError,'injected_cancel_failure'):
                ns['recover']()
            self.assertEqual(events,['cancel','restore'])
            ns['gw'].docker_api=lambda *_:[{'Id':'foreign','Names':['/gateway']}]
            events.clear()
            with self.assertRaisesRegex(RuntimeError,'recovery_container_not_owned'):
                ns['recover']()
            self.assertEqual(events,[])

    def test_running_candidate_is_not_stopped_by_targeted_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); (root/'receipt.private.json').write_text('{}')
            op=types.SimpleNamespace(saved=lambda name: {'original':{'Id':'old'}} if name=='plan.private.json'
                else {'candidateContainer':'new'})
            restore=Mock(return_value=True)
            ns=functions({'recover'},{'ROOT':root,'invariant':lambda _:None,'op':op,
                'gw':types.SimpleNamespace(inspect=lambda name:{'State':{'Running':name=='new'}}),
                'ordinary_recover':restore})
            self.assertTrue(ns['recover']()); restore.assert_called_once_with()

    def test_no_permanent_bypass_or_quarantine_mutation(self):
        source=SOURCE.read_text()
        for forbidden in ('UPDATE public.catalog_file_audio_validation_jobs','DELETE FROM','TRUNCATE',
            'os.kill(', 'op.recovery_idle =','op.base.previous.d.idle =','PROVIDER_PROXY_'):
            self.assertNotIn(forbidden,source)
        self.assertLess(source.index("gw.run(['docker','stop'"),source.index('cancel_stopped(approval)\n    gw.run'))
        self.assertIn('subtitle-scope-1789263958247573154.private.json',source)


if __name__ == '__main__':
    unittest.main()
