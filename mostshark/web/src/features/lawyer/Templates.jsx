import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { fieldsFor, fillTemplate, missingFields } from '../../lib/templates.js';
import { openSigned } from '../../lib/storage.js';
import { usePublicSettings } from '../../lib/settings.js';
import { Alert, AsyncView, Button, Card, Disclaimer, Empty, Field, Input, Modal, PageHead, Select, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';

export const TEMPLATE_CATEGORIES = ['power_of_attorney', 'legal_notice', 'contract', 'memorandum', 'pleading', 'letter', 'engagement_agreement', 'payment_acknowledgement', 'other'];

function FillModal({ tpl, onClose }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const fields = fieldsFor(tpl);
  const [values, setValues] = useState({});
  const out = fillTemplate(tpl.body || '', values);
  const missing = missingFields(tpl.body || '', values);
  const copy = async () => { try { await navigator.clipboard.writeText(out); toast(t('tpl.copied'), 'success'); } catch { toast(t('err.unknown'), 'error'); } };
  const download = () => {
    const blob = new Blob(['﻿' + out], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${tpl.title}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <Modal wide title={tpl.title} onClose={onClose} actions={<><Button onClick={onClose}>{t('common.close')}</Button><Button onClick={copy}>{t('tpl.copy')}</Button><Button variant="primary" onClick={download}>⬇ {t('common.download')}</Button></>}>
      <Alert tone="warn" className="small">{tpl.reviewed_for_purpose ? `${t('tpl.reviewed_for')}: ${tpl.reviewed_for_purpose}` : t('tpl.general_reference')}</Alert>
      <div className="grid cols-2" style={{ marginTop: 12, alignItems: 'start' }}>
        <div className="stack">{fields.map((fd) => (
          <Field key={fd.key} label={lang === 'ar' ? fd.label_ar : fd.label_en}>
            {fd.type === 'textarea' ? <Textarea value={values[fd.key] || ''} onChange={(e) => setValues({ ...values, [fd.key]: e.target.value })} />
              : <Input type={fd.type === 'date' ? 'date' : 'text'} className={fd.type === 'date' ? 'input ltr' : 'input'} value={values[fd.key] || ''} onChange={(e) => setValues({ ...values, [fd.key]: e.target.value })} />}
          </Field>))}
          {fields.length === 0 && <p className="muted small">{t('tpl.no_fields')}</p>}</div>
        <div>
          {missing.length > 0 && <Alert tone="info" className="small">{t('tpl.missing', { n: missing.length })}</Alert>}
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: 'var(--surface-2)', padding: 12, borderRadius: 8, maxHeight: 420, overflow: 'auto', lineHeight: 1.9 }}>{out}</pre>
        </div>
      </div>
    </Modal>);
}

export default function Templates() {
  const { t } = useI18n();
  const onError = useErrorToast();
  const { disclaimer } = usePublicSettings();
  const [cat, setCat] = useState('');
  const [fill, setFill] = useState(null);
  const state = useAsync(async () => {
    let q = supabase.from('document_templates').select('*').eq('status', 'published').order('title');
    if (cat) q = q.eq('category', cat);
    return unwrap(await q);
  }, [cat]);
  return (
    <>
      <PageHead title={t('nav.templates')} subtitle={t('tpl.subtitle')} />
      <Disclaimer text={disclaimer('templates')} />
      <div className="row" style={{ margin: '16px 0' }}>
        <Select style={{ maxWidth: 260 }} value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t('tpl.category')}><option value="">{t('common.all')}</option>
          {TEMPLATE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`tplcat.${c}`)}</option>)}</Select>
      </div>
      <AsyncView state={state} empty={<Empty glyph="📄" title={t('tpl.empty')}>{t('tpl.empty_hint')}</Empty>}>
        {(rows) => (
          <div className="grid cols-3">{rows.map((r) => (
            <Card key={r.id} title={r.title}>
              <p className="small muted">{t(`tplcat.${r.category}`)}</p><p className="small">{r.description}</p>
              <p className="small"><span className={`badge ${r.reviewed_for_purpose ? 'success' : 'warn'}`}>{r.reviewed_for_purpose ? t('tpl.reviewed') : t('tpl.reference_only')}</span></p>
              <div className="row">{r.body && <Button size="sm" variant="primary" onClick={() => setFill(r)}>{t('tpl.fill')}</Button>}
                {r.file_path && <Button size="sm" onClick={() => openSigned('templates', r.file_path, { download: true }).catch(onError)}>⬇ {t('common.download')}</Button>}</div>
            </Card>))}</div>)}
      </AsyncView>
      {fill && <FillModal tpl={fill} onClose={() => setFill(null)} />}
    </>);
}
