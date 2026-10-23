import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap, useDebounced, safeTerm } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/dates.js';
import { MIME_CASE, uploadFile, validateFile, openSigned, removeFiles } from '../../lib/storage.js';
import { RESOURCE_TYPES } from '../lawyer/Library.jsx';
import { Alert, AsyncView, Button, Checkbox, ConfirmDialog, Empty, Field, Input, Modal, PageHead, SearchBox, Select, StatusBadge, Tabs, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';

const NEW_CAT = '__new__';
const blank = { title: '', resource_type: 'reference', category_id: '', new_category: '', law_name: '', article_number: '', issuing_authority: '', publication_date: '', effective_date: '', version: '',
  source: '', source_url: '', language: 'ar', body_text: '', tags: '', is_official_source: false, verification_status: 'unverified', last_verified_at: '', license_note: '',
  file_name: '', status: 'published' };

/** Creates a category the admin typed in the form and returns its id. */
async function createCategory(name) {
  const slug = `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return unwrap(await supabase.from('library_categories').insert({ name_ar: name, name_en: name, slug, sort_order: 100 }).select('id').single()).id;
}

/** The admin writes it all: the name, the category (pick or create), the content and the file's name. */
function ResourceForm({ initial, cats, onClose, onSaved }) {
  const { t, lang } = useI18n();
  const toast = useToast(); const onError = useErrorToast();
  const [f, setF] = useState(initial
    ? { ...blank, ...Object.fromEntries(Object.entries(initial).filter(([k]) => k in blank).map(([k, v]) => [k, v ?? blank[k]])), tags: (initial.tags || []).join(', '), category_id: initial.category_id ? String(initial.category_id) : '' }
    : blank);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const pick = (e) => {
    const x = e.target.files?.[0] || null; setFile(x);
    if (x) setF((p) => ({ ...p, file_name: x.name, title: p.title || x.name.replace(/\.[^.]+$/, '') }));
  };
  const save = async () => {
    if (!f.title.trim()) { toast(t('val.required'), 'error'); return; }
    if (f.category_id === NEW_CAT && !f.new_category.trim()) { toast(t('admin.new_category_required'), 'error'); return; }
    if (!f.body_text.trim() && !file && !initial?.file_path) { toast(t('admin.content_or_file'), 'error'); return; }
    if (file) { const v = validateFile(file, { maxMb: 50, mimes: MIME_CASE }); if (v) { toast(t(`err.${v}`, { mb: 50 }), 'error'); return; } }
    setBusy(true);
    try {
      const categoryId = f.category_id === NEW_CAT ? await createCategory(f.new_category.trim()) : (f.category_id ? Number(f.category_id) : null);
      const row = {
        title: f.title.trim(), resource_type: f.resource_type, category_id: categoryId, status: f.status,
        law_name: f.law_name || null, article_number: f.article_number || null, issuing_authority: f.issuing_authority || null,
        publication_date: f.publication_date || null, effective_date: f.effective_date || null, version: f.version || null,
        source: f.source || null, source_url: f.source_url || null, language: f.language, body_text: f.body_text || null,
        tags: f.tags.split(/[,،]/).map((x) => x.trim()).filter(Boolean), is_official_source: f.is_official_source,
        verification_status: f.verification_status, last_verified_at: f.last_verified_at || null, license_note: f.license_note || null,
        ...(initial?.file_path && !file && f.file_name.trim() ? { file_name: f.file_name.trim() } : {}),
      };
      let id = initial?.id;
      if (id) unwrap(await supabase.from('legal_resources').update(row).eq('id', id));
      else { const { data: u } = await supabase.auth.getUser(); id = unwrap(await supabase.from('legal_resources').insert({ ...row, created_by: u.user.id }).select('id').single()).id; }
      if (file) {
        const up = await uploadFile('library', id, file);
        unwrap(await supabase.from('legal_resources').update({ file_path: up.path, file_name: f.file_name.trim() || up.file_name, mime_type: up.mime_type, size_bytes: up.size_bytes }).eq('id', id));
        if (initial?.file_path) await removeFiles('library', [initial.file_path]);
      }
      toast(t('common.saved'), 'success'); onSaved();
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <Modal wide title={initial ? t('common.edit') : t('admin.new_resource')} onClose={onClose} actions={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button></>}>
      <div className="grid cols-2">
        <Field label={t('admin.item_name')}><Input value={f.title} onChange={set('title')} maxLength={300} /></Field>
        <Field label={t('lib.category')}>
          <Select value={f.category_id} onChange={set('category_id')}><option value="">—</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{lang === 'ar' ? c.name_ar : c.name_en}</option>)}
            <option value={NEW_CAT}>＋ {t('admin.new_category')}</option></Select></Field>
        {f.category_id === NEW_CAT && <Field label={t('admin.new_category_name')}><Input value={f.new_category} onChange={set('new_category')} maxLength={80} autoFocus /></Field>}
        <Field label={t('lib.type')}><Select value={f.resource_type} onChange={set('resource_type')}>{RESOURCE_TYPES.map((r) => <option key={r} value={r}>{t(`rtype.${r}`)}</option>)}</Select></Field>
        <Field label={t('common.status')}><Select value={f.status} onChange={set('status')}>{['published', 'draft', 'unpublished', 'archived'].map((s) => <option key={s} value={s}>{t(`pub.${s}`)}</option>)}</Select></Field>
      </div>
      <Field label={t('admin.content')} hint={t('lib.body_hint')}><Textarea rows={12} value={f.body_text} onChange={set('body_text')} dir={f.language === 'en' ? 'ltr' : 'rtl'} /></Field>
      <div className="grid cols-2">
        <Field label={t('lib.file')} hint={initial?.file_name ? `${t('common.current')}: ${initial.file_name}` : t('admin.file_optional')}><input type="file" onChange={pick} /></Field>
        <Field label={t('admin.file_name')} hint={t('admin.file_name_hint')}><Input value={f.file_name} onChange={set('file_name')} disabled={!file && !initial?.file_path} maxLength={200} /></Field>
      </div>
      <details className="more-fields">
        <summary>{t('admin.more_details')}</summary>
        <Alert tone="info" className="small">{t('admin.library_no_fabrication')}</Alert>
        <div className="grid cols-2">
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
      </details>
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
  const [cat, setCat] = useState('');
  const [form, setForm] = useState(null);
  const [del, setDel] = useState(null);
  const cats = useAsync(async () => unwrap(await supabase.from('library_categories').select('*').order('sort_order').order('id')), []);
  const state = useAsync(async () => {
    let query = supabase.from('legal_resources').select('*').order('updated_at', { ascending: false }).limit(200);
    if (status) query = query.eq('status', status);
    if (cat) query = query.eq('category_id', Number(cat));
    const term = safeTerm(dq);
    if (term) query = query.ilike('title', `%${term}%`);
    return unwrap(await query);
  }, [dq, status, cat]);
  const catName = (id) => { const c = (cats.data || []).find((x) => x.id === id); return c ? (lang === 'ar' ? c.name_ar : c.name_en) : ''; };
  const setStatusOf = async (r, s) => {
    try { unwrap(await supabase.from('legal_resources').update({ status: s }).eq('id', r.id)); toast(t('common.saved'), 'success'); state.reload(); } catch (e) { onError(e); }
  };
  const remove = async () => {
    try {
      if (del.file_path) await removeFiles('library', [del.file_path]);
      unwrap(await supabase.from('legal_resources').delete().eq('id', del.id));
      setDel(null); toast(t('admin.deleted'), 'success'); state.reload();
    } catch (e) { setDel(null); onError(e); }
  };
  return (
    <>
      <PageHead title={t('nav.library')} actions={tab === 'items' && <Button variant="primary" onClick={() => setForm({})}>＋ {t('admin.new_resource')}</Button>} />
      <Tabs value={tab} onChange={setTab} items={[{ value: 'items', label: t('admin.resources') }, { value: 'reports', label: t('admin.resource_reports') }]} />
      {tab === 'reports' ? <Reports /> : (
        <>
          <div className="row" style={{ margin: '16px 0' }}>
            <SearchBox value={q} onChange={setQ} placeholder={t('lib.search')} />
            <Select style={{ maxWidth: 200 }} value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t('lib.category')}>
              <option value="">{t('common.all')}</option>{(cats.data || []).map((c) => <option key={c.id} value={c.id}>{lang === 'ar' ? c.name_ar : c.name_en}</option>)}</Select>
            <Select style={{ maxWidth: 200 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('common.status')}>
              <option value="">{t('common.all_statuses')}</option>{['draft', 'published', 'unpublished', 'archived'].map((s) => <option key={s} value={s}>{t(`pub.${s}`)}</option>)}</Select>
          </div>
          <AsyncView state={state} empty={<Empty glyph="📚" title={t('lib.none')} />}>
            {(rows) => <div className="list">{rows.map((r) => (
              <div className="list-item" key={r.id}>
                <span className="grow"><strong>{r.title}</strong>
                  <div className="small muted">{[catName(r.category_id), t(`rtype.${r.resource_type}`), r.law_name, r.file_name && `📎 ${r.file_name}`].filter(Boolean).join(' · ')}</div></span>
                <StatusBadge status={r.status} prefix="pub" />
                {r.file_path && <Button size="sm" variant="ghost" aria-label={t('common.download')} onClick={() => openSigned('library', r.file_path, { download: r.file_name || true }).catch(onError)}>📎</Button>}
                <Button size="sm" onClick={() => setForm(r)}>✏️ {t('common.edit')}</Button>
                {r.status !== 'published' && <Button size="sm" variant="primary" onClick={() => setStatusOf(r, 'published')}>{t('admin.publish')}</Button>}
                {r.status === 'published' && <Button size="sm" onClick={() => setStatusOf(r, 'unpublished')}>{t('admin.unpublish')}</Button>}
                <Button size="sm" variant="danger" onClick={() => setDel(r)}>🗑 {t('common.delete')}</Button>
              </div>))}</div>}
          </AsyncView>
        </>)}
      {form && <ResourceForm initial={form.id ? form : null} cats={cats.data || []} onClose={() => setForm(null)} onSaved={() => { setForm(null); cats.reload(); state.reload(); }} />}
      {del && <ConfirmDialog danger title={t('common.delete')} message={t('admin.delete_confirm', { name: del.title })} confirmLabel={t('common.delete')} onCancel={() => setDel(null)} onConfirm={remove} />}
    </>);
}
