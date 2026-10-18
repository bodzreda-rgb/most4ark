import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap, useDebounced, safeTerm } from '../../lib/hooks.js';
import { formatDate } from '../../lib/dates.js';
import { MIME_DOCS, uploadFile, validateFile } from '../../lib/storage.js';
import { usePublicSettings } from '../../lib/settings.js';
import {
  Alert, AsyncView, Button, Checkbox, Disclaimer, Empty, Field, Input, PageHead, PhotoTiles, SearchBox,
  Select, StatusBadge, Textarea, useErrorToast, useToast,
} from '../../components/ui.jsx';

export function MyConsultations() {
  const { t, lang } = useI18n();
  const { tz } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const dq = useDebounced(q);
  const state = useAsync(async () => {
    let query = supabase.from('consultations').select('id,reference_no,title,status,created_at,updated_at').order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const term = safeTerm(dq);
    if (term) query = query.or(`title.ilike.%${term}%,reference_no.ilike.%${term}%`);
    return unwrap(await query);
  }, [dq, status]);

  return (
    <>
      <PageHead title={t('nav.my_consultations')} actions={<Link className="btn btn-primary" to="/client/new">➕ {t('nav.new_consultation')}</Link>} />
      <PhotoTiles items={[
        { to: '/client/new', img: 'columns', label: t('nav.new_consultation') },
        { to: '/client/profile', img: 'suit', label: t('nav.profile') },
      ]} />
      <div className="row" style={{ marginBottom: 16 }}>
        <SearchBox value={q} onChange={setQ} placeholder={t('common.search')} />
        <Select style={{ maxWidth: 220 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('common.status')}>
          <option value="">{t('common.all_statuses')}</option>
          {['submitted', 'under_review', 'awaiting_info', 'assigned', 'in_progress', 'answered', 'closed', 'rejected'].map((s) => <option key={s} value={s}>{t(`cons.status.${s}`)}</option>)}
        </Select>
      </div>
      <AsyncView state={state} empty={<Empty glyph="💬" title={t('cons.empty')}>{t('cons.empty_hint')}</Empty>}>
        {(rows) => (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('cons.reference')}</th><th>{t('cons.title')}</th><th>{t('common.status')}</th><th>{t('common.created')}</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => nav(`/client/consultations/${r.id}`)}>
                <td className="ltr nowrap"><Link to={`/client/consultations/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.reference_no}</Link></td>
                <td>{r.title}</td><td><StatusBadge status={r.status} prefix="cons.status" /></td>
                <td className="nowrap">{formatDate(r.created_at, tz, lang)}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </AsyncView>
    </>
  );
}

export function NewConsultation() {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const onError = useErrorToast();
  const { disclaimer, maxUploadMb } = usePublicSettings();
  const cats = useAsync(async () => unwrap(await supabase.from('consultation_categories').select('*').eq('is_active', true).order('sort_order')), []);
  const [f, setF] = useState({ title: '', category_id: '', description: '', jurisdiction: 'مصر', location_text: '', opposing_party: '', preferred_response: 'in_app', consent_privacy: false, consent_disclaimer: false });
  const [files, setFiles] = useState([]);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const addFiles = (list) => {
    const ok = [];
    for (const file of list) {
      const bad = validateFile(file, { maxMb: Math.min(maxUploadMb, 10), mimes: MIME_DOCS });
      if (bad) toast(`${file.name}: ${t(`err.${bad}`, { mb: maxUploadMb })}`, 'error'); else ok.push(file);
    }
    setFiles((x) => [...x, ...ok].slice(0, 5));
  };

  const submit = async (e) => {
    e.preventDefault();
    const er = {};
    if (f.title.trim().length < 3) er.title = t('val.title');
    if (!f.category_id) er.category_id = t('val.required');
    if (f.description.trim().length < 10) er.description = t('val.description');
    if (!f.consent_privacy || !f.consent_disclaimer) er.consent = t('val.consent');
    setErrors(er);
    if (Object.keys(er).length) return;
    setBusy(true);
    try {
      const id = crypto.randomUUID();
      const row = unwrap(await supabase.from('consultations').insert({
        id, client_id: user.id, title: f.title.trim(), category_id: Number(f.category_id), description: f.description.trim(),
        jurisdiction: f.jurisdiction.trim() || 'مصر', location_text: f.location_text.trim() || null,
        opposing_party: f.opposing_party.trim() || null, preferred_response: f.preferred_response,
        consent_privacy: true, consent_disclaimer: true,
      }).select('id').single());
      for (const file of files) {
        const up = await uploadFile('consultation-attachments', row.id, file);
        unwrap(await supabase.from('consultation_attachments').insert({
          consultation_id: row.id, uploader_id: user.id, storage_path: up.path, file_name: up.file_name, mime_type: up.mime_type, size_bytes: up.size_bytes,
        }));
      }
      toast(t('cons.submitted_ok'), 'success');
      nav(`/client/consultations/${row.id}`);
    } catch (err) { onError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHead title={t('nav.new_consultation')} subtitle={t('cons.new_subtitle')} />
      <Disclaimer text={disclaimer('consultation')} />
      <form onSubmit={submit} noValidate className="card stack" style={{ marginTop: 16, maxWidth: 780 }}>
        <Field label={t('cons.title')} error={errors.title}><Input value={f.title} onChange={set('title')} maxLength={200} /></Field>
        <Field label={t('cons.category')} error={errors.category_id}>
          <Select value={f.category_id} onChange={set('category_id')}>
            <option value="">{t('common.choose')}</option>
            {(cats.data || []).map((c) => <option key={c.id} value={c.id}>{lang === 'ar' ? c.name_ar : c.name_en}</option>)}
          </Select>
        </Field>
        <Field label={t('cons.description')} hint={t('cons.description_hint')} error={errors.description}>
          <Textarea value={f.description} onChange={set('description')} maxLength={8000} style={{ minHeight: 160 }} />
        </Field>
        <div className="grid cols-2">
          <Field label={t('cons.jurisdiction')}><Input value={f.jurisdiction} onChange={set('jurisdiction')} /></Field>
          <Field label={t('cons.location_optional')}><Input value={f.location_text} onChange={set('location_text')} /></Field>
        </div>
        <Field label={t('cons.opposing_party')} hint={t('cons.opposing_hint')}><Input value={f.opposing_party} onChange={set('opposing_party')} /></Field>
        <Field label={t('cons.preferred_response')}>
          <Select value={f.preferred_response} onChange={set('preferred_response')}>
            {['in_app', 'email', 'phone'].map((r) => <option key={r} value={r}>{t(`cons.resp.${r}`)}</option>)}
          </Select>
        </Field>
        <Field label={t('cons.attachments')} hint={t('cons.attach_hint', { mb: Math.min(maxUploadMb, 10) })}>
          <input type="file" multiple accept={MIME_DOCS.join(',')} onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
        </Field>
        {files.length > 0 && <div className="row">{files.map((f2, i) => (
          <span className="chip" key={i}>{f2.name} <button type="button" className="btn-ghost" style={{ border: 0, cursor: 'pointer' }} aria-label={t('common.remove')} onClick={() => setFiles(files.filter((_, j) => j !== i))}>✕</button></span>))}</div>}
        <Alert tone="info" className="small">{t('cons.privacy_notice')}</Alert>
        <Checkbox checked={f.consent_privacy} onChange={set('consent_privacy')} label={t('cons.consent_privacy')} />
        <Checkbox checked={f.consent_disclaimer} onChange={set('consent_disclaimer')} label={t('cons.consent_disclaimer')} />
        {errors.consent && <span className="err small" role="alert" style={{ color: 'var(--danger)' }}>{errors.consent}</span>}
        <div className="row"><Button variant="primary" type="submit" loading={busy}>{t('cons.submit')}</Button><Button type="button" onClick={() => nav(-1)}>{t('common.cancel')}</Button></div>
      </form>
    </>
  );
}
