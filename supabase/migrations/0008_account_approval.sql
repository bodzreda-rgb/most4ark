-- =============================================================================
-- 0008_account_approval.sql — new accounts wait for an admin to accept them
-- * profiles.status gets a 'pending' state; sign-ups start as 'pending'
--   (switch off with platform_settings.require_account_approval = false)
-- * existing accounts are untouched (they stay 'active')
-- * an admin accepts via admin_set_account_status(user, 'active') — saved in the DB
-- * pending users cannot use the app: is_active_user() is false for them
-- Safe to run more than once.
-- =============================================================================

alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles add constraint profiles_status_check
  check (status in ('pending','active','suspended','deactivated'));

insert into public.platform_settings (key, value, is_public)
values ('require_account_approval', 'true', false)
on conflict (key) do nothing;

-- Sign-up trigger: profile (+ lawyer profile). 'admin' can never come from sign-up metadata.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_type text := coalesce(new.raw_user_meta_data->>'account_type', 'client');
  v_name text;
  v_locale text := coalesce(new.raw_user_meta_data->>'locale', 'ar');
  v_status text := case when public.setting_text('require_account_approval', 'true') = 'true'
                        then 'pending' else 'active' end;
begin
  if v_type not in ('client','lawyer') then v_type := 'client'; end if;
  if v_locale not in ('ar','en') then v_locale := 'ar'; end if;
  v_name := coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
                     split_part(coalesce(new.email, ''), '@', 1));
  insert into public.profiles (id, account_type, full_name, email, phone, locale, status)
  values (new.id, v_type, v_name, new.email, nullif(new.raw_user_meta_data->>'phone', ''), v_locale, v_status);
  if v_type = 'lawyer' then
    insert into public.lawyer_profiles (user_id) values (new.id);
    insert into public.lawyer_identities (user_id, full_legal_name) values (new.id, v_name);
  end if;
  if v_status = 'pending' then
    perform public.notify_admins('users.manage', 'account_pending', 'user', new.id::text);
  end if;
  return new;
end $$;

-- Accept / reject / suspend an account (audited). Accepting a pending account notifies the user.
create or replace function public.admin_set_account_status(
  p_user uuid, p_status text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare target public.profiles%rowtype;
begin
  if not public.has_admin_permission('users.manage') then
    perform public.write_audit('account.set_status', 'profiles', p_user::text, 'denied');
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status not in ('active','suspended','deactivated') then raise exception 'bad_status'; end if;
  if p_user = auth.uid() then raise exception 'cannot_modify_self'; end if;
  select * into target from public.profiles where id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;
  -- an ordinary admin can never touch another admin; only super admins can
  if target.account_type = 'admin' and not public.is_super_admin() then
    perform public.write_audit('account.set_status', 'profiles', p_user::text, 'denied');
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status <> 'active' and coalesce(trim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  update public.profiles
     set status = p_status,
         status_reason = case when p_status = 'active' then null else p_reason end,
         deleted_at = case when p_status = 'deactivated' then now() else null end
   where id = p_user;
  perform public.write_audit('account.set_status', 'profiles', p_user::text, 'success',
                             jsonb_build_object('from', target.status, 'status', p_status));
  if target.status = 'pending' and p_status = 'active' then
    perform public.create_notification(p_user, 'account_accepted', 'user', p_user::text);
  end if;
end $$;

-- Admin dashboard: add the number of accounts waiting for acceptance
create or replace function public.admin_dashboard_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_admin_permission('reports.read') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'total_users',          (select count(*) from public.profiles where deleted_at is null),
    'total_clients',        (select count(*) from public.profiles where account_type = 'client' and deleted_at is null),
    'pending_accounts',     (select count(*) from public.profiles where status = 'pending' and deleted_at is null),
    'approved_lawyers',     (select count(*) from public.lawyer_profiles where verification_status = 'approved'),
    'pending_applications', (select count(*) from public.lawyer_profiles where verification_status in ('submitted','under_review')),
    'rejected_applications',(select count(*) from public.lawyer_profiles where verification_status = 'rejected'),
    'suspended_lawyers',    (select count(*) from public.lawyer_profiles where verification_status = 'suspended'),
    'total_consultations',  (select count(*) from public.consultations),
    'pending_consultations',(select count(*) from public.consultations where status in ('submitted','under_review','awaiting_info')),
    'assigned_consultations',(select count(*) from public.consultations where status in ('assigned','in_progress')),
    'answered_consultations',(select count(*) from public.consultations where status in ('answered','closed'))
  );
end $$;
