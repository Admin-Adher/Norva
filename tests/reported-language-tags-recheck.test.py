import importlib.util, pathlib, sys, types, unittest
try:
    import fcntl
except ModuleNotFoundError:
    sys.modules['fcntl'] = types.SimpleNamespace()

PATH = pathlib.Path(__file__).resolve().parents[1] / 'ops/hetzner/scripts/recheck-reported-language-tags-20260913.py'
spec = importlib.util.spec_from_file_location('cohort', PATH)
cohort = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cohort)


class ReportedCohortTest(unittest.TestCase):
    def test_only_explicit_reported_track_codes(self):
        for code in cohort.CODES:
            self.assertTrue(cohort.reported_track([{'index':1,'lang':code}]))
        for tracks in (None, {}, [], [{'title':'Bring Her Back'}], [{'lang':'en'}]):
            self.assertFalse(cohort.reported_track(tracks))

    def test_guards_preserve_current_evidence_and_all_jobs(self):
        source = PATH.read_text()
        for fragment in ('c.audio_lang_verified_at IS NULL', 'c.observed_profile_fingerprint IS NULL',
            "coalesce(c.audio_lang_verification,'{}'::jsonb)='{}'::jsonb",
            "coalesce(c.audio_whisper_verification,'{}'::jsonb)='{}'::jsonb",
            'h.active_generation_id', 'public.admin_internal_accounts',
            'WHERE NOT EXISTS(SELECT 1 FROM public.catalog_file_audio_validation_jobs',
            'len(rows) <= 15', 'operator.step(int(sys.argv[2]))'):
            self.assertIn(fragment, source)

    def test_bounded_immutable_plan_protects_every_operator(self):
        source = PATH.read_text()
        for fragment in ('ORIGINAL, operator.RELEASE, operator.PILOT',
            "'expiresAt': time.time()+3600", "'cohort_already_prepared'", "'protected':"):
            self.assertIn(fragment, source)
        self.assertNotIn('unlink(', source)
        self.assertNotIn('UPDATE public.', source)


if __name__ == '__main__':
    unittest.main()
