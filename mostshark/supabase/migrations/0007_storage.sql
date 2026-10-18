-- =============================================================================
-- 0007_storage.sql — private buckets + object-level access control
-- All buckets are PRIVATE. Files are served only through short-lived signed URLs.
-- Path conventions (first folder is the access anchor):
--   lawyer-verification/{lawyer_id}/{file}
--   consultation-attachments/{consultation_id}/{file}
--   case-documents/{case_id}/{file}
--   library/{resource_id}/{file}      templates/{template_id}/{file}
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('lawyer-verification',      'lawyer-verification',      false, 10485760,
     array['image/jpeg','image/png','application/pdf']),
  ('consultation-attachments', 'consultation-attachments', false, 10485760,
     array['image/jpeg','image/png','application/pdf','application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  ('case-documents',           'case-documents',           false, 26214400,
     array['image/jpeg','image/png','application/pdf','application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           'application/vnd.ms-excel',
           'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/plain']),
  ('library',                  'library',                  false, 52428800,
     array['application/pdf','application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain']),
  ('templates',                'templates',                false, 26214400,
     array['application/pdf','application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- safe uuid cast for folder names
create or replace function public.try_uuid(p text)
returns uuid language plpgsql immutable as $$
begin return p::uuid; exception when others then return null; end $$;

-- lawyer verification documents --------------------------------------------------
create policy "lv_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'lawyer-verification'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (select 1 from public.lawyer_profiles lp
                where lp.user_id = auth.uid() and lp.verification_status in ('draft','rejected')));
create policy "lv_select" on storage.objects for select to authenticated
  using (bucket_id = 'lawyer-verification'
    and ((storage.foldername(name))[1] = auth.uid()::text
         or public.has_admin_permission('lawyers.identity.read')));
create policy "lv_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'lawyer-verification'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (select 1 from public.lawyer_profiles lp
                where lp.user_id = auth.uid() and lp.verification_status in ('draft','rejected')));

-- consultation attachments --------------------------------------------------------
create policy "ca_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'consultation-attachments'
    and public.can_access_consultation(public.try_uuid((storage.foldername(name))[1])));
create policy "ca_select" on storage.objects for select to authenticated
  using (bucket_id = 'consultation-attachments'
    and public.can_access_consultation(public.try_uuid((storage.foldername(name))[1])));

-- case documents ------------------------------------------------------------------
create policy "cd_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'case-documents'
    and public.can_access_case(public.try_uuid((storage.foldername(name))[1]), true));
create policy "cd_select" on storage.objects for select to authenticated
  using (bucket_id = 'case-documents'
    and public.can_access_case(public.try_uuid((storage.foldername(name))[1])));
create policy "cd_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'case-documents'
    and public.owns_case(public.try_uuid((storage.foldername(name))[1])));

-- library + templates (read: approved lawyers on published items; write: admins) -----
create policy "lib_select" on storage.objects for select to authenticated
  using (bucket_id = 'library'
    and (public.has_admin_permission('library.manage')
         or (public.is_approved_lawyer() and exists (
              select 1 from public.legal_resources r
              where r.id = public.try_uuid((storage.foldername(name))[1]) and r.status = 'published'))));
create policy "lib_write" on storage.objects for all to authenticated
  using (bucket_id = 'library' and public.has_admin_permission('library.manage'))
  with check (bucket_id = 'library' and public.has_admin_permission('library.manage'));

create policy "tpl_select" on storage.objects for select to authenticated
  using (bucket_id = 'templates'
    and (public.has_admin_permission('templates.manage')
         or (public.is_approved_lawyer() and exists (
              select 1 from public.document_templates t
              where t.id = public.try_uuid((storage.foldername(name))[1]) and t.status = 'published'))));
create policy "tpl_write" on storage.objects for all to authenticated
  using (bucket_id = 'templates' and public.has_admin_permission('templates.manage'))
  with check (bucket_id = 'templates' and public.has_admin_permission('templates.manage'));
