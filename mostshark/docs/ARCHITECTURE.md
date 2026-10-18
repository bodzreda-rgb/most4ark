# Architecture (web)
- React 18 SPA (Vite), react-router, custom i18n (`web/src/locales`), design tokens in `web/src/styles`.
- All data access via supabase-js with the user's JWT; RLS decides. Sensitive operations are SECURITY DEFINER RPCs that re-check permissions and write `audit_logs`.
- Dates: stored as UTC; shown/edited in the user's IANA time zone (default Africa/Cairo, DST-aware); week starts Saturday.
- Finance: append-only ledger; outstanding = agreed + additional + refunds − payments − credits; expenses separate; reversed rows excluded.
- Files: private buckets, UUID paths, short-lived signed URLs, mime/size allow-lists enforced client- and server-side.
- Lawyer identity privacy: real name/bar number live in `lawyer_identities`; directory is a view exposing only alias and professional fields.
