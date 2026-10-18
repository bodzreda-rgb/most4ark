# Step 2 — Architecture, Schema, Screen Map, Plan (concise)

## Stack
Flutter + Dart; Riverpod; GoRouter; Freezed/json_serializable; Supabase (Postgres, Auth, Storage, Edge Functions, RLS); FCM; Arabic default + English (gen-l10n, ARB); flutter_map for maps.
No service-role key ever ships in the app. Privileged work (approve lawyer, assign consultation, signed URLs for ID docs, push sending) lives in Edge Functions / SECURITY DEFINER RPCs that re-check the caller's role.

## Folder structure
```
mostshark/
  lib/
    main.dart, app.dart
    core/        (config, router, theme/design system, l10n, utils, errors, widgets)
    data/        (supabase client, repositories, DTOs/models)
    features/
      auth/ lawyer_registration/ directory/ dashboard/ calendar/ cases/ clients/
      finance/ consultations/ admin/ library/ templates/ notifications/ settings/
  supabase/
    migrations/  (versioned SQL)  functions/ (edge functions)  seed.sql  tests/ (pgTAP)
  test/  integration_test/
  docs/
```
Each feature: `presentation/` (screens, widgets, controllers) · `domain/` (models) · `data/` (repository).

## Roles & access control
- `profiles` (1:1 auth.users): holds `account_type` (client | lawyer | admin) and `status`. Never trusted from the client.
- Admin privileges come from `admin_roles` + `admin_permissions` tables (super_admin, reviewer, support, content), checked by SQL helper `has_admin_permission(perm)` used in RLS and Edge Functions.
- Lawyer features gated by `lawyer_profiles.verification_status = 'approved'` via helper `is_approved_lawyer()`.
- Roles cannot be changed by the user: no UPDATE policy on role/status columns; changes only via admin RPC (audited).

## Database (core tables)
identity: `profiles`, `admin_roles`, `admin_permissions`, `admin_user_roles`
lawyers: `specializations`, `lawyer_profiles` (private: real name, bar no.), `lawyer_applications`, `application_documents` (private bucket paths), `verification_events`, `public_lawyer_directory` (VIEW exposing only alias, specializations, experience, city, bio, availability)
practice (owner = lawyer_id): `clients`, `cases`, `case_notes`, `case_events`, `hearings`, `appointments` (events table unified, with `kind`), `tasks`, `reminders`, `financial_transactions` (append-only; reversals via `reverses_id`), `fee_agreements`
consultations: `consultation_categories`, `consultations` (ref number), `consultation_assignments`, `consultation_messages`, `consultation_attachments`, `consultation_status_history`
library: `legal_resources`, `resource_versions`, `resource_bookmarks`, `resource_views`, `resource_reports`, `document_templates`
platform: `notifications`, `notification_preferences`, `device_tokens`, `audit_logs`, `platform_settings`
Conventions: uuid PKs, `created_at/updated_at`, soft delete (`deleted_at`) where retention matters, timestamptz in UTC, display via Africa/Cairo (tz package handles DST).

Balance model: `outstanding = agreed_fee + charges(expense billed) − payments − credits`, computed in a SQL view from non-reversed transactions only; reversals are separate rows so nothing is counted twice.

## Storage buckets (all private)
`lawyer-verification` (admin + owner only, signed URLs, 5 MB, jpg/png/pdf) · `consultation-attachments` (client + assigned lawyer + admin) · `case-documents` (owner lawyer) · `library` (published = authenticated read) · `templates`.

## Security checklist
RLS on every table; deny-by-default; public directory only through the view; no PII in notifications/logs; audit log written by DB triggers/Edge Functions; upload validation (type/size/magic bytes server-side); rate limiting on consultation submit & signup (Edge Function + Supabase auth limits); secrets only in `.env`/Supabase secrets (`.env.example` committed, `.env` gitignored).

## Navigation (GoRouter, role-aware redirects)
- Public/auth: splash, language, login, signup (client | lawyer), verify, forgot password
- Client: home, new consultation, my consultations, consultation thread, notifications, profile
- Lawyer: dashboard (day/week/month/30d), calendar, cases (+detail), clients (+detail), finance (+transaction detail), consultations (assigned), library, templates, directory, notifications, profile, application status
- Admin (web-first, side nav): overview, lawyer applications, lawyers, users, consultations, library, templates, categories & settings, reports, audit log

## Design system
Tokens: navy `#12263F`, deep teal accent, warm gold highlight, neutral greys; Arabic font Cairo/IBM Plex Sans Arabic, Latin Inter; 4/8-pt spacing; radii 8/12/16; components: buttons, inputs, cards, badges, dialogs, sheets, empty/error/loading states, adaptive scaffold (bottom nav → rail → sidebar).

## Authorization matrix (summary; full version produced at Step 4)
| Resource | Client | Lawyer (approved) | Admin |
|---|---|---|---|
| Own profile | R/U | R/U | R/U |
| Lawyer real identity/docs | – | own R | R (permission) |
| Public directory | R (alias only) | R (alias only) | R full |
| Cases/clients/finance/notes | – | own CRUD | – (no access by default) |
| Consultations | own C/R | assigned R/respond | R/assign/respond/close |
| Library | R published | R published, bookmark | CRUD |
| Audit logs | – | – | R |

## Implementation plan
3 Foundation+design system+auth+nav → 4 Migrations+RLS+storage → 5 Registration/verification/directory → 6 Dashboard/calendar/cases/clients/finance → 7 Consultations → 8 Admin dashboard → 9 Library/templates → 10 Notifications/search/export → 11 Tests/security/perf → 12 Docs/deploy.

## Known limits (so far)
Flutter toolchain not runnable in my sandbox: code is written here but compiled/tested on your machine; I'll give exact commands and fix errors you paste back. Egyptian legal texts must be supplied by you/admin; none will be fabricated.
