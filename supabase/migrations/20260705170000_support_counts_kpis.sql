-- Support page KPIs: extend admin_support_counts with the figures the Support
-- header cards need (in-progress + resolved 7d/30d), on top of the existing
-- open / needs_reply / stale_24h. "Resolved" uses the ticket's updated_at as a
-- proxy for when it was closed.
create or replace function public.admin_support_counts()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'open',         (select count(*) from cloud_support_tickets where status <> 'closed'),
    'needs_reply',  (select count(*) from cloud_support_tickets where status <> 'closed' and last_from = 'user'),
    'in_progress',  (select count(*) from cloud_support_tickets where status <> 'closed' and last_from <> 'user'),
    'stale_24h',    (select count(*) from cloud_support_tickets where status <> 'closed' and last_from = 'user' and last_message_at < now() - interval '24 hours'),
    'resolved_7d',  (select count(*) from cloud_support_tickets where status = 'closed' and updated_at > now() - interval '7 days'),
    'resolved_30d', (select count(*) from cloud_support_tickets where status = 'closed' and updated_at > now() - interval '30 days')
  ) where public.is_admin();
$$;
