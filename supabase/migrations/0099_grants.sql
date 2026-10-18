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
