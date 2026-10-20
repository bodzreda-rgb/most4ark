-- =============================================================================
-- 0011_guest_clients.sql — clients can join as a GUEST (Supabase anonymous sign-in)
-- * a guest gets an active 'client' profile automatically (no account acceptance)
-- * before sending a consultation the guest fills a contact form; it is stored on
--   the consultation (contact_name / contact_phone / contact_email)
-- * when a guest later creates an account (email + password) the profile email follows
-- * admins see the contact details the guest entered
-- REQUIRES: Authentication -> Sign In / Providers -> "Allow anonymous sign-ins" = ON
-- Safe to run more than once.
-- =============================================================================

alter table public.consultations
  add column if not exists contact_name  text,
  add column if not exists contact_phone text,
  add column if not exists contact_email text;
alter table public.consultations drop constraint if exists consultations_contact_len;
alter table public.consultations add constraint consultations_contact_len
  check (char_length(coalesce(contact_name, ''))  <= 200
     and char_length(coalesce(contact_phone, '')) <= 40
     and char_length(coalesce(contact_email, '')) <= 254);

-- Sign-up trigger (supersedes 0009): guests are active clients
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_anon boolean := coalesce(new.is_anonymous, false);
  v_type text := case when coalesce(new.is_anonymous, false) then 'client'
                      else coalesce(new.raw_user_meta_data->>'account_type', 'client') end;
  v_name text;
  v_locale text := coalesce(new.raw_user_meta_data->>'locale', 'ar');
  v_status text;
begin
  if v_type not in ('client','lawyer') then v_type := 'client'; end if;
  if v_locale not in ('ar','en') then v_locale := 'ar'; end if;
  -- lawyers are gated by the verification workflow; guests are limited to submitting consultations;
  -- registered clients wait for account acceptance
  v_status := case when v_type = 'client' and not v_anon
                    and public.setting_text('require_account_approval', 'true') = 'true'
                   then 'pending' else 'active' end;
  v_name := case when v_anon then case when v_locale = 'en' then 'Guest' else 'ضيف' end
                 else coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
                               split_part(coalesce(new.email, ''), '@', 1)) end;
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

-- A guest who later registers (auth.updateUser with email) keeps profile.email in sync
create or replace function public.sync_profile_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set email = new.email where id = new.id and email is distinct from new.email;
  return new;
end $$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function public.sync_profile_email();

-- Admins: prefer the contact details entered on the consultation (guests), else the profile
create or replace function public.admin_consultation_people(p_ids uuid[])
returns table (consultation_id uuid, client_name text, client_email text, client_phone text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_admin_permission('consultations.manage') or public.has_admin_permission('users.read')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select c.id,
           coalesce(nullif(c.contact_name, ''),  pr.full_name),
           coalesce(nullif(c.contact_email, ''), pr.email),
           coalesce(nullif(c.contact_phone, ''), pr.phone)
      from public.consultations c
      join public.profiles pr on pr.id = c.client_id
     where c.id = any(p_ids);
end $$;
grant execute on function public.admin_consultation_people(uuid[]) to authenticated;
