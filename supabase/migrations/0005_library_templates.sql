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
