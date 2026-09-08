"""Five explicitly labeled, idempotent internal email transport validations."""
import base64,json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parent
payload=base64.b64encode((root/'internal-validation.json').read_bytes()).decode()
q="""
begin;
set local lock_timeout='3s';
do $test$
declare u uuid;x jsonb;v_id uuid;v_to text;
begin
 select a.user_id,lower(btrim(u.email)) into strict u,v_to
 from admin_internal_accounts a join auth.users u on u.id=a.user_id
 where lower(u.email)='buildtrack.admin@gmail.com' and u.email_confirmed_at is not null;
 for x in select value from jsonb_array_elements(convert_from(decode('PAYLOAD','base64'),'UTF8')::jsonb) loop
  -- Freeze the exact rendered multipart sample at INSERT; transport payloads
  -- are immutable even before their first claim.
  v_id:=gen_random_uuid();
  insert into cloud_branded_email_outbox(id,delivery_key,dedupe_key,user_id,flow,state,
    recipient_email,request_from,request_reply_to,request_subject,request_html,request_text,request_tags,next_attempt_at)
  values(v_id,'norva-branded-'||v_id,'email-reliability-20260908:'||(x->>'flow'),u,'postal_transport_test','pending',
    v_to,'Norva <updates@norva.tv>','support@norva.tv',x->>'subject',x->>'html',x->>'text',
    '[{"name":"app","value":"norva"},{"name":"category","value":"transactional"},{"name":"flow","value":"postal_transport_test"}]',now())
  on conflict(dedupe_key) where dedupe_key is not null do nothing;
 end loop;
 perform norva_enqueue_branded_email(v_to,'[TEST Norva] Your Norva password was changed','Password changed — TEST',
  'TECHNICAL VALIDATION: no password was changed. Sample notification: The password on your Norva account was just changed. If this was you, no further action is needed.',
  'Go to my account','https://norva.tv/account.html',
  'If you did NOT change your password, reset it from the app immediately and review your account.',
  'postal_transport_test','email-reliability-20260908:security_password_changed',u);
 perform norva_enqueue_branded_email(v_to,'[TEST Norva] Your Norva email was changed','Email address changed — TEST',
  'TECHNICAL VALIDATION: no email address was changed. Sample notification: The email on your Norva account was changed to new-address@example.test. If this was you, no action is needed.',
  null,null,'If you did NOT request this change, contact support immediately.',
  'postal_transport_test','email-reliability-20260908:security_email_changed',u);
end $test$;
select state,count(*) from cloud_branded_email_outbox where dedupe_key like 'email-reliability-20260908:%' group by state;
commit;
""".replace('PAYLOAD',payload)
r=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-At','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],input=q,text=True,capture_output=True,timeout=30)
if r.returncode:raise RuntimeError(r.stderr[-1000:])
print(r.stdout)
