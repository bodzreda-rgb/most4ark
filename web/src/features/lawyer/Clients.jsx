import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap, useDebounced, safeTerm } from '../../lib/hooks.js';
import { formatDate, formatDateTime } from '../../lib/dates.js';
import { fmtMoney, summarize } from '../../lib/finance.js';
import { Alert, AsyncView, Button, Card, ConfirmDialog, Empty, Field, Input, KV, Modal, PageHead, SearchBox, Select, StatusBadge, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';
import { TotalsBar } from './Finance.jsx';
import { CaseModal } from './Cases.jsx';
import TransactionModal from './TransactionModal.jsx';

const CONTACT = ['phone', 'whatsapp', 'email', 'in_person'];

function ClientModal({ item, onClose, onSaved }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const toast = useToast(); const onError = useErrorToast();
  const c0 = item || {};
  const [f, setF] = useState({ full_name: c0.full_name || '', phone: c0.phone || '', email: c0.email || '', preferred_contact: c0.preferred_contact || 'phone', contact_details: c0.contact_details || '', internal_notes: c0.internal_notes || '' });
  const [errors, setErrors] = useState({}); const [busy, setBusy] = useState(false); const [dups, setDups] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const persist = async () => {
    setBusy(true);
    const row = { full_name: f.full_name.trim(), phone: f.phone.trim() || null, email: f.email.trim() || null, preferred_contact: f.preferred_contact,
      contact_details: f.contact_details.trim() || null, internal_notes: f.internal_notes.trim() || null };
    try {
      if (item) unwrap(await supabase.from('clients').update(row).eq('id', item.id));
      else unwrap(await supabase.from('clients').insert({ ...row, lawyer_id: user.id }));
      toast(t('common.saved'), 'success'); onSaved();
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  const save = async () => {
    const er = {};
    if (f.full_name.trim().length < 3) er.full_name = t('val.name');
    if (f.email && !/^\S+@\S+\.\S+$/.test(f.email)) er.email = t('val.email');
    setErrors(er); if (Object.keys(er).length) return;
    if (!item) {
      try {
        const found = unwrap(await supabase.rpc('find_duplicate_clients', { p_name: f.full_name.trim(), p_phone: f.phone.trim() || null }));
        if (found.length) { setDups(found); return; }
      } catch (e) { onError(e); return; }
    }
    persist();
  };
  return (
    <Modal title={item ? t('clients.edit') : t('clients.new')} onClose={onClose} actions={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        <Field label={t('auth.full_name')} error={errors.full_name}><Input value={f.full_name} onChange={set('full_name')} /></Field>
        <div className="grid cols-2">
          <Field label={t('auth.phone')}><Input className="input ltr" value={f.phone} onChange={set('phone')} /></Field>
          <Field label={t('auth.email')} error={errors.email}><Input className="input ltr" type="email" value={f.email} onChange={set('email')} /></Field>
        </div>
        <Field label={t('clients.preferred_contact')}><Select value={f.preferred_contact} onChange={set('preferred_contact')}>{CONTACT.map((c) => <option key={c} value={c}>{t(`contact.${c}`)}</option>)}</Select></Field>
        <Field label={t('clients.contact_details')}><Input value={f.contact_details} onChange={set('contact_details')} /></Field>
        <Field label={t('clients.internal_notes')}><Textarea value={f.internal_notes} onChange={set('internal_notes')} /></Field>
      </div>
      {dups && (
        <Modal title={t('clients.duplicate_title')} onClose={() => setDups(null)} actions={<><Button onClick={() => setDups(null)}>{t('common.back')}</Button><Button variant="primary" onClick={() => { setDups(null); persist(); }}>{t('clients.create_anyway')}</Button></>}>
          <Alert tone="warn">{t('clients.duplicate_msg')}</Alert>
          <div className="list" style={{ marginTop: 8 }}>{dups.map((d) => (
            <div className="list-item" key={d.id}><span className="grow">{d.full_name}</span><span className="ltr small muted">{d.phone}</span><span className="chip">{t(`clients.dup.${d.reason}`)}</span></div>))}</div>
        </Modal>)}
    </Modal>);
}

export default function Clients() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [q, setQ] = useState(''); const [creating, setCreating] = useState(false);
  const dq = useDebounced(q);
  const state = useAsync(async () => {
    const term = safeTerm(dq);
    let query = supabase.from('clients').select('*').is('deleted_at', null).order('full_name').limit(300);
    if (term) {
      // search by name, phone, or associated case
      const caseHits = unwrap(await supabase.from('cases').select('client_id').is('deleted_at', null).or(`case_number.ilike.%${term}%,title.ilike.%${term}%`).limit(100)).map((x) => x.client_id).filter(Boolean);
      const ors = [`full_name.ilike.%${term}%`, `phone.ilike.%${term}%`];
      if (caseHits.length) ors.push(`id.in.(${caseHits.join(',')})`);
      query = query.or(ors.join(','));
    }
    const rows = unwrap(await query);
    const bal = rows.length ? unwrap(await supabase.from('client_balances').select('client_id,outstanding').in('client_id', rows.map((r) => r.id))) : [];
    const map = Object.fromEntries(bal.map((b) => [b.client_id, b.outstanding]));
    return rows.map((r) => ({ ...r, outstanding: map[r.id] || 0 }));
  }, [dq]);
  const { lang } = useI18n();
  return (
    <>
      <PageHead title={t('nav.clients')} actions={<Button variant="primary" onClick={() => setCreating(true)}>➕ {t('clients.new')}</Button>} />
      <div className="row" style={{ marginBottom: 16 }}><SearchBox value={q} onChange={setQ} placeholder={t('clients.search_hint')} /></div>
      <Alert tone="info" className="small">{t('clients.private_note')}</Alert>
      <div style={{ marginTop: 16 }}>
        <AsyncView state={state} empty={<Empty glyph="👥" title={t('clients.empty')} />}>
          {(rows) => (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>{t('auth.full_name')}</th><th>{t('auth.phone')}</th><th>{t('clients.preferred_contact')}</th><th>{t('fin.outstanding')}</th></tr></thead>
              <tbody>{rows.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => nav(`/lawyer/clients/${c.id}`)}>
                  <td>{c.full_name}</td><td className="ltr">{c.phone || '—'}</td><td>{t(`contact.${c.preferred_contact}`)}</td>
                  <td className="num-cell">{Number(c.outstanding) > 0 ? <strong style={{ color: 'var(--warn)' }}>{fmtMoney(c.outstanding, lang)}</strong> : '—'}</td></tr>))}</tbody></table></div>)}
        </AsyncView>
      </div>
      {creating && <ClientModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); state.reload(); }} />}
    </>);
}

export function ClientDetail() {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { tz } = useAuth();
  const nav = useNavigate();
  const toast = useToast(); const onError = useErrorToast();
  const [editing, setEditing] = useState(false); const [confirm, setConfirm] = useState(false); const [caseModal, setCaseModal] = useState(false); const [txModal, setTxModal] = useState(false);
  const state = useAsync(async () => {
    const c = unwrap(await supabase.from('clients').select('*').eq('id', id).maybeSingle());
    if (!c) return null;
    const [cases, events, tx] = await Promise.all([
      supabase.from('cases').select('id,case_number,title,status').eq('client_id', id).is('deleted_at', null).order('created_at', { ascending: false }),
      supabase.from('calendar_events').select('id,title,kind,starts_at,status').eq('client_id', id).is('deleted_at', null).order('starts_at', { ascending: false }).limit(30),
      supabase.from('financial_transactions').select('*').eq('client_id', id).order('occurred_on', { ascending: false })]);
    return { c, cases: unwrap(cases), events: unwrap(events), tx: unwrap(tx) };
  }, [id]);
  const archive = async () => {
    try { unwrap(await supabase.from('clients').update({ deleted_at: new Date().toISOString() }).eq('id', id)); toast(t('common.saved'), 'success'); nav('/lawyer/clients'); }
    catch (e) { onError(e); }
  };
  return (
    <AsyncView state={state}>
      {(d) => {
        if (!d) return <Alert tone="warn">{t('common.not_found')}</Alert>;
        const { c } = d;
        return (
          <>
            <PageHead title={c.full_name} actions={<><Button size="sm" onClick={() => nav('/lawyer/clients')}>{t('common.back')}</Button><Button size="sm" onClick={() => setEditing(true)}>{t('common.edit')}</Button>
              <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>{t('clients.archive')}</Button></>} />
            <div className="stack">
              <TotalsBar s={summarize(d.tx)} />
              <div className="grid cols-2" style={{ alignItems: 'start' }}>
                <Card title={t('common.details')}><KV items={[
                  [t('auth.phone'), c.phone && <span key="p" className="ltr">{c.phone}</span>], [t('auth.email'), c.email && <span key="e" className="ltr">{c.email}</span>],
                  [t('clients.preferred_contact'), t(`contact.${c.preferred_contact}`)], [t('clients.contact_details'), c.contact_details], [t('clients.internal_notes'), c.internal_notes]]} /></Card>
                <Card title={t('clients.cases')} actions={<Button size="sm" onClick={() => setCaseModal(true)}>➕ {t('cases.new')}</Button>}>
                  {d.cases.length === 0 ? <p className="muted small">{t('cases.empty')}</p> : (
                    <div className="list">{d.cases.map((k) => (<div className="list-item clickable" key={k.id} onClick={() => nav(`/lawyer/cases/${k.id}`)}>
                      <span className="ltr">{k.case_number}</span><span className="grow">{k.title}</span><StatusBadge status={k.status} prefix="case.status" /></div>))}</div>)}
                </Card>
                <Card title={t('clients.appointments')}>
                  {d.events.length === 0 ? <p className="muted small">{t('cal.empty')}</p> : (
                    <div className="list">{d.events.map((e) => (<div className="list-item" key={e.id}><span className="grow">{e.title}</span><span className="small muted">{formatDateTime(e.starts_at, tz, lang)}</span></div>))}</div>)}
                </Card>
                <Card title={t('clients.payments')} actions={<Button size="sm" onClick={() => setTxModal(true)}>➕ {t('fin.new_transaction')}</Button>}>
                  {d.tx.length === 0 ? <p className="muted small">{t('fin.empty')}</p> : (
                    <div className="list">{d.tx.map((x) => (<div className="list-item clickable" key={x.id} onClick={() => nav(`/lawyer/finance/${x.id}`)}>
                      <span className="chip">{t(`tx.kind.${x.kind}`)}</span><span className="grow small muted">{formatDate(`${x.occurred_on}T12:00:00Z`, 'UTC', lang)}</span><strong className="num-cell">{fmtMoney(x.amount, lang)}</strong></div>))}</div>)}
                </Card>
              </div>
            </div>
            {editing && <ClientModal item={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); state.reload(); }} />}
            {caseModal && <CaseModal defaults={{ client_id: id }} onClose={() => setCaseModal(false)} onSaved={(cid) => nav(`/lawyer/cases/${cid}`)} />}
            {txModal && <TransactionModal defaults={{ client_id: id }} onClose={() => setTxModal(false)} onSaved={() => { setTxModal(false); state.reload(); }} />}
            {confirm && <ConfirmDialog title={t('clients.archive')} message={t('clients.archive_msg')} danger onCancel={() => setConfirm(false)} onConfirm={archive} />}
          </>);
      }}
    </AsyncView>);
}
