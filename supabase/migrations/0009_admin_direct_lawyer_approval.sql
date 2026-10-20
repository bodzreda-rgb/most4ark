-- =============================================================================
-- 0009_admin_direct_lawyer_approval.sql
-- * An admin (permission lawyers.review) can approve a lawyer straight from the
--   list, even if the lawyer has not submitted the application yet.
-- * Approving a lawyer also activates the account if it was still 'pending'.
-- * Lawyer sign-ups start 'active' (they only reach the application page until
--   approved); only client sign-ups wait in 'pending'.
-- Safe to run more than once.
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_type text := coalesce(new.raw_user_meta_data->>'account_type', 'client');
  v_name text;
  v_locale text := coalesce(new.raw_user_meta_data->>'locale', 'ar');
  v_status text;
begin
  if v_type not in ('client','lawyer') then v_type := 'client'; end if;
  if v_locale not in ('ar','en') then v_locale := 'ar'; end if;
  -- lawyers are gated by the verification workflow; clients by account acceptance
  v_status := case when v_type = 'client'
                    and public.setting_text('require_account_approval', 'true') = 'true'
                   then 'pending' else 'active' end;
  v_name := coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
                     split_part(coalesce(new.email, ''), '@', 1));
  insert into public.profiles (id, account_type, full_name, email, phone, locale, status)
  values (new.id, v_type, v_name, new.email, nullif(new.raw_user_meta_data->>'phone', ''), v_locale, v_status);
  if v_type = 'lawyer' then
    insert into public.lawyer_profiles (user_id) values (new.id);
    insert into public.lawyer_identities (user_id, full_legal_name) values (new.id, v_name);
    perform public.notify_admins('lawyers.review', 'application_submitted', 'lawyer', new.id::text);
  end if;
  if v_status = 'pending' then
    perform public.notify_admins('users.manage', 'account_pending', 'user', new.id::text);
  end if;
  return new;
end $$;

create or replace function public.admin_review_lawyer(
  p_lawyer uuid, p_action text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  lp public.lawyer_profiles%rowtype;
  v_to text;
  v_alias text;
begin
  if p_action in ('start_review','approve','reject') then
    if not public.has_admin_permission('lawyers.review') then
      perform public.write_audit('lawyer.' || p_action, 'lawyer_profiles', p_lawyer::text, 'denied');
      raise exception 'forbidden' using errcode = '42501';
    end if;
  elsif p_action in ('suspend','reactivate') then
    if not public.has_admin_permission('lawyers.manage') then
      perform public.write_audit('lawyer.' || p_action, 'lawyer_profiles', p_lawyer::text, 'denied');
      raise exception 'forbidden' using errcode = '42501';
    end if;
  else
    raise exception 'unknown_action';
  end if;

  select * into lp from public.lawyer_profiles where user_id = p_lawyer for update;
  if not found then raise exception 'lawyer_not_found'; end if;

  if p_action = 'start_review' then
    if lp.verification_status <> 'submitted' then raise exception 'invalid_state'; end if;
    v_to := 'under_review';
  elsif p_action = 'approve' then
    -- direct approval allowed from draft / rejected as well as submitted / under_review
    if lp.verification_status not in ('draft','submitted','under_review','rejected') then raise exception 'invalid_state'; end if;
    v_to := 'approved';
  elsif p_action = 'reject' then
    if lp.verification_status not in ('submitted','under_review') then raise exception 'invalid_state'; end if;
    if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required'; end if;
    v_to := 'rejected';
  elsif p_action = 'suspend' then
    if lp.verification_status <> 'approved' then raise exception 'invalid_state'; end if;
    if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required'; end if;
    v_to := 'suspended';
  else -- reactivate
    if lp.verification_status <> 'suspended' then raise exception 'invalid_state'; end if;
    v_to := 'approved';
  end if;

  v_alias := lp.public_alias;
  if v_to = 'approved' and v_alias is null then
    v_alias := public.setting_text('alias_prefix', 'Advocate #A') || nextval('public.lawyer_alias_seq');
  end if;

  perform set_config('app.workflow_rpc', '1', true);
  update public.lawyer_profiles
     set verification_status = v_to,
         public_alias = v_alias,
         rejection_reason = case when v_to = 'rejected' then p_reason else null end,
         reviewed_by = auth.uid(),
         reviewed_at = now()
   where user_id = p_lawyer;

  -- an approved lawyer must be able to sign in: accept a still-pending account too
  if v_to = 'approved' then
    update public.profiles set status = 'active', status_reason = null, deleted_at = null
     where id = p_lawyer and status = 'pending';
  end if;

  insert into public.verification_events (lawyer_id, from_status, to_status, actor_id, reason)
  values (p_lawyer, lp.verification_status, v_to, auth.uid(), p_reason);

  perform public.write_audit('lawyer.' || p_action, 'lawyer_profiles', p_lawyer::text,
                             'success', jsonb_build_object('from', lp.verification_status, 'to', v_to));
  perform public.create_notification(p_lawyer,
     case v_to when 'approved' then (case when lp.verification_status = 'suspended'
                                          then 'lawyer_reactivated' else 'lawyer_approved' end)
               when 'rejected' then 'lawyer_rejected'
               when 'suspended' then 'lawyer_suspended'
               else 'lawyer_under_review' end,
     'lawyer', p_lawyer::text);
end $$;

-- Lawyers who signed up while approval was required and are still 'pending' can now
-- reach the application page (or be approved directly): activate them.
update public.profiles set status = 'active'
 where account_type = 'lawyer' and status = 'pending' and deleted_at is null;
