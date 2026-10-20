-- =============================================================================
-- 0010_admin_names_and_fixes.sql
-- 1. Admins can see the real name / email / phone of the client behind a consultation.
-- 2. Row-read rules for cases and consultations no longer depend on a helper function
--    that cannot see a row created in the same statement (insert ... returning).
-- 3. The library bucket accepts the same file types the admin form offers
--    (pdf, word, excel, text, jpeg, png).
-- Safe to run more than once.
-- =============================================================================

-- 1. names for admins ---------------------------------------------------------
create or replace function public.admin_consultation_people(p_ids uuid[])
returns table (consultation_id uuid, client_name text, client_email text, client_phone text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_admin_permission('consultations.manage') or public.has_admin_permission('users.read')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select c.id, pr.full_name, pr.email, pr.phone
      from public.consultations c
      join public.profiles pr on pr.id = c.client_id
     where c.id = any(p_ids);
end $$;
grant execute on function public.admin_consultation_people(uuid[]) to authenticated;

-- 2. read rules ---------------------------------------------------------------
drop policy if exists cases_select on public.cases;
create policy cases_select on public.cases for select
  using ((lawyer_id = auth.uid() and deleted_at is null and public.is_approved_lawyer())
         or public.can_access_case(id));

drop policy if exists consultations_select on public.consultations;
create policy consultations_select on public.consultations for select
  using ((client_id = auth.uid() and public.is_active_user())
         or public.can_access_consultation(id));

-- 3. library file types -------------------------------------------------------
update storage.buckets
   set allowed_mime_types = array['application/pdf','application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'text/plain','image/jpeg','image/png']
 where id = 'library';
