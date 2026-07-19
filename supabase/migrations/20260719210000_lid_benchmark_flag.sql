-- Manual, fail-closed gate for the read-only audio language benchmark.
-- It remains disabled outside a deliberately bounded operator run.
insert into public.admin_feature_flags(key, enabled, description)
values (
  'lid_benchmark_enabled',
  false,
  'Autorise temporairement le benchmark LID audio en lecture seule'
)
on conflict (key) do nothing;
