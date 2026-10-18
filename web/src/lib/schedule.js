import { supabase } from './supabase.js';
import { unwrap } from './hooks.js';

/**
 * Loads everything that belongs on the lawyer's calendar between two instants:
 *  - calendar_events (hearings, appointments, deadlines, personal)
 *  - tasks with a due date (shown as 'task')
 *  - expected payments (shown as read-only 'payment_deadline')
 * All reads are RLS-protected and return only the signed-in lawyer's rows.
 */
export async function loadSchedule(fromIso, toIso, { fromDay, toDay } = {}) {
  const [ev, tasks, pays] = await Promise.all([
    supabase.from('calendar_events').select('*, case:cases(id,title,case_number), client:clients(id,full_name)')
      .is('deleted_at', null).gte('starts_at', fromIso).lt('starts_at', toIso).order('starts_at'),
    supabase.from('tasks').select('*').is('deleted_at', null).eq('status', 'open').gte('due_at', fromIso).lt('due_at', toIso).order('due_at'),
    supabase.from('expected_payments').select('*, case:cases(id,title), client:clients(id,full_name)')
      .eq('status', 'pending').gte('due_on', fromDay).lte('due_on', toDay).order('due_on'),
  ]);
  const items = [];
  for (const e of unwrap(ev)) items.push({ ...e, source: 'event', key: 'e' + e.id });
  for (const k of unwrap(tasks)) {
    items.push({ id: k.id, key: 't' + k.id, source: 'task', kind: 'task', title: k.title, starts_at: k.due_at, status: 'scheduled', priority: k.priority, raw: k });
  }
  for (const p of unwrap(pays)) {
    items.push({
      id: p.id, key: 'p' + p.id, source: 'payment', kind: 'payment_deadline', title: p.note || p.client?.full_name || '', amount: p.amount,
      starts_at: null, due_on: p.due_on, status: 'scheduled', case: p.case, client: p.client, raw: p,
    });
  }
  return items;
}

export function itemDay(item, tz, dayKeyOf, startOfDayIso) {
  return item.due_on || dayKeyOf(item.starts_at, tz);
}

export function filterItems(items, { kinds, q, caseId }) {
  const term = (q || '').trim().toLowerCase();
  return items.filter((i) => {
    if (kinds && kinds.size && !kinds.has(i.kind)) return false;
    if (caseId && i.case?.id !== caseId) return false;
    if (term) {
      const hay = `${i.title} ${i.case?.title || ''} ${i.case?.case_number || ''} ${i.client?.full_name || ''} ${i.location_text || ''}`.toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });
}
