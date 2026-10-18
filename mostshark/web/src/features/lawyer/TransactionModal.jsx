import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { todayKey } from '../../lib/dates.js';
import { usePublicSettings } from '../../lib/settings.js';
import { Button, Disclaimer, Field, Input, Modal, Select, useErrorToast, useToast } from '../../components/ui.jsx';

export const TX_KINDS = ['fee_agreed', 'advance_payment', 'payment', 'additional_charge', 'expense', 'refund', 'credit'];
export const METHODS = ['cash', 'bank_transfer', 'instapay', 'cheque', 'card', 'other'];

export default function TransactionModal({ defaults = {}, onClose, onSaved }) {
  const { t, lang } = useI18n();
  const { user, tz } = useAuth();
  const toast = useToast(); const onError = useErrorToast();
  const { disclaimer } = usePublicSettings();
  const lists = useAsync(async () => {
    const [cases, clients] = await Promise.all([
      supabase.from('cases').select('id,title,case_number,client_id').is('deleted_at', null).eq('lawyer_id', user.id).order('created_at', { ascending: false }).limit(300),
      supabase.from('clients').select('id,full_name').is('deleted_at', null).order('full_name').limit(500)]);
    return { cases: unwrap(cases), clients: unwrap(clients) };
  }, [user.id]);
  const [f, setF] = useState({
    kind: defaults.kind || 'payment', amount: defaults.amount ?? '', occurred_on: todayKey(tz), method: 'cash', category: '', description: defaults.description || '',
    case_id: defaults.case_id || '', client_id: defaults.client_id || '' });
  const [errors, setErrors] = useState({}); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    const er = {}; const amt = Number(f.amount);
    if (!(amt > 0) || !Number.isFinite(amt)) er.amount = t('val.amount');
    if (!f.occurred_on) er.occurred_on = t('val.required');
    setErrors(er); if (Object.keys(er).length) return;
    setBusy(true);
    try {
      unwrap(await supabase.from('financial_transactions').insert({
        lawyer_id: user.id, kind: f.kind, amount: Math.round(amt * 100) / 100, occurred_on: f.occurred_on, method: f.method || null,
        category: f.category.trim() || null, description: f.description.trim() || null, case_id: f.case_id || null, client_id: f.client_id || null }));
      toast(t('common.saved'), 'success'); onSaved();
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  const onCase = (e) => {
    const id = e.target.value; const c = lists.data?.cases.find((x) => x.id === id);
    setF({ ...f, case_id: id, client_id: c?.client_id || f.client_id });
  };

  return (
    <Modal title={t('fin.new_transaction')} onClose={onClose} actions={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        <Disclaimer text={disclaimer('finance')} />
        <div className="grid cols-2">
          <Field label={t('fin.type')}><Select value={f.kind} onChange={set('kind')}>{TX_KINDS.map((k) => <option key={k} value={k}>{t(`tx.kind.${k}`)}</option>)}</Select></Field>
          <Field label={`${t('fin.amount')} (EGP)`} error={errors.amount}><Input className="input ltr" type="number" step="0.01" min="0.01" value={f.amount} onChange={set('amount')} /></Field>
          <Field label={t('fin.date')} error={errors.occurred_on}><Input className="input ltr" type="date" value={f.occurred_on} onChange={set('occurred_on')} /></Field>
          <Field label={t('fin.method')}><Select value={f.method} onChange={set('method')}>{METHODS.map((m) => <option key={m} value={m}>{t(`method.${m}`)}</option>)}</Select></Field>
          <Field label={t('fin.case')}><Select value={f.case_id} onChange={onCase}><option value="">—</option>
            {(lists.data?.cases || []).map((c) => <option key={c.id} value={c.id}>{c.case_number} — {c.title}</option>)}</Select></Field>
          <Field label={t('fin.client')}><Select value={f.client_id} onChange={set('client_id')}><option value="">—</option>
            {(lists.data?.clients || []).map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</Select></Field>
        </div>
        <Field label={t('fin.category')}><Input value={f.category} onChange={set('category')} placeholder={t('fin.category_hint')} /></Field>
        <Field label={t('fin.description')}><Input value={f.description} onChange={set('description')} /></Field>
      </div>
    </Modal>
  );
}
