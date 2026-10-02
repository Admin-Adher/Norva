begin;
do $test$
declare result jsonb; value jsonb;
begin
 result:=public.norva_selection_public_editorial_metadata(
   '{"tmdb":{"id":1399,"number_of_seasons":8,"password":"private"},"user_id":"private"}');
 if result#>'{tmdb,number_of_seasons}'<>'8'::jsonb or result#>'{tmdb,password}' is not null or result?'user_id' then
   raise exception 'Public season count lost or private fields exposed'; end if;
 for value in select v from jsonb_array_elements('["8",-1,1.5,1001,{"url":"private"},null]') v loop
   result:=public.norva_selection_public_editorial_metadata(jsonb_build_object('tmdb',jsonb_build_object('number_of_seasons',value)));
   if result#>'{tmdb,number_of_seasons}' is not null then raise exception 'Invalid public season count accepted: %',value; end if;
 end loop;
 raise notice 'PASS: public season count preserved; invalid and private fields excluded';
end $test$;
rollback;
