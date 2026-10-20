import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap, useDebounced, safeTerm } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/dates.js';
import { AsyncView, Button, Checkbox, Empty, Field, Input, Modal, PageHead, SearchBox, Select, StatusBadge, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';

export const CASE_STATUSES = ['new', 'in_progress', 'awaiting_hearing', 'awaiting_documents', 'awaiting_payment', 'suspended', 'closed', 'archived'];
export const CASE_CATEGORIES = ['civil', 'criminal', 'family', 'commercial', 'labor', 'administrative', 'real_estate', 'other'];

export function CaseModal({ item, defaults, onClose, onSaved }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const toast = useToast(); const onError = useErrorToast();
  const clients = useAsync(async () => unwrap(await supabase.from('clients').select('id,full_name').is('deleted_at', null).order('full_name').limit(500)), []);
  const c0 = item || defaults || {};
  const [f, setF] = useState({
    case_number: c0.case_number || '', title: c0.title || '', court: c0.court || '', category: c0.category || '', client_id: c0.client_id || '',
    opposing_party: c0.opposing_party || '', status: c0.status || 'new', description: c0.description || '', opened_on: c0.opened_on || '' });
  const [errors, setErrors] = useState({}); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const er = {};
    if (!f.case_number.trim()) er.case_number = t('val.required');
    if (f.title.trim().length < 3) er.title = t('val.title');
    setErrors(er); if (Object.keys(er).length) return;
    setBusy(true);
    const row = { case_number: f.case_number.trim(), title: f.title.trim(), court: f.court.trim() || null, category: f.category || null,
      client_id: f.client_id || null, opposing_party: f.opposing_party.trim() || null, description: f.description.trim() || null, opened_on: f.opened_on || null };
    try {
      if (item) { row.status = f.status; unwrap(await supabase.from('cases').update(row).eq('id', item.id)); onSaved(item.id); }
      else { const id = crypto.randomUUID();   // no .select(): the new row is not readable inside the same insert statement
        unwrap(await supabase.from('cases').insert({ id, ...row, lawyer_id: user.id, status: f.status })); onSaved(id); }
      toast(t('common.saved'), 'success');
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <Modal wide title={item ? t('cases.edit') : t('cases.new')} onClose={onClose} actions={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button></>}>
      <div className="grid cols-2">
        <Field label={t('cases.number')} error={errors.case_number}><Input className="input ltr" value={f.case_number} onChange={set('case_number')} /></Field>
        <Field label={t('cases.title')} error={errors.title}><Input value={f.title} onChange={set('title')} /></Field>
        <Field label={t('cases.court')}><Input value={f.court} onChange={set('court')} /></Field>
        <Field label={t('cases.category')}><Select value={f.category} onChange={set('category')}><option value="">—</option>{CASE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`casecat.${c}`)}</option>)}</Select></Field>
        <Field label={t('cases.client')}><Select value={f.client_id} onChange={set('client_id')}><option value="">—</option>{(clients.data || []).map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</Select></Field>
        <Field label={t('cases.opposing')}><Input value={f.opposing_party} onChange={set('opposing_party')} /></Field>
        <Field label={t('common.status')}><Select value={f.status} onChange={set('status')}>{CASE_STATUSES.filter((s) => item || s !== 'archived').map((s) => <option key={s} value={s}>{t(`case.status.${s}`)}</option>)}</Select></Field>
        <Field label={t('cases.opened_on')}><Input className="input ltr" type="date" value={f.opened_on} onChange={set('opened_on')} /></Field>
      </div>
      <Field label={t('cases.description')}><Textarea value={f.description} onChange={set('description')} /></Field>
    </Modal>
  );
}

export default function Cases() {
  const { t, lang } = useI18n();
  const { tz } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const dq = useDebounced(q);
  const state = useAsync(async () => {
    let query = supabase.from('cases').select('*, client:clients(full_name)').is('deleted_at', null).order('updated_at', { ascending: false }).limit(300);
    if (status) query = query.eq('status', status); else if (!showArchived) query = query.neq('status', 'archived');
    const term = safeTerm(dq);
    if (term) query = query.or(`title.ilike.%${term}%,case_number.ilike.%${term}%,opposing_party.ilike.%${term}%,court.ilike.%${term}%`);
    return unwrap(await query);
  }, [dq, status, showArchived]);
  return (
    <>
      <PageHead title={t('nav.cases')} actions={<Button variant="primary" onClick={() => setCreating(true)}>➕ {t('cases.new')}</Button>} />
      <div className="row" style={{ marginBottom: 16 }}>
        <SearchBox value={q} onChange={setQ} placeholder={t('cases.search_hint')} />
        <Select style={{ maxWidth: 220 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('common.status')}>
          <option value="">{t('common.all_statuses')}</option>{CASE_STATUSES.map((s) => <option key={s} value={s}>{t(`case.status.${s}`)}</option>)}</Select>
        <Checkbox label={t('cases.show_archived')} checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
      </div>
      <AsyncView state={state} empty={<Empty glyph="⚖️" title={t('cases.empty')}>{t('cases.empty_hint')}</Empty>}>
        {(rows) => (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('cases.number')}</th><th>{t('cases.title')}</th><th>{t('cases.client')}</th><th>{t('cases.court')}</th><th>{t('common.status')}</th><th>{t('cases.next_hearing')}</th></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => nav(`/lawyer/cases/${c.id}`)}>
                <td className="ltr nowrap">{c.case_number}</td><td>{c.title}</td><td>{c.client?.full_name || '—'}</td><td>{c.court || '—'}</td>
                <td><StatusBadge status={c.status} prefix="case.status" /></td><td className="nowrap">{c.next_hearing_at ? formatDateTime(c.next_hearing_at, tz, lang) : '—'}</td></tr>))}</tbody></table></div>)}
      </AsyncView>
      {creating && <CaseModal onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); nav(`/lawyer/cases/${id}`); }} />}
    </>);
}
