import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { MIME_DOCS, uploadFile, validateFile, openSigned } from '../../lib/storage.js';
import { placeholdersOf } from '../../lib/templates.js';
import { Alert, AsyncView, Button, Empty, Field, Input, Modal, PageHead, Select, StatusBadge, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';

export const TEMPLATE_CATEGORIES = ['power_of_attorney', 'legal_notice', 'contract', 'memorandum', 'pleading', 'letter', 'engagement_agreement', 'payment_acknowledgement', 'other'];

function Form({ initial, onClose, onSaved }) {
  const { t } = useI18n();
  const toast = useToast(); const onError = useErrorToast();
  const [f, setF] = useState({ title: initial?.title || '', category: initial?.category || 'other', description: initial?.description || '', body: initial?.body || '', reviewed_for_purpose: initial?.reviewed_for_purpose || '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    if (!f.title.trim()) { toast(t('val.required'), 'error'); return; }
    if (file) { const v = validateFile(file, { maxMb: 25, mimes: MIME_DOCS }); if (v) { toast(t(`err.${v}`), 'error'); return; } }
    setBusy(true);
    try {
      const fields = placeholdersOf(f.body).map((k) => (initial?.fields || []).find((x) => x.key === k) || { key: k, label_ar: k, label_en: k, type: 'text' });
      const row = { title: f.title.trim(), category: f.category, description: f.description || null, body: f.body || null, fields, reviewed_for_purpose: f.reviewed_for_purpose || null };
      let id = initial?.id;
      if (id) unwrap(await supabase.from('document_templates').update(row).eq('id', id));
      else { const { data: u } = await supabase.auth.getUser(); id = unwrap(await supabase.from('document_templates').insert({ ...row, created_by: u.user.id }).select('id').single()).id; }
      if (file) {
        const up = await uploadFile('templates', id, file);
        unwrap(await supabase.from('document_templates').update({ file_path: up.path, file_name: up.file_name, mime_type: up.mime_type, size_bytes: up.size_bytes }).eq('id', id));
      }
      toast(t('common.saved'), 'success'); onSaved();
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <Modal wide title={initial ? t('common.edit') : t('admin.new_template')} onClose={onClose} actions={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button></>}>
      <Alert tone="info" className="small">{t('admin.template_no_fabrication')}</Alert>
      <Field label={t('lib.title')}><Input value={f.title} onChange={set('title')} /></Field>
      <Field label={t('tpl.category')}><Select value={f.category} onChange={set('category')}>{TEMPLATE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`tplcat.${c}`)}</option>)}</Select></Field>
      <Field label={t('common.description')}><Input value={f.description} onChange={set('description')} /></Field>
      <Field label={t('tpl.body')} hint={t('tpl.body_hint')}><Textarea rows={10} value={f.body} onChange={set('body')} /></Field>
      <Field label={t('tpl.reviewed_for')} hint={t('tpl.reviewed_for_hint')}><Input value={f.reviewed_for_purpose} onChange={set('reviewed_for_purpose')} /></Field>
      <Field label={t('lib.file')} hint={initial?.file_name || ''}><input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>
    </Modal>);
}

export default function TemplatesAdmin() {
  const { t } = useI18n();
  const toast = useToast(); const onError = useErrorToast();
  const [form, setForm] = useState(null);
  const state = useAsync(async () => unwrap(await supabase.from('document_templates').select('*').order('updated_at', { ascending: false })), []);
  const setStatus = async (r, s) => { try { unwrap(await supabase.from('document_templates').update({ status: s }).eq('id', r.id)); toast(t('common.saved'), 'success'); state.reload(); } catch (e) { onError(e); } };
  return (
    <>
      <PageHead title={t('nav.templates')} actions={<Button variant="primary" onClick={() => setForm({})}>＋ {t('admin.new_template')}</Button>} />
      <AsyncView state={state} empty={<Empty glyph="📄" title={t('tpl.none')} />}>
        {(rows) => <div className="list">{rows.map((r) => (
          <div className="list-item" key={r.id}>
            <span className="grow"><strong>{r.title}</strong><div className="small muted">{t(`tplcat.${r.category}`)}</div></span>
            <StatusBadge status={r.status} prefix="pub" />
            {r.file_path && <Button size="sm" variant="ghost" onClick={() => openSigned('templates', r.file_path).catch(onError)}>📎</Button>}
            <Button size="sm" onClick={() => setForm(r)}>{t('common.edit')}</Button>
            {r.status !== 'published' && r.status !== 'archived' && <Button size="sm" variant="primary" onClick={() => setStatus(r, 'published')}>{t('admin.publish')}</Button>}
            {r.status === 'published' && <Button size="sm" onClick={() => setStatus(r, 'unpublished')}>{t('admin.unpublish')}</Button>}
            {r.status !== 'archived' && <Button size="sm" variant="ghost" onClick={() => setStatus(r, 'archived')}>{t('admin.archive')}</Button>}
          </div>))}</div>}
      </AsyncView>
      {form && <Form initial={form.id ? form : null} onClose={() => setForm(null)} onSaved={() => { setForm(null); state.reload(); }} />}
    </>);
}
