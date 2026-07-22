begin;

alter table public.paywall_funnel_events
  drop constraint if exists paywall_funnel_events_event_source_check;

alter table public.paywall_funnel_events
  add constraint paywall_funnel_events_event_source_check check (event_source in (
    'client_rpc', 'checkout_order', 'native_google_play', 'billing_ledger',
    'entitlement_projection', 'playback_first_frame'
  ));

commit;

notify pgrst, 'reload schema';
