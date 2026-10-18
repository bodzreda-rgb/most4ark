-- =============================================================================
-- 0002_lawyers.sql — specializations, lawyer profiles, verification workflow
-- =============================================================================

create table public.specializations (
  id         int generated always as identity primary key,
  slug       text not null unique,
  name_ar    text not null,
  name_en    text not null,
  is_active  boolean not null default true,
  sort_order int not null default 0
);
alter table public.specializations enable row level security;
create policy specializations_select on public.specializations for select
  using (is_active or public.has_admin_permission('categories.manage'));
create policy specializations_write on public.specializations for all
  using (public.has_admin_permission('categories.manage'))
  with check (public.has_admin_permission('categories.manage'));
create trigger trg_audit_specializations after insert or update or delete on public.specializations
  for each row execute function public.audit_row_change();

create sequence public.lawyer_alias_seq start 1001;

create table public.lawyer_profiles (
  user_id                uuid primary key references public.profiles(id) on delete cascade,
  -- professional info (identity lives in lawyer_identities)
  city                   text,
  working_locations      text[] not null default '{}',
  years_experience       int check (years_experience between 0 and 70),
  bio                    text check (char_length(bio) <= 2000),
  languages              text[] not null default '{ar}',
  contact_preferences    text[] not null default '{in_app}',
  accepts_consultations  boolean not null default false,
  availability_note      text,
  show_in_directory      boolean not null default true,
  -- workflow (changed only through RPCs)
  public_alias           text unique,
  verification_status    text not null default 'draft'
    check (verification_status in ('draft','submitted','under_review','approved','rejected','suspended')),
  rejection_reason       text,
  submitted_at           timestamptz,
  reviewed_by            uuid references public.profiles(id),
  reviewed_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index lawyer_profiles_status_idx on public.lawyer_profiles (verification_status);
create index lawyer_profiles_city_idx on public.lawyer_profiles (city);
create trigger trg_lawyer_profiles_updated before update on public.lawyer_profiles
  for each row execute function public.set_updated_at();
alter table public.lawyer_profiles enable row level security;

-- PRIVATE legal identity. Separate table so that column-level secrecy is enforced by RLS:
-- only the owner and admins holding `lawyers.identity.read` can ever read these rows.
create table public.lawyer_identities (
  user_id                uuid primary key references public.lawyer_profiles(user_id) on delete cascade,
  full_legal_name        text not null default '',
  bar_membership_number  text,
  bar_branch             text,
  updated_at             timestamptz not null default now()
);
create trigger trg_lawyer_identities_updated before update on public.lawyer_identities
  for each row execute function public.set_updated_at();
alter table public.lawyer_identities enable row level security;

create table public.lawyer_specializations (
  lawyer_id         uuid not null references public.lawyer_profiles(user_id) on delete cascade,
  specialization_id int  not null references public.specializations(id),
  primary key (lawyer_id, specialization_id)
);
alter table public.lawyer_specializations enable row level security;

create table public.application_documents (
  id           uuid primary key default gen_random_uuid(),
  lawyer_id    uuid not null references public.lawyer_profiles(user_id) on delete cascade,
  doc_type     text not null check (doc_type in ('bar_card','supporting')),
  storage_path text not null unique,
  file_name    text,
  mime_type    text not null check (mime_type in ('image/jpeg','image/png','application/pdf')),
  size_bytes   bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  deleted_at   timestamptz,
  created_at   timestamptz not null default now(),
  -- path must be inside the owner's folder
  check (storage_path like lawyer_id::text || '/%')
);
create index application_documents_lawyer_idx on public.application_documents (lawyer_id);
alter table public.application_documents enable row level security;

create table public.verification_events (
  id          uuid primary key default gen_random_uuid(),
  lawyer_id   uuid not null references public.lawyer_profiles(user_id) on delete cascade,
  from_status text,
  to_status   text not null,
  actor_id    uuid references public.profiles(id),
  reason      text,
  created_at  timestamptz not null default now()
);
create index verification_events_lawyer_idx on public.verification_events (lawyer_id, created_at desc);
alter table public.verification_events enable row level security;

-- -----------------------------------------------------------------------------
-- Helper: approved lawyer?
-- -----------------------------------------------------------------------------
create or replace function public.is_approved_lawyer(p_uid uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.lawyer_profiles lp
    join public.profiles pr on pr.id = lp.user_id
    where lp.user_id = p_uid
      and lp.verification_status = 'approved'
      and pr.account_type = 'lawyer'
      and pr.status = 'active'
      and pr.deleted_at is null)
$$;

-- -----------------------------------------------------------------------------
-- Signup trigger: creates profile (+ empty lawyer profile). 'admin' can NEVER be
-- requested through signup metadata.
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_type text := coalesce(new.raw_user_meta_data->>'account_type', 'client');
  v_name text;
  v_locale text := coalesce(new.raw_user_meta_data->>'locale', 'ar');
begin
  if v_type not in ('client','lawyer') then v_type := 'client'; end if;
  if v_locale not in ('ar','en') then v_locale := 'ar'; end if;
  v_name := coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
                     split_part(coalesce(new.email, ''), '@', 1));
  insert into public.profiles (id, account_type, full_name, email, phone, locale)
  values (new.id, v_type, v_name, new.email, nullif(new.raw_user_meta_data->>'phone', ''), v_locale);
  if v_type = 'lawyer' then
    insert into public.lawyer_profiles (user_id) values (new.id);
    insert into public.lawyer_identities (user_id, full_legal_name) values (new.id, v_name);
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- Identity lock: after submission only an authorised admin may change legal
-- identity fields. Workflow columns can never be changed by a lawyer directly.
-- -----------------------------------------------------------------------------
create or replace function public.lawyer_profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null
     or current_setting('app.workflow_rpc', true) = '1'   -- set only inside our SECURITY DEFINER RPCs
     or public.has_admin_permission('lawyers.manage') then
    return new;   -- service role / workflow RPC / authorised admin
  end if;
  if new.verification_status is distinct from old.verification_status
     or new.public_alias is distinct from old.public_alias
     or new.rejection_reason is distinct from old.rejection_reason
     or new.reviewed_by is distinct from old.reviewed_by
     or new.reviewed_at is distinct from old.reviewed_at
     or new.submitted_at is distinct from old.submitted_at then
    raise exception 'workflow_columns_protected' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_lawyer_profiles_guard before update on public.lawyer_profiles
  for each row execute function public.lawyer_profiles_guard();

-- Identity lock: after submission only an authorised admin may change legal identity.
create or replace function public.lawyer_identities_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.has_admin_permission('lawyers.identity.read') then
    return new;
  end if;
  if (select verification_status from public.lawyer_profiles where user_id = old.user_id)
       not in ('draft','rejected') then
    raise exception 'identity_locked' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_lawyer_identities_guard before update on public.lawyer_identities
  for each row execute function public.lawyer_identities_guard();

-- Specializations may be edited by the owner only while editable or approved
create or replace function public.lawyer_specializations_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.has_admin_permission('lawyers.manage') then
    return coalesce(new, old);
  end if;
  if (select verification_status from public.lawyer_profiles
      where user_id = coalesce(new.lawyer_id, old.lawyer_id)) in ('suspended') then
    raise exception 'account_suspended' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_lawyer_specializations_guard before insert or delete on public.lawyer_specializations
  for each row execute function public.lawyer_specializations_guard();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
create policy lawyer_profiles_select on public.lawyer_profiles for select
  using (user_id = auth.uid()
         or public.has_admin_permission('lawyers.review')
         or public.has_admin_permission('lawyers.manage'));
create policy lawyer_profiles_update on public.lawyer_profiles for update
  using (user_id = auth.uid() or public.has_admin_permission('lawyers.manage'))
  with check (user_id = auth.uid() or public.has_admin_permission('lawyers.manage'));

create policy lawyer_identities_select on public.lawyer_identities for select
  using (user_id = auth.uid() or public.has_admin_permission('lawyers.identity.read'));
create policy lawyer_identities_update on public.lawyer_identities for update
  using (user_id = auth.uid() or public.has_admin_permission('lawyers.identity.read'))
  with check (user_id = auth.uid() or public.has_admin_permission('lawyers.identity.read'));

create policy lawyer_specs_select on public.lawyer_specializations for select
  using (lawyer_id = auth.uid()
         or public.has_admin_permission('lawyers.review')
         or public.has_admin_permission('lawyers.manage'));
create policy lawyer_specs_insert on public.lawyer_specializations for insert
  with check (lawyer_id = auth.uid() or public.has_admin_permission('lawyers.manage'));
create policy lawyer_specs_delete on public.lawyer_specializations for delete
  using (lawyer_id = auth.uid() or public.has_admin_permission('lawyers.manage'));

-- Verification documents: owner sees own; only admins with identity permission
-- may see others'. Owner may add/remove only while draft or rejected.
create policy app_docs_select on public.application_documents for select
  using (lawyer_id = auth.uid() or public.has_admin_permission('lawyers.identity.read'));
create policy app_docs_insert on public.application_documents for insert
  with check (lawyer_id = auth.uid()
    and exists (select 1 from public.lawyer_profiles lp
                where lp.user_id = auth.uid() and lp.verification_status in ('draft','rejected')));
create policy app_docs_update on public.application_documents for update
  using (lawyer_id = auth.uid()
    and exists (select 1 from public.lawyer_profiles lp
                where lp.user_id = auth.uid() and lp.verification_status in ('draft','rejected')))
  with check (lawyer_id = auth.uid());

create policy verification_events_select on public.verification_events for select
  using (lawyer_id = auth.uid() or public.has_admin_permission('lawyers.review'));

-- -----------------------------------------------------------------------------
-- Workflow RPCs
-- -----------------------------------------------------------------------------
create or replace function public.submit_lawyer_application()
returns void language plpgsql security definer set search_path = public as $$
declare lp public.lawyer_profiles%rowtype;
begin
  select * into lp from public.lawyer_profiles where user_id = auth.uid() for update;
  if not found then raise exception 'not_a_lawyer' using errcode = '42501'; end if;
  if not public.is_active_user() then raise exception 'account_inactive' using errcode = '42501'; end if;
  if lp.verification_status not in ('draft','rejected') then
    raise exception 'invalid_state';
  end if;
  if not exists (select 1 from public.lawyer_identities li
                 where li.user_id = auth.uid()
                   and coalesce(trim(li.full_legal_name), '') <> ''
                   and coalesce(trim(li.bar_membership_number), '') <> '')
     or coalesce(trim(lp.city), '') = ''
     or lp.years_experience is null then
    raise exception 'incomplete_application';
  end if;
  if not exists (select 1 from public.application_documents
                 where lawyer_id = auth.uid() and doc_type = 'bar_card' and deleted_at is null) then
    raise exception 'missing_bar_card';
  end if;
  if not exists (select 1 from public.lawyer_specializations where lawyer_id = auth.uid()) then
    raise exception 'missing_specialization';
  end if;

  perform set_config('app.workflow_rpc', '1', true);
  update public.lawyer_profiles
     set verification_status = 'submitted', rejection_reason = null, submitted_at = now()
   where user_id = auth.uid();
  insert into public.verification_events (lawyer_id, from_status, to_status, actor_id)
  values (auth.uid(), lp.verification_status, 'submitted', auth.uid());
  perform public.write_audit('lawyer.application.submit', 'lawyer_profiles', auth.uid()::text);
  perform public.notify_admins('lawyers.review', 'lawyer_application_submitted', 'lawyer', auth.uid()::text);
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
    if lp.verification_status not in ('submitted','under_review') then raise exception 'invalid_state'; end if;
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

  insert into public.verification_events (lawyer_id, from_status, to_status, actor_id, reason)
  values (p_lawyer, lp.verification_status, v_to, auth.uid(), p_reason);

  perform public.write_audit('lawyer.' || p_action, 'lawyer_profiles', p_lawyer::text,
                             'success', jsonb_build_object('to', v_to));
  perform public.create_notification(p_lawyer,
     case v_to when 'approved' then (case when lp.verification_status = 'suspended'
                                          then 'lawyer_reactivated' else 'lawyer_approved' end)
               when 'rejected' then 'lawyer_rejected'
               when 'suspended' then 'lawyer_suspended'
               else 'lawyer_under_review' end,
     'lawyer', p_lawyer::text);
end $$;

-- Reveal verified identity to an authorised admin (always audited).
create or replace function public.admin_get_lawyer_identity(p_lawyer uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.has_admin_permission('lawyers.identity.read') then
    perform public.write_audit('lawyer.identity.view', 'lawyer_profiles', p_lawyer::text, 'denied');
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select jsonb_build_object(
      'user_id', lp.user_id,
      'full_legal_name', li.full_legal_name,
      'bar_membership_number', li.bar_membership_number,
      'bar_branch', li.bar_branch,
      'email', pr.email,
      'phone', pr.phone,
      'public_alias', lp.public_alias,
      'verification_status', lp.verification_status,
      'documents', coalesce((select jsonb_agg(jsonb_build_object(
            'id', d.id, 'doc_type', d.doc_type, 'storage_path', d.storage_path,
            'file_name', d.file_name, 'mime_type', d.mime_type, 'created_at', d.created_at)
            order by d.created_at)
          from public.application_documents d
          where d.lawyer_id = lp.user_id and d.deleted_at is null), '[]'::jsonb))
    into v
    from public.lawyer_profiles lp join public.profiles pr on pr.id = lp.user_id
    join public.lawyer_identities li on li.user_id = lp.user_id
   where lp.user_id = p_lawyer;
  if v is null then raise exception 'lawyer_not_found'; end if;
  perform public.write_audit('lawyer.identity.view', 'lawyer_profiles', p_lawyer::text);
  return v;
end $$;

-- Account-level suspension / reactivation / soft deactivation (audited).
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
                             jsonb_build_object('status', p_status));
end $$;

-- Lawyers invite colleagues to a case by public alias only (identity stays hidden).
create or replace function public.resolve_alias(p_alias text)
returns uuid language sql stable security definer set search_path = public as $$
  select lp.user_id from public.lawyer_profiles lp
  where lp.public_alias = p_alias and lp.verification_status = 'approved'
    and public.is_approved_lawyer()
$$;

-- Admin lawyer list. Real names are returned ONLY to admins who hold `lawyers.identity.read`.
create or replace function public.admin_list_lawyers(p_status text default null, p_search text default null)
returns table (user_id uuid, public_alias text, full_legal_name text, city text, years_experience int,
               verification_status text, submitted_at timestamptz, reviewed_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v_ident boolean := public.has_admin_permission('lawyers.identity.read');
        v_term text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not (public.has_admin_permission('lawyers.review') or public.has_admin_permission('lawyers.manage')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select lp.user_id, lp.public_alias,
           case when v_ident then li.full_legal_name end,
           lp.city, lp.years_experience, lp.verification_status, lp.submitted_at, lp.reviewed_at
      from public.lawyer_profiles lp
      join public.lawyer_identities li on li.user_id = lp.user_id
     where (p_status is null or lp.verification_status = p_status)
       and (v_term is null
            or lp.public_alias ilike '%' || v_term || '%'
            or lp.city ilike '%' || v_term || '%'
            or (v_ident and (li.full_legal_name ilike '%' || v_term || '%'
                             or li.bar_membership_number ilike '%' || v_term || '%')))
     order by (lp.verification_status in ('submitted','under_review')) desc,
              coalesce(lp.submitted_at, lp.created_at) desc
     limit 300;
end $$;
