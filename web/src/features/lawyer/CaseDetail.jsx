import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { formatDate, formatDateTime } from '../../lib/dates.js';
import { fmtMoney } from '../../lib/finance.js';
import { MIME_CASE, openSigned, uploadFile, validateFile } from '../../lib/storage.js';
import { Alert, AsyncView, Button, Card, ConfirmDialog, Empty, Field, Input, KV, PageHead, Select, StatusBadge, Tabs, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';
import { CASE_STATUSES, CaseModal } from './Cases.jsx';
import EventModal from './EventModal.jsx';
import TransactionModal from './TransactionModal.jsx';
import { TotalsBar } from './Finance.jsx';
import { summarize } from '../../lib/finance.js';

const BUCKET = 'case-documents';

export default function CaseDetail() {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { user, tz } = useAuth();
  const nav = useNavigate();
  const toast = useToast(); const onError = useErrorToast();
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [eventModal, setEventModal] = useState(null);
  const [txModal, setTxModal] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [note, setNote] = useState('');
  const [alias, setAlias] = useState('');
  const [perms, setPerms] = useState({ can_edit: false, can_view_notes: false });
  const [taskTitle, setTaskTitle] = useState('');
  const fileRef = useRef(null);

  const state = useAsync(async () => {
    const c = unwrap(await supabase.from('cases').select('*, client:clients(id,full_name,phone)').eq('id', id).maybeSingle());
    if (!c) return null;
    const owner = c.lawyer_id === user.id;
    const [hearings, docs, notes, activity, tasks, tx, members] = await Promise.all([
      supabase.from('calendar_events').select('*').eq('case_id', id).is('deleted_at', null).order('starts_at', { ascending: false }),
      supabase.from('case_documents').select('*').eq('case_id', id).is('deleted_at', null).order('created_at', { ascending: false }),
      supabase.from('case_notes').select('*').eq('case_id', id).is('deleted_at', null).order('created_at', { ascending: false }),
      supabase.from('case_activity').select('*').eq('case_id', id).order('created_at', { ascending: false }).limit(100),
      supabase.from('tasks').select('*').eq('case_id', id).is('deleted_at', null).order('created_at', { ascending: false }),
      owner ? supabase.from('financial_transactions').select('*').eq('case_id', id).order('occurred_on', { ascending: false }) : Promise.resolve({ data: [] }),
      owner ? supabase.rpc('list_case_members', { p_case: id }) : Promise.resolve({ data: [] }),
    ]);
    return { c, owner, hearings: unwrap(hearings), docs: unwrap(docs), notes: unwrap(notes), activity: unwrap(activity), tasks: unwrap(tasks), tx: unwrap(tx), members: unwrap(members) };
  }, [id]);

  const run = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg, 'success'); state.reload(); } catch (e) { onError(e); } };

  return (
    <AsyncView state={state}>
      {(d) => {
        if (!d) return <Alert tone="warn">{t('common.not_found')}</Alert>;
        const { c, owner } = d;
        const archived = c.status === 'archived'; const closed = c.status === 'closed';
        const items = [
          { value: 'overview', label: t('case.tab.overview') }, { value: 'hearings', label: t('case.tab.hearings') }, { value: 'documents', label: t('case.tab.documents') },
          { value: 'tasks', label: t('case.tab.tasks') }, { value: 'notes', label: t('case.tab.notes') },
          ...(owner ? [{ value: 'finance', label: t('case.tab.finance') }, { value: 'team', label: t('case.tab.team') }] : []),
          { value: 'activity', label: t('case.tab.activity') }];
        const setStatus = (status) => run(async () => unwrap(await supabase.from('cases').update({ status }).eq('id', id)), t('common.saved'));
        const upload = (file) => run(async () => {
          const bad = validateFile(file, { maxMb: 25, mimes: MIME_CASE });
          if (bad) { toast(t(`err.${bad}`, { mb: 25 }), 'error'); return; }
          const up = await uploadFile(BUCKET, id, file);
          unwrap(await supabase.from('case_documents').insert({ case_id: id, uploaded_by: user.id, storage_path: up.path, file_name: up.file_name, mime_type: up.mime_type, size_bytes: up.size_bytes }));
        }, t('common.saved'));
        return (
          <>
            <PageHead title={c.title} subtitle={<span><span className="ltr">{c.case_number}</span> · {c.client?.full_name || t('cases.no_client')}</span>}
              actions={<><StatusBadge status={c.status} prefix="case.status" /><Button size="sm" onClick={() => nav('/lawyer/cases')}>{t('common.back')}</Button>
                <Button size="sm" onClick={() => setEditing(true)}>{t('common.edit')}</Button>
                {owner && (closed ? <Button size="sm" onClick={() => setStatus('archived')}>{t('cases.archive')}</Button> : null)}
                {owner && (closed || archived) && <Button size="sm" variant="primary" onClick={() => setConfirm('reopen')}>{t('cases.reopen')}</Button>}
                {owner && !closed && !archived && <Button size="sm" onClick={() => setConfirm('close')}>{t('cases.close')}</Button>}</>} />
            {!owner && <Alert tone="info" className="small">{t('cases.shared_with_you')}</Alert>}
            <Tabs value={tab} onChange={setTab} items={items} />

            {tab === 'overview' && (
              <div className="grid cols-2" style={{ alignItems: 'start' }}>
                <Card title={t('common.details')}><KV items={[
                  [t('cases.number'), <span key="n" className="ltr">{c.case_number}</span>], [t('cases.court'), c.court], [t('cases.category'), c.category ? t(`casecat.${c.category}`) : null],
                  [t('cases.client'), c.client ? <Link key="c" to={`/lawyer/clients/${c.client.id}`}>{c.client.full_name}</Link> : null], [t('cases.opposing'), c.opposing_party],
                  [t('cases.opened_on'), c.opened_on ? formatDate(`${c.opened_on}T12:00:00Z`, 'UTC', lang) : null],
                  [t('cases.closed_on'), c.closed_on ? formatDate(`${c.closed_on}T12:00:00Z`, 'UTC', lang) : null],
                  [t('cases.next_hearing'), c.next_hearing_at ? formatDateTime(c.next_hearing_at, tz, lang) : null]]} /></Card>
                <Card title={t('cases.description')}>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{c.description || '—'}</p>
                  {!closed && !archived && <Field label={t('cases.change_status')}>
                    <Select value={c.status} onChange={(e) => setStatus(e.target.value)}>{CASE_STATUSES.filter((s) => !['archived', 'closed'].includes(s)).map((s) => <option key={s} value={s}>{t(`case.status.${s}`)}</option>)}</Select></Field>}
                </Card>
              </div>)}

            {tab === 'hearings' && (
              <Card title={t('case.tab.hearings')} actions={<Button size="sm" variant="primary" onClick={() => setEventModal({ defaults: { kind: 'hearing', case_id: id } })}>➕ {t('cases.add_hearing')}</Button>}>
                {d.hearings.length === 0 ? <Empty glyph="⚖️" title={t('cases.no_hearings')} /> : (
                  <div className="list">{d.hearings.map((h) => (
                    <div className="list-item clickable" key={h.id} onClick={() => setEventModal({ event: h })}>
                      <span className="grow"><strong>{formatDateTime(h.starts_at, tz, lang)}</strong><div className="small muted">{h.location_text || ''}{h.outcome ? ` · ${h.outcome}` : ''}</div></span>
                      <span className={`badge ${h.source === 'verified_external' ? 'success' : 'warn'}`}>{t(`cal.source.${h.source}`)}</span><StatusBadge status={h.status} prefix="evstatus" /></div>))}</div>)}
              </Card>)}

            {tab === 'documents' && (
              <Card title={t('case.tab.documents')} actions={<><input ref={fileRef} hidden type="file" accept={MIME_CASE.join(',')} onChange={(e) => { if (e.target.files[0]) upload(e.target.files[0]); e.target.value = ''; }} />
                <Button size="sm" variant="primary" onClick={() => fileRef.current.click()}>{t('common.upload')}</Button></>}>
                {d.docs.length === 0 ? <Empty glyph="📁" title={t('cases.no_docs')} /> : (
                  <div className="list">{d.docs.map((x) => (
                    <div className="list-item" key={x.id}><span>📄</span><span className="grow">{x.file_name}<div className="small muted">{formatDateTime(x.created_at, tz, lang)}</div></span>
                      <Button size="sm" onClick={() => openSigned(BUCKET, x.storage_path).catch(onError)}>{t('common.open')}</Button>
                      {owner && <Button size="sm" variant="danger" onClick={() => run(async () => { await supabase.storage.from(BUCKET).remove([x.storage_path]); unwrap(await supabase.from('case_documents').update({ deleted_at: new Date().toISOString() }).eq('id', x.id)); })}>{t('common.remove')}</Button>}
                    </div>))}</div>)}
              </Card>)}

            {tab === 'tasks' && (
              <Card title={t('case.tab.tasks')}>
                <form className="row" style={{ flexWrap: 'nowrap', marginBottom: 8 }} onSubmit={(e) => { e.preventDefault(); if (!taskTitle.trim()) return; run(async () => { unwrap(await supabase.from('tasks').insert({ lawyer_id: user.id, case_id: id, title: taskTitle.trim() })); setTaskTitle(''); }); }}>
                  <Input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder={t('dash.add_task')} /><Button type="submit" variant="primary">{t('common.add')}</Button></form>
                {d.tasks.length === 0 ? <p className="muted small">{t('dash.no_tasks')}</p> : (
                  <div className="list">{d.tasks.map((k) => (
                    <div className="list-item" key={k.id}><input type="checkbox" checked={k.status === 'done'} style={{ width: 18, height: 18 }}
                      onChange={() => run(async () => unwrap(await supabase.from('tasks').update({ status: k.status === 'done' ? 'open' : 'done' }).eq('id', k.id)))} />
                      <span className="grow" style={{ textDecoration: k.status === 'done' ? 'line-through' : 'none' }}>{k.title}</span></div>))}</div>)}
              </Card>)}

            {tab === 'notes' && (
              <Card title={t('case.tab.notes')}>
                <Alert tone="info" className="small">{t('cases.notes_private')}</Alert>
                <div className="stack" style={{ margin: '12px 0' }}>
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('cases.write_note')} />
                  <div><Button variant="primary" disabled={!note.trim()} onClick={() => run(async () => { unwrap(await supabase.from('case_notes').insert({ case_id: id, author_id: user.id, body: note.trim() })); setNote(''); })}>{t('cases.add_note')}</Button></div>
                </div>
                {d.notes.length === 0 ? <p className="muted small">{t('cases.no_notes')}</p> : (
                  <div className="list">{d.notes.map((n) => (
                    <div className="list-item" key={n.id} style={{ alignItems: 'flex-start' }}><div className="grow"><div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div><div className="small muted">{formatDateTime(n.created_at, tz, lang)}</div></div>
                      {n.author_id === user.id && <Button size="sm" variant="ghost" onClick={() => run(async () => unwrap(await supabase.from('case_notes').update({ deleted_at: new Date().toISOString() }).eq('id', n.id)))}>{t('common.delete')}</Button>}</div>))}</div>)}
              </Card>)}

            {tab === 'finance' && owner && (
              <div className="stack">
                <TotalsBar s={summarize(d.tx)} />
                <Card title={t('case.tab.finance')} actions={<Button size="sm" variant="primary" onClick={() => setTxModal(true)}>➕ {t('fin.new_transaction')}</Button>}>
                  {d.tx.length === 0 ? <Empty glyph="💰" title={t('fin.empty')} /> : (
                    <div className="list">{d.tx.map((x) => (
                      <div className="list-item clickable" key={x.id} onClick={() => nav(`/lawyer/finance/${x.id}`)}>
                        <span className="chip">{t(`tx.kind.${x.kind}`)}</span><span className="grow small muted">{x.description || ''}</span>
                        <span className="small muted">{formatDate(`${x.occurred_on}T12:00:00Z`, 'UTC', lang)}</span><strong className="num-cell">{fmtMoney(x.amount, lang)}</strong></div>))}</div>)}
                </Card>
              </div>)}

            {tab === 'team' && owner && (
              <Card title={t('case.tab.team')}>
                <Alert tone="info" className="small">{t('cases.team_hint')}</Alert>
                <div className="row" style={{ margin: '12px 0' }}>
                  <Input style={{ maxWidth: 240 }} className="input ltr" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Advocate #A1002" aria-label={t('dir.alias')} />
                  <label className="chip"><input type="checkbox" checked={perms.can_edit} onChange={(e) => setPerms({ ...perms, can_edit: e.target.checked })} /> {t('cases.can_edit')}</label>
                  <label className="chip"><input type="checkbox" checked={perms.can_view_notes} onChange={(e) => setPerms({ ...perms, can_view_notes: e.target.checked })} /> {t('cases.can_view_notes')}</label>
                  <Button variant="primary" disabled={!alias.trim()} onClick={() => run(async () => { unwrap(await supabase.rpc('add_case_member_by_alias', { p_case: id, p_alias: alias.trim(), p_can_edit: perms.can_edit, p_can_view_notes: perms.can_view_notes })); setAlias(''); }, t('common.saved'))}>{t('common.add')}</Button>
                </div>
                {d.members.length === 0 ? <p className="muted small">{t('cases.no_team')}</p> : (
                  <div className="list">{d.members.map((m) => (
                    <div className="list-item" key={m.member_id}><span className="grow ltr">{m.public_alias}</span>
                      {m.can_edit && <span className="chip">{t('cases.can_edit')}</span>}{m.can_view_notes && <span className="chip">{t('cases.can_view_notes')}</span>}
                      <Button size="sm" variant="danger" onClick={() => run(async () => unwrap(await supabase.from('case_members').delete().eq('case_id', id).eq('member_id', m.member_id)))}>{t('common.remove')}</Button></div>))}</div>)}
              </Card>)}

            {tab === 'activity' && (
              <Card title={t('case.tab.activity')}>
                <div className="list">{d.activity.map((a) => (
                  <div className="list-item" key={a.id}><span className="grow">{t(`activity.${a.action}`)}{a.details?.to ? ` → ${t(`case.status.${a.details.to}`)}` : ''}</span>
                    <span className="small muted">{formatDateTime(a.created_at, tz, lang)}</span></div>))}</div>
              </Card>)}

            {editing && <CaseModal item={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); state.reload(); }} />}
            {eventModal && <EventModal event={eventModal.event} defaults={eventModal.defaults} onClose={() => setEventModal(null)} onSaved={() => { setEventModal(null); state.reload(); }} />}
            {txModal && <TransactionModal defaults={{ case_id: id, client_id: c.client_id }} onClose={() => setTxModal(false)} onSaved={() => { setTxModal(false); state.reload(); }} />}
            {confirm === 'close' && <ConfirmDialog title={t('cases.close')} message={t('cases.close_msg')} onCancel={() => setConfirm(null)} onConfirm={async () => { setConfirm(null); await setStatus('closed'); }} />}
            {confirm === 'reopen' && <ConfirmDialog title={t('cases.reopen')} message={t('cases.reopen_msg')} onCancel={() => setConfirm(null)} onConfirm={async () => { setConfirm(null); await setStatus('in_progress'); }} />}
          </>);
      }}
    </AsyncView>);
}
