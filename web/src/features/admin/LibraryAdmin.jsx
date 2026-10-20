import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap, useDebounced, safeTerm } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/dates.js';
import { MIME_CASE, uploadFile, validateFile, openSigned } from '../../lib/storage.js';
import { RESOURCE_TYPES } from '../lawyer/Library.jsx';
import { Alert, AsyncView, Button, Checkbox, Empty, Field, Input, Modal, PageHead, SearchBox, Select, StatusBadge, Tabs, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';

const blank = { title: '', resource_type: 'law', category_id: '', law_name: '', article_number: '', issuing_authority: '', publication_date: '', effective_date: '', version: '',
  source: '', source_url: '', language: 'ar', body_text: '', tags: '', is_official_source: false, verification_status: 'unverified', last_verified_at: '', license_note: '' };

/** Fast path: pick a file, give it a title and category, and publish it for the lawyers. */
function QuickUpload({ cats, onClose, onSaved }) {
  const { t, lang } = useI18n();
  const toast = useToast(); const onError = useErrorToast();
  const [f, setF] = useState({ title: '', resource_type: 'reference', category_id: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const pick = (e) => {
    const x = e.target.files?.[0] || null; setFile(x);
    if (x && !f.title) setF({ ...f, title: x.name.replace(/.[^.]+$/, '') });
  };
  const save = async () => {
    if (!file) { toast(t('lib.pick_file'), 'error'); return; }
    if (!f.title.trim()) { toast(t('val.required'), 'error'); return; }
    const v = validateFile(file, { maxMb: 50, mimes: MIME_CASE }); if (v) { toast(t(`err.${v}`, { mb: 50 }), 'error'); return; }
    setBusy(true);
    try {
      const id = crypto.randomUUID();
      const { data: u } = await supabase.auth.getUser();
      const up = await uploadFile('library', id, file);
      unwrap(await supabase.from('legal_resources').insert({
        id, title: f.title.trim(), resource_type: f.resource_type, category_id: f.category_id ? Number(f.category_id) : null, language: 'ar',
        status: 'published', created_by: u.user.id, file_path: up.path, file_name: up.file_name, mime_type: up.mime_type, size_bytes: up.size_bytes,
      }));
      toast(t('lib.uploaded_ok'), 'success'); onSaved();
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('lib.upload_file')} onClose={onClose} actions={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('lib.upload_publish')}</Button></>}>
      <div className="stack">
        <Field label={t('lib.file')} hint={t('lib.file_hint')}><input type="file" onChange={pick} /></Field>
        <Field label={t('lib.title')}><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <div className="grid cols-2">
          <Field label={t('lib.type')}><Select value={f.resource_type} onChange={(e) => setF({ ...f, resource_type: e.target.value })}>{RESOURCE_TYPES.map((x) => <option key={x} value={x}>{t(`rtype.${x}`)}</option>)}</Select></Field>
          <Field label={t('lib.category')}><Select value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}><option value="">—</option>{cats.map((c) => <option key={c.id} value={c.id}>{lang === 'ar' ? c.name_ar : c.name_en}</option>)}</Select></Field>
        </div>
      </div>
    </Modal>);
}

function ResourceForm({ initial, cats, onClose, onSaved }) {
  const { t, lang } = useI18n();
  const toast = useToast(); const onError = useErrorToast();
  const [f, setF] = useState(initial ? { ...blank, ...Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v ?? blank[k] ?? ''])), tags: (initial.tags || []).join(', ') } : blank);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async () => {
    if (!f.title.trim()) { toast(t('val.required'), 'error'); return; }
    if (file) { const v = validateFile(file, { maxMb: 50, mimes: MIME_CASE }); if (v) { toast(t(`err.${v}`), 'error'); return; } }
    setBusy(true);
    try {
      const row = {
        title: f.title.trim(), resource_type: f.resource_type, category_id: f.category_id ? Number(f.category_id) : null,
        law_name: f.law_name || null, article_number: f.article_number || null, issuing_authority: f.issuing_authority || null,
        publication_date: f.publication_date || null, effective_date: f.effective_date || null, version: f.version || null,
        source: f.source || null, source_url: f.source_url || null, language: f.language, body_text: f.body_text || null,
        tags: f.tags.split(/[,،]/).map((x) => x.trim()).filter(Boolean), is_official_source: f.is_official_source,
        verification_status: f.verification_status, last_verified_at: f.last_verified_at || null, license_note: f.license_note || null,
      };
      let id = initial?.id;
      if (id) unwrap(await supabase.from('legal_resources').update(row).eq('id', id));
      else { const { data: u } = await supabase.auth.getUser(); id = unwrap(await supabase.from('legal_resources').insert({ ...row, created_by: u.user.id }).select('id').single()).id; }
      if (file) {
        const up = await uploadFile('library', id, file);
        unwrap(await supabase.from('legal_resources').update({ file_path: up.path, file_name: up.file_name, mime_type: up.mime_type, size_bytes: up.size_bytes }).eq('id', id));
      }
      toast(t('common.saved'), 'success'); onSaved();
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <Modal wide title={initial ? t('common.edit') : t('admin.new_resource')} onClose={onClose} actions={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button></>}>
      <Alert tone="info" className="small">{t('admin.library_no_fabrication')}</Alert>
      <div className="grid cols-2">
        <Field label={t('lib.title')}><Input value={f.title} onChange={set('title')} /></Field>
        <Field label={t('lib.type')}><Select value={f.resource_type} onChange={set('resource_type')}>{RESOURCE_TYPES.map((r) => <option key={r} value={r}>{t(`rtype.${r}`)}</option>)}</Select></Field>
        <Field label={t('lib.category')}><Select value={f.category_id} onChange={set('category_id')}><option value="">—</option>{cats.map((c) => <option key={c.id} value={c.id}>{lang === 'ar' ? c.name_ar : c.name_en}</option>)}</Select></Field>
        <Field label={t('lib.language')}><Select value={f.language} onChange={set('language')}><option value="ar">{t('lang.ar')}</option><option value="en">{t('lang.en')}</option></Select></Field>
        <Field label={t('lib.law_name')}><Input value={f.law_name} onChange={set('law_name')} /></Field>
        <Field label={t('lib.article')}><Input value={f.article_number} onChange={set('article_number')} /></Field>
        <Field label={t('lib.authority')}><Input value={f.issuing_authority} onChange={set('issuing_authority')} /></Field>
        <Field label={t('lib.version')}><Input value={f.version} onChange={set('version')} /></Field>
        <Field label={t('lib.publication_date')}><Input type="date" value={f.publication_date} onChange={set('publication_date')} /></Field>
        <Field label={t('lib.effective_date')}><Input type="date" value={f.effective_date} onChange={set('effective_date')} /></Field>
        <Field label={t('lib.source')} hint={t('lib.source_hint')}><Input value={f.source} onChange={set('source')} /></Field>
        <Field label={t('lib.source_url')}><Input className="input ltr" dir="ltr" type="url" value={f.source_url} onChange={set('source_url')} /></Field>
        <Field label={t('lib.verification')}><Select value={f.verification_status} onChange={set('verification_status')}>{['unverified', 'verified', 'outdated'].map((x) => <option key={x} value={x}>{t(`lib.vstatus.${x}`)}</option>)}</Select></Field>
        <Field label={t('lib.last_verified')}><Input type="date" value={f.last_verified_at} onChange={set('last_verified_at')} /></Field>
      </div>
      <Checkbox label={t('lib.official_source')} checked={f.is_official_source} onChange={set('is_official_source')} />
      <Field label={t('lib.tags')} hint={t('lib.tags_hint')}><Input value={f.tags} onChange={set('tags')} /></Field>
      <Field label={t('lib.license_note')}><Input value={f.license_note} onChange={set('license_note')} /></Field>
      <Field label={t('lib.body')} hint={t('lib.body_hint')}><Textarea rows={8} value={f.body_text} onChange={set('body_text')} /></Field>
      <Field label={t('lib.file')} hint={initial?.file_name ? `${t('common.current')}: ${initial.file_name}` : t('lib.file_hint')}>
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>
    </Modal>);
}

function Reports() {
  const { t, lang } = useI18n();
  const { tz } = useAuth();
  const toast = useToast(); const onError = useErrorToast();
  const state = useAsync(async () => unwrap(await supabase.from('resource_reports').select('*, legal_resources(title)').order('created_at', { ascending: false }).limit(100)), []);
  const resolve = async (id, status) => {
    try { const { data: u } = await supabase.auth.getUser(); unwrap(await supabase.from('resource_reports').update({ status, resolved_by: u.user.id }).eq('id', id)); toast(t('common.saved'), 'success'); state.reload(); }
    catch (e) { onError(e); }
  };
  return (
    <AsyncView state={state} empty={<Empty glyph="🚩" title={t('admin.no_reports')} />}>
      {(rows) => <div className="list">{rows.map((r) => (
        <div className="list-item" key={r.id}>
          <span className="grow"><strong>{r.legal_resources?.title}</strong><div className="small muted">{t(`lib.report.${r.reason}`)} {r.details ? `— ${r.details}` : ''}</div>
            <div className="small muted">{formatDateTime(r.created_at, tz, lang)}</div></span>
          <StatusBadge status={r.status} prefix="rstatus" />
          {r.status === 'open' && <><Button size="sm" onClick={() => resolve(r.id, 'resolved')}>{t('admin.resolve')}</Button><Button size="sm" variant="ghost" onClick={() => resolve(r.id, 'dismissed')}>{t('admin.dismiss')}</Button></>}
        </div>))}</div>}
    </AsyncView>);
}

export default function LibraryAdmin() {
  const { t, lang } = useI18n();
  const toast = useToast(); const onError = useErrorToast();
  const [tab, setTab] = useState('items');
  const [q, setQ] = useState(''); const dq = useDebounced(q);
  const [status, setStatus] = useState('');
  const [form, setForm] = useState(null);
  const [quick, setQuick] = useState(false);
  const cats = useAsync(async () => unwrap(await supabase.from('library_categories').select('*').order('sort_order')), []);
  const state = useAsync(async () => {
    let query = supabase.from('legal_resources').select('*').order('updated_at', { ascending: false }).limit(200);
    if (status) query = query.eq('status', status);
    const term = safeTerm(dq);
    if (term) query = query.ilike('title', `%${term}%`);
    return unwrap(await query);
  }, [dq, status]);
  const setStatusOf = async (r, s) => {
    try { unwrap(await supabase.from('legal_resources').update({ status: s }).eq('id', r.id)); toast(t('common.saved'), 'success'); state.reload(); } catch (e) { onError(e); }
  };
  return (
    <>
      <PageHead title={t('nav.library')} actions={tab === 'items' && <><Button variant="primary" onClick={() => setQuick(true)}>⬆ {t('lib.upload_file')}</Button><Button onClick={() => setForm({})}>＋ {t('admin.new_resource')}</Button></>} />
      <Tabs value={tab} onChange={setTab} items={[{ value: 'items', label: t('admin.resources') }, { value: 'reports', label: t('admin.resource_reports') }]} />
      {tab === 'reports' ? <Reports /> : (
        <>
          <div className="row" style={{ margin: '16px 0' }}>
            <SearchBox value={q} onChange={setQ} placeholder={t('lib.search')} />
            <Select style={{ maxWidth: 200 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('common.status')}>
              <option value="">{t('common.all_statuses')}</option>{['draft', 'published', 'unpublished', 'archived'].map((s) => <option key={s} value={s}>{t(`pub.${s}`)}</option>)}</Select>
          </div>
          <AsyncView state={state} empty={<Empty glyph="📚" title={t('lib.none')} />}>
            {(rows) => <div className="list">{rows.map((r) => (
              <div className="list-item" key={r.id}>
                <span className="grow"><strong>{r.title}</strong><div className="small muted">{t(`rtype.${r.resource_type}`)}{r.law_name ? ` · ${r.law_name}` : ''}{r.article_number ? ` · ${r.article_number}` : ''}</div></span>
                <StatusBadge status={r.verification_status} prefix="lib.vstatus" /><StatusBadge status={r.status} prefix="pub" />
                {r.file_path && <Button size="sm" variant="ghost" onClick={() => openSigned('library', r.file_path).catch(onError)}>📎</Button>}
                <Button size="sm" onClick={() => setForm(r)}>{t('common.edit')}</Button>
                {r.status !== 'published' && r.status !== 'archived' && <Button size="sm" variant="primary" onClick={() => setStatusOf(r, 'published')}>{t('admin.publish')}</Button>}
                {r.status === 'published' && <Button size="sm" onClick={() => setStatusOf(r, 'unpublished')}>{t('admin.unpublish')}</Button>}
                {r.status !== 'archived' && <Button size="sm" variant="ghost" onClick={() => setStatusOf(r, 'archived')}>{t('admin.archive')}</Button>}
              </div>))}</div>}
          </AsyncView>
        </>)}
      {quick && <QuickUpload cats={cats.data || []} onClose={() => setQuick(false)} onSaved={() => { setQuick(false); state.reload(); }} />}
      {form && <ResourceForm initial={form.id ? form : null} cats={cats.data || []} onClose={() => setForm(null)} onSaved={() => { setForm(null); state.reload(); }} />}
    </>);
}
