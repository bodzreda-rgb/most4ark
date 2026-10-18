import { describe, expect, it } from 'vitest';
import { summarize } from '../lib/finance.js';

const tx = (id, kind, amount, extra = {}) => ({ id, kind, amount, ...extra });

describe('finance summary', () => {
  it('computes outstanding = agreed + charges + refunds - payments - credits', () => {
    const s = summarize([tx(1, 'fee_agreed', 10000), tx(2, 'additional_charge', 500), tx(3, 'payment', 4000), tx(4, 'advance_payment', 1000), tx(5, 'credit', 250), tx(6, 'refund', 100)]);
    expect(s.outstanding).toBe(10000 + 500 + 100 - 5000 - 250);
    expect(s.collected).toBe(5000 - 100);
  });
  it('excludes both a reversed transaction and its reversal row', () => {
    const s = summarize([tx(1, 'fee_agreed', 1000), tx(2, 'payment', 400), tx(3, 'reversal', 400, { reverses_id: 2 })]);
    expect(s.payments).toBe(0);
    expect(s.outstanding).toBe(1000);
  });
  it('keeps expenses out of the receivable and avoids float drift', () => {
    const s = summarize([tx(1, 'fee_agreed', 0.1), tx(2, 'payment', 0.2), tx(3, 'expense', 300)]);
    expect(s.outstanding).toBeCloseTo(-0.1, 10);
    expect(s.expenses).toBe(300);
  });
});
