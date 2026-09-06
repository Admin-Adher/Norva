do $$begin
 if (select count(*) from public.full_proof_checks)<>40 then raise exception 'missing_checks';end if;
 if exists(select 1 from norva_postal_full.policy where enabled) then raise exception 'gate_reopened';end if;
 if (select count(*) from norva_postal_full.receipts where state='sent')<>7 then raise exception 'receipt_drift';end if;
 if not exists(select 1 from public.cloud_email_suppressions where active and complaint_seen_at is not null) then raise exception 'suppression_lost';end if;
end$$;
