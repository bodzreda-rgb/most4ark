-- =============================================================================
-- 0006_directory_admin.sql — privacy-preserving directory, admin stats/reports
-- =============================================================================

-- The ONLY public surface for lawyers. Runs with owner rights (security_invoker
-- = false) and exposes just whitelisted columns. No user_id, no real name, no
-- bar number, no contact details.
create view public.public_lawyer_directory with (security_invoker = false) as
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
  true as verified
from public.lawyer_profiles lp
join public.profiles pr on pr.id = lp.user_id
where lp.verification_status = 'approved'
  and lp.show_in_directory
  and lp.public_alias is not null
  and pr.status = 'active' and pr.deleted_at is null
  and coalesce((select (value #>> '{}')::boolean from public.platform_settings
                 where key = 'directory_enabled'), true);

-- ------------------------------ admin stats -----------------------------------
create or replace function public.admin_dashboard_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_admin_permission('reports.read') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'total_users',          (select count(*) from public.profiles where deleted_at is null),
    'total_clients',        (select count(*) from public.profiles where account_type = 'client' and deleted_at is null),
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

create or replace function public.admin_report_summary(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_admin_permission('reports.read') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'consultations_by_status', coalesce((select jsonb_object_agg(status, n) from (
        select status, count(*) n from public.consultations
         where created_at::date between p_from and p_to group by status) s), '{}'::jsonb),
    'consultations_by_category', coalesce((select jsonb_agg(jsonb_build_object('category', coalesce(cc.name_ar, '—'), 'count', n))
        from (select category_id, count(*) n from public.consultations
               where created_at::date between p_from and p_to group by category_id) s
        left join public.consultation_categories cc on cc.id = s.category_id), '[]'::jsonb),
    'signups_by_month', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'count', n) order by m)
        from (select to_char(date_trunc('month', created_at), 'YYYY-MM') m, count(*) n
                from public.profiles where created_at::date between p_from and p_to group by 1) s), '[]'::jsonb),
    'lawyers_by_status', coalesce((select jsonb_object_agg(verification_status, n) from (
        select verification_status, count(*) n from public.lawyer_profiles group by 1) s), '{}'::jsonb),
    'open_resource_reports', (select count(*) from public.resource_reports where status = 'open')
  );
end $$;

create or replace function public.send_announcement(p_title text, p_body text, p_audience text default 'all')
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.has_admin_permission('settings.manage') then
    perform public.write_audit('announcement.send', 'notifications', null, 'denied');
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_audience not in ('all','lawyers','clients') then raise exception 'bad_audience'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'title_required'; end if;
  insert into public.notifications (user_id, kind, title, body)
  select pr.id, 'announcement', p_title, p_body
    from public.profiles pr
   where pr.status = 'active' and pr.deleted_at is null and pr.account_type <> 'admin'
     and (p_audience = 'all'
          or (p_audience = 'lawyers' and pr.account_type = 'lawyer')
          or (p_audience = 'clients' and pr.account_type = 'client'))
     and not exists (select 1 from public.notification_preferences np
                      where np.user_id = pr.id and np.kind = 'announcement' and not np.in_app);
  get diagnostics n = row_count;
  perform public.write_audit('announcement.send', 'notifications', null, 'success',
                             jsonb_build_object('audience', p_audience, 'recipients', n));
  return n;
end $$;

-- ------------------------------ admin: users ----------------------------------
create or replace function public.admin_list_users(
  p_type text default null, p_status text default null, p_search text default null)
returns table (id uuid, account_type text, full_name text, email text, phone text,
               status text, status_reason text, created_at timestamptz, identity_hidden boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_ident boolean := public.has_admin_permission('lawyers.identity.read');
        v_term text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not public.has_admin_permission('users.read') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select pr.id, pr.account_type,
           case when pr.account_type = 'lawyer' and not v_ident then null else pr.full_name end,
           case when pr.account_type = 'lawyer' and not v_ident then null else pr.email end,
           case when pr.account_type = 'lawyer' and not v_ident then null else pr.phone end,
           pr.status, pr.status_reason, pr.created_at,
           (pr.account_type = 'lawyer' and not v_ident)
      from public.profiles pr
     where (p_type is null or pr.account_type = p_type)
       and (p_status is null or pr.status = p_status)
       and (v_term is null
            or ((pr.account_type <> 'lawyer' or v_ident)
                and (pr.full_name ilike '%' || v_term || '%' or pr.email ilike '%' || v_term || '%'
                     or pr.phone ilike '%' || v_term || '%')))
     order by pr.created_at desc
     limit 300;
end $$;
