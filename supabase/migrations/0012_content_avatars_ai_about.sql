-- =============================================================================
-- 0012_content_avatars_ai_about.sql
-- * admins write library / template content themselves: free-text template categories,
--   library categories can be created from the library screen (library.manage)
-- * profile pictures (public `avatars` bucket) + a short lawyer headline
-- * the lawyer directory is for clients (and admins) only, and shows photo + headline
-- * AI assistant (Gemini, Edge Function `ai-assistant`): per-user daily usage counter
-- * About page content (platform_settings.about_page, public, edited by admins)
-- Safe to run more than once.
-- =============================================================================

-- ---------------------------------------------------------------- library / templates
alter table public.document_templates drop constraint if exists document_templates_category_check;
alter table public.document_templates drop constraint if exists document_templates_category_len;
alter table public.document_templates add constraint document_templates_category_len
  check (char_length(trim(category)) between 1 and 80);

drop policy if exists libcat_insert_library on public.library_categories;
create policy libcat_insert_library on public.library_categories for insert
  with check (public.has_admin_permission('library.manage'));

-- ---------------------------------------------------------------- avatars + headline
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles drop constraint if exists profiles_avatar_url_len;
alter table public.profiles add constraint profiles_avatar_url_len check (char_length(coalesce(avatar_url, '')) <= 500);
grant update (avatar_url) on public.profiles to authenticated;

alter table public.lawyer_profiles add column if not exists headline text;
alter table public.lawyer_profiles drop constraint if exists lawyer_profiles_headline_len;
alter table public.lawyer_profiles add constraint lawyer_profiles_headline_len check (char_length(coalesce(headline, '')) <= 160);
grant update (headline) on public.lawyer_profiles to authenticated;

-- Public bucket: profile photos are meant to be seen. Path: avatars/{user_id}/{file}
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars', 'avatars', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "av_select" on storage.objects;
drop policy if exists "av_insert" on storage.objects;
drop policy if exists "av_delete" on storage.objects;
create policy "av_select" on storage.objects for select to authenticated
  using (bucket_id = 'avatars');
create policy "av_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars'
    and ((storage.foldername(name))[1] = auth.uid()::text
         or ((storage.foldername(name))[1] = 'site' and public.has_admin_permission('settings.manage'))));
create policy "av_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars'
    and ((storage.foldername(name))[1] = auth.uid()::text
         or ((storage.foldername(name))[1] = 'site' and public.has_admin_permission('settings.manage'))));

-- ---------------------------------------------------------------- directory (clients only)
-- New columns go at the end so `create or replace view` keeps working.
create or replace view public.public_lawyer_directory with (security_invoker = false) as
select
  lp.public_alias,
  lp.years_experience,
  lp.city,
  lp.working_locations,
  lp.bio,
  lp.languages,
  lp.accepts_consultations,
  lp.availability_note,
  coalesce((select array_agg(ls.specialization_id order by ls.specialization_id)
              from public.lawyer_specializations ls
             where ls.lawyer_id = lp.user_id), '{}'::int[]) as specialization_ids,
  coalesce((select array_agg(distinct cc.id)
              from public.lawyer_specializations ls
              join public.consultation_categories cc
                on cc.specialization_id = ls.specialization_id and cc.is_active
             where ls.lawyer_id = lp.user_id), '{}'::int[]) as consultation_category_ids,
  true as verified,
  pr.avatar_url,
  lp.headline
from public.lawyer_profiles lp
join public.profiles pr on pr.id = lp.user_id
where lp.verification_status = 'approved'
  and lp.show_in_directory
  and lp.public_alias is not null
  and pr.status = 'active' and pr.deleted_at is null
  and coalesce(public.current_account_type(), '') in ('client', 'admin')
  and coalesce((select (value #>> '{}')::boolean from public.platform_settings
                 where key = 'directory_enabled'), true);
grant select on public.public_lawyer_directory to authenticated;

-- ---------------------------------------------------------------- AI assistant usage
-- Written only by the Edge Function (service role); users may read their own counter.
create table if not exists public.ai_chat_usage (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day     date not null default current_date,
  count   int  not null default 0,
  primary key (user_id, day)
);
alter table public.ai_chat_usage enable row level security;
drop policy if exists ai_usage_select on public.ai_chat_usage;
create policy ai_usage_select on public.ai_chat_usage for select using (user_id = auth.uid());
grant select on public.ai_chat_usage to authenticated;
grant all on public.ai_chat_usage to service_role;

-- Atomically counts one request; returns false once the daily limit is reached.
create or replace function public.ai_chat_take(p_user uuid, p_limit int)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.ai_chat_usage (user_id, day, count) values (p_user, current_date, 1)
  on conflict (user_id, day) do update set count = ai_chat_usage.count + 1
  returning count into n;
  return n <= p_limit;
end $$;
revoke execute on function public.ai_chat_take(uuid, int) from public, anon, authenticated;
grant execute on function public.ai_chat_take(uuid, int) to service_role;

insert into public.platform_settings (key, value, is_public) values
  ('ai_daily_limit', '30', false),
  ('ai_enabled', 'true', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- About page
insert into public.platform_settings (key, value, is_public) values
  ('about_page', jsonb_build_object(
     'office_name_ar', 'مكتب الحلواني للمحاماة',
     'office_name_en', 'El-Helwany Law Office',
     'tagline_ar', 'محاماة واستشارات قانونية',
     'tagline_en', 'Advocacy and legal consultations',
     'body_ar', 'اكتب هنا نبذة عن المكتب وتاريخه ومجالات عمله. يمكن تعديل هذا النص من لوحة الإدارة ← صفحة "من نحن".',
     'body_en', 'Write a short introduction to the office, its history and its practice areas here. Edit it from Admin → About page.',
     'admin_name', '', 'admin_title_ar', '', 'admin_title_en', '', 'admin_bio_ar', '', 'admin_bio_en', '',
     'admin_photo_url', '', 'logo_url', '',
     'services_ar', '', 'services_en', '',      -- one service per line
     'phone', '', 'email', '', 'address_ar', '', 'address_en', '', 'hours_ar', '', 'hours_en', ''), true)
on conflict (key) do nothing;
