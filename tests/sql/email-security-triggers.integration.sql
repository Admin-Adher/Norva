-- Disposable database only. Real trigger guards and functions, no mail transport.
begin;
insert into auth.users(id,email,encrypted_password,email_confirmed_at,updated_at)
values ('10000000-0000-0000-0000-000000000001','old@example.test','hash0',null,now());
update auth.users set encrypted_password='hash1';
do $$begin if exists(select 1 from public.captured_email) then raise exception 'signup emitted security mail';end if;end$$;
update auth.users set email_confirmed_at=now();
update auth.users set encrypted_password='hash1';
do $$begin if exists(select 1 from public.captured_email) then raise exception 'unchanged password emitted mail';end if;end$$;
update auth.users set encrypted_password='hash2';
do $$begin if (select count(*) from public.captured_email where flow='security_password_changed')<>1 then raise exception 'password reset missing';end if;end$$;
update auth.users set email='OLD@example.test';
do $$begin if (select count(*) from public.captured_email)<>1 then raise exception 'case-only email change emitted mail';end if;end$$;
update auth.users set email='new@example.test',updated_at=clock_timestamp();
do $$begin
 if (select count(*) from public.captured_email where flow='security_email_changed' and lower(recipient)='old@example.test')<>1 then raise exception 'old address notification missing';end if;
 if (select count(*) from public.captured_email)<>2 then raise exception 'unexpected notification count';end if;
end$$;
rollback;
select 'EMAIL_SECURITY_TRIGGER_PROOF_OK';
