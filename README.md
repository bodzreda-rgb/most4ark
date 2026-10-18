# مستشارك — Mostshark

Arabic-first (RTL) legal-practice management and consultation platform. English is secondary.
**Web app**: React 18 + Vite. **Backend**: Supabase (Postgres + RLS, Auth, private Storage, Edge Functions).

Roles: **lawyer** (verification, directory, dashboard, calendar, cases, clients, finance, library, templates),
**client** (consultations), **admin** (dashboard, approvals, assignments, library, templates, settings, reports, audit).

## Layout
```
supabase/migrations/   0001–0007 + 0099_grants.sql   (apply in order)
supabase/seed.sql      reference data only (specializations, categories) — NO legal text
supabase/tests/        policy tests (plain Postgres + Supabase stub): run_local.sh
supabase/functions/    process-reminders, send-push (Edge Functions)
web/                   React app (src/features/{client,lawyer,admin,shared})
web/tests/smoke.py     Playwright smoke test against a mocked API
docs/                  architecture + authorization matrix
```

## Setup
1. Create a Supabase project.
2. Apply `supabase/migrations/0001…0007`, then `0099_grants.sql`, then `seed.sql` (SQL editor or `supabase db push`).
3. Auth settings: enable email sign-in; require email confirmation; set a strong password policy and Auth rate limits.
4. Create the first admin: sign up normally, then in the SQL editor run
   `select create_admin('<that user uuid>', 'super_admin');`
   (Admin rights can **never** be obtained from sign-up metadata.)
5. `cd web && cp .env.example .env.local`, fill `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the **public anon key only**; never the service-role key).
6. `npm install && npm run dev` (or `npm run build` and host `dist/` with an SPA fallback to `index.html`).
7. Reminders: deploy `process-reminders`, set secret `CRON_SECRET`, and schedule it every minute
   (pg_cron + `net.http_post` with header `x-cron-secret`, or Supabase Scheduled Functions).
8. Optional push: deploy `send-push`, set `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON`, `WEBHOOK_SECRET`, and add a Database Webhook on `notifications` INSERT.
9. Optional: schedule `select purge_deleted_records();` daily (retention per `platform_settings`).

## Tests
- `web`: `npm test` (Vitest: dates incl. Cairo DST, finance model, CSV injection guard, templates, i18n key parity and coverage).
- `supabase/tests/run_local.sh`: ~110 assertions of RLS/RPC behaviour on real Postgres.
- `web/tests/smoke.py`: Playwright; every route for all three roles renders under RTL with no console errors; cross-role routing blocked.

## Admin-supplied content (not included on purpose)
The platform ships **no Egyptian legal text, citations or templates**. The legal library and templates are empty until an admin
adds real, sourced material (source, official-source flag, verification status and license note are tracked per item).

## Known limitations (read before launch)
- The UI has been exercised against a **mocked** API and the database against plain Postgres with a Supabase stub — **not against a live Supabase project**. Do a staging pass (auth, storage policies, realtime) first.
- Storage policies are tested only through the stub's logic; verify uploads/signed URLs on a real project.
- Push notifications need FCM credentials; the web app does not register device tokens yet. In-app notifications work.
- Calendar events marked hearings are user-entered (`source = user_entered`) and labelled unverified; there is no court-system integration.
- No dark mode; no automated accessibility audit beyond semantic markup and labelled controls.
- Maps use OpenStreetMap tiles (check the usage policy for production traffic or use a tile provider).
- Anti-conflict checks are heuristic (name/phone matching) and advisory.
