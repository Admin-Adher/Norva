"""Offline verifier fixtures: execute only its pure helpers, never its live main body."""
import ast
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

FILE = Path(__file__).resolve().parents[1] / 'ops/hetzner/postal/full-transport-v1/verify-production.py'
SOURCE = ast.parse(FILE.read_text())
PURE = ast.Module(body=[node for node in SOURCE.body
                       if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef))
                       or isinstance(node, ast.Assign) and any(
                           isinstance(target, ast.Name) and target.id in {'R', 'E', 'RELEASES'}
                           for target in node.targets)], type_ignores=[])
MODULE = {}
exec(compile(PURE, str(FILE), 'exec'), MODULE)


class ReleaseVerifierTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name).resolve()
        self.old, self.new = root / 'old', root / 'new'
        self.cloud = 'norva-cloud/index.ts'
        self.sender = 'norva-support/index.ts'
        for tree in [self.old, self.new]:
            for name, data in [(self.cloud, b'old context'), (self.sender, b'Postal sender')]:
                file = tree / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(data)
        (self.new / self.cloud).write_bytes(b'observed context')
        sha = lambda data: MODULE['hashlib'].sha256(data).hexdigest()
        active = patch.dict(MODULE['RELEASES'], {self.old: {}, self.new: {
            self.cloud: (sha(b'old context'), sha(b'observed context'))}}, clear=True)
        active.start()
        self.addCleanup(active.stop)

    def verify(self, source=None):
        return MODULE['verify_release'](source or self.new, self.old)

    def test_original_and_reviewed_overlay_pass(self):
        self.assertEqual(self.verify(self.old)['reviewedNonMailOverlays'], 0)
        self.assertEqual(self.verify(), {'verifiedFiles': 2, 'reviewedNonMailOverlays': 1})

    def test_changed_mail_sender_is_rejected(self):
        (self.new / self.sender).write_bytes(b'Resend sender')
        with self.assertRaisesRegex(RuntimeError, 'unreviewed_runtime_change'): self.verify()

    def test_overlay_is_exact_not_a_general_cloud_exception(self):
        (self.new / self.cloud).write_bytes(b'arbitrary context change')
        with self.assertRaisesRegex(RuntimeError, 'reviewed_overlay_hash_mismatch'): self.verify()

    def test_changed_overlay_baseline_is_rejected(self):
        (self.old / self.cloud).write_bytes(b'wrong baseline')
        with self.assertRaisesRegex(RuntimeError, 'reviewed_overlay_hash_mismatch'): self.verify()

    def test_extra_and_missing_files_are_rejected(self):
        extra = self.new / 'extra.ts'
        extra.write_bytes(b'extra')
        with self.assertRaisesRegex(RuntimeError, 'release_inventory_mismatch'): self.verify()
        extra.unlink()
        (self.new / self.sender).unlink()
        with self.assertRaisesRegex(RuntimeError, 'release_inventory_mismatch'): self.verify()

    def test_unknown_release_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'unapproved_release'): self.verify(self.new / 'other')

    def test_symlink_is_rejected(self):
        try: (self.new / 'linked.ts').symlink_to(self.new / self.sender)
        except OSError: self.skipTest('symlink creation not permitted on this host')
        with self.assertRaisesRegex(RuntimeError, 'release_symlink'): self.verify()


if __name__ == '__main__': unittest.main()
