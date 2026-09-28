"""Emit an isolated SQL fixture using the repository's actual lease implementation."""
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
def read(path):
    return (root / path).read_text(encoding='utf-8')

base = read('supabase/migrations/20260911204928_exact_file_account_enrichment_admission.sql')
marker = '-- Rolling deployments cannot let an older identity-wide crawler bypass the new'
assert base.count(marker) == 1
parts = [
    read('tests/sql/metadata-rollout.setup.sql'),
    read('supabase/migrations/20260928194000_language_metadata_progressive_rollout.sql'),
    read('tests/sql/exact-file-scoped.setup.sql'),
    base.split(marker)[0] + '\ncommit;\n',
    read('supabase/migrations/20260928211000_exact_file_scoped_rollout.sql'),
    read('tests/sql/exact-file-scoped.sql'),
]
sys.stdout.buffer.write('\n'.join(parts).encode('utf-8'))
