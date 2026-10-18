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
