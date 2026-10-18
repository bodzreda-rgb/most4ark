import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { invalidateSettings } from '../../lib/settings.js';
import { Alert, AsyncView, Button, Card, Checkbox, ConfirmDialog, Field, Input, PageHead, Select, Tabs, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';

const slugify = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function Taxonomy({ table }) {
  const { t } = useI18n();
  const toast = useToast(); const onError = useErrorToast();
  const state = useAsync(async () => unwrap(await supabase.from(table).select('*').order('sort_order').order('id')), [table]);
  const [nw, setNw] = useState({ name_ar: '', name_en: '', slug: '' });
  const add = async () => {
    const slug = nw.slug || slugify(nw.name_en);
    if (!nw.name_ar.trim() || !nw.name_en.trim() || !slug) { toast(t('val.required'), 'error'); return; }
    try { unwrap(await supabase.from(table).insert({ name_ar: nw.name_ar.trim(), name_en: nw.name_en.trim(), slug, sort_order: (state.data?.length || 0) + 1 })); setNw({ name_ar: '', name_en: '', slug: '' }); toast(t('common.saved'), 'success'); state.reload(); }
    catch (e) { onError(e); }
  };
  const patch = async (row, p) => { try { unwrap(await supabase.from(table).update(p).eq('id', row.id)); state.reload(); } catch (e) { onError(e); } };
  return (
    <div className="stack">
      <AsyncView state={state}>
        {(rows) => <div className="list">{rows.map((r) => (
          <div className="list-item" key={r.id}>
            <Input defaultValue={r.name_ar} aria-label={t('settings.name_ar')} onBlur={(e) => e.target.value.trim() && e.target.value !== r.name_ar && patch(r, { name_ar: e.target.value.trim() })} />
            <Input className="input ltr" dir="ltr" defaultValue={r.name_en} aria-label={t('settings.name_en')} onBlur={(e) => e.target.value.trim() && e.target.value !== r.name_en && patch(r, { name_en: e.target.value.trim() })} />
            <Checkbox label={t('settings.active')} checked={r.is_active} onChange={(e) => patch(r, { is_active: e.target.checked })} />
          </div>))}</div>}
      </AsyncView>
      <div className="row">
        <Input placeholder={t('settings.name_ar')} value={nw.name_ar} onChange={(e) => setNw({ ...nw, name_ar: e.target.value })} />
        <Input className="input ltr" dir="ltr" placeholder={t('settings.name_en')} value={nw.name_en} onChange={(e) => setNw({ ...nw, name_en: e.target.value })} />
        <Button variant="primary" onClick={add}>＋ {t('common.add')}</Button>
      </div>
    </div>);
}

function PlatformSettings() {
  const { t } = useI18n();
  const toast = useToast(); const onError = useErrorToast();
  const state = useAsync(async () => unwrap(await supabase.from('platform_settings').select('*').order('key')), []);
  const [drafts, setDrafts] = useState({});
  const save = async (row) => {
    let value;
    try { value = JSON.parse(drafts[row.key]); } catch { toast(t('settings.invalid_json'), 'error'); return; }
    try { unwrap(await supabase.from('platform_settings').update({ value }).eq('key', row.key)); invalidateSettings(); setDrafts((d) => { const n = { ...d }; delete n[row.key]; return n; }); toast(t('common.saved'), 'success'); state.reload(); }
    catch (e) { onError(e); }
  };
  return (
    <AsyncView state={state}>
      {(rows) => <div className="stack">{rows.map((r) => {
        const cur = drafts[r.key] ?? JSON.stringify(r.value);
        const long = cur.length > 70;
        return (
          <Field key={r.key} label={<span className="ltr">{r.key}</span>} hint={r.is_public ? t('settings.public') : t('settings.private')}>
            <div className="row">
              {long ? <Textarea rows={3} value={cur} onChange={(e) => setDrafts({ ...drafts, [r.key]: e.target.value })} />
                : <Input className="input ltr" dir="ltr" value={cur} onChange={(e) => setDrafts({ ...drafts, [r.key]: e.target.value })} />}
              <Button size="sm" disabled={drafts[r.key] === undefined} onClick={() => save(r)}>{t('common.save')}</Button>
            </div>
          </Field>);
      })}</div>}
    </AsyncView>);
}

function Announcements() {
  const { t } = useI18n();
  const toast = useToast(); const onError = useErrorToast();
  const [f, setF] = useState({ title: '', body: '', audience: 'all' });
  const [confirm, setConfirm] = useState(false);
  const send = async () => {
    try { const n = unwrap(await supabase.rpc('send_announcement', { p_title: f.title.trim(), p_body: f.body.trim(), p_audience: f.audience })); setConfirm(false); setF({ title: '', body: '', audience: 'all' }); toast(t('settings.announcement_sent', { n }), 'success'); }
    catch (e) { setConfirm(false); onError(e); }
  };
  return (
    <div className="stack">
      <Alert tone="info" className="small">{t('settings.announcement_note')}</Alert>
      <Field label={t('settings.audience')}><Select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}>
        {['all', 'lawyers', 'clients'].map((a) => <option key={a} value={a}>{t(`settings.aud.${a}`)}</option>)}</Select></Field>
      <Field label={t('lib.title')}><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={120} /></Field>
      <Field label={t('settings.message')}><Textarea rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} maxLength={1000} /></Field>
      <div><Button variant="primary" disabled={!f.title.trim()} onClick={() => setConfirm(true)}>{t('settings.send')}</Button></div>
      {confirm && <ConfirmDialog title={t('settings.send')} message={t('settings.send_confirm')} onCancel={() => setConfirm(false)} onConfirm={send} />}
    </div>);
}

export default function Settings() {
  const { t } = useI18n();
  const [tab, setTab] = useState('spec');
  return (
    <>
      <PageHead title={t("nav.settings")} />
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'spec', label: t('settings.specializations') }, { value: 'cons', label: t('settings.consultation_categories') },
        { value: 'lib', label: t('settings.library_categories') }, { value: 'platform', label: t('settings.platform') }, { value: 'ann', label: t('settings.announcements') }]} />
      <Card className="mt">
        {tab === 'spec' && <Taxonomy table="specializations" />}
        {tab === 'cons' && <Taxonomy table="consultation_categories" />}
        {tab === 'lib' && <Taxonomy table="library_categories" />}
        {tab === 'platform' && <PlatformSettings />}
        {tab === 'ann' && <Announcements />}
      </Card>
    </>);
}
