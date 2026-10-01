begin;
-- A verified Google Orders + Subscriptions response can confirm an offer during
-- the remaining-access interval, before RevenueCat emits its first paid renewal.
create or replace function public.norva_play_retention_purchase() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.cloud_play_retention_offers%rowtype; bought timestamptz;
  proof jsonb := new.payload #> '{_norva,play_retention}'; offer_code text;
begin
 if new.provider is distinct from 'revenuecat' or new.processed_at is null
    or new.event_type not in ('INITIAL_PURCHASE','RENEWAL')
    or new.payload->>'store' is distinct from 'PLAY_STORE'
    or new.payload->>'environment' is distinct from 'PRODUCTION'
    or not (coalesce(new.payload->'_norva','{}'::jsonb) ? 'projection_applied')
    or coalesce(new.payload->>'original_transaction_id','')='' then return new; end if;
 offer_code := new.payload->>'offer_code';
 if coalesce(offer_code,'')='' and new.event_type='INITIAL_PURCHASE'
    and proof->>'source'='google_play_api'
    and proof->>'environment'=new.payload->>'environment' then
   offer_code := proof->>'offerId';
 end if;
 if coalesce(offer_code,'') not in ('retention-monthly-20','retention-annual-10') then return new; end if;
 if coalesce(new.payload->>'purchased_at_ms','') !~ '^[0-9]{10,16}$' then return new; end if;
 bought:=to_timestamp((new.payload->>'purchased_at_ms')::numeric/1000);
 perform pg_advisory_xact_lock(hashtextextended('norva:revolut:money:'||new.user_id::text,0));
 select * into o from public.cloud_play_retention_offers where user_id=new.user_id
   and state in ('offered','declined') and product_id=new.payload->>'product_id' and offer_id=offer_code
   and claimed_at is not null and bought>=claimed_at-interval '5 minutes'
   and bought<=expires_at+interval '1 day' order by claimed_at desc limit 1 for update;
 if not found then return new; end if;
 if coalesce(new.payload->>'offer_code','')='' then
   if proof->>'claimId' is distinct from o.claim_id::text
      or nullif(proof->>'accessUntil','') is null then return new; end if;
   begin
     if (proof->>'accessUntil')::timestamptz < o.access_until then return new; end if;
   exception when invalid_datetime_format or datetime_field_overflow then return new;
   end;
 end if;
 update public.cloud_play_retention_offers set state='accepted',accepted_at=bought,
   purchase_event=new.provider_event_id,original_transaction_id=new.payload->>'original_transaction_id'
 where id=o.id;
 return new;
end;
$$;
commit;
