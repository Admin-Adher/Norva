-- A verified public season count is editorial data and must survive a synopsis
-- refresh. Reject non-numeric, negative, fractional and excessive values.
begin;
set local lock_timeout='3s';
do $upgrade$
declare d text; needle text;
begin
 select pg_get_functiondef('public.norva_selection_public_editorial_metadata(jsonb)'::regprocedure) into d;
 if position('number_of_seasons' in d)>0 then
   raise exception 'Public season count already installed' using errcode='55000'; end if;
 needle:='''status'',''confidence'',''matched''';
 if length(d)-length(replace(d,needle,''))<>length(needle) then raise exception 'Editorial allowlist drift'; end if;
 d:=replace(d,needle,needle||',''number_of_seasons''');
 needle:='and v<>''null''::jsonb and v<>''""''::jsonb';
 if length(d)-length(replace(d,needle,''))<>length(needle) then raise exception 'Editorial field guard drift'; end if;
 d:=replace(d,needle,needle||$guard$
       and (k<>'number_of_seasons' or (jsonb_typeof(v)='number'
         and public.safe_numeric(v#>>'{}') between 0 and 1000
         and public.safe_numeric(v#>>'{}')=trunc(public.safe_numeric(v#>>'{}'))))$guard$);
 execute d;
end $upgrade$;
notify pgrst,'reload schema';
commit;
