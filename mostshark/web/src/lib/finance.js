// Financial calculation model — mirrors supabase/migrations/0003_practice.sql.
// The database views are the source of truth; this module is used for previews and tests.
//
//   +amount (client owes more):  fee_agreed, additional_charge, refund
//   -amount (client owes less):  payment, advance_payment, credit
//   expense: lawyer cost, not part of the receivable
//   A reversed transaction and its 'reversal' row are both excluded, so a
//   transaction is never counted twice and is never silently deleted.
//
//   outstanding = agreed + additional_charges + refunds - payments - credits

export const KINDS = ['fee_agreed', 'advance_payment', 'payment', 'additional_charge',
  'expense', 'refund', 'credit'];

export const toCents = (n) => Math.round(Number(n || 0) * 100);
export const fromCents = (c) => c / 100;

export function effectiveTransactions(txs) {
  const reversed = new Set(txs.filter((t) => t.kind === 'reversal' && t.reverses_id).map((t) => t.reverses_id));
  return txs.filter((t) => t.kind !== 'reversal' && !reversed.has(t.id));
}

export function summarize(txs) {
  const eff = effectiveTransactions(txs);
  const sum = (pred) => eff.filter(pred).reduce((a, t) => a + toCents(t.amount), 0);
  const agreed = sum((t) => t.kind === 'fee_agreed');
  const charges = sum((t) => t.kind === 'additional_charge');
  const payments = sum((t) => t.kind === 'payment' || t.kind === 'advance_payment');
  const credits = sum((t) => t.kind === 'credit');
  const refunds = sum((t) => t.kind === 'refund');
  const expenses = sum((t) => t.kind === 'expense');
  return {
    agreed_fee: fromCents(agreed),
    additional_charges: fromCents(charges),
    payments: fromCents(payments),
    credits: fromCents(credits),
    refunds: fromCents(refunds),
    expenses: fromCents(expenses),
    outstanding: fromCents(agreed + charges + refunds - payments - credits),
    collected: fromCents(payments - refunds),
    net_after_expenses: fromCents(payments - refunds - expenses),
  };
}

export function isOverdue(expected, todayKeyStr) {
  return expected.status === 'pending' && expected.due_on < todayKeyStr;
}

export function fmtMoney(n, lang = 'ar', currency = 'EGP') {
  return new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', {
    style: 'currency', currency, maximumFractionDigits: 2,
  }).format(Number(n || 0));
}
