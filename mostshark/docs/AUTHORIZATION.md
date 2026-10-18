# Authorization matrix (enforced by RLS + SECURITY DEFINER RPCs; the UI only hides things)

| Data | Client | Lawyer (approved) | Lawyer (unapproved) | Admin |
|---|---|---|---|---|
| Own profile | rw (not account_type/status) | rw (same) | rw | per `users.*` |
| Lawyer real identity (`lawyer_identities`, bar card) | – | own | own (locked after submit) | only `lawyers.identity.read`, via audited RPC |
| Directory | – | aliases only, whitelisted columns | – | – |
| Cases / clients / calendar / finance / tasks | – | own (+ cases shared by alias) | – | – |
| Finance ledger | – | own, append-only (reversal rows) | – | – |
| Consultations | own | only assigned ones | – | `consultations.manage` |
| Library / templates | – | published only | – | `library.manage` / `templates.manage` |
| Audit log | – | – | – | `audit.read` (read-only) |
| Settings, categories, announcements | – | – | – | `settings.manage` / `categories.manage` |

Admin roles: super_admin, reviewer, support, content (see `admin_role_permissions`). Privileged keys never reach the browser.
