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
