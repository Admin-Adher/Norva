-- Release-gate activation is a privileged approval, independently of the
-- capability that owns each gate. Keep the existing capability/flag mapping
-- intact and add one fail-closed assurance boundary at the state transition.
create or replace function
affiliate_private.guard_partners_release_gate_activation_aal2()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.satisfied is false
    and new.satisfied is true
    and auth.uid() is not null
  then
    perform affiliate_private.partners_require_aal2(
      'Partners release gate activation'
    );
  end if;

  return new;
end;
$$;

revoke all on function
  affiliate_private.guard_partners_release_gate_activation_aal2()
  from public, anon, authenticated, service_role;

drop trigger if exists affiliate_release_gates_activation_aal2
  on affiliate_private.affiliate_release_gates;

create trigger affiliate_release_gates_activation_aal2
before update of satisfied
on affiliate_private.affiliate_release_gates
for each row
execute function
  affiliate_private.guard_partners_release_gate_activation_aal2();

comment on function
  affiliate_private.guard_partners_release_gate_activation_aal2()
is 'Requires a live verified TOTP-backed AAL2 session for every authenticated false-to-true Partners release-gate transition without changing gate ownership; owner-only maintenance remains explicit.';

comment on trigger affiliate_release_gates_activation_aal2
  on affiliate_private.affiliate_release_gates
is 'Fail-closed AAL2 guard for release-gate activation.';
