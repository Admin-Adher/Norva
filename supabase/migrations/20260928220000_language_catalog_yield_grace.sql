begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- The foreground activity grace lasts five minutes. A 90-second catalogue
-- yield can expire while the two-job scheduler serves another provider, letting
-- catalogue traffic renew that grace forever. Cover the grace plus one cron
-- interval; retain the existing ten-minute shared window and two-minute cooldown.
-- This grants no provider connection and never changes the activity ledger.
do $patch$
declare d text; needle text := 'interval ''90 seconds''';
begin
 d := pg_get_functiondef('public.request_language_validation_catalog_yield(uuid,text,text)'::regprocedure);
 if (length(d)-length(replace(d,needle,'')))/length(needle) <> 3 then
  raise exception 'Catalogue yield duration baseline drift';
 end if;
 execute replace(d,needle,'interval ''6 minutes''');
end $patch$;
commit;
