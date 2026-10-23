-- =============================================================================
-- 0013_admin_directory_control.sql — admins manage the lawyer directory; who sees lawyer names
-- * list every approved lawyer with their listing (incl. hidden ones)
-- * show / hide, feature (pinned first), edit photo, headline, bio, "accepts consultations"
-- * admins may upload lawyer photos into the avatars bucket
-- * lawyer REAL NAMES are shown to clients (directory, their assigned lawyer) and admins.
--   Lawyers never see another lawyer's name: they cannot read the directory, other profiles or
--   identities, and colleague features (case members, invites) use the public alias only.
-- All writes go through audited SECURITY DEFINER RPCs gated by `lawyers.manage`.
-- Safe to run more than once.
-- =============================================================================

alter table public.lawyer_profiles add column if not exists directory_featured boolean not null default false;

-- Re-create the directory view with `featured` appended (column order of 0012 kept).
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
  lp.headline,
  lp.directory_featured as featured,
  coalesce(nullif(trim(li.full_legal_name), ''), pr.full_name) as full_name
from public.lawyer_profiles lp
join public.profiles pr on pr.id = lp.user_id
left join public.lawyer_identities li on li.user_id = lp.user_id
where lp.verification_status = 'approved'
  and lp.show_in_directory
  and lp.public_alias is not null
  and pr.status = 'active' and pr.deleted_at is null
  and coalesce(public.current_account_type(), '') in ('client', 'admin')
  and coalesce((select (value #>> '{}')::boolean from public.platform_settings
                 where key = 'directory_enabled'), true);
grant select on public.public_lawyer_directory to authenticated;

-- Every approved/suspended lawyer with their listing and real name.
create or replace function public.admin_directory_list()
returns table (user_id uuid, public_alias text, full_legal_name text, avatar_url text, headline text, bio text,
               city text, years_experience int, specialization_ids int[], show_in_directory boolean,
               accepts_consultations boolean, featured boolean, verification_status text, account_status text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_admin_permission('lawyers.manage') or public.has_admin_permission('lawyers.review')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select lp.user_id, lp.public_alias,
           coalesce(nullif(trim(li.full_legal_name), ''), pr.full_name),
           pr.avatar_url, lp.headline, lp.bio, lp.city, lp.years_experience,
           coalesce((select array_agg(ls.specialization_id order by ls.specialization_id)
                       from public.lawyer_specializations ls where ls.lawyer_id = lp.user_id), '{}'::int[]),
           lp.show_in_directory, lp.accepts_consultations, lp.directory_featured,
           lp.verification_status, pr.status
      from public.lawyer_profiles lp
      join public.profiles pr on pr.id = lp.user_id
      left join public.lawyer_identities li on li.user_id = lp.user_id
     where lp.verification_status in ('approved', 'suspended') and pr.deleted_at is null
     order by lp.directory_featured desc, lp.show_in_directory desc, lp.public_alias;
end $$;

-- Edit a lawyer's listing. NULL arguments leave that field unchanged; '' clears a text field.
create or replace function public.admin_update_lawyer_listing(
  p_lawyer uuid,
  p_show boolean default null, p_featured boolean default null, p_accepts boolean default null,
  p_headline text default null, p_bio text default null, p_avatar_url text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_admin_permission('lawyers.manage') then
    perform public.write_audit('lawyer.listing.update', 'lawyer_profiles', p_lawyer::text, 'denied');
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.lawyer_profiles where user_id = p_lawyer) then
    raise exception 'lawyer_not_found';
  end if;
  if char_length(coalesce(p_headline, '')) > 160 or char_length(coalesce(p_bio, '')) > 2000
     or char_length(coalesce(p_avatar_url, '')) > 500 then
    raise exception 'too_long';
  end if;
  update public.lawyer_profiles
     set show_in_directory     = coalesce(p_show, show_in_directory),
         directory_featured    = coalesce(p_featured, directory_featured),
         accepts_consultations = coalesce(p_accepts, accepts_consultations),
         headline = case when p_headline is null then headline else nullif(trim(p_headline), '') end,
         bio      = case when p_bio is null then bio else nullif(trim(p_bio), '') end
   where user_id = p_lawyer;
  if p_avatar_url is not null then
    update public.profiles set avatar_url = nullif(trim(p_avatar_url), '') where id = p_lawyer;
  end if;
  perform public.write_audit('lawyer.listing.update', 'lawyer_profiles', p_lawyer::text, 'success',
    jsonb_strip_nulls(jsonb_build_object('show', p_show, 'featured', p_featured, 'accepts', p_accepts,
      'headline', p_headline is not null, 'bio', p_bio is not null, 'photo', p_avatar_url is not null)));
end $$;

revoke execute on function public.admin_directory_list() from public, anon;
revoke execute on function public.admin_update_lawyer_listing(uuid, boolean, boolean, boolean, text, text, text) from public, anon;
grant execute on function public.admin_directory_list() to authenticated;
grant execute on function public.admin_update_lawyer_listing(uuid, boolean, boolean, boolean, text, text, text) to authenticated;

-- Admins with lawyers.manage may upload / remove lawyer photos (avatars/{lawyer_id}/...).
drop policy if exists "av_admin_insert" on storage.objects;
drop policy if exists "av_admin_delete" on storage.objects;
create policy "av_admin_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and public.has_admin_permission('lawyers.manage'));
create policy "av_admin_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and public.has_admin_permission('lawyers.manage'));

-- ---------------------------------------------------------------- lawyer names for admins and clients
-- Admins: real names for a set of lawyers (e.g. the "assign a lawyer" list).
create or replace function public.admin_lawyer_names(p_ids uuid[])
returns table (user_id uuid, full_name text, avatar_url text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select lp.user_id, coalesce(nullif(trim(li.full_legal_name), ''), pr.full_name), pr.avatar_url
      from public.lawyer_profiles lp
      join public.profiles pr on pr.id = lp.user_id
      left join public.lawyer_identities li on li.user_id = lp.user_id
     where lp.user_id = any(p_ids);
end $$;

-- The client who owns a consultation (or an admin) sees who their assigned lawyer is.
create or replace function public.consultation_lawyer(p_consultation uuid)
returns table (full_name text, public_alias text, avatar_url text, headline text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (exists (select 1 from public.consultations c where c.id = p_consultation and c.client_id = auth.uid())
          or public.has_admin_permission('consultations.manage')) then
    return;
  end if;
  return query
    select coalesce(nullif(trim(li.full_legal_name), ''), pr.full_name), lp.public_alias, pr.avatar_url, lp.headline
      from public.consultation_assignments a
      join public.lawyer_profiles lp on lp.user_id = a.lawyer_id
      join public.profiles pr on pr.id = lp.user_id
      left join public.lawyer_identities li on li.user_id = lp.user_id
     where a.consultation_id = p_consultation and a.status = 'active'
     limit 1;
end $$;

revoke execute on function public.admin_lawyer_names(uuid[]) from public, anon;
revoke execute on function public.consultation_lawyer(uuid) from public, anon;
grant execute on function public.admin_lawyer_names(uuid[]) to authenticated;
grant execute on function public.consultation_lawyer(uuid) to authenticated;
