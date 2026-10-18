import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap, useDebounced } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/dates.js';
import { openSigned } from '../../lib/storage.js';
import { Alert, AsyncView, Button, Card, Checkbox, ConfirmDialog, Empty, Field, Input, KV, Modal, PageHead, SearchBox, Select, StatusBadge, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';

const STATUSES = ['draft', 'submitted', 'under_review', 'approved', 'rejected', 'suspended'];

export function AdminLawyers() {
  const { t, lang } = useI18n();
  const { tz } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') || '';
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const state = useAsync(async () => unwrap(await supabase.rpc('admin_list_lawyers', { p_status: status || null, p_search: dq || null })), [status, dq]);
  return (
    <>
      <PageHead title={t('nav.lawyers')} />
      <div className="row" style={{ marginBottom: 16 }}>
        <SearchBox value={q} onChange={setQ} placeholder={t('admin.lawyer_search')} />
        <Select style={{ maxWidth: 220 }} value={status} onChange={(e) => setSp(e.target.value ? { status: e.target.value } : {})} aria-label={t('common.status')}>
          <option value="">{t('common.all_statuses')}</option>{STATUSES.map((s) => <option key={s} value={s}>{t(`vstatus.${s}`)}</option>)}</Select>
      </div>
      <AsyncView state={state} empty={<Empty glyph="🪪" title={t('admin.no_lawyers')} />}>
        {(rows) => (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('admin.legal_name')}</th><th>{t('dir.alias')}</th><th>{t('lawyer.city')}</th><th>{t('lawyer.years')}</th><th>{t('common.status')}</th><th>{t('admin.submitted_at')}</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.user_id} className="clickable" onClick={() => nav(`/admin/lawyers/${r.user_id}`)}>
                <td>{r.full_legal_name || <span className="muted">{t('admin.identity_hidden')}</span>}</td><td className="ltr">{r.public_alias || '—'}</td>
                <td>{r.city || '—'}</td><td>{r.years_experience ?? '—'}</td><td><StatusBadge status={r.verification_status} prefix="vstatus" /></td>
                <td className="nowrap">{r.submitted_at ? formatDateTime(r.submitted_at, tz, lang) : '—'}</td></tr>))}</tbody></table></div>)}
      </AsyncView>
    </>);
}

export function AdminLawyerDetail() {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { tz, can } = useAuth();
  const nav = useNavigate();
  const toast = useToast(); const onError = useErrorToast();
  const [identity, setIdentity] = useState(null);
  const [action, setAction] = useState(null);
  const [edit, setEdit] = useState(null);
  const [acct, setAcct] = useState(null);

  const state = useAsync(async () => {
    const lp = unwrap(await supabase.from('lawyer_profiles').select('*').eq('user_id', id).maybeSingle());
    if (!lp) return null;
    const [events, specs, allSpecs] = await Promise.all([
      supabase.from('verification_events').select('*').eq('lawyer_id', id).order('created_at', { ascending: false }),
      supabase.from('lawyer_specializations').select('specialization_id').eq('lawyer_id', id),
      supabase.from('specializations').select('*')]);
    return { lp, events: unwrap(events), specs: unwrap(specs).map((x) => x.specialization_id), allSpecs: unwrap(allSpecs) };
  }, [id]);

  const reveal = async () => {
    try { setIdentity(unwrap(await supabase.rpc('admin_get_lawyer_identity', { p_lawyer: id }))); } catch (e) { onError(e); }
  };
  const review = async (act, reason) => {
    try { unwrap(await supabase.rpc('admin_review_lawyer', { p_lawyer: id, p_action: act, p_reason: reason || null })); setAction(null); toast(t('common.saved'), 'success'); state.reload(); }
    catch (e) { onError(e); }
  };
  const saveEdit = async () => {
    try {
      unwrap(await supabase.from('lawyer_profiles').update({ city: edit.city, bio: edit.bio || null, accepts_consultations: edit.accepts_consultations, show_in_directory: edit.show_in_directory }).eq('user_id', id));
      setEdit(null); toast(t('common.saved'), 'success'); state.reload();
    } catch (e) { onError(e); }
  };
  const setAccount = async (status, reason) => {
    try { unwrap(await supabase.rpc('admin_set_account_status', { p_user: id, p_status: status, p_reason: reason || null })); setAcct(null); toast(t('common.saved'), 'success'); state.reload(); }
    catch (e) { onError(e); }
  };

  return (
    <AsyncView state={state}>
      {(d) => {
        if (!d) return <Alert tone="warn">{t('common.not_found')}</Alert>;
        const { lp } = d; const st = lp.verification_status;
        const specName = (sid) => { const s = d.allSpecs.find((x) => x.id === sid); return s ? (lang === 'ar' ? s.name_ar : s.name_en) : sid; };
        return (
          <>
            <PageHead title={identity?.full_legal_name || lp.public_alias || t('admin.application')} subtitle={<StatusBadge status={st} prefix="vstatus" />}
              actions={<><Button size="sm" onClick={() => nav('/admin/lawyers')}>{t('common.back')}</Button>
                {can('lawyers.review') && st === 'submitted' && <Button size="sm" onClick={() => review('start_review')}>{t('admin.start_review')}</Button>}
                {can('lawyers.review') && ['submitted', 'under_review'].includes(st) && <><Button size="sm" variant="primary" onClick={() => setAction('approve')}>{t('admin.approve')}</Button>
                  <Button size="sm" variant="danger" onClick={() => setAction('reject')}>{t('admin.reject')}</Button></>}
                {can('lawyers.manage') && st === 'approved' && <Button size="sm" variant="danger" onClick={() => setAction('suspend')}>{t('admin.suspend')}</Button>}
                {can('lawyers.manage') && st === 'suspended' && <Button size="sm" variant="primary" onClick={() => setAction('reactivate')}>{t('admin.reactivate')}</Button>}</>} />
            {st === 'draft' && <Alert tone="info" className="small" >{t('admin.draft_not_submitted')}</Alert>}
            <div className="grid cols-2" style={{ alignItems: 'start' }}>
              <div className="stack">
                <Card title={t('admin.verified_identity')}>
                  {!can('lawyers.identity.read') ? <Alert tone="warn">{t('admin.no_identity_permission')}</Alert>
                    : identity ? (
                      <div className="stack">
                        <KV items={[[t('admin.legal_name'), identity.full_legal_name], [t('lawyer.bar_number'), <span key="b" className="ltr">{identity.bar_membership_number}</span>], [t('lawyer.bar_branch'), identity.bar_branch],
                          [t('auth.email'), <span key="e" className="ltr">{identity.email}</span>], [t('auth.phone'), <span key="p" className="ltr">{identity.phone}</span>]]} />
                        <h4>{t('lawyer.documents')}</h4>
                        {identity.documents.length === 0 ? <p className="muted small">{t('lawyer.no_docs')}</p> : (
                          <div className="list">{identity.documents.map((doc) => (
                            <div className="list-item" key={doc.id}><span>{doc.doc_type === 'bar_card' ? '🪪' : '📎'}</span>
                              <span className="grow">{t(`lawyer.doc.${doc.doc_type}`)}<div className="small muted">{doc.file_name}</div></span>
                              <Button size="sm" variant="primary" onClick={() => openSigned('lawyer-verification', doc.storage_path).catch(onError)}>{t('common.open')}</Button></div>))}</div>)}
                      </div>)
                    : (<div className="stack"><Alert tone="info" className="small">{t('admin.identity_audited')}</Alert><div><Button variant="primary" onClick={reveal}>🔓 {t('admin.reveal_identity')}</Button></div></div>)}
                </Card>
                <Card title={t('lawyer.history')}>
                  <div className="list">{d.events.map((ev) => (
                    <div className="list-item" key={ev.id}><StatusBadge status={ev.to_status} prefix="vstatus" /><span className="grow small muted">{ev.reason || ''}</span>
                      <span className="small muted">{formatDateTime(ev.created_at, tz, lang)}</span></div>))}{d.events.length === 0 && <p className="muted small">—</p>}</div>
                </Card>
              </div>
              <div className="stack">
                <Card title={t('lawyer.professional_info')} actions={can('lawyers.manage') && <Button size="sm" onClick={() => setEdit({ city: lp.city || '', bio: lp.bio || '', accepts_consultations: lp.accepts_consultations, show_in_directory: lp.show_in_directory })}>{t('common.edit')}</Button>}>
                  <KV items={[[t('dir.alias'), <span key="a" className="ltr">{lp.public_alias || '—'}</span>], [t('lawyer.city'), lp.city], [t('lawyer.working_locations'), (lp.working_locations || []).join('، ')],
                    [t('lawyer.years'), lp.years_experience], [t('lawyer.specializations'), d.specs.map(specName).join('، ')],
                    [t('lawyer.languages'), (lp.languages || []).map((l) => t(`lang.${l}`)).join('، ')], [t('lawyer.accepts_consultations'), lp.accepts_consultations ? t('common.yes') : t('common.no')],
                    [t('lawyer.show_in_directory'), lp.show_in_directory ? t('common.yes') : t('common.no')], [t('lawyer.bio'), lp.bio], lp.rejection_reason && [t('lawyer.rejected_title'), lp.rejection_reason]]} />
                </Card>
                {can('users.manage') && (
                  <Card title={t('admin.account_controls')}><div className="row">
                    <Button size="sm" variant="danger" onClick={() => setAcct('suspended')}>{t('admin.suspend_account')}</Button>
                    <Button size="sm" onClick={() => setAcct('active')}>{t('admin.activate_account')}</Button>
                    <Button size="sm" variant="danger" onClick={() => setAcct('deactivated')}>{t('admin.deactivate_account')}</Button></div></Card>)}
              </div>
            </div>
            {action && <ConfirmDialog title={t(`admin.${action}`)} message={t(`admin.${action}_msg`)} danger={action !== 'approve' && action !== 'reactivate'} requireReason={['reject', 'suspend'].includes(action)} onCancel={() => setAction(null)} onConfirm={(r) => review(action, r)} />}
            {acct && <ConfirmDialog title={t('admin.account_controls')} message={t('common.cannot_undo')} danger={acct !== 'active'} requireReason={acct !== 'active'} onCancel={() => setAcct(null)} onConfirm={(r) => setAccount(acct, r)} />}
            {edit && (
              <Modal title={t('common.edit')} onClose={() => setEdit(null)} actions={<>
                <Button onClick={() => setEdit(null)}>{t('common.cancel')}</Button>
                <Button variant="primary" onClick={saveEdit}>{t('common.save')}</Button></>}>
                <div className="stack">
                  <Field label={t('lawyer.city')}><Input value={edit.city} onChange={(e) => setEdit({ ...edit, city: e.target.value })} /></Field>
                  <Field label={t('lawyer.bio')}><Textarea rows={4} value={edit.bio} onChange={(e) => setEdit({ ...edit, bio: e.target.value })} /></Field>
                  <Checkbox label={t('lawyer.accepts_consultations')} checked={edit.accepts_consultations} onChange={(e) => setEdit({ ...edit, accepts_consultations: e.target.checked })} />
                  <Checkbox label={t('lawyer.show_in_directory')} checked={edit.show_in_directory} onChange={(e) => setEdit({ ...edit, show_in_directory: e.target.checked })} />
                </div>
              </Modal>)}
          </>);
      }}
    </AsyncView>);
}
