import copy
import datetime as dt
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('cleanup', Path(__file__).resolve().parents[1] / 'ops/backup/cleanup-reviewed-legacy-20261002.py')
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class FakeS3:
    def __init__(self):
        self.now = dt.datetime.now(dt.timezone.utc)
        keys = [*cleanup.DELETE, cleanup.RETAIN]
        keys += [f'selfhost/dumps/norva-selfhost-202609{day:02d}-034000.tar.gz.age' for day in range(17, 31)]
        keys += [f'selfhost/base/base-{day}/base.tar.gz' for day in range(3)]
        keys += ['selfhost/wal/KEEP', 'db/unrelated-KEEP']
        self.objects = {k: dict(Key=k, Size=2_000_000_000, ETag='unchanged', LastModified=self.now) for k in keys}
        self.deleted = []

    def get_paginator(self, _):
        return self

    def paginate(self, Bucket, Prefix):
        yield {'Contents': [copy.copy(o) for k, o in self.objects.items() if k.startswith(Prefix)]}

    def head_object(self, Bucket, Key):
        return dict(ContentLength=self.objects[Key]['Size'], ETag=self.objects[Key]['ETag'])

    def delete_object(self, Bucket, Key):
        self.deleted.append(Key)
        del self.objects[Key]


class CleanupTests(unittest.TestCase):
    def test_dry_run_never_deletes(self):
        s3 = FakeS3()
        self.run_in_temp(s3, False)
        self.assertEqual(s3.deleted, [])

    def test_apply_only_allowlist_and_idempotent(self):
        s3 = FakeS3()
        self.run_in_temp(s3, True)
        self.assertEqual(s3.deleted, list(cleanup.DELETE))
        self.assertIn(cleanup.RETAIN, s3.objects)
        self.assertIn('selfhost/wal/KEEP', s3.objects)
        self.assertIn('db/unrelated-KEEP', s3.objects)
        self.run_in_temp(s3, True)
        self.assertEqual(len(s3.deleted), 3)

    def test_missing_replacement_blocks(self):
        s3 = FakeS3()
        del s3.objects['selfhost/dumps/norva-selfhost-20260920-034000.tar.gz.age']
        with self.assertRaises(RuntimeError):
            self.run_in_temp(s3, True)
        self.assertEqual(s3.deleted, [])

    def test_stale_main_backups_block(self):
        s3 = FakeS3()
        for k, o in s3.objects.items():
            if k.startswith('selfhost/'):
                o['LastModified'] -= dt.timedelta(days=3)
        with self.assertRaises(RuntimeError):
            self.run_in_temp(s3, True)
        self.assertEqual(s3.deleted, [])

    def test_retained_archive_missing_blocks(self):
        s3 = FakeS3()
        del s3.objects[cleanup.RETAIN]
        with self.assertRaises(RuntimeError):
            self.run_in_temp(s3, True)
        self.assertEqual(s3.deleted, [])

    def run_in_temp(self, s3, apply):
        cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                cleanup.run(s3, apply)
            finally:
                os.chdir(cwd)


if __name__ == '__main__':
    unittest.main()
