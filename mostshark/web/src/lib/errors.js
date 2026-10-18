// Maps database / API errors to translation keys.
const KNOWN = new Set([
  'rate_limited', 'potential_conflict', 'missing_bar_card', 'missing_specialization',
  'incomplete_application', 'invalid_state', 'reason_required', 'forbidden', 'alias_not_found',
  'lawyer_not_eligible', 'lawyer_not_accepting', 'consultation_closed', 'identity_locked',
  'cannot_modify_self', 'invalid_reversal_target', 'ledger_is_append_only', 'reopen_not_authorized',
  'archive_requires_closed', 'cannot_add_self', 'not_a_lawyer', 'account_inactive',
]);

export function errorKey(error) {
  if (!error) return 'err.unknown';
  const msg = String(error.message || '').trim();
  if (KNOWN.has(msg)) return 'err.' + msg;
  const code = error.code;
  if (code === '23505') return 'err.duplicate';
  if (code === '42501' || /row-level security|permission denied/i.test(msg)) return 'err.forbidden';
  if (code === '23514') return 'err.invalid_value';
  if (code === '54000') return 'err.rate_limited';
  if (/Invalid login credentials/i.test(msg)) return 'err.bad_login';
  if (/already registered|already been registered/i.test(msg)) return 'err.email_taken';
  if (/Email not confirmed/i.test(msg)) return 'err.email_unconfirmed';
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'err.network';
  return 'err.unknown';
}
