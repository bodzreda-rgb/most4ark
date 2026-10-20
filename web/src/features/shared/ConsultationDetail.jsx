import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/dates.js';
import { MIME_DOCS, openSigned, uploadFile, validateFile } from '../../lib/storage.js';
import { usePublicSettings } from '../../lib/settings.js';
import {
  Alert, AsyncView, Button, Card, ConfirmDialog, Disclaimer, Field, KV, PageHead,
  Select, StatusBadge, Textarea, useErrorToast, useToast,
} from '../../components/ui.jsx';

const BUCKET = 'consultation-attachments';

function AssignPanel({ consultationId, onDone }) {
  const { t } = useI18n();
  const toast = useToast();
  const onError = useErrorToast();
  const [override, setOverride] = useState(null);   // lawyer being assigned despite conflict
  const state = useAsync(async () => unwrap(await supabase.rpc('eligible_lawyers_for_consultation', { p_consultation: consultationId })), [consultationId]);

  const assign = async (lawyerId, ov = false, note = null) => {
    try {
      unwrap(await supabase.rpc('assign_consultation', { p_consultation: consultationId, p_lawyer: lawyerId, p_override_conflict: ov, p_note: note }));
      toast(t('cons.assigned_ok'), 'success');
      setOverride(null);
      onDone();
    } catch (e) { onError(e); }
  };

  return (
    <Card title={t('cons.assign')}>
      <AsyncView state={state} empty={<p className="muted">{t('cons.no_eligible')}</p>}>
        {(rows) => (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('dir.alias')}</th><th>{t('dir.experience')}</th><th>{t('cons.spec_match')}</th><th>{t('cons.load')}</th><th>{t('cons.conflicts')}</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.lawyer_id}>
                  <td className="ltr">{r.public_alias}</td>
                  <td>{r.years_experience ?? '—'}</td>
                  <td>{r.specialization_match ? '✓' : '—'}</td>
                  <td>{r.open_load}</td>
                  <td>{r.conflicts > 0 ? <span className="badge danger">{t('cons.potential_conflict')}</span> : '—'}</td>
                  <td><Button size="sm" variant="primary" onClick={() => (r.conflicts > 0 ? setOverride(r) : assign(r.lawyer_id))}>{t('cons.assign_btn')}</Button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </AsyncView>
      {override && (
        <ConfirmDialog title={t('cons.conflict_title')} message={t('cons.conflict_msg')} requireReason danger
          onCancel={() => setOverride(null)} onConfirm={(note) => assign(override.lawyer_id, true, note)} />
      )}
    </Card>
  );
}

export default function ConsultationDetail({ role }) {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { tz, user } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const onError = useErrorToast();
  const { disclaimer, maxUploadMb } = usePublicSettings();
  const fileRef = useRef(null);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState('message');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);

  const state = useAsync(async () => {
    const [c, msgs, atts, hist] = await Promise.all([
      supabase.from('consultations').select('*, category:consultation_categories(name_ar,name_en)').eq('id', id).maybeSingle(),
      supabase.from('consultation_messages').select('*').eq('consultation_id', id).order('created_at'),
      supabase.from('consultation_attachments').select('*').eq('consultation_id', id).order('created_at'),
      supabase.from('consultation_status_history').select('*').eq('consultation_id', id).order('created_at'),
    ]);
    if (c.error) throw c.error;
    if (!c.data) return { missing: true };
    let person = null;
    if (role === 'admin') person = ((await supabase.rpc('admin_consultation_people', { p_ids: [id] })).data || [])[0] || null;
    return { c: c.data, msgs: unwrap(msgs), atts: unwrap(atts), hist: unwrap(hist), person };
  }, [id]);

  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      unwrap(await supabase.from('consultation_messages').insert({
        consultation_id: id, sender_id: user.id, sender_role: role, kind: role === 'client' ? 'message' : kind, body: body.trim(),
      }));
      setBody(''); setKind('message'); state.reload();
    } catch (e) { onError(e); } finally { setBusy(false); }
  };

  const upload = async (file) => {
    const bad = validateFile(file, { maxMb: Math.min(maxUploadMb, 10), mimes: MIME_DOCS });
    if (bad) return toast(t(`err.${bad}`, { mb: maxUploadMb }), 'error');
    try {
      const up = await uploadFile(BUCKET, id, file);
      unwrap(await supabase.from('consultation_attachments').insert({
        consultation_id: id, uploader_id: user.id, storage_path: up.path, file_name: up.file_name, mime_type: up.mime_type, size_bytes: up.size_bytes,
      }));
      state.reload();
    } catch (e) { onError(e); }
  };

  const setStatus = async (to, note = null) => {
    try {
      unwrap(await supabase.rpc('set_consultation_status', { p_id: id, p_to: to, p_note: note }));
      setConfirm(null); state.reload();
    } catch (e) { onError(e); }
  };

  return (
    <AsyncView state={state}>
      {(d) => {
        if (d.missing) return <Alert tone="warn">{t('common.not_found')}</Alert>;
        const { c, msgs, atts, hist, person } = d;
        const closed = ['closed', 'rejected'].includes(c.status);
        const catName = c.category ? (lang === 'ar' ? c.category.name_ar : c.category.name_en) : '—';
        return (
          <>
            <PageHead title={c.title} subtitle={<span className="ltr">{c.reference_no}</span>}
              actions={<><StatusBadge status={c.status} prefix="cons.status" /><Button size="sm" onClick={() => nav(-1)}>{t('common.back')}</Button></>} />
            <Disclaimer text={disclaimer('consultation')} />
            <div className="grid cols-2" style={{ marginTop: 16, alignItems: 'start' }}>
              <div className="stack">
                <Card title={t('cons.details')}>
                  <KV items={[
                    person && [t('admin.client_name'), person.client_name],
                    person && [t('auth.email'), <span key="pe" className="ltr">{person.client_email}</span>],
                    person && [t('auth.phone'), <span key="pp" className="ltr">{person.client_phone || '—'}</span>],
                    [t('cons.category'), catName],
                    [t('cons.jurisdiction'), c.jurisdiction],
                    c.location_text && [t('cons.location'), c.location_text],
                    [t('cons.preferred_response'), t(`cons.resp.${c.preferred_response}`)],
                    [t('common.created'), formatDateTime(c.created_at, tz, lang)],
                    c.closed_reason && [t('cons.closed_reason'), c.closed_reason],
                  ]} />
                  <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '12px 0' }} />
                  <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{c.description}</p>
                </Card>

                <Card title={t('cons.attachments')} actions={!closed && <>
                  <input ref={fileRef} type="file" hidden accept={MIME_DOCS.join(',')} onChange={(e) => { if (e.target.files[0]) upload(e.target.files[0]); e.target.value = ''; }} />
                  <Button size="sm" onClick={() => fileRef.current.click()}>{t('common.upload')}</Button></>}>
                  {atts.length === 0 ? <p className="muted small">{t('cons.no_attachments')}</p> : (
                    <div className="list">{atts.map((a) => (
                      <div className="list-item" key={a.id}>
                        <span>📎</span><span className="grow">{a.file_name}</span>
                        <Button size="sm" onClick={() => openSigned(BUCKET, a.storage_path).catch(onError)}>{t('common.open')}</Button>
                      </div>))}</div>
                  )}
                </Card>

                <Card title={t('cons.history')}>
                  <div className="list">{hist.map((h) => (
                    <div className="list-item" key={h.id}>
                      <StatusBadge status={h.to_status} prefix="cons.status" />
                      <span className="grow small muted">{h.note || ''}</span>
                      <span className="small muted">{formatDateTime(h.created_at, tz, lang)}</span>
                    </div>))}</div>
                </Card>
              </div>

              <div className="stack">
                <Card title={t('cons.conversation')}>
                  <div className="thread">
                    {msgs.length === 0 && <p className="muted small">{t('cons.no_messages')}</p>}
                    {msgs.map((m) => (
                      <div key={m.id} className={`msg ${m.sender_id === user.id ? 'mine' : ''} ${m.kind !== 'message' ? m.kind : ''}`}>
                        <div className="meta">
                          {t(`cons.role.${m.sender_role}`)} · {formatDateTime(m.created_at, tz, lang)}
                          {m.kind !== 'message' && <> · <strong>{t(`cons.kind.${m.kind}`)}</strong></>}
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
                      </div>
                    ))}
                  </div>
                  {!closed ? (
                    <div className="stack" style={{ marginTop: 16 }}>
                      {role !== 'client' && (
                        <Field label={t('cons.message_type')}>
                          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                            <option value="message">{t('cons.kind.message')}</option>
                            <option value="info_request">{t('cons.kind.info_request')}</option>
                            <option value="answer">{t('cons.kind.answer')}</option>
                          </Select>
                        </Field>
                      )}
                      <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('cons.write_message')} maxLength={8000} />
                      <div><Button variant="primary" loading={busy} onClick={send} disabled={!body.trim()}>{t('common.send')}</Button></div>
                    </div>
                  ) : <Alert tone="info" className="small">{t('cons.closed_note')}</Alert>}
                </Card>

                {role === 'client' && !closed && (
                  <Button variant="secondary" onClick={() => setConfirm({ to: 'closed', title: t('cons.close_title') })}>{t('cons.close')}</Button>
                )}
                {role === 'lawyer' && !closed && (
                  <Card title={t('cons.update_status')}><div className="row">
                    {['in_progress', 'awaiting_info', 'answered'].map((s) => (
                      <Button key={s} size="sm" disabled={c.status === s} onClick={() => setStatus(s)}>{t(`cons.status.${s}`)}</Button>))}
                  </div></Card>
                )}
                {role === 'admin' && (
                  <>
                    {!closed && <AssignPanel consultationId={id} onDone={state.reload} />}
                    <Card title={t('cons.update_status')}><div className="row">
                      {['under_review', 'awaiting_info', 'in_progress', 'answered'].map((s) => (
                        <Button key={s} size="sm" disabled={c.status === s || closed} onClick={() => setStatus(s)}>{t(`cons.status.${s}`)}</Button>))}
                      {!closed && <>
                        <Button size="sm" variant="danger" onClick={() => setConfirm({ to: 'closed', title: t('cons.close_title'), reason: true })}>{t('cons.close')}</Button>
                        <Button size="sm" variant="danger" onClick={() => setConfirm({ to: 'rejected', title: t('cons.reject_title'), reason: true })}>{t('cons.reject')}</Button></>}
                    </div></Card>
                  </>
                )}
              </div>
            </div>
            {confirm && (
              <ConfirmDialog title={confirm.title} message={t('common.cannot_undo')} danger requireReason={confirm.reason}
                onCancel={() => setConfirm(null)} onConfirm={(reason) => setStatus(confirm.to, reason || null)} />
            )}
          </>
        );
      }}
    </AsyncView>
  );
}
