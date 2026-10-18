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
