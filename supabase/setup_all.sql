-- ===== migrations/0001_core.sql =====
-- =============================================================================
-- 0001_core.sql — profiles, admin RBAC, settings, audit log, notifications
-- Mostshark (مستشارك)
-- =============================================================================
create extension if not exists pg_trgm;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- profiles (1:1 with auth.users). account_type / status are NEVER writable by
-- the owning user: column-level grants (see 0099_grants.sql) + no client path.
-- -----------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  account_type  text not null default 'client'
                  check (account_type in ('client','lawyer','admin')),
  full_name     text not null default '',
  email         text,
  phone         text,
  locale        text not null default 'ar' check (locale in ('ar','en')),
  timezone      text not null default 'Africa/Cairo',
  status        text not null default 'active'
                  check (status in ('active','suspended','deactivated')),
  status_reason text,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();
alter table public.profiles enable row level security;

-- -----------------------------------------------------------------------------
-- Admin RBAC (server-side; never a client flag)
-- -----------------------------------------------------------------------------
create table public.admin_role_permissions (
  role       text not null check (role in ('super_admin','reviewer','support','content')),
  permission text not null,
  primary key (role, permission)
);
alter table public.admin_role_permissions enable row level security;

insert into public.admin_role_permissions (role, permission)
select 'super_admin', p from unnest(array[
  'users.read','users.manage','lawyers.review','lawyers.manage','lawyers.identity.read',
  'consultations.manage','library.manage','templates.manage','categories.manage',
  'settings.manage','audit.read','reports.read','admins.manage']) p
union all
select 'reviewer', p from unnest(array[
  'users.read','lawyers.review','lawyers.manage','lawyers.identity.read','reports.read']) p
union all
select 'support', p from unnest(array[
  'users.read','consultations.manage','reports.read']) p
union all
select 'content', p from unnest(array[
  'library.manage','templates.manage','categories.manage']) p;

create table public.admin_users (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  role       text not null check (role in ('super_admin','reviewer','support','content')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;

create or replace function public.has_admin_permission(p_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.admin_users au
    join public.admin_role_permissions rp on rp.role = au.role
    join public.profiles pr on pr.id = au.user_id
    where au.user_id = auth.uid()
      and rp.permission = p_permission
      and pr.account_type = 'admin'
      and pr.status = 'active'
      and pr.deleted_at is null
  )
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admin_users au
    join public.profiles pr on pr.id = au.user_id
    where au.user_id = auth.uid() and pr.account_type = 'admin'
      and pr.status = 'active' and pr.deleted_at is null)
$$;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admin_users au
    join public.profiles pr on pr.id = au.user_id
    where au.user_id = auth.uid() and au.role = 'super_admin'
      and pr.account_type = 'admin' and pr.status = 'active' and pr.deleted_at is null)
$$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and status = 'active' and deleted_at is null)
$$;

create or replace function public.current_account_type()
returns text language sql stable security definer set search_path = public as $$
  select account_type from public.profiles
  where id = auth.uid() and status = 'active' and deleted_at is null
$$;

-- User's "today" in their own configured timezone (DST-aware via tz database).
create or replace function public.user_today()
returns date language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce(
            (select timezone from public.profiles where id = auth.uid()), 'Africa/Cairo'))::date
$$;

-- Bootstrap an administrator. Callable only by service_role / SQL editor.
create or replace function public.create_admin(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'profile_not_found';
  end if;
  update public.profiles set account_type = 'admin' where id = p_user_id;
  insert into public.admin_users (user_id, role) values (p_user_id, p_role)
  on conflict (user_id) do update set role = excluded.role;
end $$;

-- Admin policies on RBAC tables
create policy admin_users_select on public.admin_users for select
  using (user_id = auth.uid() or public.has_admin_permission('admins.manage'));
create policy admin_role_permissions_select on public.admin_role_permissions for select
  using (public.is_admin());

-- profiles policies
-- Own row only. Admins list accounts through admin_list_users(), which masks lawyer
-- identities (name/email/phone) unless the admin holds `lawyers.identity.read`.
create policy profiles_select on public.profiles for select
  using (id = auth.uid());
create policy profiles_update_own on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- -----------------------------------------------------------------------------
-- Platform settings
-- -----------------------------------------------------------------------------
create table public.platform_settings (
  key        text primary key,
  value      jsonb not null,
  is_public  boolean not null default false,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
alter table public.platform_settings enable row level security;
create policy settings_select on public.platform_settings for select
  using (is_public or public.has_admin_permission('settings.manage'));
create policy settings_write on public.platform_settings for all
  using (public.has_admin_permission('settings.manage'))
  with check (public.has_admin_permission('settings.manage'));

create or replace function public.setting_text(p_key text, p_default text default null)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select value #>> '{}' from public.platform_settings where key = p_key), p_default)
$$;

create or replace function public.setting_int(p_key text, p_default int)
returns int language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::int from public.platform_settings where key = p_key), p_default)
$$;

insert into public.platform_settings (key, value, is_public) values
  ('alias_prefix',                   '"Advocate #A"', false),
  ('default_language',               '"ar"', true),
  ('supported_languages',            '["ar","en"]', true),
  ('directory_enabled',              'true', true),
  ('calendar_default_range_days',    '30', true),
  ('max_upload_mb',                  '10', true),
  ('consultation_rate_limit_per_hour','5', false),
  ('client_retention_years',         '5', false),
  ('disclaimer_consultation_ar',
   '"الردود المقدمة عبر المنصة هي معلومات عامة ولا تُنشئ علاقة محامٍ-موكل رسمية، ولا تُغني عن استشارة قانونية متخصصة في وقائع قضيتك. لا تضمن المنصة صحة أو ملاءمة أي رد لكل حالة."', true),
  ('disclaimer_consultation_en',
   '"Responses given through the platform are general information. They do not create a formal lawyer-client relationship and are not a substitute for advice on your specific facts. The platform does not guarantee that any response is correct or suitable for every situation."', true),
  ('disclaimer_finance_ar',
   '"السجلات المالية هنا هي سجلات إدارية خاصة بك، وليست فواتير ضريبية رسمية أو كشوف حسابات أو إثباتًا للدفع."', true),
  ('disclaimer_finance_en',
   '"Financial records here are your private management records. They are not official tax invoices, accounting statements, or proof of payment."', true),
  ('disclaimer_library_ar',
   '"المواد المعروضة قد لا تكون محدّثة. تحقق دائمًا من النص الرسمي المنشور والتعديلات اللاحقة قبل الاعتماد عليها. لا تدّعي المنصة اكتمال أو حداثة قاعدة التشريعات المصرية."', true),
  ('disclaimer_library_en',
   '"Materials may not be current. Always verify against the official published text and later amendments. The platform does not claim to hold a complete or current Egyptian legal database."', true),
  ('disclaimer_templates_ar',
   '"النماذج مراجع عامة ما لم تُعتمد لغرض محدد، ولا تُعد صالحة للتقديم القانوني دون مراجعة المحامي."', true),
  ('disclaimer_templates_en',
   '"Templates are general reference material unless reviewed for a specific purpose and do not satisfy any filing requirement without lawyer review."', true);

-- -----------------------------------------------------------------------------
-- Audit log (append-only). Never store passwords, tokens or document contents.
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  action      text not null,
  entity_type text,
  entity_id   text,
  result      text not null default 'success' check (result in ('success','denied','error')),
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);
alter table public.audit_logs enable row level security;
create policy audit_select on public.audit_logs for select
  using (public.has_admin_permission('audit.read'));
-- no insert/update/delete policies: writes only through write_audit()

create or replace function public.write_audit(
  p_action text, p_entity_type text, p_entity_id text,
  p_result text default 'success', p_metadata jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, result, metadata)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, p_result, coalesce(p_metadata, '{}'::jsonb));
end $$;

-- generic row-change audit (records only table, op and key; never row content)
create or replace function public.audit_row_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  j jsonb := to_jsonb(coalesce(new, old));
  v_id text := coalesce(j->>'id', j->>'key', j->>'user_id');
begin
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, result, metadata)
  values (auth.uid(), tg_table_name || '.' || lower(tg_op), tg_table_name, v_id,
          'success', jsonb_build_object('op', tg_op));
  return coalesce(new, old);
end $$;

create trigger trg_audit_settings after insert or update or delete on public.platform_settings
  for each row execute function public.audit_row_change();
create trigger trg_audit_admin_users after insert or update or delete on public.admin_users
  for each row execute function public.audit_row_change();

-- -----------------------------------------------------------------------------
-- Notifications (generic text only — details are fetched in-app after auth)
-- -----------------------------------------------------------------------------
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null,
  title       text,              -- only for admin announcements (public content)
  body        text,
  entity_type text,
  entity_id   text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;
alter table public.notifications enable row level security;
create policy notifications_select on public.notifications for select using (user_id = auth.uid());
create policy notifications_update on public.notifications for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_delete on public.notifications for delete using (user_id = auth.uid());

create table public.notification_preferences (
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind    text not null,
  in_app  boolean not null default true,
  push    boolean not null default true,
  primary key (user_id, kind)
);
alter table public.notification_preferences enable row level security;
create policy notif_prefs_all on public.notification_preferences for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.device_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  token      text not null unique,
  platform   text not null check (platform in ('android','ios','web')),
  created_at timestamptz not null default now()
);
alter table public.device_tokens enable row level security;
create policy device_tokens_all on public.device_tokens for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.create_notification(
  p_user uuid, p_kind text, p_entity_type text default null, p_entity_id text default null,
  p_title text default null, p_body text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.notification_preferences
             where user_id = p_user and kind = p_kind and in_app = false) then
    return;
  end if;
  insert into public.notifications (user_id, kind, entity_type, entity_id, title, body)
  values (p_user, p_kind, p_entity_type, p_entity_id, p_title, p_body);
end $$;

create or replace function public.notify_admins(
  p_permission text, p_kind text, p_entity_type text default null, p_entity_id text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in
    select distinct au.user_id
    from public.admin_users au
    join public.admin_role_permissions rp on rp.role = au.role
    join public.profiles pr on pr.id = au.user_id
    where rp.permission = p_permission and pr.status = 'active'
  loop
    perform public.create_notification(r.user_id, p_kind, p_entity_type, p_entity_id);
  end loop;
end $$;

create or replace function public.mark_all_notifications_read()
returns void language sql security invoker as $$
  update public.notifications set read_at = now() where user_id = auth.uid() and read_at is null
$$;

-- ===== migrations/0002_lawyers.sql =====
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

-- ===== migrations/0003_practice.sql =====
-- =============================================================================
-- 0003_practice.sql — clients, cases, calendar, tasks, reminders, finance
-- Ownership model: every private row has lawyer_id (= auth.uid() of the owner).
-- Only APPROVED, ACTIVE lawyers can touch these tables (is_approved_lawyer()).
-- =============================================================================

-- ------------------------------ clients --------------------------------------
create table public.clients (
  id                uuid primary key default gen_random_uuid(),
  lawyer_id         uuid not null references public.lawyer_profiles(user_id) on delete cascade,
  full_name         text not null check (char_length(trim(full_name)) > 0),
  phone             text,
  email             text,
  preferred_contact text not null default 'phone'
                      check (preferred_contact in ('phone','whatsapp','email','in_person')),
  contact_details   text,
  internal_notes    text,
  retention_until   date,
  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index clients_lawyer_idx on public.clients (lawyer_id) where deleted_at is null;
create index clients_phone_idx on public.clients (lawyer_id, phone);
create index clients_name_trgm on public.clients using gin (full_name gin_trgm_ops);
create trigger trg_clients_updated before update on public.clients
  for each row execute function public.set_updated_at();
alter table public.clients enable row level security;

create policy clients_select on public.clients for select
  using (lawyer_id = auth.uid() and public.is_approved_lawyer());
create policy clients_insert on public.clients for insert
  with check (lawyer_id = auth.uid() and public.is_approved_lawyer());
create policy clients_update on public.clients for update
  using (lawyer_id = auth.uid() and public.is_approved_lawyer())
  with check (lawyer_id = auth.uid());
-- no DELETE policy: records are soft-deleted (deleted_at) and purged by retention job

-- Duplicate detection (the app asks for confirmation before creating anyway).
create or replace function public.find_duplicate_clients(p_name text, p_phone text default null)
returns table (id uuid, full_name text, phone text, reason text)
language sql stable security invoker as $$
  -- phones are compared on their last 10 digits so 0100…, +20100… and 20100… match
  with q as (select right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10) as ph)
  select c.id, c.full_name, c.phone,
         case when q.ph <> '' and right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10) = q.ph
              then 'phone' else 'name' end
  from public.clients c, q
  where c.lawyer_id = auth.uid() and c.deleted_at is null
    and ( (q.ph <> '' and right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10) = q.ph)
       or lower(trim(c.full_name)) = lower(trim(p_name))
       or similarity(c.full_name, p_name) > 0.6)
$$;

-- ------------------------------- cases ---------------------------------------
create table public.cases (
  id               uuid primary key default gen_random_uuid(),
  lawyer_id        uuid not null references public.lawyer_profiles(user_id) on delete cascade,
  case_number      text not null check (char_length(trim(case_number)) > 0),
  title            text not null check (char_length(trim(title)) > 0),
  court            text,
  category         text,
  client_id        uuid references public.clients(id),
  opposing_party   text,
  status           text not null default 'new'
    check (status in ('new','in_progress','awaiting_hearing','awaiting_documents',
                      'awaiting_payment','suspended','closed','archived')),
  description      text,
  opened_on        date,
  closed_on        date,
  next_hearing_at  timestamptz,
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (lawyer_id, case_number)
);
create index cases_lawyer_idx on public.cases (lawyer_id, status) where deleted_at is null;
create index cases_client_idx on public.cases (client_id);
create index cases_title_trgm on public.cases using gin (title gin_trgm_ops);
create trigger trg_cases_updated before update on public.cases
  for each row execute function public.set_updated_at();
alter table public.cases enable row level security;

create table public.case_members (
  case_id         uuid not null references public.cases(id) on delete cascade,
  member_id       uuid not null references public.lawyer_profiles(user_id) on delete cascade,
  can_edit        boolean not null default false,
  can_view_notes  boolean not null default false,
  added_by        uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  primary key (case_id, member_id)
);
alter table public.case_members enable row level security;

create or replace function public.can_access_case(p_case uuid, p_edit boolean default false)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_approved_lawyer() and exists (
    select 1 from public.cases c
    where c.id = p_case and c.deleted_at is null
      and (c.lawyer_id = auth.uid()
           or exists (select 1 from public.case_members m
                      where m.case_id = c.id and m.member_id = auth.uid()
                        and (not p_edit or m.can_edit))))
$$;

create or replace function public.owns_case(p_case uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_approved_lawyer() and exists (
    select 1 from public.cases c where c.id = p_case and c.lawyer_id = auth.uid())
$$;

create or replace function public.can_view_case_notes(p_case uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_approved_lawyer() and exists (
    select 1 from public.cases c
    where c.id = p_case and c.deleted_at is null
      and (c.lawyer_id = auth.uid()
           or exists (select 1 from public.case_members m
                      where m.case_id = c.id and m.member_id = auth.uid() and m.can_view_notes)))
$$;

create or replace function public.owns_client(p_client uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.clients c where c.id = p_client and c.lawyer_id = auth.uid())
$$;

create policy cases_select on public.cases for select using (public.can_access_case(id));
create policy cases_insert on public.cases for insert
  with check (lawyer_id = auth.uid() and public.is_approved_lawyer()
              and (client_id is null or public.owns_client(client_id)));
create policy cases_update on public.cases for update
  using (public.can_access_case(id, true))
  with check (client_id is null or exists (select 1 from public.clients c
                                           where c.id = client_id and c.lawyer_id = cases.lawyer_id));

create or replace function public.cases_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.lawyer_id <> old.lawyer_id then
      raise exception 'owner_immutable' using errcode = '42501';
    end if;
    -- only the owner may reopen / un-archive, delete or restore
    if old.status in ('closed','archived') and new.status not in ('closed','archived')
       and auth.uid() is distinct from old.lawyer_id then
      raise exception 'reopen_not_authorized' using errcode = '42501';
    end if;
    if new.deleted_at is distinct from old.deleted_at and auth.uid() is distinct from old.lawyer_id then
      raise exception 'delete_not_authorized' using errcode = '42501';
    end if;
    if new.status = 'archived' and old.status not in ('closed','archived') then
      raise exception 'archive_requires_closed';
    end if;
    if new.status = 'closed' and old.status <> 'closed' and new.closed_on is null then
      new.closed_on := current_date;
    end if;
    if new.status not in ('closed','archived') and old.status in ('closed','archived') then
      new.closed_on := null;
    end if;
  end if;
  return new;
end $$;
create trigger trg_cases_guard before update on public.cases
  for each row execute function public.cases_guard();

create policy case_members_select on public.case_members for select
  using (member_id = auth.uid() or public.owns_case(case_id));
create policy case_members_write on public.case_members for all
  using (public.owns_case(case_id))
  with check (public.owns_case(case_id) and public.is_approved_lawyer(member_id));

create or replace function public.add_case_member_by_alias(
  p_case uuid, p_alias text, p_can_edit boolean default false, p_can_view_notes boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v_member uuid;
begin
  if not public.owns_case(p_case) then raise exception 'forbidden' using errcode = '42501'; end if;
  v_member := public.resolve_alias(p_alias);
  if v_member is null then raise exception 'alias_not_found'; end if;
  if v_member = auth.uid() then raise exception 'cannot_add_self'; end if;
  insert into public.case_members (case_id, member_id, can_edit, can_view_notes, added_by)
  values (p_case, v_member, p_can_edit, p_can_view_notes, auth.uid())
  on conflict (case_id, member_id) do update
    set can_edit = excluded.can_edit, can_view_notes = excluded.can_view_notes;
  perform public.create_notification(v_member, 'case_shared', 'case', p_case::text);
end $$;

-- Team list for owner showing aliases (not identities)
create or replace function public.list_case_members(p_case uuid)
returns table (member_id uuid, public_alias text, can_edit boolean, can_view_notes boolean)
language sql stable security definer set search_path = public as $$
  select m.member_id, lp.public_alias, m.can_edit, m.can_view_notes
  from public.case_members m join public.lawyer_profiles lp on lp.user_id = m.member_id
  where m.case_id = p_case and public.owns_case(p_case)
$$;

create table public.case_notes (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references public.cases(id) on delete cascade,
  author_id  uuid not null references public.lawyer_profiles(user_id),
  body       text not null check (char_length(trim(body)) > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index case_notes_case_idx on public.case_notes (case_id, created_at desc);
alter table public.case_notes enable row level security;
create policy case_notes_select on public.case_notes for select
  using (public.can_view_case_notes(case_id));
create policy case_notes_insert on public.case_notes for insert
  with check (author_id = auth.uid() and public.can_view_case_notes(case_id));
create policy case_notes_update on public.case_notes for update
  using (author_id = auth.uid() and public.can_view_case_notes(case_id))
  with check (author_id = auth.uid());

create table public.case_documents (
  id           uuid primary key default gen_random_uuid(),
  case_id      uuid not null references public.cases(id) on delete cascade,
  uploaded_by  uuid not null references public.lawyer_profiles(user_id),
  storage_path text not null unique,
  file_name    text not null,
  mime_type    text not null,
  size_bytes   bigint not null check (size_bytes > 0 and size_bytes <= 26214400),
  deleted_at   timestamptz,
  created_at   timestamptz not null default now(),
  check (mime_type in ('application/pdf','image/jpeg','image/png',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/plain'))
);
create index case_documents_case_idx on public.case_documents (case_id);
alter table public.case_documents enable row level security;
create policy case_documents_select on public.case_documents for select
  using (public.can_access_case(case_id));
create policy case_documents_insert on public.case_documents for insert
  with check (uploaded_by = auth.uid() and public.can_access_case(case_id, true));
create policy case_documents_update on public.case_documents for update
  using (public.owns_case(case_id)) with check (public.owns_case(case_id));

-- chronological activity (written only by triggers; contains no financial data)
create table public.case_activity (
  id         bigint generated always as identity primary key,
  case_id    uuid not null references public.cases(id) on delete cascade,
  actor_id   uuid,
  action     text not null,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index case_activity_case_idx on public.case_activity (case_id, created_at desc);
alter table public.case_activity enable row level security;
create policy case_activity_select on public.case_activity for select
  using (public.can_access_case(case_id));

create or replace function public.log_case_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'cases' then
    if tg_op = 'INSERT' then
      insert into public.case_activity (case_id, actor_id, action) values (new.id, auth.uid(), 'case_created');
    else
      if new.status is distinct from old.status then
        insert into public.case_activity (case_id, actor_id, action, details)
        values (new.id, auth.uid(), 'status_changed', jsonb_build_object('from', old.status, 'to', new.status));
      end if;
      if new.next_hearing_at is distinct from old.next_hearing_at then
        insert into public.case_activity (case_id, actor_id, action, details)
        values (new.id, auth.uid(), 'next_hearing_changed',
                jsonb_build_object('at', new.next_hearing_at));
      end if;
    end if;
  elsif tg_table_name = 'case_notes' then
    insert into public.case_activity (case_id, actor_id, action) values (new.case_id, auth.uid(), 'note_added');
  elsif tg_table_name = 'case_documents' then
    insert into public.case_activity (case_id, actor_id, action, details)
    values (new.case_id, auth.uid(), 'document_added', jsonb_build_object('name', new.file_name));
  end if;
  return new;
end $$;
create trigger trg_cases_activity after insert or update on public.cases
  for each row execute function public.log_case_activity();
create trigger trg_case_notes_activity after insert on public.case_notes
  for each row execute function public.log_case_activity();
create trigger trg_case_documents_activity after insert on public.case_documents
  for each row execute function public.log_case_activity();

-- ------------------------- calendar events -----------------------------------
create table public.calendar_events (
  id                    uuid primary key default gen_random_uuid(),
  lawyer_id             uuid not null references public.lawyer_profiles(user_id) on delete cascade,
  kind                  text not null
    check (kind in ('hearing','appointment','payment_deadline','case_deadline','personal')),
  title                 text not null check (char_length(trim(title)) > 0),
  description           text,
  case_id               uuid references public.cases(id) on delete set null,
  client_id             uuid references public.clients(id) on delete set null,
  starts_at             timestamptz not null,
  ends_at               timestamptz,
  all_day               boolean not null default false,
  location_text         text,
  latitude              double precision check (latitude between -90 and 90),
  longitude             double precision check (longitude between -180 and 180),
  nav_url               text,
  status                text not null default 'scheduled'
    check (status in ('scheduled','completed','cancelled')),
  -- provenance: a lawyer-entered hearing is NOT an officially verified one
  source                text not null default 'user_entered'
    check (source in ('user_entered','verified_external')),
  outcome               text,
  reminder_offsets_min  int[] not null default '{1440,120,30}',
  deleted_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at),
  check ((latitude is null) = (longitude is null))
);
create index calendar_events_range_idx on public.calendar_events (lawyer_id, starts_at)
  where deleted_at is null;
create index calendar_events_case_idx on public.calendar_events (case_id);
-- prevents accidental duplicate events (same kind/title/start)
create unique index calendar_events_no_dupes on public.calendar_events
  (lawyer_id, kind, lower(title), starts_at)
  where deleted_at is null and status <> 'cancelled';
create trigger trg_calendar_events_updated before update on public.calendar_events
  for each row execute function public.set_updated_at();
alter table public.calendar_events enable row level security;

create policy events_select on public.calendar_events for select
  using (lawyer_id = auth.uid() and public.is_approved_lawyer());
create policy events_insert on public.calendar_events for insert
  with check (lawyer_id = auth.uid() and public.is_approved_lawyer()
              and (case_id is null or public.owns_case(case_id))
              and (client_id is null or public.owns_client(client_id)));
create policy events_update on public.calendar_events for update
  using (lawyer_id = auth.uid() and public.is_approved_lawyer())
  with check (lawyer_id = auth.uid()
              and (case_id is null or public.owns_case(case_id))
              and (client_id is null or public.owns_client(client_id)));

create table public.reminders (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.calendar_events(id) on delete cascade,
  lawyer_id   uuid not null references public.lawyer_profiles(user_id) on delete cascade,
  offset_min  int not null,
  remind_at   timestamptz not null,
  status      text not null default 'pending' check (status in ('pending','sent','failed','cancelled')),
  sent_at     timestamptz,
  error       text,
  created_at  timestamptz not null default now()
);
create unique index reminders_pending_unique on public.reminders (event_id, offset_min)
  where status = 'pending';
create index reminders_due_idx on public.reminders (remind_at) where status = 'pending';
alter table public.reminders enable row level security;
create policy reminders_select on public.reminders for select using (lawyer_id = auth.uid());

-- Reminders follow the event: reschedule => rebuilt, cancel/delete => cancelled
create or replace function public.rebuild_event_reminders()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE'
     and new.starts_at is not distinct from old.starts_at
     and new.status is not distinct from old.status
     and new.reminder_offsets_min is not distinct from old.reminder_offsets_min
     and new.deleted_at is not distinct from old.deleted_at then
    return new;
  end if;
  update public.reminders set status = 'cancelled' where event_id = new.id and status = 'pending';
  if new.status = 'scheduled' and new.deleted_at is null then
    insert into public.reminders (event_id, lawyer_id, offset_min, remind_at)
    select new.id, new.lawyer_id, o, new.starts_at - make_interval(mins => o)
    from (select distinct unnest(new.reminder_offsets_min) as o) x
    where new.starts_at - make_interval(mins => o) > now();
  end if;
  return new;
end $$;
create trigger trg_events_reminders after insert or update on public.calendar_events
  for each row execute function public.rebuild_event_reminders();

create or replace function public.log_hearing_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.case_id is not null and new.kind = 'hearing' then
    if tg_op = 'INSERT' then
      insert into public.case_activity (case_id, actor_id, action, details)
      values (new.case_id, auth.uid(), 'hearing_scheduled', jsonb_build_object('at', new.starts_at));
    elsif new.outcome is distinct from old.outcome and new.outcome is not null then
      insert into public.case_activity (case_id, actor_id, action)
      values (new.case_id, auth.uid(), 'hearing_result_recorded');
    elsif new.starts_at is distinct from old.starts_at then
      insert into public.case_activity (case_id, actor_id, action, details)
      values (new.case_id, auth.uid(), 'hearing_rescheduled', jsonb_build_object('at', new.starts_at));
    elsif new.status = 'cancelled' and old.status <> 'cancelled' then
      insert into public.case_activity (case_id, actor_id, action) values (new.case_id, auth.uid(), 'hearing_cancelled');
    end if;
  end if;
  return new;
end $$;
create trigger trg_hearing_activity after insert or update on public.calendar_events
  for each row execute function public.log_hearing_activity();

-- Conflict warning (RLS applies: security invoker)
create or replace function public.find_event_conflicts(
  p_start timestamptz, p_end timestamptz default null, p_exclude uuid default null)
returns setof public.calendar_events language sql stable security invoker as $$
  select * from public.calendar_events e
  where e.lawyer_id = auth.uid() and e.deleted_at is null and e.status = 'scheduled'
    and (p_exclude is null or e.id <> p_exclude)
    and tstzrange(e.starts_at, coalesce(e.ends_at, e.starts_at + interval '1 minute'), '[)')
        && tstzrange(p_start, coalesce(p_end, p_start + interval '1 minute'), '[)')
$$;

-- Record a hearing result and (optionally) schedule the next hearing
create or replace function public.record_hearing_result(
  p_event uuid, p_outcome text, p_next_start timestamptz default null, p_next_location text default null)
returns uuid language plpgsql security invoker as $$
declare ev public.calendar_events%rowtype; v_new uuid;
begin
  select * into ev from public.calendar_events where id = p_event and lawyer_id = auth.uid() for update;
  if not found or ev.kind <> 'hearing' then raise exception 'hearing_not_found'; end if;
  update public.calendar_events set outcome = p_outcome, status = 'completed' where id = p_event;
  if p_next_start is not null then
    insert into public.calendar_events (lawyer_id, kind, title, case_id, client_id, starts_at, location_text)
    values (auth.uid(), 'hearing', ev.title, ev.case_id, ev.client_id, p_next_start,
            coalesce(p_next_location, ev.location_text))
    returning id into v_new;
    if ev.case_id is not null then
      update public.cases set next_hearing_at = p_next_start, status = 'awaiting_hearing'
       where id = ev.case_id;
    end if;
  end if;
  return v_new;
end $$;

-- ------------------------------- tasks ---------------------------------------
create table public.tasks (
  id          uuid primary key default gen_random_uuid(),
  lawyer_id   uuid not null references public.lawyer_profiles(user_id) on delete cascade,
  title       text not null check (char_length(trim(title)) > 0),
  notes       text,
  due_at      timestamptz,
  priority    text not null default 'normal' check (priority in ('low','normal','high')),
  status      text not null default 'open' check (status in ('open','done','cancelled')),
  case_id     uuid references public.cases(id) on delete set null,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index tasks_lawyer_idx on public.tasks (lawyer_id, status, due_at) where deleted_at is null;
create trigger trg_tasks_updated before update on public.tasks
  for each row execute function public.set_updated_at();
alter table public.tasks enable row level security;
create policy tasks_select on public.tasks for select
  using (lawyer_id = auth.uid() and public.is_approved_lawyer());
create policy tasks_insert on public.tasks for insert
  with check (lawyer_id = auth.uid() and public.is_approved_lawyer()
              and (case_id is null or public.owns_case(case_id)));
create policy tasks_update on public.tasks for update
  using (lawyer_id = auth.uid() and public.is_approved_lawyer())
  with check (lawyer_id = auth.uid());

-- ----------------------------- finance ---------------------------------------
-- Calculation model (single source of truth; mirrored by lib/.../finance_calculator.dart):
--   receivable_delta:
--     fee_agreed, additional_charge, refund          => +amount  (client owes more)
--     payment, advance_payment, credit               => -amount  (client owes less)
--     expense                                        => 0 (lawyer cost; reported separately)
--   Reversed transactions and the 'reversal' rows themselves are excluded together,
--   so nothing is ever counted twice and nothing is silently deleted.
--   outstanding = agreed + additional_charges + refunds - payments - credits
create table public.financial_transactions (
  id           uuid primary key default gen_random_uuid(),
  lawyer_id    uuid not null references public.lawyer_profiles(user_id) on delete cascade,
  case_id      uuid references public.cases(id),
  client_id    uuid references public.clients(id),
  kind         text not null check (kind in
                 ('fee_agreed','advance_payment','payment','additional_charge',
                  'expense','refund','credit','reversal')),
  amount       numeric(14,2) not null check (amount > 0),
  currency     text not null default 'EGP',
  occurred_on  date not null,
  method       text check (method in ('cash','bank_transfer','instapay','cheque','card','other')),
  category     text,
  description  text,
  reverses_id  uuid references public.financial_transactions(id),
  created_at   timestamptz not null default now()
);
create unique index financial_transactions_one_reversal on public.financial_transactions (reverses_id)
  where reverses_id is not null;
create index financial_transactions_case_idx on public.financial_transactions (case_id);
create index financial_transactions_client_idx on public.financial_transactions (client_id);
create index financial_transactions_date_idx on public.financial_transactions (lawyer_id, occurred_on desc);
alter table public.financial_transactions enable row level security;

create policy ft_select on public.financial_transactions for select
  using (lawyer_id = auth.uid() and public.is_approved_lawyer());
create policy ft_insert on public.financial_transactions for insert
  with check (lawyer_id = auth.uid() and public.is_approved_lawyer()
              and (case_id is null or exists (select 1 from public.cases c
                                              where c.id = case_id and c.lawyer_id = auth.uid()))
              and (client_id is null or public.owns_client(client_id)));
-- NO update / delete policies and no grants: ledger is append-only.

create or replace function public.financial_transactions_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare orig public.financial_transactions%rowtype;
begin
  if new.kind = 'reversal' then
    if new.reverses_id is null then raise exception 'reversal_requires_target'; end if;
    select * into orig from public.financial_transactions where id = new.reverses_id;
    if not found or orig.lawyer_id <> new.lawyer_id or orig.kind = 'reversal' then
      raise exception 'invalid_reversal_target';
    end if;
    new.amount := orig.amount;
    new.case_id := orig.case_id;
    new.client_id := orig.client_id;
    new.currency := orig.currency;
  else
    if new.reverses_id is not null then raise exception 'reverses_id_only_for_reversal'; end if;
    if new.client_id is null and new.case_id is not null then
      select client_id into new.client_id from public.cases where id = new.case_id;
    end if;
  end if;
  return new;
end $$;
create trigger trg_ft_guard before insert on public.financial_transactions
  for each row execute function public.financial_transactions_guard();

create or replace function public.financial_transactions_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'ledger_is_append_only' using errcode = '42501';
end $$;
create trigger trg_ft_no_update before update or delete on public.financial_transactions
  for each row execute function public.financial_transactions_immutable();

create or replace function public.reverse_transaction(p_tx uuid, p_reason text)
returns uuid language plpgsql security invoker as $$
declare v_id uuid;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  insert into public.financial_transactions (lawyer_id, kind, amount, occurred_on, description, reverses_id)
  values (auth.uid(), 'reversal', 1, public.user_today(), p_reason, p_tx)
  returning id into v_id;
  return v_id;
end $$;

create table public.expected_payments (
  id          uuid primary key default gen_random_uuid(),
  lawyer_id   uuid not null references public.lawyer_profiles(user_id) on delete cascade,
  case_id     uuid references public.cases(id),
  client_id   uuid references public.clients(id),
  amount      numeric(14,2) not null check (amount > 0),
  due_on      date not null,
  status      text not null default 'pending' check (status in ('pending','paid','cancelled')),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index expected_payments_idx on public.expected_payments (lawyer_id, status, due_on);
create trigger trg_expected_payments_updated before update on public.expected_payments
  for each row execute function public.set_updated_at();
alter table public.expected_payments enable row level security;
create policy ep_select on public.expected_payments for select
  using (lawyer_id = auth.uid() and public.is_approved_lawyer());
create policy ep_insert on public.expected_payments for insert
  with check (lawyer_id = auth.uid() and public.is_approved_lawyer()
              and (case_id is null or public.owns_case(case_id))
              and (client_id is null or public.owns_client(client_id)));
create policy ep_update on public.expected_payments for update
  using (lawyer_id = auth.uid() and public.is_approved_lawyer())
  with check (lawyer_id = auth.uid());

-- effective (non-reversed) transactions with their signed receivable effect
create view public.v_transactions_effective with (security_invoker = true) as
select t.id, t.lawyer_id, t.case_id, t.client_id, t.kind, t.amount, t.currency,
       t.occurred_on, t.method, t.category, t.description, t.created_at,
       case t.kind
         when 'fee_agreed' then t.amount
         when 'additional_charge' then t.amount
         when 'refund' then t.amount
         when 'advance_payment' then -t.amount
         when 'payment' then -t.amount
         when 'credit' then -t.amount
         else 0::numeric end as receivable_delta
from public.financial_transactions t
where t.kind <> 'reversal'
  and not exists (select 1 from public.financial_transactions r where r.reverses_id = t.id);

create view public.case_balances with (security_invoker = true) as
select e.lawyer_id, e.case_id,
  coalesce(sum(e.amount) filter (where e.kind = 'fee_agreed'), 0)                         as agreed_fee,
  coalesce(sum(e.amount) filter (where e.kind = 'additional_charge'), 0)                  as additional_charges,
  coalesce(sum(e.amount) filter (where e.kind in ('payment','advance_payment')), 0)       as payments,
  coalesce(sum(e.amount) filter (where e.kind = 'credit'), 0)                             as credits,
  coalesce(sum(e.amount) filter (where e.kind = 'refund'), 0)                             as refunds,
  coalesce(sum(e.amount) filter (where e.kind = 'expense'), 0)                            as expenses,
  coalesce(sum(e.receivable_delta), 0)                                                    as outstanding,
  coalesce(sum(e.amount) filter (where e.kind in ('payment','advance_payment')), 0)
    - coalesce(sum(e.amount) filter (where e.kind = 'refund'), 0)                         as collected,
  coalesce(sum(e.amount) filter (where e.kind in ('payment','advance_payment')), 0)
    - coalesce(sum(e.amount) filter (where e.kind = 'refund'), 0)
    - coalesce(sum(e.amount) filter (where e.kind = 'expense'), 0)                        as net_after_expenses
from public.v_transactions_effective e
where e.case_id is not null
group by e.lawyer_id, e.case_id;

create view public.client_balances with (security_invoker = true) as
select e.lawyer_id, e.client_id,
  coalesce(sum(e.amount) filter (where e.kind = 'fee_agreed'), 0)                         as agreed_fee,
  coalesce(sum(e.amount) filter (where e.kind = 'additional_charge'), 0)                  as additional_charges,
  coalesce(sum(e.amount) filter (where e.kind in ('payment','advance_payment')), 0)       as payments,
  coalesce(sum(e.amount) filter (where e.kind = 'credit'), 0)                             as credits,
  coalesce(sum(e.amount) filter (where e.kind = 'refund'), 0)                             as refunds,
  coalesce(sum(e.amount) filter (where e.kind = 'expense'), 0)                            as expenses,
  coalesce(sum(e.receivable_delta), 0)                                                    as outstanding
from public.v_transactions_effective e
where e.client_id is not null
group by e.lawyer_id, e.client_id;

create view public.monthly_financial_summary with (security_invoker = true) as
select e.lawyer_id, date_trunc('month', e.occurred_on)::date as month,
  coalesce(sum(e.amount) filter (where e.kind in ('payment','advance_payment')), 0)
    - coalesce(sum(e.amount) filter (where e.kind = 'refund'), 0)       as collected,
  coalesce(sum(e.amount) filter (where e.kind = 'expense'), 0)           as expenses,
  coalesce(sum(e.amount) filter (where e.kind in ('fee_agreed','additional_charge')), 0) as billed,
  coalesce(sum(e.amount) filter (where e.kind in ('payment','advance_payment')), 0)
    - coalesce(sum(e.amount) filter (where e.kind = 'refund'), 0)
    - coalesce(sum(e.amount) filter (where e.kind = 'expense'), 0)      as net
from public.v_transactions_effective e
group by e.lawyer_id, date_trunc('month', e.occurred_on);

-- Single RPC powering the lawyer dashboard summary tiles (RLS applies)
create or replace function public.lawyer_dashboard_summary()
returns jsonb language plpgsql stable security invoker as $$
begin
  return jsonb_build_object(
    'active_cases', (select count(*) from public.cases
                      where lawyer_id = auth.uid() and deleted_at is null
                        and status not in ('closed','archived')),
    'outstanding_total', coalesce((select sum(receivable_delta) from public.v_transactions_effective
                                    where lawyer_id = auth.uid()), 0),
    'overdue_count', (select count(*) from public.expected_payments
                       where lawyer_id = auth.uid() and status = 'pending'
                         and due_on < public.user_today()),
    'overdue_amount', coalesce((select sum(amount) from public.expected_payments
                                 where lawyer_id = auth.uid() and status = 'pending'
                                   and due_on < public.user_today()), 0),
    'open_tasks', (select count(*) from public.tasks
                    where lawyer_id = auth.uid() and status = 'open' and deleted_at is null),
    'pending_consultations', (select count(*) from public.consultation_assignments a
                               join public.consultations c on c.id = a.consultation_id
                               where a.lawyer_id = auth.uid() and a.status = 'active'
                                 and c.status in ('assigned','in_progress','awaiting_info'))
  );
end $$;

-- Reminder dispatcher. Run by pg_cron or the `process-reminders` Edge Function
-- (service_role only). Cancelled / deleted events never produce notifications.
create or replace function public.process_due_reminders(p_limit int default 500)
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  update public.reminders rm set status = 'cancelled'
   where rm.status = 'pending'
     and exists (select 1 from public.calendar_events e
                 where e.id = rm.event_id and (e.status <> 'scheduled' or e.deleted_at is not null));
  for r in
    select rm.id, rm.lawyer_id, rm.event_id
    from public.reminders rm
    join public.calendar_events e on e.id = rm.event_id
    where rm.status = 'pending' and rm.remind_at <= now()
      and e.status = 'scheduled' and e.deleted_at is null
    order by rm.remind_at
    limit p_limit
    for update of rm skip locked
  loop
    perform public.create_notification(r.lawyer_id, 'event_reminder', 'calendar_event', r.event_id::text);
    update public.reminders set status = 'sent', sent_at = now() where id = r.id;
    n := n + 1;
  end loop;
  -- payment reminders for expected payments due today or overdue (once per day per payment)
  return n;
end $$;

-- Retention job (service_role): hard-delete soft-deleted clients past retention
create or replace function public.purge_deleted_records()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.clients c
   where c.deleted_at is not null
     and c.deleted_at < now() - make_interval(years => public.setting_int('client_retention_years', 5))
     and not exists (select 1 from public.cases k where k.client_id = c.id)
     and not exists (select 1 from public.financial_transactions t where t.client_id = c.id);
  get diagnostics n = row_count;
  return n;
end $$;

-- ===== migrations/0004_consultations.sql =====
-- =============================================================================
-- 0004_consultations.sql — public legal consultation workflow
-- NOTE: submitting a consultation never creates a formal lawyer-client
-- engagement. Responses are informational (see platform disclaimers).
-- =============================================================================
create table public.consultation_categories (
  id                int generated always as identity primary key,
  slug              text not null unique,
  name_ar           text not null,
  name_en           text not null,
  specialization_id int references public.specializations(id),
  is_active         boolean not null default true,
  sort_order        int not null default 0
);
alter table public.consultation_categories enable row level security;
create policy cc_select on public.consultation_categories for select
  using (is_active or public.has_admin_permission('categories.manage'));
create policy cc_write on public.consultation_categories for all
  using (public.has_admin_permission('categories.manage'))
  with check (public.has_admin_permission('categories.manage'));
create trigger trg_audit_cc after insert or update or delete on public.consultation_categories
  for each row execute function public.audit_row_change();

create sequence public.consultation_ref_seq start 100001;

create table public.consultations (
  id                 uuid primary key default gen_random_uuid(),
  reference_no       text not null unique default
    ('MS-' || to_char(now(), 'YYMM') || '-' || lpad(nextval('public.consultation_ref_seq')::text, 6, '0')),
  client_id          uuid not null references public.profiles(id),
  title              text not null check (char_length(trim(title)) between 3 and 200),
  category_id        int references public.consultation_categories(id),
  description        text not null check (char_length(trim(description)) >= 10
                                          and char_length(description) <= 8000),
  jurisdiction       text not null default 'مصر',
  location_text      text,
  opposing_party     text,
  preferred_response text not null default 'in_app' check (preferred_response in ('in_app','email','phone')),
  status             text not null default 'submitted'
    check (status in ('submitted','under_review','awaiting_info','assigned',
                      'in_progress','answered','closed','rejected')),
  consent_privacy    boolean not null check (consent_privacy),
  consent_disclaimer boolean not null check (consent_disclaimer),
  closed_reason      text,
  closed_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index consultations_client_idx on public.consultations (client_id, created_at desc);
create index consultations_status_idx on public.consultations (status, created_at);
create trigger trg_consultations_updated before update on public.consultations
  for each row execute function public.set_updated_at();
alter table public.consultations enable row level security;

create table public.consultation_assignments (
  id               uuid primary key default gen_random_uuid(),
  consultation_id  uuid not null references public.consultations(id) on delete cascade,
  lawyer_id        uuid not null references public.lawyer_profiles(user_id),
  assigned_by      uuid references public.profiles(id),
  status           text not null default 'active' check (status in ('active','reassigned','completed')),
  conflict_checked boolean not null default false,
  conflict_note    text,
  created_at       timestamptz not null default now()
);
create unique index consultation_one_active_assignment on public.consultation_assignments (consultation_id)
  where status = 'active';
create index consultation_assignments_lawyer_idx on public.consultation_assignments (lawyer_id, status);
alter table public.consultation_assignments enable row level security;

create table public.consultation_messages (
  id               uuid primary key default gen_random_uuid(),
  consultation_id  uuid not null references public.consultations(id) on delete cascade,
  sender_id        uuid not null references public.profiles(id),
  sender_role      text not null check (sender_role in ('client','lawyer','admin')),
  kind             text not null default 'message' check (kind in ('message','answer','info_request')),
  body             text not null check (char_length(trim(body)) > 0 and char_length(body) <= 8000),
  created_at       timestamptz not null default now(),
  check (sender_role <> 'client' or kind = 'message')
);
create index consultation_messages_idx on public.consultation_messages (consultation_id, created_at);
alter table public.consultation_messages enable row level security;

create table public.consultation_attachments (
  id               uuid primary key default gen_random_uuid(),
  consultation_id  uuid not null references public.consultations(id) on delete cascade,
  uploader_id      uuid not null references public.profiles(id),
  storage_path     text not null unique,
  file_name        text not null,
  mime_type        text not null check (mime_type in ('application/pdf','image/jpeg','image/png',
      'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes       bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  created_at       timestamptz not null default now(),
  check (storage_path like consultation_id::text || '/%')
);
create index consultation_attachments_idx on public.consultation_attachments (consultation_id);
alter table public.consultation_attachments enable row level security;

create table public.consultation_status_history (
  id               bigint generated always as identity primary key,
  consultation_id  uuid not null references public.consultations(id) on delete cascade,
  from_status      text,
  to_status        text not null,
  actor_id         uuid,
  note             text,
  created_at       timestamptz not null default now()
);
create index consultation_status_history_idx on public.consultation_status_history (consultation_id, created_at);
alter table public.consultation_status_history enable row level security;

-- ------------------------------- access --------------------------------------
create or replace function public.is_assigned_lawyer(p_consultation uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_approved_lawyer() and exists (
    select 1 from public.consultation_assignments a
    where a.consultation_id = p_consultation and a.lawyer_id = auth.uid() and a.status = 'active')
$$;

create or replace function public.can_access_consultation(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_active_user() and exists (
    select 1 from public.consultations c
    where c.id = p_id
      and (c.client_id = auth.uid()
           or public.has_admin_permission('consultations.manage')
           or public.is_assigned_lawyer(c.id)))
$$;

create policy consultations_select on public.consultations for select
  using (public.can_access_consultation(id));
create policy consultations_insert on public.consultations for insert
  with check (client_id = auth.uid() and status = 'submitted'
              and public.current_account_type() = 'client');
-- no UPDATE policy: status changes only via set_consultation_status()

create policy assignments_select on public.consultation_assignments for select
  using (lawyer_id = auth.uid() or public.has_admin_permission('consultations.manage'));

create policy cmsg_select on public.consultation_messages for select
  using (public.can_access_consultation(consultation_id));
create policy cmsg_insert on public.consultation_messages for insert
  with check (
    sender_id = auth.uid() and public.is_active_user()
    and exists (
      select 1 from public.consultations c
      where c.id = consultation_id and c.status not in ('closed','rejected')
        and ( (sender_role = 'client' and c.client_id = auth.uid())
           or (sender_role = 'admin' and public.has_admin_permission('consultations.manage'))
           or (sender_role = 'lawyer' and public.is_assigned_lawyer(c.id)))));

create policy catt_select on public.consultation_attachments for select
  using (public.can_access_consultation(consultation_id));
create policy catt_insert on public.consultation_attachments for insert
  with check (uploader_id = auth.uid() and public.can_access_consultation(consultation_id)
              and exists (select 1 from public.consultations c
                          where c.id = consultation_id and c.status not in ('closed','rejected')));

create policy csh_select on public.consultation_status_history for select
  using (public.can_access_consultation(consultation_id));

-- --------------------------- abuse protection ---------------------------------
create or replace function public.consultations_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_limit int := public.setting_int('consultation_rate_limit_per_hour', 5);
begin
  if (select count(*) from public.consultations
       where client_id = new.client_id and created_at > now() - interval '1 hour') >= v_limit then
    raise exception 'rate_limited' using errcode = '54000';
  end if;
  return new;
end $$;
create trigger trg_consultations_rate_limit before insert on public.consultations
  for each row execute function public.consultations_rate_limit();

create or replace function public.consultations_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.consultation_status_history (consultation_id, from_status, to_status, actor_id)
  values (new.id, null, new.status, auth.uid());
  perform public.notify_admins('consultations.manage', 'consultation_new', 'consultation', new.id::text);
  return new;
end $$;
create trigger trg_consultations_after_insert after insert on public.consultations
  for each row execute function public.consultations_after_insert();

-- ------------------------ status machine (internal) ---------------------------
create or replace function public._apply_consultation_status(
  p_id uuid, p_to text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare c public.consultations%rowtype;
begin
  select * into c from public.consultations where id = p_id for update;
  if not found then raise exception 'consultation_not_found'; end if;
  if c.status = p_to then return; end if;
  update public.consultations
     set status = p_to,
         closed_at = case when p_to in ('closed','rejected') then now() else null end,
         closed_reason = case when p_to in ('closed','rejected') then p_note else null end
   where id = p_id;
  insert into public.consultation_status_history (consultation_id, from_status, to_status, actor_id, note)
  values (p_id, c.status, p_to, auth.uid(), p_note);
  if p_to in ('answered','awaiting_info','closed','rejected','assigned') and c.client_id <> coalesce(auth.uid(), c.client_id) then
    perform public.create_notification(c.client_id,
      case p_to when 'answered' then 'consultation_answered'
                when 'awaiting_info' then 'consultation_info_requested'
                when 'closed' then 'consultation_closed'
                when 'rejected' then 'consultation_rejected'
                else 'consultation_status_changed' end,
      'consultation', p_id::text);
  end if;
end $$;

create or replace function public.set_consultation_status(p_id uuid, p_to text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare c public.consultations%rowtype;
begin
  if p_to not in ('submitted','under_review','awaiting_info','assigned','in_progress','answered','closed','rejected') then
    raise exception 'bad_status';
  end if;
  select * into c from public.consultations where id = p_id;
  if not found then raise exception 'consultation_not_found'; end if;

  if public.has_admin_permission('consultations.manage') then
    if p_to in ('closed','rejected') and coalesce(trim(p_note), '') = '' then
      raise exception 'reason_required';
    end if;
    if p_to = 'assigned' then raise exception 'use_assign_consultation'; end if;
  elsif public.is_assigned_lawyer(p_id) then
    if p_to not in ('in_progress','answered','awaiting_info') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  elsif c.client_id = auth.uid() and public.is_active_user() then
    if p_to <> 'closed' then raise exception 'forbidden' using errcode = '42501'; end if;
  else
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public._apply_consultation_status(p_id, p_to, p_note);
  if public.has_admin_permission('consultations.manage') then
    perform public.write_audit('consultation.status', 'consultations', p_id::text, 'success',
                               jsonb_build_object('to', p_to));
  end if;
end $$;

-- messages drive statuses + notifications
create or replace function public.consultation_message_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare c public.consultations%rowtype; v_assigned uuid;
begin
  select * into c from public.consultations where id = new.consultation_id;
  select lawyer_id into v_assigned from public.consultation_assignments
   where consultation_id = new.consultation_id and status = 'active';
  if new.sender_role = 'client' then
    if c.status in ('awaiting_info','answered','submitted') then
      perform public._apply_consultation_status(c.id,
        case when v_assigned is not null then 'in_progress' else 'under_review' end);
    end if;
    if v_assigned is not null then
      perform public.create_notification(v_assigned, 'consultation_client_reply', 'consultation', c.id::text);
    else
      perform public.notify_admins('consultations.manage', 'consultation_client_reply', 'consultation', c.id::text);
    end if;
  else
    if new.kind = 'answer' then
      perform public._apply_consultation_status(c.id, 'answered');
    elsif new.kind = 'info_request' then
      perform public._apply_consultation_status(c.id, 'awaiting_info');
    elsif c.status in ('submitted') then
      perform public._apply_consultation_status(c.id, 'under_review');
    end if;
    perform public.create_notification(c.client_id, 'consultation_response', 'consultation', c.id::text);
  end if;
  return new;
end $$;
create trigger trg_cmsg_after_insert after insert on public.consultation_messages
  for each row execute function public.consultation_message_after_insert();

-- ------------------------ conflict + eligibility ------------------------------
-- Potential conflict of interest (returns only a count, never the lawyer's data):
--  (1) the opposing party named in the consultation is one of the lawyer's own clients, or
--  (2) the lawyer is currently ADVERSE to the consulting client (an open matter lists
--      the client's name as opposing party).
create or replace function public.consultation_conflict_count(p_consultation uuid, p_lawyer uuid)
returns int language plpgsql stable security definer set search_path = public as $$
declare v_op text; v_client text;
begin
  if not public.has_admin_permission('consultations.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select lower(trim(coalesce(c.opposing_party, ''))), lower(trim(pr.full_name))
    into v_op, v_client
    from public.consultations c join public.profiles pr on pr.id = c.client_id
   where c.id = p_consultation;
  return (case when v_op <> '' then
            (select count(*) from public.clients c
              where c.lawyer_id = p_lawyer and c.deleted_at is null
                and lower(trim(c.full_name)) = v_op)
          else 0 end)
       + (select count(*) from public.cases k
           where k.lawyer_id = p_lawyer and k.deleted_at is null
             and k.status not in ('closed','archived')
             and lower(trim(coalesce(k.opposing_party, ''))) = v_client);
end $$;

create or replace function public.eligible_lawyers_for_consultation(p_consultation uuid)
returns table (lawyer_id uuid, public_alias text, years_experience int, city text,
               specialization_match boolean, open_load int, conflicts int)
language plpgsql stable security definer set search_path = public as $$
declare v_spec int;
begin
  if not public.has_admin_permission('consultations.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select cc.specialization_id into v_spec
    from public.consultations c join public.consultation_categories cc on cc.id = c.category_id
   where c.id = p_consultation;
  return query
    select lp.user_id, lp.public_alias, lp.years_experience, lp.city,
           (v_spec is not null and exists (select 1 from public.lawyer_specializations ls
                                           where ls.lawyer_id = lp.user_id and ls.specialization_id = v_spec)),
           (select count(*)::int from public.consultation_assignments a
             join public.consultations k on k.id = a.consultation_id
            where a.lawyer_id = lp.user_id and a.status = 'active'
              and k.status in ('assigned','in_progress','awaiting_info')),
           public.consultation_conflict_count(p_consultation, lp.user_id)
      from public.lawyer_profiles lp
      join public.profiles pr on pr.id = lp.user_id
     where lp.verification_status = 'approved' and lp.accepts_consultations
       and pr.status = 'active' and pr.deleted_at is null
     order by 5 desc, 6 asc, lp.years_experience desc nulls last;
end $$;

create or replace function public.assign_consultation(
  p_consultation uuid, p_lawyer uuid, p_override_conflict boolean default false, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare c public.consultations%rowtype; v_conf int;
begin
  if not public.has_admin_permission('consultations.manage') then
    perform public.write_audit('consultation.assign', 'consultations', p_consultation::text, 'denied');
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into c from public.consultations where id = p_consultation for update;
  if not found then raise exception 'consultation_not_found'; end if;
  if c.status in ('closed','rejected') then raise exception 'consultation_closed'; end if;
  if not public.is_approved_lawyer(p_lawyer) then raise exception 'lawyer_not_eligible'; end if;
  if not exists (select 1 from public.lawyer_profiles where user_id = p_lawyer and accepts_consultations) then
    raise exception 'lawyer_not_accepting';
  end if;
  v_conf := public.consultation_conflict_count(p_consultation, p_lawyer);
  if v_conf > 0 and not (p_override_conflict and coalesce(trim(p_note), '') <> '') then
    raise exception 'potential_conflict';
  end if;
  update public.consultation_assignments set status = 'reassigned'
   where consultation_id = p_consultation and status = 'active';
  insert into public.consultation_assignments
    (consultation_id, lawyer_id, assigned_by, conflict_checked, conflict_note)
  values (p_consultation, p_lawyer, auth.uid(), true, case when v_conf > 0 then p_note end);
  perform public._apply_consultation_status(p_consultation, 'assigned', p_note);
  perform public.create_notification(p_lawyer, 'consultation_assigned', 'consultation', p_consultation::text);
  perform public.write_audit('consultation.assign', 'consultations', p_consultation::text, 'success',
                             jsonb_build_object('conflicts', v_conf));
end $$;

-- ===== migrations/0005_library_templates.sql =====
-- =============================================================================
-- 0005_library_templates.sql — legal library + document templates
-- NO legal text is shipped. Admins upload verified material with its source.
-- =============================================================================
create table public.library_categories (
  id         int generated always as identity primary key,
  slug       text not null unique,
  name_ar    text not null,
  name_en    text not null,
  is_active  boolean not null default true,
  sort_order int not null default 0
);
alter table public.library_categories enable row level security;
create policy libcat_select on public.library_categories for select
  using (is_active or public.has_admin_permission('categories.manage'));
create policy libcat_write on public.library_categories for all
  using (public.has_admin_permission('categories.manage'))
  with check (public.has_admin_permission('categories.manage'));

create table public.legal_resources (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null check (char_length(trim(title)) > 0),
  resource_type       text not null check (resource_type in
    ('law','article','constitutional','bar_resource','civil_commercial','criminal','procedure',
     'evidence','labor','personal_status','administrative','regulation','judgment','principle',
     'form','contract','pleading','memo','circular','reference','other')),
  category_id         int references public.library_categories(id),
  law_name            text,
  article_number      text,
  issuing_authority   text,
  publication_date    date,
  effective_date      date,
  version             text,
  source              text,                  -- e.g. official gazette reference
  source_url          text,
  language            text not null default 'ar' check (language in ('ar','en')),
  body_text           text,                  -- preserved verbatim from the uploaded source
  tags                text[] not null default '{}',
  amendment_history   jsonb not null default '[]'::jsonb,
  is_official_source  boolean not null default false,  -- official legislation vs. explanatory material
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified','verified','outdated')),
  last_verified_at    date,
  license_note        text,
  file_path           text,
  file_name           text,
  mime_type           text,
  size_bytes          bigint check (size_bytes is null or size_bytes <= 52428800),
  status              text not null default 'draft'
    check (status in ('draft','published','unpublished','archived')),
  created_by          uuid references public.profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  fts tsvector generated always as (
    to_tsvector('simple',
      coalesce(title,'') || ' ' || coalesce(law_name,'') || ' ' ||
      coalesce(article_number,'') || ' ' || coalesce(body_text,''))) stored
);
create index legal_resources_fts on public.legal_resources using gin (fts);
create index legal_resources_title_trgm on public.legal_resources using gin (title gin_trgm_ops);
create index legal_resources_lawname_trgm on public.legal_resources using gin (law_name gin_trgm_ops);
create index legal_resources_status_idx on public.legal_resources (status, resource_type);
create trigger trg_legal_resources_updated before update on public.legal_resources
  for each row execute function public.set_updated_at();
create trigger trg_audit_legal_resources after insert or update or delete on public.legal_resources
  for each row execute function public.audit_row_change();
alter table public.legal_resources enable row level security;

create policy resources_select on public.legal_resources for select
  using ((status = 'published' and public.is_approved_lawyer())
         or public.has_admin_permission('library.manage'));
create policy resources_write on public.legal_resources for all
  using (public.has_admin_permission('library.manage'))
  with check (public.has_admin_permission('library.manage'));

create table public.resource_bookmarks (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  resource_id uuid not null references public.legal_resources(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, resource_id)
);
alter table public.resource_bookmarks enable row level security;
create policy bookmarks_all on public.resource_bookmarks for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.resource_views (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  resource_id uuid not null references public.legal_resources(id) on delete cascade,
  viewed_at   timestamptz not null default now(),
  primary key (user_id, resource_id)
);
alter table public.resource_views enable row level security;
create policy views_select on public.resource_views for select using (user_id = auth.uid());
create policy views_insert on public.resource_views for insert with check (user_id = auth.uid());
create policy views_update on public.resource_views for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.touch_resource_view(p_resource uuid)
returns void language plpgsql security invoker as $$
begin
  insert into public.resource_views (user_id, resource_id) values (auth.uid(), p_resource)
  on conflict (user_id, resource_id) do update set viewed_at = now();
end $$;

create table public.resource_reports (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.legal_resources(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id),
  reason      text not null check (reason in ('outdated','incorrect','copyright','other')),
  details     text,
  status      text not null default 'open' check (status in ('open','resolved','dismissed')),
  resolved_by uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
alter table public.resource_reports enable row level security;
create policy rr_select on public.resource_reports for select
  using (reporter_id = auth.uid() or public.has_admin_permission('library.manage'));
create policy rr_insert on public.resource_reports for insert
  with check (reporter_id = auth.uid() and public.is_approved_lawyer());
create policy rr_update on public.resource_reports for update
  using (public.has_admin_permission('library.manage'))
  with check (public.has_admin_permission('library.manage'));

create table public.document_templates (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null check (char_length(trim(title)) > 0),
  category            text not null check (category in
    ('power_of_attorney','legal_notice','contract','memorandum','pleading','letter',
     'engagement_agreement','payment_acknowledgement','other')),
  description         text,
  body                text,                 -- uses {{field_key}} placeholders
  fields              jsonb not null default '[]'::jsonb,   -- [{key,label_ar,label_en,type}]
  file_path           text,
  file_name           text,
  mime_type           text,
  size_bytes          bigint check (size_bytes is null or size_bytes <= 26214400),
  reviewed_for_purpose text,                -- null => general reference only
  status              text not null default 'draft'
    check (status in ('draft','published','unpublished','archived')),
  created_by          uuid references public.profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger trg_templates_updated before update on public.document_templates
  for each row execute function public.set_updated_at();
create trigger trg_audit_templates after insert or update or delete on public.document_templates
  for each row execute function public.audit_row_change();
alter table public.document_templates enable row level security;
create policy templates_select on public.document_templates for select
  using ((status = 'published' and public.is_approved_lawyer())
         or public.has_admin_permission('templates.manage'));
create policy templates_write on public.document_templates for all
  using (public.has_admin_permission('templates.manage'))
  with check (public.has_admin_permission('templates.manage'));

-- ===== migrations/0006_directory_admin.sql =====
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

-- ===== migrations/0007_storage.sql =====
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

-- ===== migrations/0099_grants.sql =====
-- =============================================================================
-- 0099_grants.sql — least-privilege grants. RLS is the second layer.
-- Re-run the REVOKE block whenever new tables/functions are added.
-- =============================================================================
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;

-- anon: only public settings (pre-login disclaimers / language)
grant select on public.platform_settings to anon;

-- authenticated: table privileges (RLS filters rows) ------------------------------
grant select on public.platform_settings, public.specializations, public.consultation_categories,
                public.library_categories, public.admin_users, public.admin_role_permissions,
                public.verification_events, public.lawyer_specializations,
                public.application_documents, public.audit_logs,
                public.consultation_assignments, public.consultation_status_history,
                public.case_activity, public.reminders, public.public_lawyer_directory,
                public.v_transactions_effective, public.case_balances,
                public.client_balances, public.monthly_financial_summary,
                public.resource_views
  to authenticated;

grant select on public.profiles to authenticated;
grant update (full_name, phone, locale, timezone) on public.profiles to authenticated;

grant select on public.lawyer_profiles to authenticated;
grant select on public.lawyer_identities to authenticated;
grant update (full_legal_name, bar_membership_number, bar_branch) on public.lawyer_identities to authenticated;
grant update (city, working_locations,
              years_experience, bio, languages, contact_preferences, accepts_consultations,
              availability_note, show_in_directory) on public.lawyer_profiles to authenticated;

grant insert, delete on public.lawyer_specializations to authenticated;
grant insert on public.application_documents to authenticated;
grant update (deleted_at) on public.application_documents to authenticated;

grant insert, update, delete on public.platform_settings, public.specializations,
      public.consultation_categories, public.library_categories to authenticated;

grant select, insert, update on public.clients, public.cases, public.calendar_events,
      public.tasks, public.expected_payments to authenticated;
grant select, insert, update, delete on public.case_members to authenticated;
grant select, insert on public.case_notes, public.case_documents to authenticated;
grant update (body, deleted_at) on public.case_notes to authenticated;
grant update (deleted_at) on public.case_documents to authenticated;
grant select, insert on public.financial_transactions to authenticated;   -- append-only

grant select, insert on public.consultations to authenticated;
grant select, insert on public.consultation_messages, public.consultation_attachments to authenticated;

grant select, insert, update, delete on public.legal_resources, public.document_templates to authenticated;
grant select, insert, update, delete on public.resource_bookmarks to authenticated;
grant insert, update on public.resource_views to authenticated;
grant select, insert, update on public.resource_reports to authenticated;

grant select, update, delete on public.notifications to authenticated;
grant select, insert, update, delete on public.notification_preferences, public.device_tokens to authenticated;

grant usage, select on all sequences in schema public to authenticated;

-- functions callable by signed-in users (each re-checks authorization inside) -----
grant execute on function
  public.has_admin_permission(text), public.is_admin(), public.is_super_admin(),
  public.is_active_user(), public.current_account_type(), public.user_today(),
  public.is_approved_lawyer(uuid), public.can_access_case(uuid, boolean), public.owns_case(uuid),
  public.can_view_case_notes(uuid), public.owns_client(uuid),
  public.can_access_consultation(uuid), public.is_assigned_lawyer(uuid),
  public.setting_text(text, text), public.setting_int(text, int), public.try_uuid(text),
  public.mark_all_notifications_read(),
  public.submit_lawyer_application(), public.admin_review_lawyer(uuid, text, text),
  public.admin_get_lawyer_identity(uuid), public.admin_list_users(text, text, text), public.admin_list_lawyers(text, text), public.admin_set_account_status(uuid, text, text),
  public.resolve_alias(text), public.add_case_member_by_alias(uuid, text, boolean, boolean),
  public.list_case_members(uuid), public.find_duplicate_clients(text, text),
  public.find_event_conflicts(timestamptz, timestamptz, uuid),
  public.record_hearing_result(uuid, text, timestamptz, text),
  public.reverse_transaction(uuid, text), public.lawyer_dashboard_summary(),
  public.set_consultation_status(uuid, text, text),
  public.consultation_conflict_count(uuid, uuid), public.eligible_lawyers_for_consultation(uuid),
  public.assign_consultation(uuid, uuid, boolean, text),
  public.touch_resource_view(uuid),
  public.admin_dashboard_stats(), public.admin_report_summary(date, date),
  public.send_announcement(text, text, text)
  to authenticated;

-- RLS helper functions are also needed by anon policy evaluation on platform_settings
grant execute on function public.has_admin_permission(text) to anon;

-- service role (Edge Functions / cron) ----------------------------------------------
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- pg_trgm's similarity() is used by find_duplicate_clients (SECURITY INVOKER).
-- When the extension lives in `public` the blanket REVOKE above removed its EXECUTE
-- grant; on Supabase (extensions schema) this block is a no-op.
do $$ begin
  if to_regprocedure('public.similarity(text,text)') is not null then
    grant execute on function public.similarity(text, text) to authenticated;
  end if;
end $$;

-- ===== seed.sql =====
-- Reference data only. NO legal texts, NO fabricated statutes.
insert into public.specializations (slug, name_ar, name_en, sort_order) values
 ('civil','القانون المدني','Civil law',1),
 ('criminal','القانون الجنائي','Criminal law',2),
 ('personal-status','الأحوال الشخصية','Personal status',3),
 ('commercial','القانون التجاري والشركات','Commercial & corporate',4),
 ('labor','قانون العمل','Labor law',5),
 ('administrative','القانون الإداري','Administrative law',6),
 ('real-estate','العقارات','Real estate',7),
 ('tax','الضرائب والجمارك','Tax & customs',8),
 ('ip','الملكية الفكرية','Intellectual property',9),
 ('banking','البنوك والتمويل','Banking & finance',10)
on conflict (slug) do nothing;

insert into public.consultation_categories (slug, name_ar, name_en, specialization_id, sort_order)
select s.slug, s.name_ar, s.name_en, s.id, s.sort_order from public.specializations s
on conflict (slug) do nothing;
insert into public.consultation_categories (slug, name_ar, name_en, sort_order) values
 ('other','أخرى','Other',99) on conflict (slug) do nothing;

insert into public.library_categories (slug, name_ar, name_en, sort_order) values
 ('constitution','الدستور','Constitution',1),
 ('civil-commercial','القانون المدني والتجاري','Civil & commercial',2),
 ('criminal','القانون الجنائي','Criminal',3),
 ('procedure','المرافعات والإجراءات','Procedure',4),
 ('evidence','الإثبات','Evidence',5),
 ('labor','العمل','Labor',6),
 ('personal-status','الأحوال الشخصية','Personal status',7),
 ('administrative','الإداري','Administrative',8),
 ('regulations','اللوائح التنفيذية','Executive regulations',9),
 ('judicial','المبادئ والأحكام','Judicial principles',10),
 ('bar','نقابة المحامين','Bar Association',11),
 ('forms','نماذج وعقود','Forms & contracts',12)
on conflict (slug) do nothing;

