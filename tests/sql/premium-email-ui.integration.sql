-- Presentation proof: no outbox, auth user or network calls.
do $test$
declare h text; n text;
begin
 h:=public.norva_branded_email_html('Hello <script> & "test"','<p>Trusted <strong>body</strong></p>','Open & review','https://norva.tv/account.html?a=1&b=2','Footer <x>');
 if position('<h1' in h)=0 or position('Hello &lt;script&gt; &amp; &quot;test&quot;' in h)=0 then raise exception 'heading not escaped';end if;
 if position('<p>Trusted <strong>body</strong></p>' in h)=0 then raise exception 'body markup changed';end if;
 if position('href="https://norva.tv/account.html?a=1&amp;b=2"' in h)=0 or position('Open &amp; review' in h)=0 then raise exception 'CTA not escaped';end if;
 if position('Footer &lt;x&gt;' in h)=0 then raise exception 'footer not escaped';end if;
 if position('bgcolor="#080B12"' in h)=0 or position('mso-padding-alt:16px 24px' in h)=0 then raise exception 'client fallback missing';end if;
 n:=public.norva_branded_email_html(null,null,null,null,null);
 if n is null or position('<!doctype html>' in n)=0 or position('mso-padding-alt:' in n)>0 then raise exception 'null values or optional CTA broken';end if;
 n:=public.norva_branded_email_html('Title','Body','   ','https://norva.tv');
 if position('mso-padding-alt:' in n)>0 then raise exception 'blank CTA rendered';end if;
end $test$;
select 'PREMIUM_EMAIL_UI_PROOF_OK';
