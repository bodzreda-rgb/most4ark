-- =============================================================================
-- 10_policy_tests.sql — authorization / RLS / finance / calendar / consultation tests
-- Runs as a superuser connection; impersonates users via tests.login(uuid).
-- Any failed assertion raises an exception and aborts the run (ON_ERROR_STOP).
-- =============================================================================
create schema tests;
grant usage on schema tests to public;

create function tests.login(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  execute 'set role authenticated';
end $$;
create function tests.logout() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', false);
end $$;
create function tests.ok(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if not coalesce(p_cond, false) then raise exception 'FAIL: %', p_msg; end if;
  raise notice 'ok - %', p_msg;
end $$;
create function tests.throws(p_sql text, p_msg text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok - % [%]', p_msg, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_msg;
end $$;
create function tests.count(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin execute 'select count(*) from (' || p_sql || ') q' into n; return n; end $$;

-- ------------------------------- fixtures -------------------------------------
\set sa  '''00000000-0000-0000-0000-0000000000a1'''
\set rev '''00000000-0000-0000-0000-0000000000a2'''
\set sup '''00000000-0000-0000-0000-0000000000a3'''
\set law1 '''00000000-0000-0000-0000-000000000011'''
\set law2 '''00000000-0000-0000-0000-000000000012'''
\set law3 '''00000000-0000-0000-0000-000000000013'''
\set cx  '''00000000-0000-0000-0000-000000000021'''
\set cy  '''00000000-0000-0000-0000-000000000022'''

-- fixtures sign up already-active users (account approval is exercised separately)
update public.platform_settings set value = 'false' where key = 'require_account_approval';

insert into auth.users (id, email, raw_user_meta_data) values
 (:sa,  'super@ms.test',  '{"full_name":"Super Admin","account_type":"admin"}'),   -- admin request must be ignored
 (:rev, 'rev@ms.test',    '{"full_name":"Reviewer"}'),
 (:sup, 'sup@ms.test',    '{"full_name":"Support"}'),
 (:law1,'l1@ms.test',     '{"full_name":"أحمد محمد علي","account_type":"lawyer","phone":"01000000001"}'),
 (:law2,'l2@ms.test',     '{"full_name":"سارة حسن","account_type":"lawyer"}'),
 (:law3,'l3@ms.test',     '{"full_name":"Unverified Lawyer","account_type":"lawyer"}'),
 (:cx,  'cx@ms.test',     '{"full_name":"Client X"}'),
 (:cy,  'cy@ms.test',     '{"full_name":"Client Y"}');

select tests.ok((select account_type from profiles where id = :sa) = 'client',
  'signup metadata cannot create an admin');
select create_admin(:sa::uuid, 'super_admin');
select create_admin(:rev::uuid, 'reviewer');
select create_admin(:sup::uuid, 'support');

-- ---------------------- privilege escalation attempts --------------------------
select tests.login(:cx);
select tests.throws($$update profiles set account_type = 'admin' where id = '00000000-0000-0000-0000-000000000021'$$,
  'user cannot change own account_type');
select tests.throws($$update profiles set status = 'active' where id = '00000000-0000-0000-0000-000000000021'$$,
  'user cannot change own status');
select tests.throws($$insert into admin_users (user_id, role) values ('00000000-0000-0000-0000-000000000021','super_admin')$$,
  'user cannot grant themselves admin');
select tests.throws($$insert into audit_logs (action) values ('forged')$$, 'user cannot forge audit rows');
select tests.ok(tests.count('select 1 from profiles') = 1, 'user sees only own profile');
select tests.logout();

-- ----------------- lawyer 1: application + verification flow -------------------
select tests.login(:law1);
select tests.throws($$update lawyer_profiles set verification_status = 'approved'$$,
  'lawyer cannot self-approve');
select tests.throws($$insert into clients (lawyer_id, full_name) values ('00000000-0000-0000-0000-000000000011','x')$$,
  '#1 unverified lawyer cannot create clients');
select tests.throws($$select submit_lawyer_application()$$, 'cannot submit incomplete application');
update lawyer_profiles set city = 'القاهرة', years_experience = 8, bio = 'محامٍ بالنقض', accepts_consultations = true;
update lawyer_identities set bar_membership_number = '12345';
insert into lawyer_specializations values ('00000000-0000-0000-0000-000000000011', 1);
select tests.throws($$select submit_lawyer_application()$$, 'cannot submit without bar card');
insert into application_documents (lawyer_id, doc_type, storage_path, mime_type, size_bytes)
values ('00000000-0000-0000-0000-000000000011', 'bar_card',
        '00000000-0000-0000-0000-000000000011/card.png', 'image/png', 1000);
select tests.throws($$insert into application_documents (lawyer_id, doc_type, storage_path, mime_type, size_bytes)
   values ('00000000-0000-0000-0000-000000000011','supporting','00000000-0000-0000-0000-000000000099/x.png','image/png',10)$$,
   'document path must be inside own folder');
select tests.throws($$insert into application_documents (lawyer_id, doc_type, storage_path, mime_type, size_bytes)
   values ('00000000-0000-0000-0000-000000000011','supporting','00000000-0000-0000-0000-000000000011/x.exe','application/x-msdownload',10)$$,
   'document mime type validated');
select submit_lawyer_application();
select tests.ok((select verification_status from lawyer_profiles) = 'submitted', 'application submitted');
select tests.throws($$update lawyer_identities set full_legal_name = 'Other Name'$$,
  'identity locked after submission');
select tests.logout();

select tests.login(:sup);
select tests.throws($$select admin_review_lawyer('00000000-0000-0000-0000-000000000011','approve')$$,
  'support admin cannot approve lawyers');
select tests.logout();

select tests.login(:law2);
select tests.throws($$select admin_review_lawyer('00000000-0000-0000-0000-000000000011','approve')$$,
  'lawyer cannot approve lawyers');
select tests.logout();

select tests.login(:rev);
select tests.throws($$select admin_review_lawyer('00000000-0000-0000-0000-000000000011','reject')$$,
  'rejection requires a reason');
select admin_review_lawyer(:law1::uuid, 'start_review');
select admin_review_lawyer(:law1::uuid, 'approve');
select tests.ok((select verification_status from lawyer_profiles where user_id = :law1) = 'approved',
  '#2 admin approves a valid application');
select tests.ok((select public_alias from lawyer_profiles where user_id = :law1) = 'Advocate #A1001',
  'public alias generated');
select tests.logout();

select tests.login(:law1);
select tests.ok(tests.count('select 1 from notifications where kind = ''lawyer_approved''') = 1,
  'lawyer receives approval notification');
select tests.logout();

-- lawyer 2 approved directly (fixture) -------------------------------------------
update lawyer_profiles set city = 'الإسكندرية', years_experience = 3, accepts_consultations = true where user_id = :law2;
update lawyer_identities set bar_membership_number = '777' where user_id = :law2;
insert into lawyer_specializations values (:law2, 2);
update lawyer_profiles set verification_status = 'submitted' where user_id = :law2;   -- fixture shortcut
select tests.login(:rev);
select admin_review_lawyer(:law2::uuid, 'approve');
select tests.logout();

-- rejection + resubmission ---------------------------------------------------------
update lawyer_profiles set city = 'x', years_experience = 1 where user_id = :law3;
update lawyer_identities set bar_membership_number = '1' where user_id = :law3;
insert into lawyer_specializations values (:law3, 1);
insert into application_documents (lawyer_id, doc_type, storage_path, mime_type, size_bytes)
values (:law3, 'bar_card', :law3 || '/c.png', 'image/png', 10);
select tests.login(:law3);
select submit_lawyer_application();
select tests.logout();
select tests.login(:rev);
select admin_review_lawyer(:law3::uuid, 'reject', 'صورة الكارنيه غير واضحة');
select tests.logout();
select tests.login(:law3);
select tests.ok((select rejection_reason from lawyer_profiles) = 'صورة الكارنيه غير واضحة', 'lawyer sees rejection reason');
select tests.ok((select count(*) from verification_events) >= 2, 'lawyer sees own verification history');
select tests.throws($$insert into cases (lawyer_id, case_number, title) values ('00000000-0000-0000-0000-000000000013','1','t')$$,
  '#1 rejected lawyer still cannot use professional features');
update lawyer_profiles set city = 'الجيزة';   -- may correct
select submit_lawyer_application();
select tests.ok((select verification_status from lawyer_profiles) = 'submitted', 'rejected lawyer can resubmit');
select tests.logout();

-- ---------------------------- identity visibility -------------------------------
select tests.login(:rev);
select tests.ok((admin_get_lawyer_identity(:law1::uuid)->>'full_legal_name') = 'أحمد محمد علي',
  '#6 authorised admin views verified identity');
select tests.logout();
select tests.login(:sup);
select tests.throws($$select admin_get_lawyer_identity('00000000-0000-0000-0000-000000000011')$$,
  'admin without identity permission cannot view identity');
select tests.logout();
select tests.login(:law2);
select tests.throws($$select admin_get_lawyer_identity('00000000-0000-0000-0000-000000000011')$$,
  'lawyer cannot call identity RPC');
select tests.ok(tests.count('select 1 from lawyer_profiles') = 1, 'lawyer sees only own lawyer_profile');
select tests.ok(tests.count('select 1 from application_documents') = 0, 'lawyer cannot see others documents');

-- identity table is private; reviewers without identity.read cannot read names
select tests.ok(tests.count('select 1 from lawyer_identities') = 1, 'lawyer sees only own identity row');
select tests.logout();
select tests.login(:rev);
select tests.ok(tests.count('select 1 from lawyer_identities') = 3, 'identity-authorised admin lists identities');
select tests.ok((select count(*) from admin_list_lawyers(null, 'أحمد')) = 1, 'admin can search lawyers by real name');
select tests.logout();
select tests.login(:sup);
select tests.ok(tests.count('select 1 from lawyer_identities') = 0, 'support admin cannot read identities');
select tests.throws($$select * from admin_list_lawyers(null, null)$$, 'support admin cannot list lawyers');
select tests.logout();

-- admin user list masks lawyer identities unless the admin may read them
select tests.login(:sup);
select tests.ok(tests.count('select 1 from profiles') = 1, 'support admin cannot read other profiles directly');
select tests.ok((select count(*) from admin_list_users('lawyer')) = 3, 'support admin lists lawyer accounts');
select tests.ok((select count(*) from admin_list_users('lawyer') where full_name is not null or email is not null) = 0,
  'lawyer names/emails are masked for admins without identity permission');
select tests.ok((select count(*) from admin_list_users('client') where full_name is not null) >= 2, 'client names visible to support');
select tests.logout();
select tests.login(:rev);
select tests.ok((select count(*) from admin_list_users('lawyer') where full_name is not null) = 3, 'identity-authorised admin sees lawyer names');
select tests.logout();
select tests.login(:law1);
select tests.throws($$select * from admin_list_users()$$, 'lawyer cannot list users');
select tests.logout();

-- ----------------------------- public directory ---------------------------------
select tests.login(:cx);
select tests.ok(tests.count('select 1 from public_lawyer_directory') = 2, 'directory lists only approved lawyers');
select tests.ok(not exists (select 1 from information_schema.columns
    where table_name = 'public_lawyer_directory'
      and column_name in ('user_id','full_legal_name','bar_membership_number','email','phone','full_name')),
  '#5 directory exposes no identity columns');
select tests.ok(not exists (select 1 from public_lawyer_directory d
    where d::text like '%أحمد%' or d::text like '%l1@ms.test%' or d::text like '%12345%'),
  '#5 directory rows contain no real name/email/bar number');
select tests.ok(tests.count('select 1 from lawyer_profiles') = 0, 'client cannot read lawyer_profiles');
select tests.logout();

-- ------------------------------ practice data -----------------------------------
select tests.login(:law1);
insert into clients (lawyer_id, full_name, phone) values (:law1, 'محمود إبراهيم', '0100 111 2222');
select tests.ok(tests.count($$select 1 from find_duplicate_clients('مختلف تماما','+20 100 111 2222')$$) = 1,
  'duplicate client detected by phone');
select tests.ok(tests.count($$select 1 from find_duplicate_clients('محمود إبراهيم', null)$$) = 1,
  'duplicate client detected by name');
insert into cases (lawyer_id, case_number, title, client_id, opposing_party, court)
select :law1, '100/2026', 'قضية تجريبية', id, 'شركة الخصم', 'محكمة القاهرة' from clients limit 1;
select tests.throws($$insert into cases (lawyer_id, case_number, title) values ('00000000-0000-0000-0000-000000000011','100/2026','dup')$$,
  'case number unique per lawyer');
insert into case_notes (case_id, author_id, body) select id, :law1, 'ملاحظة خاصة' from cases;
select tests.ok(tests.count('select 1 from case_activity') >= 2, 'case activity is recorded');
select tests.logout();

select tests.login(:law2);
select tests.ok(tests.count('select 1 from cases') = 0, '#3 lawyer cannot read another lawyer''s cases');
select tests.ok(tests.count('select 1 from clients') = 0, 'lawyer cannot read another lawyer''s clients');
select tests.ok(tests.count('select 1 from case_notes') = 0, 'lawyer cannot read another lawyer''s notes');
update cases set title = 'hacked';
select tests.ok((select count(*) from cases) = 0, 'cross-lawyer update affects nothing');
select tests.throws($$insert into cases (lawyer_id, case_number, title) values ('00000000-0000-0000-0000-000000000011','x','forged owner')$$,
  'cannot create case in another lawyer''s name');
select tests.logout();
select tests.ok((select title from cases limit 1) = 'قضية تجريبية', 'case title unchanged by other lawyer');

-- team member access by alias ----------------------------------------------------------
select tests.login(:law1);
select add_case_member_by_alias((select id from cases), 'Advocate #A1002', false, false);
select tests.ok((select count(*) from list_case_members((select id from cases))) = 1, 'owner lists members by alias');
select tests.logout();
select tests.login(:law2);
select tests.ok(tests.count('select 1 from cases') = 1, 'member can read shared case');
select tests.ok(tests.count('select 1 from case_notes') = 0, 'member without permission cannot read private notes');
select tests.throws($$insert into case_notes (case_id, author_id, body)
   select id, '00000000-0000-0000-0000-000000000012', 'x' from cases$$, 'member without permission cannot write notes');
update cases set title = 'edit by read-only member';
select tests.ok((select title from cases) = 'قضية تجريبية', 'read-only member cannot edit');
select tests.ok(tests.count('select 1 from financial_transactions') = 0, 'member cannot see finance');
select tests.logout();
select tests.login(:law1);
update case_members set can_view_notes = true;
select tests.logout();
select tests.login(:law2);
select tests.ok(tests.count('select 1 from case_notes') = 1, 'member with permission can read notes');
select tests.logout();

-- reopen requires owner
select tests.login(:law1);
update cases set status = 'closed';
select tests.ok((select closed_on from cases) is not null, 'closing sets closed_on');
update cases set status = 'archived';
select tests.logout();
select tests.login(:law2);
update case_members set can_edit = true;   -- member cannot change own rights (no rows visible to update)
select tests.logout();
select tests.login(:law1);
update case_members set can_edit = true;
select tests.logout();
select tests.login(:law2);
select tests.throws($$update cases set status = 'in_progress'$$, 'member cannot reopen an archived case');
select tests.logout();
select tests.login(:law1);
update cases set status = 'in_progress';
select tests.ok((select closed_on from cases) is null, 'owner can reopen');
select tests.logout();

-- ------------------------------- finance -----------------------------------------
select tests.login(:law1);
select tests.throws($$insert into financial_transactions (lawyer_id, kind, amount, occurred_on)
    values ('00000000-0000-0000-0000-000000000011','payment',-5,current_date)$$, 'amount must be positive');
insert into financial_transactions (lawyer_id, case_id, kind, amount, occurred_on, method)
select :law1, id, k, a, current_date, 'cash' from cases,
  (values ('fee_agreed',1000),('advance_payment',300),('payment',200),('expense',50),
          ('credit',100),('additional_charge',50)) v(k, a);
select tests.ok((select outstanding from case_balances) = 450, '#7 outstanding = 1000+50-500-100');
select tests.ok((select collected from case_balances) = 500, 'collected = payments');
select tests.ok((select net_after_expenses from case_balances) = 450, 'net after expenses');
select tests.ok((select outstanding from client_balances) = 450, 'client balance equals case balance (no double count)');
select reverse_transaction((select id from financial_transactions where kind = 'payment'), 'مدفوعة بالخطأ');
select tests.ok((select outstanding from case_balances) = 650, '#7 reversal restores the balance');
select tests.ok((select payments from case_balances) = 300, 'reversed payment excluded from totals');
select tests.throws($$select reverse_transaction((select id from financial_transactions where kind = 'advance_payment' limit 1), '')$$,
  'reversal requires a reason');
select tests.throws($$select reverse_transaction((select reverses_id from financial_transactions where kind = 'reversal'), 'again')$$,
  'transaction cannot be reversed twice');
select tests.throws($$update financial_transactions set amount = 1$$, 'ledger rows cannot be edited');
select tests.throws($$delete from financial_transactions$$, 'ledger rows cannot be deleted');
select tests.ok((select net from monthly_financial_summary) = 300 - 50, 'monthly net = collected - expenses');
insert into expected_payments (lawyer_id, amount, due_on, case_id)
  select :law1, 100, current_date - 3, id from cases;
select tests.ok(((lawyer_dashboard_summary())->>'overdue_count')::int = 1, 'dashboard counts overdue payments');
select tests.ok(((lawyer_dashboard_summary())->>'outstanding_total')::numeric = 650, 'dashboard outstanding total');
select tests.logout();

select tests.login(:law2);
select tests.ok(tests.count('select 1 from financial_transactions') = 0, 'financial data is private');
select tests.ok(tests.count('select 1 from case_balances') = 0, 'balances are private');
select tests.logout();
select tests.login(:rev);
select tests.ok(tests.count('select 1 from financial_transactions') = 0, 'admins cannot read lawyer finances');
select tests.ok(tests.count('select 1 from clients') = 0, 'admins cannot read lawyer clients');
select tests.ok(tests.count('select 1 from cases') = 0, 'admins cannot read lawyer cases');
select tests.logout();

-- ------------------------------ calendar -----------------------------------------
select tests.login(:law1);
insert into calendar_events (lawyer_id, kind, title, starts_at, ends_at)
values (:law1, 'hearing', 'جلسة', now() + interval '3 days', now() + interval '3 days 1 hour');
select tests.ok(tests.count($$select 1 from reminders where status = 'pending'$$) = 3, 'three reminders created');
select tests.throws($$insert into calendar_events (lawyer_id, kind, title, starts_at)
   select lawyer_id, kind, title, starts_at from calendar_events limit 1$$, 'duplicate event rejected');
select tests.ok(tests.count($$select 1 from find_event_conflicts(now() + interval '3 days 10 minutes', null, null)$$) = 1,
  'conflict warning finds overlapping event');
update calendar_events set starts_at = now() + interval '5 days', ends_at = now() + interval '5 days 1 hour';
select tests.ok(tests.count($$select 1 from reminders where status = 'pending'$$) = 3, '#8 reschedule rebuilds reminders');
select tests.ok(tests.count($$select 1 from reminders where status = 'cancelled'$$) = 3, 'old reminders cancelled on reschedule');
select tests.ok((select min(remind_at) from reminders where status = 'pending')
              = (select starts_at - interval '1440 minutes' from calendar_events), 'new reminder times follow new start');
update calendar_events set status = 'cancelled';
select tests.ok(tests.count($$select 1 from reminders where status = 'pending'$$) = 0, '#9 cancelled event has no pending reminders');
update calendar_events set status = 'scheduled', starts_at = now() + interval '3 hours', reminder_offsets_min = '{120}';
select tests.logout();
-- make the reminder due, then cancel before dispatch
update reminders set remind_at = now() - interval '1 minute' where status = 'pending';
select tests.ok(process_due_reminders() = 1, 'due reminder dispatched');
select tests.login(:law1);
select tests.ok(tests.count($$select 1 from notifications where kind = 'event_reminder'$$) = 1, 'reminder notification delivered');
update calendar_events set starts_at = now() + interval '4 hours';
select tests.logout();
update reminders set remind_at = now() - interval '1 minute' where status = 'pending';
select tests.login(:law1);
update calendar_events set status = 'cancelled';
select tests.logout();
-- even if a stale pending row slips through, the dispatcher re-checks the event
insert into reminders (event_id, lawyer_id, offset_min, remind_at)
  select id, lawyer_id, 5, now() - interval '1 minute' from calendar_events;
select tests.ok(process_due_reminders() = 0, '#9 dispatcher never fires for cancelled events');
select tests.login(:law1);
select tests.ok(tests.count($$select 1 from notifications where kind = 'event_reminder'$$) = 1, 'no extra notification created');
select tests.ok((select ends_at is not null from calendar_events) is not null, 'events readable');
select tests.logout();

-- hearing result -> next hearing -----------------------------------------------------
select tests.login(:law1);
insert into calendar_events (lawyer_id, kind, title, case_id, starts_at)
  select :law1, 'hearing', 'جلسة ٢', id, now() + interval '10 days' from cases;
select record_hearing_result((select id from calendar_events where title = 'جلسة ٢'), 'تأجيل للمرافعة',
                             now() + interval '40 days');
select tests.ok((select count(*) from calendar_events where title = 'جلسة ٢' and status = 'completed') = 1, 'hearing completed');
select tests.ok((select next_hearing_at from cases) is not null, 'case next hearing updated');
select tests.ok(tests.count($$select 1 from case_activity where action = 'hearing_result_recorded'$$) = 1, 'hearing result in case history');
select tests.logout();

-- ----------------------------- consultations -------------------------------------
select tests.login(:cx);
insert into consultations (client_id, title, category_id, description, consent_privacy, consent_disclaimer, opposing_party)
values (:cx, 'استشارة عقد إيجار', 1, 'أريد معرفة حقوقي في عقد إيجار قديم', true, true, 'شركة الخصم');
select tests.throws($$insert into consultations (client_id, title, description, consent_privacy, consent_disclaimer)
   values ('00000000-0000-0000-0000-000000000021','abc','long enough description', false, true)$$,
   'consent is mandatory');
select tests.throws($$insert into consultations (client_id, title, description, consent_privacy, consent_disclaimer, status)
   values ('00000000-0000-0000-0000-000000000021','abc','long enough description', true, true, 'answered')$$,
   'client cannot insert a non-submitted status');
select tests.throws($$update consultations set status = 'answered'$$, 'client cannot update status directly');
select tests.ok((select reference_no from consultations) like 'MS-%', 'reference number generated');
select tests.logout();

select tests.login(:cy);
select tests.ok(tests.count('select 1 from consultations') = 0, '#4 client cannot see another client''s consultation');
select tests.ok(tests.count('select 1 from consultation_messages') = 0, 'nor its messages');
select tests.logout();

select tests.login(:law1);
select tests.ok(tests.count('select 1 from consultations') = 0, '#11 unassigned lawyer cannot access consultation');
select tests.throws($$select assign_consultation((select id from consultations), '00000000-0000-0000-0000-000000000011')$$,
   'lawyer cannot assign consultations');
select tests.logout();

select tests.login(:sup);
select tests.ok(tests.count('select 1 from consultations') = 1, 'support admin sees consultations');
select tests.ok(tests.count('select 1 from eligible_lawyers_for_consultation((select id from consultations))') = 2,
  'eligible lawyers listed');
select tests.logout();
select tests.login(:sup);
-- law1 has a client named like the opposing party? no -> ok. Create a conflict for law2:
select tests.logout();
insert into clients (lawyer_id, full_name) values (:law2, 'شركة الخصم');
select tests.login(:sup);
select tests.throws($$select assign_consultation((select id from consultations), '00000000-0000-0000-0000-000000000012')$$,
  'conflict of interest blocks assignment');
select tests.throws($$select assign_consultation((select id from consultations), '00000000-0000-0000-0000-000000000013')$$,
  'unapproved lawyer cannot be assigned');
select assign_consultation((select id from consultations), :law1::uuid);
select tests.ok((select status from consultations) = 'assigned', '#10 consultation assigned to eligible lawyer');
select tests.logout();

select tests.login(:law1);
select tests.ok(tests.count('select 1 from consultations') = 1, 'assigned lawyer sees consultation');
select tests.ok(tests.count($$select 1 from notifications where kind = 'consultation_assigned'$$) = 1, 'assignment notification');
insert into consultation_messages (consultation_id, sender_id, sender_role, kind, body)
  select id, :law1, 'lawyer', 'info_request', 'ما تاريخ بدء الإيجار؟' from consultations;
select tests.ok((select status from consultations) = 'awaiting_info', 'info request moves status');
select tests.throws($$insert into consultation_messages (consultation_id, sender_id, sender_role, kind, body)
   select id, '00000000-0000-0000-0000-000000000011', 'client', 'message', 'x' from consultations$$,
   'lawyer cannot post as client');
select tests.logout();
select tests.login(:law2);
select tests.ok(tests.count('select 1 from consultations') = 0, 'other lawyer cannot access assigned consultation');
select tests.logout();
select tests.login(:cx);
select tests.ok(tests.count($$select 1 from notifications where kind = 'consultation_response'$$) = 1, 'client notified of response');
insert into consultation_messages (consultation_id, sender_id, sender_role, kind, body)
  select id, :cx, 'client', 'message', 'بدأ في 2015' from consultations;
select tests.ok((select status from consultations) = 'in_progress', 'client reply moves status back');
select tests.throws($$insert into consultation_messages (consultation_id, sender_id, sender_role, kind, body)
   select id, '00000000-0000-0000-0000-000000000021', 'client', 'answer', 'x' from consultations$$,
   'client cannot post an official answer');
select tests.logout();
select tests.login(:law1);
insert into consultation_messages (consultation_id, sender_id, sender_role, kind, body)
  select id, :law1, 'lawyer', 'answer', 'ملخص معلومات عامة' from consultations;
select tests.ok((select status from consultations) = 'answered', 'answer sets answered');
select tests.logout();
select tests.login(:cx);
select set_consultation_status((select id from consultations), 'closed', null);
select tests.ok((select status from consultations) = 'closed', 'client may close own consultation');
select tests.ok(tests.count('select 1 from consultation_status_history') >= 5, 'status history recorded');
select tests.throws($$insert into consultation_messages (consultation_id, sender_id, sender_role, kind, body)
   select id, '00000000-0000-0000-0000-000000000021', 'client', 'message', 'late' from consultations$$,
   'no messages on closed consultation');
-- rate limit
insert into consultations (client_id, title, description, consent_privacy, consent_disclaimer)
select :cx, 'استشارة ' || g, 'وصف طويل بما يكفي ' || g, true, true from generate_series(1, 4) g;
select tests.throws($$insert into consultations (client_id, title, description, consent_privacy, consent_disclaimer)
   values ('00000000-0000-0000-0000-000000000021','one too many','long enough description', true, true)$$,
   'consultation submissions are rate limited');
select tests.logout();

-- ------------------------------- storage -----------------------------------------
insert into storage.objects (bucket_id, name) values
 ('lawyer-verification', :law1 || '/card.png'),
 ('consultation-attachments', (select id::text from consultations where title = 'استشارة عقد إيجار') || '/doc.pdf'),
 ('case-documents', (select id::text from cases) || '/file.pdf');
select tests.login(:law2);
select tests.ok(tests.count($$select 1 from storage.objects where bucket_id = 'lawyer-verification'$$) = 0,
  '#12 other lawyers cannot download verification cards');
select tests.ok(tests.count($$select 1 from storage.objects where bucket_id = 'case-documents'$$) = 1,
  'case member can read case documents');
select tests.logout();
select tests.login(:law3);
select tests.ok(tests.count($$select 1 from storage.objects$$) = 0, '#12 unrelated user sees no files');
select tests.throws($$insert into storage.objects (bucket_id, name) values ('lawyer-verification','00000000-0000-0000-0000-000000000011/evil.png')$$,
  'cannot upload into someone else''s folder');
select tests.logout();
select tests.login(:law1);
select tests.ok(tests.count($$select 1 from storage.objects where bucket_id = 'lawyer-verification'$$) = 1, 'owner reads own card');
select tests.throws($$insert into storage.objects (bucket_id, name) values ('lawyer-verification','00000000-0000-0000-0000-000000000011/new.png')$$,
  'approved lawyers cannot change verification files');
select tests.logout();
select tests.login(:rev);
select tests.ok(tests.count($$select 1 from storage.objects where bucket_id = 'lawyer-verification'$$) = 1,
  'authorised admin reads verification card');
select tests.ok(tests.count($$select 1 from storage.objects where bucket_id = 'case-documents'$$) = 0, 'admin cannot read case documents');
select tests.logout();
select tests.login(:sup);
select tests.ok(tests.count($$select 1 from storage.objects where bucket_id = 'lawyer-verification'$$) = 0,
  'support admin cannot read verification cards');
select tests.ok(tests.count($$select 1 from storage.objects where bucket_id = 'consultation-attachments'$$) = 1,
  'support admin reads consultation attachment');
select tests.logout();
select tests.login(:cx);
select tests.ok(tests.count($$select 1 from storage.objects where bucket_id = 'consultation-attachments'$$) = 1, 'client reads own attachment');
select tests.logout();
select tests.login(:cy);
select tests.ok(tests.count($$select 1 from storage.objects where bucket_id = 'consultation-attachments'$$) = 0, 'other client cannot read attachment');
select tests.logout();
select tests.ok((select bool_and(not public) from storage.buckets), 'all buckets are private');

-- ------------------------------- library -----------------------------------------
select tests.login(:sup);
select tests.throws($$insert into legal_resources (title, resource_type) values ('x','law')$$, 'non-content admin cannot add resources');
select tests.logout();
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a4','c@ms.test','{"full_name":"Content"}');
select create_admin('00000000-0000-0000-0000-0000000000a4', 'content');
select tests.login('00000000-0000-0000-0000-0000000000a4');
insert into legal_resources (title, resource_type, status, law_name, article_number, source, is_official_source)
values ('مورد منشور (اختبار)', 'law', 'published', 'قانون اختباري', '5', 'مصدر اختبار', false),
       ('مسودة', 'law', 'draft', null, null, null, false);
select tests.logout();
select tests.login(:law1);
select tests.ok(tests.count('select 1 from legal_resources') = 1, 'lawyers see only published resources');
select tests.ok(tests.count($$select 1 from legal_resources where fts @@ plainto_tsquery('simple', 'اختباري')$$) = 1, 'full-text search works');
select touch_resource_view((select id from legal_resources));
select tests.ok(tests.count('select 1 from resource_views') = 1, 'recently viewed tracked');
select tests.throws($$insert into legal_resources (title, resource_type) values ('x','law')$$, 'lawyer cannot add resources');
insert into resource_reports (resource_id, reporter_id, reason, details)
  select id, :law1, 'outdated', 'يحتاج تحديث' from legal_resources;
select tests.logout();
select tests.login(:cx);
select tests.ok(tests.count('select 1 from legal_resources') = 0, 'clients cannot read the library');
select tests.logout();
select tests.login(:law3);   -- rejected/submitted lawyer
select tests.ok(tests.count('select 1 from legal_resources') = 0, '#1 unverified lawyer cannot read the library');
select tests.logout();

-- ------------------------- audit + admin controls ---------------------------------
select tests.login(:law1);
select tests.ok(tests.count('select 1 from audit_logs') = 0, 'lawyers cannot read audit logs');
select tests.logout();
select tests.login(:sa);
select tests.ok(tests.count($$select 1 from audit_logs where action = 'lawyer.approve'$$) = 2, 'approvals are audited');
select tests.ok(tests.count($$select 1 from audit_logs where action = 'lawyer.identity.view'$$) >= 1, 'identity views are audited');
select tests.ok(not exists (select 1 from audit_logs where metadata::text ~* 'password|token|bar_card'), 'audit holds no secrets');
select tests.ok(((admin_dashboard_stats())->>'approved_lawyers')::int = 2, 'admin stats are real');
select tests.throws($$select admin_set_account_status('00000000-0000-0000-0000-0000000000a1','suspended','x')$$, 'admin cannot modify self');
select admin_set_account_status(:cy::uuid, 'suspended', 'اختبار');
select tests.logout();
select tests.login(:rev);
select tests.throws($$select admin_set_account_status('00000000-0000-0000-0000-000000000021','suspended','x')$$,
  'reviewer lacks users.manage');
select tests.logout();
select tests.login(:cy);
select tests.ok(tests.count('select 1 from consultations') = 0, 'suspended client has no access');
select tests.throws($$insert into consultations (client_id, title, description, consent_privacy, consent_disclaimer)
   values ('00000000-0000-0000-0000-000000000022','abc','long enough description', true, true)$$, 'suspended client cannot submit');
select tests.logout();
select tests.login(:sa);
select admin_set_account_status(:cy::uuid, 'active');
select admin_review_lawyer(:law2::uuid, 'suspend', 'مخالفة');
select tests.logout();
select tests.login(:law2);
select tests.ok(tests.count('select 1 from cases') = 0, 'suspended lawyer loses professional access immediately');
select tests.ok(tests.count('select 1 from public_lawyer_directory') = 1, 'suspended lawyer leaves the directory');
select tests.logout();
select tests.login(:sa);
select admin_review_lawyer(:law2::uuid, 'reactivate');
select tests.ok(send_announcement('صيانة', 'سيتم إجراء صيانة', 'lawyers') >= 3, 'announcement fan-out');
select tests.logout();
select tests.login(:law2);
select tests.ok(tests.count($$select 1 from notifications where kind = 'announcement'$$) = 1, 'announcement delivered');
update notifications set read_at = now() where kind = 'announcement';
select tests.ok(tests.count($$select 1 from notifications where read_at is not null$$) >= 1, 'notifications can be marked read');
select tests.throws($$insert into notifications (user_id, kind) values ('00000000-0000-0000-0000-000000000012','x')$$, 'users cannot forge notifications');
select tests.logout();
select tests.login(:cx);
select tests.ok(tests.count($$select 1 from notifications where user_id <> '00000000-0000-0000-0000-000000000021'$$) = 0, 'notifications are per-user');
select tests.logout();

-- anon access ---------------------------------------------------------------------
set role anon;
select tests.ok(tests.count('select 1 from platform_settings') > 0, 'anon can read public settings');
select tests.ok(tests.count($$select 1 from platform_settings where key = 'alias_prefix'$$) = 0, 'anon cannot read private settings');
select tests.throws($$select 1 from profiles$$, 'anon cannot read profiles');
select tests.throws($$select 1 from public_lawyer_directory$$, 'anon cannot read the directory');
reset role;

select 'ALL POLICY TESTS PASSED' as result;
