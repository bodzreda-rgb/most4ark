import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap, useDebounced, safeTerm } from '../../lib/hooks.js';
import { MIME_DOCS, uploadFile, validateFile, openSigned, removeFiles } from '../../lib/storage.js';
import { placeholdersOf } from '../../lib/templates.js';
import { TEMPLATE_CATEGORIES, tplCatLabel } from '../lawyer/Templates.jsx';
import { Alert, AsyncView, Button, ConfirmDialog, Empty, Field, Input, Modal, PageHead, SearchBox, Select, StatusBadge, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';

/** The admin writes everything: name, category (pick or type a new one), content and the file's name. */
function Form({ initial, knownCats, onClose, onSaved }) {
  const { t } = useI18n();
  const toast = useToast(); const onError = useErrorToast();
  const [f, setF] = useState({
    title: initial?.title || '', category: initial ? tplCatLabel(t, initial.category) : '', description: initial?.description || '',
    body: initial?.body || '', reviewed_for_purpose: initial?.reviewed_for_purpose || '', file_name: initial?.file_name || '',
    status: initial?.status || 'published',
  });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const pick = (e) => {
    const x = e.target.files?.[0] || null; setFile(x);
    if (x) setF((p) => ({ ...p, file_name: x.name, title: p.title || x.name.replace(/\.[^.]+$/, '') }));
  };
  // a typed label that matches a built-in category is stored as its key
  const categoryKey = (label) => TEMPLATE_CATEGORIES.find((c) => c === label || t(`tplcat.${c}`) === label) || label;
  const save = async () => {
    if (!f.title.trim() || !f.category.trim()) { toast(t('val.required'), 'error'); return; }
    if (!f.body.trim() && !file && !initial?.file_path) { toast(t('admin.content_or_file'), 'error'); return; }
    if (file) { const v = validateFile(file, { maxMb: 25, mimes: MIME_DOCS }); if (v) { toast(t(`err.${v}`, { mb: 25 }), 'error'); return; } }
    setBusy(true);
    try {
      const fields = placeholdersOf(f.body).map((k) => (initial?.fields || []).find((x) => x.key === k) || { key: k, label_ar: k, label_en: k, type: 'text' });
      const row = {
        title: f.title.trim(), category: categoryKey(f.category.trim()), description: f.description.trim() || null, body: f.body || null, fields,
        reviewed_for_purpose: f.reviewed_for_purpose.trim() || null, status: f.status,
        ...(initial?.file_path && !file && f.file_name.trim() ? { file_name: f.file_name.trim() } : {}),
      };
      let id = initial?.id;
      if (id) unwrap(await supabase.from('document_templates').update(row).eq('id', id));
      else { const { data: u } = await supabase.auth.getUser(); id = unwrap(await supabase.from('document_templates').insert({ ...row, created_by: u.user.id }).select('id').single()).id; }
      if (file) {
        const up = await uploadFile('templates', id, file);
        unwrap(await supabase.from('document_templates').update({ file_path: up.path, file_name: f.file_name.trim() || up.file_name, mime_type: up.mime_type, size_bytes: up.size_bytes }).eq('id', id));
        if (initial?.file_path) await removeFiles('templates', [initial.file_path]);
      }
      toast(t('common.saved'), 'success'); onSaved();
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <Modal wide title={initial ? t('common.edit') : t('admin.new_template')} onClose={onClose} actions={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button></>}>
      <Alert tone="info" className="small">{t('admin.template_no_fabrication')}</Alert>
      <div className="grid cols-2">
        <Field label={t('admin.item_name')}><Input value={f.title} onChange={set('title')} maxLength={200} /></Field>
        <Field label={t('tpl.category')} hint={t('admin.category_type_hint')}>
          <Input value={f.category} onChange={set('category')} list="tpl-cats" maxLength={80} /></Field>
      </div>
      <datalist id="tpl-cats">{[...new Set([...TEMPLATE_CATEGORIES, ...knownCats])].map((c) => <option key={c} value={tplCatLabel(t, c)} />)}</datalist>
      <Field label={t('common.description')}><Input value={f.description} onChange={set('description')} /></Field>
      <Field label={t('admin.content')} hint={t('tpl.body_hint')}><Textarea rows={12} value={f.body} onChange={set('body')} /></Field>
      <div className="grid cols-2">
        <Field label={t('lib.file')} hint={initial?.file_name ? `${t('common.current')}: ${initial.file_name}` : t('admin.file_optional')}><input type="file" accept={MIME_DOCS.join(',')} onChange={pick} /></Field>
        <Field label={t('admin.file_name')} hint={t('admin.file_name_hint')}><Input value={f.file_name} onChange={set('file_name')} disabled={!file && !initial?.file_path} maxLength={200} /></Field>
        <Field label={t('tpl.reviewed_for')} hint={t('tpl.reviewed_for_hint')}><Input value={f.reviewed_for_purpose} onChange={set('reviewed_for_purpose')} /></Field>
        <Field label={t('common.status')}><Select value={f.status} onChange={set('status')}>{['published', 'draft', 'unpublished', 'archived'].map((s) => <option key={s} value={s}>{t(`pub.${s}`)}</option>)}</Select></Field>
      </div>
    </Modal>);
}

export default function TemplatesAdmin() {
  const { t } = useI18n();
  const toast = useToast(); const onError = useErrorToast();
  const [form, setForm] = useState(null);
  const [del, setDel] = useState(null);
  const [q, setQ] = useState(''); const dq = useDebounced(q);
  const state = useAsync(async () => {
    let query = supabase.from('document_templates').select('*').order('updated_at', { ascending: false });
    const term = safeTerm(dq);
    if (term) query = query.ilike('title', `%${term}%`);
    return unwrap(await query);
  }, [dq]);
  const knownCats = [...new Set((state.data || []).map((r) => r.category))];
  const setStatus = async (r, s) => { try { unwrap(await supabase.from('document_templates').update({ status: s }).eq('id', r.id)); toast(t('common.saved'), 'success'); state.reload(); } catch (e) { onError(e); } };
  const remove = async () => {
    try {
      if (del.file_path) await removeFiles('templates', [del.file_path]);
      unwrap(await supabase.from('document_templates').delete().eq('id', del.id));
      setDel(null); toast(t('admin.deleted'), 'success'); state.reload();
    } catch (e) { setDel(null); onError(e); }
  };
  return (
    <>
      <PageHead title={t('nav.templates')} actions={<Button variant="primary" onClick={() => setForm({})}>＋ {t('admin.new_template')}</Button>} />
      <div className="row" style={{ margin: '16px 0' }}><SearchBox value={q} onChange={setQ} placeholder={t('common.search')} /></div>
      <AsyncView state={state} empty={<Empty glyph="📄" title={t('tpl.none')} />}>
        {(rows) => <div className="list">{rows.map((r) => (
          <div className="list-item" key={r.id}>
            <span className="grow"><strong>{r.title}</strong><div className="small muted">{tplCatLabel(t, r.category)}{r.file_name ? ` · 📎 ${r.file_name}` : ''}</div></span>
            <StatusBadge status={r.status} prefix="pub" />
            {r.file_path && <Button size="sm" variant="ghost" aria-label={t('common.download')} onClick={() => openSigned('templates', r.file_path, { download: r.file_name || true }).catch(onError)}>📎</Button>}
            <Button size="sm" onClick={() => setForm(r)}>✏️ {t('common.edit')}</Button>
            {r.status !== 'published' && <Button size="sm" variant="primary" onClick={() => setStatus(r, 'published')}>{t('admin.publish')}</Button>}
            {r.status === 'published' && <Button size="sm" onClick={() => setStatus(r, 'unpublished')}>{t('admin.unpublish')}</Button>}
            <Button size="sm" variant="danger" onClick={() => setDel(r)}>🗑 {t('common.delete')}</Button>
          </div>))}</div>}
      </AsyncView>
      {form && <Form initial={form.id ? form : null} knownCats={knownCats} onClose={() => setForm(null)} onSaved={() => { setForm(null); state.reload(); }} />}
      {del && <ConfirmDialog danger title={t('common.delete')} message={t('admin.delete_confirm', { name: del.title })} confirmLabel={t('common.delete')} onCancel={() => setDel(null)} onConfirm={remove} />}
    </>);
}
