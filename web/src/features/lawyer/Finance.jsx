import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap, useDebounced, safeTerm } from '../../lib/hooks.js';
import { formatDate, formatDateTime, formatDayKey, todayKey } from '../../lib/dates.js';
import { fmtMoney, summarize } from '../../lib/finance.js';
import { downloadCsv, toCsv } from '../../lib/csv.js';
import { usePublicSettings } from '../../lib/settings.js';
import { Alert, AsyncView, Button, Card, ConfirmDialog, Disclaimer, Empty, Field, Input, KV, PageHead, SearchBox, Select, Stat, Tabs, useErrorToast, useToast } from '../../components/ui.jsx';
import TransactionModal, { TX_KINDS } from './TransactionModal.jsx';

const LIMIT = 500;

export function TotalsBar({ s }) {
  const { t, lang } = useI18n();
  const m = (n) => fmtMoney(n, lang);
  return (
    <div className="grid cols-4">
      <Card><Stat value={m(s.agreed_fee + s.additional_charges)} label={t('fin.total_billed')} /></Card>
      <Card><Stat value={m(s.collected)} label={t('fin.collected')} /></Card>
      <Card><Stat value={m(s.outstanding)} label={t('fin.outstanding')} tone={s.outstanding > 0 ? 'warn' : ''} /></Card>
      <Card><Stat value={m(s.expenses)} label={t('fin.expenses')} /></Card>
      <Card><Stat value={m(s.net_after_expenses)} label={t('fin.net')} /></Card>
      <Card><Stat value={m(s.credits)} label={t('fin.credits')} /></Card>
    </div>);
}

function Transactions({ onNew }) {
  const { t, lang } = useI18n();
  const { tz } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ from: '', to: '', kind: '', case_id: '', client_id: '', q: '' });
  const dq = useDebounced(f.q);
  const filters = useAsync(async () => {
    const [cases, clients] = await Promise.all([supabase.from('cases').select('id,title,case_number').order('created_at', { ascending: false }).limit(300), supabase.from('clients').select('id,full_name').order('full_name').limit(500)]);
    return { cases: unwrap(cases), clients: unwrap(clients) };
  }, []);
  const state = useAsync(async () => {
    let q = supabase.from('financial_transactions').select('*, case:cases(id,title,case_number), client:clients(id,full_name)').order('occurred_on', { ascending: false }).order('created_at', { ascending: false }).limit(LIMIT);
    if (f.from) q = q.gte('occurred_on', f.from);
    if (f.to) q = q.lte('occurred_on', f.to);
    if (f.kind) q = q.eq('kind', f.kind);
    if (f.case_id) q = q.eq('case_id', f.case_id);
    if (f.client_id) q = q.eq('client_id', f.client_id);
    const term = safeTerm(dq);
    if (term) q = q.or(`description.ilike.%${term}%,category.ilike.%${term}%`);
    const rows = unwrap(await q);
    const revs = unwrap(await supabase.from('financial_transactions').select('id,kind,amount,reverses_id').eq('kind', 'reversal'));
    return { rows, revs };
  }, [f.from, f.to, f.kind, f.case_id, f.client_id, dq]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const exportCsv = () => {
    const rows = state.data?.rows || [];
    const reversed = new Set((state.data?.revs || []).map((r) => r.reverses_id));
    const csv = toCsv(rows, [
      { key: 'occurred_on', label: t('fin.date') }, { label: t('fin.type'), get: (r) => t(`tx.kind.${r.kind}`) },
      { key: 'amount', label: t('fin.amount') }, { label: t('fin.case'), get: (r) => r.case?.case_number || '' },
      { label: t('fin.client'), get: (r) => r.client?.full_name || '' }, { label: t('fin.method'), get: (r) => (r.method ? t(`method.${r.method}`) : '') },
      { key: 'category', label: t('fin.category') }, { key: 'description', label: t('fin.description') },
      { label: t('common.status'), get: (r) => (r.kind === 'reversal' ? t('fin.reversal') : reversed.has(r.id) ? t('fin.reversed') : t('fin.active')) },
    ]);
    downloadCsv(`mostshark-transactions-${todayKey(tz)}.csv`, csv);
  };

  return (
    <>
      <div className="card flat grid cols-4" style={{ marginBottom: 12 }}>
        <Field label={t('fin.from')}><Input className="input ltr" type="date" value={f.from} onChange={set('from')} /></Field>
        <Field label={t('fin.to')}><Input className="input ltr" type="date" value={f.to} onChange={set('to')} /></Field>
        <Field label={t('fin.type')}><Select value={f.kind} onChange={set('kind')}><option value="">{t('common.all')}</option>
          {[...TX_KINDS, 'reversal'].map((k) => <option key={k} value={k}>{t(`tx.kind.${k}`)}</option>)}</Select></Field>
        <Field label={t('fin.case')}><Select value={f.case_id} onChange={set('case_id')}><option value="">{t('common.all')}</option>
          {(filters.data?.cases || []).map((c) => <option key={c.id} value={c.id}>{c.case_number}</option>)}</Select></Field>
        <Field label={t('fin.client')}><Select value={f.client_id} onChange={set('client_id')}><option value="">{t('common.all')}</option>
          {(filters.data?.clients || []).map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</Select></Field>
        <Field label={t('common.search')}><SearchBox value={f.q} onChange={(v) => setF({ ...f, q: v })} placeholder={t('fin.search_hint')} /></Field>
      </div>
      <AsyncView state={state} empty={<Card><Empty glyph="💰" title={t('fin.empty')} /></Card>}>
        {({ rows, revs }) => {
          if (!rows.length) return <Card><Empty glyph="💰" title={t('fin.empty')} /></Card>;
          const reversed = new Set(revs.map((r) => r.reverses_id));
          const totals = summarize([...rows, ...revs.filter((r) => !rows.some((x) => x.id === r.id))]);
          return (
            <div className="stack">
              <TotalsBar s={totals} />
              <div className="row between"><span className="small muted">{rows.length >= LIMIT ? t('fin.limit_note', { n: LIMIT }) : ''}</span>
                <div className="row"><Button size="sm" onClick={exportCsv}>⬇ {t('common.export_csv')}</Button><Button size="sm" variant="primary" onClick={onNew}>➕ {t('fin.new_transaction')}</Button></div></div>
              <div className="table-wrap"><table className="table">
                <thead><tr><th>{t('fin.date')}</th><th>{t('fin.type')}</th><th>{t('fin.amount')}</th><th>{t('fin.case')}</th><th>{t('fin.client')}</th><th>{t('fin.method')}</th><th>{t('common.status')}</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => nav(`/lawyer/finance/${r.id}`)} style={{ opacity: reversed.has(r.id) ? 0.55 : 1 }}>
                    <td className="nowrap">{formatDate(`${r.occurred_on}T12:00:00Z`, 'UTC', lang)}</td>
                    <td>{t(`tx.kind.${r.kind}`)}</td>
                    <td className="num-cell" style={{ textDecoration: reversed.has(r.id) ? 'line-through' : 'none' }}>{fmtMoney(r.amount, lang)}</td>
                    <td className="ltr">{r.case?.case_number || '—'}</td><td>{r.client?.full_name || '—'}</td>
                    <td>{r.method ? t(`method.${r.method}`) : '—'}</td>
                    <td>{r.kind === 'reversal' ? <span className="badge neutral">{t('fin.reversal')}</span> : reversed.has(r.id) ? <span className="badge danger">{t('fin.reversed')}</span> : <span className="badge success">{t('fin.active')}</span>}</td>
                  </tr>))}</tbody></table></div>
            </div>);
        }}
      </AsyncView>
    </>);
}

function Balances({ by }) {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const view = by === 'client' ? 'client_balances' : 'case_balances';
  const state = useAsync(async () => {
    const rows = unwrap(await supabase.from(view).select('*').order('outstanding', { ascending: false }));
    const ids = rows.map((r) => r[`${by}_id`]).filter(Boolean);
    let names = {};
    if (ids.length) {
      if (by === 'client') names = Object.fromEntries(unwrap(await supabase.from('clients').select('id,full_name').in('id', ids)).map((c) => [c.id, c.full_name]));
      else names = Object.fromEntries(unwrap(await supabase.from('cases').select('id,title,case_number').in('id', ids)).map((c) => [c.id, `${c.case_number} — ${c.title}`]));
    }
    return rows.map((r) => ({ ...r, name: names[r[`${by}_id`]] || '—' }));
  }, [by]);
  const m = (n) => fmtMoney(n, lang);
  return (
    <AsyncView state={state} empty={<Card><Empty glyph="💰" title={t('fin.empty')} /></Card>}>
      {(rows) => (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{by === 'client' ? t('fin.client') : t('fin.case')}</th><th>{t('fin.agreed_fee')}</th><th>{t('fin.additional')}</th><th>{t('fin.payments')}</th><th>{t('fin.credits')}</th><th>{t('fin.expenses')}</th><th>{t('fin.outstanding')}</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r[`${by}_id`]} className="clickable" onClick={() => nav(by === 'client' ? `/lawyer/clients/${r.client_id}` : `/lawyer/cases/${r.case_id}`)}>
              <td>{r.name}</td><td className="num-cell">{m(r.agreed_fee)}</td><td className="num-cell">{m(r.additional_charges)}</td>
              <td className="num-cell">{m(r.payments)}</td><td className="num-cell">{m(r.credits)}</td><td className="num-cell">{m(r.expenses)}</td>
              <td className="num-cell"><strong>{m(r.outstanding)}</strong></td></tr>))}</tbody></table></div>)}
    </AsyncView>);
}

function Monthly() {
  const { t, lang } = useI18n();
  const state = useAsync(async () => unwrap(await supabase.from('monthly_financial_summary').select('*').order('month', { ascending: false }).limit(36)), []);
  const m = (n) => fmtMoney(n, lang);
  return (
    <AsyncView state={state} empty={<Card><Empty glyph="📆" title={t('fin.empty')} /></Card>}>
      {(rows) => (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('fin.month')}</th><th>{t('fin.total_billed')}</th><th>{t('fin.collected')}</th><th>{t('fin.expenses')}</th><th>{t('fin.net')}</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.month}><td>{formatDayKey(r.month, lang, { month: 'long', year: 'numeric' })}</td><td className="num-cell">{m(r.billed)}</td>
              <td className="num-cell">{m(r.collected)}</td><td className="num-cell">{m(r.expenses)}</td><td className="num-cell"><strong>{m(r.net)}</strong></td></tr>))}</tbody></table></div>)}
    </AsyncView>);
}

function Expected({ onPay }) {
  const { t, lang } = useI18n();
  const { tz, user } = useAuth();
  const toast = useToast(); const onError = useErrorToast();
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ amount: '', due_on: todayKey(tz), note: '', client_id: '', case_id: '' });
  const lists = useAsync(async () => {
    const [cases, clients] = await Promise.all([supabase.from('cases').select('id,title,case_number,client_id').limit(300), supabase.from('clients').select('id,full_name').order('full_name').limit(500)]);
    return { cases: unwrap(cases), clients: unwrap(clients) };
  }, []);
  const state = useAsync(async () => unwrap(await supabase.from('expected_payments').select('*, case:cases(id,title,case_number), client:clients(id,full_name)').eq('status', 'pending').order('due_on')), []);
  const today = todayKey(tz);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const add = async () => {
    if (!(Number(f.amount) > 0)) return toast(t('val.amount'), 'error');
    try {
      unwrap(await supabase.from('expected_payments').insert({ lawyer_id: user.id, amount: Number(f.amount), due_on: f.due_on, note: f.note || null, client_id: f.client_id || null, case_id: f.case_id || null }));
      setAdding(false); setF({ ...f, amount: '', note: '' }); state.reload();
    } catch (e) { onError(e); }
  };
  const cancel = async (id) => { try { unwrap(await supabase.from('expected_payments').update({ status: 'cancelled' }).eq('id', id)); state.reload(); } catch (e) { onError(e); } };
  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}><Alert tone="info" className="small">{t('fin.expected_hint')}</Alert><Button variant="primary" size="sm" onClick={() => setAdding(!adding)}>➕ {t('fin.add_expected')}</Button></div>
      {adding && (
        <Card className="stack" title={t('fin.add_expected')}>
          <div className="grid cols-3">
            <Field label={`${t('fin.amount')} (EGP)`}><Input className="input ltr" type="number" step="0.01" value={f.amount} onChange={set('amount')} /></Field>
            <Field label={t('fin.due_on')}><Input className="input ltr" type="date" value={f.due_on} onChange={set('due_on')} /></Field>
            <Field label={t('fin.client')}><Select value={f.client_id} onChange={set('client_id')}><option value="">—</option>{(lists.data?.clients || []).map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</Select></Field>
            <Field label={t('fin.case')}><Select value={f.case_id} onChange={set('case_id')}><option value="">—</option>{(lists.data?.cases || []).map((c) => <option key={c.id} value={c.id}>{c.case_number}</option>)}</Select></Field>
          </div>
          <Field label={t('fin.description')}><Input value={f.note} onChange={set('note')} /></Field>
          <div><Button variant="primary" onClick={add}>{t('common.save')}</Button></div>
        </Card>)}
      <AsyncView state={state} empty={<Card><Empty glyph="🗓️" title={t('fin.no_expected')} /></Card>}>
        {(rows) => (
          <div className="table-wrap" style={{ marginTop: 12 }}><table className="table">
            <thead><tr><th>{t('fin.due_on')}</th><th>{t('fin.amount')}</th><th>{t('fin.client')}</th><th>{t('fin.case')}</th><th>{t('common.status')}</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}><td className="nowrap">{formatDayKey(r.due_on, lang, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                <td className="num-cell">{fmtMoney(r.amount, lang)}</td><td>{r.client?.full_name || '—'}</td><td className="ltr">{r.case?.case_number || '—'}</td>
                <td>{r.due_on < today ? <span className="badge danger">{t('fin.overdue')}</span> : <span className="badge info">{t('fin.upcoming')}</span>}</td>
                <td><div className="row"><Button size="sm" variant="primary" onClick={() => onPay(r)}>{t('fin.record_payment')}</Button><Button size="sm" onClick={() => cancel(r.id)}>{t('common.cancel')}</Button></div></td></tr>))}</tbody></table></div>)}
      </AsyncView>
    </>);
}

export default function Finance() {
  const { t } = useI18n();
  const { disclaimer } = usePublicSettings();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'transactions';
  const [modal, setModal] = useState(null);
  const [bump, setBump] = useState(0);
  const toast = useToast(); const onError = useErrorToast();

  const markPaid = async (exp) => {
    setModal({ defaults: { kind: 'payment', amount: exp.amount, case_id: exp.case_id, client_id: exp.client_id, description: exp.note || '' }, expected: exp });
  };
  const onSaved = async () => {
    const exp = modal?.expected; setModal(null);
    if (exp) { try { unwrap(await supabase.from('expected_payments').update({ status: 'paid' }).eq('id', exp.id)); } catch (e) { onError(e); } }
    setBump((x) => x + 1);
  };
  return (
    <>
      <PageHead title={t('nav.finance')} actions={<Button variant="primary" onClick={() => setModal({ defaults: {} })}>➕ {t('fin.new_transaction')}</Button>} />
      <Disclaimer text={disclaimer('finance')} />
      <div style={{ marginTop: 16 }}>
        <Tabs value={tab} onChange={(v) => setSp({ tab: v })} items={[
          { value: 'transactions', label: t('fin.tab.transactions') }, { value: 'clients', label: t('fin.tab.clients') }, { value: 'cases', label: t('fin.tab.cases') },
          { value: 'monthly', label: t('fin.tab.monthly') }, { value: 'expected', label: t('fin.tab.expected') }]} />
        <div key={bump}>
          {tab === 'transactions' && <Transactions onNew={() => setModal({ defaults: {} })} />}
          {tab === 'clients' && <Balances by="client" />}
          {tab === 'cases' && <Balances by="case" />}
          {tab === 'monthly' && <Monthly />}
          {tab === 'expected' && <Expected onPay={markPaid} />}
        </div>
      </div>
      {modal && <TransactionModal defaults={modal.defaults} onClose={() => setModal(null)} onSaved={onSaved} />}
    </>);
}

export function TransactionDetail() {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { tz } = useAuth();
  const nav = useNavigate();
  const toast = useToast(); const onError = useErrorToast();
  const [confirm, setConfirm] = useState(false);
  const state = useAsync(async () => {
    const tx = unwrap(await supabase.from('financial_transactions').select('*, case:cases(id,title,case_number), client:clients(id,full_name)').eq('id', id).maybeSingle());
    if (!tx) return null;
    const rev = unwrap(await supabase.from('financial_transactions').select('*').eq('reverses_id', id).maybeSingle());
    const orig = tx.reverses_id ? unwrap(await supabase.from('financial_transactions').select('*').eq('id', tx.reverses_id).maybeSingle()) : null;
    return { tx, rev, orig };
  }, [id]);
  const reverse = async (reason) => {
    try { unwrap(await supabase.rpc('reverse_transaction', { p_tx: id, p_reason: reason })); toast(t('fin.reversed_ok'), 'success'); setConfirm(false); state.reload(); }
    catch (e) { onError(e); }
  };
  return (
    <AsyncView state={state}>
      {(d) => {
        if (!d) return <Alert tone="warn">{t('common.not_found')}</Alert>;
        const { tx, rev, orig } = d;
        return (
          <>
            <PageHead title={t('fin.transaction')} subtitle={t(`tx.kind.${tx.kind}`)} actions={<Button size="sm" onClick={() => nav(-1)}>{t('common.back')}</Button>} />
            <div className="grid cols-2" style={{ alignItems: 'start' }}>
              <Card title={t('common.details')}>
                <KV items={[
                  [t('fin.amount'), <strong key="a">{fmtMoney(tx.amount, lang, tx.currency)}</strong>],
                  [t('fin.date'), formatDate(`${tx.occurred_on}T12:00:00Z`, 'UTC', lang)],
                  [t('fin.type'), t(`tx.kind.${tx.kind}`)],
                  [t('fin.method'), tx.method ? t(`method.${tx.method}`) : null],
                  [t('fin.category'), tx.category],
                  [t('fin.description'), tx.description],
                  [t('fin.case'), tx.case ? <Link key="c" to={`/lawyer/cases/${tx.case.id}`}>{tx.case.case_number} — {tx.case.title}</Link> : null],
                  [t('fin.client'), tx.client ? <Link key="cl" to={`/lawyer/clients/${tx.client.id}`}>{tx.client.full_name}</Link> : null],
                  [t('fin.recorded_at'), formatDateTime(tx.created_at, tz, lang)],
                ]} />
              </Card>
              <Card title={t('fin.history')}>
                <div className="stack">
                  <div className="row"><span className="badge success">{t('fin.recorded')}</span><span className="small muted">{formatDateTime(tx.created_at, tz, lang)}</span></div>
                  {orig && <Alert tone="info">{t('fin.reversal_of')}: <Link to={`/lawyer/finance/${orig.id}`}>{t(`tx.kind.${orig.kind}`)} · {fmtMoney(orig.amount, lang)}</Link></Alert>}
                  {rev && <Alert tone="danger">{t('fin.was_reversed')}: <Link to={`/lawyer/finance/${rev.id}`}>{formatDateTime(rev.created_at, tz, lang)}</Link> — {rev.description}</Alert>}
                  {tx.kind !== 'reversal' && !rev && <Button variant="danger" onClick={() => setConfirm(true)}>{t('fin.reverse')}</Button>}
                  <p className="small muted">{t('fin.append_only')}</p>
                </div>
              </Card>
            </div>
            {confirm && <ConfirmDialog title={t('fin.reverse')} message={t('fin.reverse_msg')} danger requireReason onCancel={() => setConfirm(false)} onConfirm={reverse} />}
          </>);
      }}
    </AsyncView>);
}
