-- Preparation only: channel activation is a separate audited operator decision.
-- Keep audience, readiness, consent, timezone, conversion and TTL checks intact.
set lock_timeout='3s';
set statement_timeout='30s';

create function pg_temp.norva_patch_notification_definition(p_signature regprocedure,p_old text,p_new text)
returns void language plpgsql as $function$
declare v_definition text:=replace(pg_get_functiondef(p_signature),chr(13),'');
begin
 if cardinality(string_to_array(v_definition,p_old))<>2 then
  raise exception 'notification function anchor changed: %',p_signature;
 end if;
 execute replace(v_definition,p_old,p_new);
end $function$;

select pg_temp.norva_patch_notification_definition('public.admin_update_behavioral_lifecycle_runtime(boolean,text,text,text)',
 $old$if not coalesce(p_emergency_stop,true) and v_mode='production' and exists (
    select 1 from public.behavioral_lifecycle_steps s join public.behavioral_lifecycle_journeys j using(journey_key)
    where j.status='active' and s.enabled and s.channel<>'email'
  ) then raise exception 'production audience is email-only' using errcode='22023';end if;

  $old$, '');
select pg_temp.norva_patch_notification_definition('public.norva_behavioral_delivery_eligible(uuid,timestamptz)',
 $old$      and (o.channel='email' or not exists(select 1 from public.behavioral_lifecycle_runtime
        where audience_mode='production'))
$old$, '');
select pg_temp.norva_patch_notification_definition('public.norva_behavioral_delivery_eligible(uuid,timestamptz)',
 $old$        or o.channel <> 'email'
$old$, '');

-- The existing explicit marketing preference also gates commercial push.
-- OS permission remains necessary and never grants marketing consent.
create function public.norva_marketing_contact_allowed(p_user_id uuid,p_exclude_delivery_id uuid default null)
returns boolean language sql stable security definer set search_path='' as $function$
 with contacts as (
  select o.state in ('pending','processing') as reserved,o.sent_at as accepted_at
  from public.cloud_branded_email_outbox o where o.user_id=p_user_id and o.is_marketing
   and (o.state in ('pending','processing') or (o.state='sent' and o.sent_at>now()-interval '7 days'))
  union all
  select o.status='processing' and o.transport_started_at is not null,
   coalesce(o.provider_accepted_at,o.transport_started_at)
  from public.behavioral_lifecycle_outbox o where o.user_id=p_user_id and o.is_marketing and o.channel='push'
   and (p_exclude_delivery_id is null or o.id<>p_exclude_delivery_id)
   and ((o.status='processing' and o.transport_started_at is not null)
    or o.provider_accepted_at>now()-interval '7 days')
 )
 select not exists(select 1 from contacts where reserved or accepted_at>now()-interval '24 hours')
  and (select count(*) from contacts where accepted_at>now()-interval '7 days')<2;
$function$;
revoke all on function public.norva_marketing_contact_allowed(uuid,uuid) from public,anon,authenticated;
grant execute on function public.norva_marketing_contact_allowed(uuid,uuid) to service_role;

-- Retain the existing API and lock identity used by winback/checkout emails.
create or replace function public.norva_marketing_email_contact_allowed(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $function$
 select public.norva_marketing_contact_allowed(p_user_id);
$function$;

select pg_temp.norva_patch_notification_definition('public.norva_authorize_behavioral_push(uuid,uuid)',
 $old$  v_quiet_allowed := public.norva_behavioral_next_allowed_at($old$,
 $new$  if o.is_marketing then
    perform pg_advisory_xact_lock(hashtextextended('norva:marketing-email:'||o.user_id::text,0));
    if not public.norva_marketing_contact_allowed(o.user_id,o.id) then
      update public.behavioral_lifecycle_outbox set status='pending',
        next_attempt_at=v_now+interval '1 hour',last_error_family='frequency_capped',
        lease_token=null,lease_expires_at=null,updated_at=v_now
      where id=o.id and status='processing' and lease_token=p_lease_token;
      return jsonb_build_object('authorized',false,'reason','deferred');
    end if;
  end if;

  v_quiet_allowed := public.norva_behavioral_next_allowed_at($new$);
select pg_temp.norva_patch_notification_definition('public.norva_authorize_behavioral_push(uuid,uuid)',
 $old$o.user_id, 'push', o.journey_key, v_now$old$,
 $new$o.user_id, 'push', o.journey_key, v_now, o.id$new$);

-- All outbound behavioral guidance shares one 24-hour spacing window.
-- In-app help, security, receipts and immediate service events are unaffected.
select pg_temp.norva_patch_notification_definition('public.norva_behavioral_frequency_allowed_at(uuid,text,text,timestamptz,uuid)',
 $old$  return v_allowed;
end;$old$,
 $new$  if p_channel in ('email','push') then
    select greatest(v_allowed,coalesce(max(coalesce(o.provider_accepted_at,o.transport_started_at,o.updated_at))
      +interval '24 hours',v_allowed)) into v_allowed
    from public.behavioral_lifecycle_outbox o
    where o.user_id=p_user_id and o.channel in ('email','push')
      and (p_exclude_delivery_id is null or o.id<>p_exclude_delivery_id)
      and (o.provider_accepted_at>=coalesce(p_now,clock_timestamp())-interval '24 hours'
        or (o.status='processing' and o.transport_started_at>=coalesce(p_now,clock_timestamp())-interval '24 hours')
        or (o.status='email_queued' and coalesce(o.transport_started_at,o.updated_at)>=coalesce(p_now,clock_timestamp())-interval '24 hours'));
  end if;
  return v_allowed;
end;$new$);

-- Inventory describes protected capabilities, not a claim that eight push rules
-- are running. Provider channel switches are read from their actual flags.
create or replace function public.admin_marketing_system_automations()
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare v_provider_channels jsonb;v_provider_stage text;
begin
 if not public.is_admin() then raise exception 'not authorized' using errcode='42501';end if;
 select stage into v_provider_stage from public.cloud_provider_access_rollout where singleton;
 select jsonb_agg(jsonb_build_object('channel',c.label,'enabled',coalesce(f.enabled,false)
  and coalesce((select enabled from public.admin_feature_flags where key='provider_access_notifications_v1_enabled'),false)
  and coalesce((select enabled from public.admin_feature_flags where key='provider_access_v1_enabled'),false)
  and coalesce(v_provider_stage<>'off',false)) order by c.position)
 into v_provider_channels from (values
  ('provider_access_email_v1_enabled','E-mail',1),('provider_access_push_v1_enabled','Push',2),
  ('provider_access_in_app_v1_enabled','Dans l’app',3)) c(key,label,position)
 left join public.admin_feature_flags f on f.key=c.key;
 return jsonb_build_array(
  jsonb_build_object('id','security-account','name','Sécurité du compte','trigger','Mot de passe, adresse, MFA ou méthode de connexion','channels',jsonb_build_array('E-mail'),'state','transactional','control','protected','description','Notifications de sécurité liées aux événements confirmés du compte.'),
  jsonb_build_object('id','billing-lifecycle','name','Paiement, renouvellement et reconquête','trigger','Événement de facturation ou abandon confirmé','channels',jsonb_build_array('E-mail'),'state','transactional','control','protected','description','Reçus, impayés et renouvellements. La reconquête respecte les préférences marketing et la fréquence de contact.'),
  jsonb_build_object('id','trial-ending','name','Fin d’essai','trigger','J-3 et J-1 avant échéance','channels',jsonb_build_array('E-mail'),'state','transactional','control','protected','description','Échéances calculées par le moteur d’abonnement.'),
  jsonb_build_object('id','import-lifecycle','name','Import terminé ou en échec','trigger','Fin du traitement d’une source','channels',jsonb_build_array('E-mail','Push'),'state','transactional','control','protected','description','Livraison transactionnelle avec reprise ; les relances de configuration sont détaillées dans Parcours.'),
  jsonb_build_object('id','new-content','name','Nouveautés du catalogue','trigger','Événement new_content','channels',jsonb_build_array('Dans l’app'),'state','transactional','control','extendable','event_key','new_content','description','Les relances de reprise et de nouveautés sont coordonnées dans Parcours. Une règle complémentaire reste facultative.'),
  jsonb_build_object('id','subtitle-status','name','Résultat des sous-titres IA','trigger','Prêt, vide ou en échec','channels',jsonb_build_array('E-mail','Dans l’app'),'state','transactional','control','extendable','event_key','subtitle_ready','description','Le résultat est disponible dans l’app et par e-mail. Un push complémentaire peut être créé ici.'),
  jsonb_build_object('id','provider-access','name','Accès fournisseur','trigger','Expiration, masquage ou restauration','channels',jsonb_build_array('E-mail','Push','Dans l’app'),'channel_states',v_provider_channels,'scope',v_provider_stage,'state','deployment_controlled','control','protected','description','États réels des canaux sur la cohorte du produit Accès fournisseur.'),
  jsonb_build_object('id','support-replies','name','Réponses du support','trigger','Nouvelle réponse dans un ticket','channels',jsonb_build_array('E-mail','Dans l’app'),'state','transactional','control','protected','description','Réponse liée au ticket et à son destinataire.')
 );
end $function$;
revoke all on function public.admin_marketing_system_automations() from public,anon;
grant execute on function public.admin_marketing_system_automations() to authenticated,service_role;
