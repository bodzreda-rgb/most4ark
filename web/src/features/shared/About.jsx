import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { unwrap } from '../../lib/hooks.js';
import { invalidateSettings, usePublicSettings } from '../../lib/settings.js';
import { MIME_AVATAR, avatarPathOf, removeFiles, uploadPublicImage, validateFile } from '../../lib/storage.js';
import { Logo, BrandName } from '../../components/Layout.jsx';
import { Button, Field, Input, Modal, PageHead, Spinner, Tabs, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';

const lines = (s) => (s || '').split('\n').map((x) => x.trim()).filter(Boolean);

function ImageField({ label, value, onChange }) {
  const { t } = useI18n();
  const toast = useToast(); const onError = useErrorToast();
  const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    const bad = validateFile(file, { maxMb: 2, mimes: MIME_AVATAR });
    if (bad) { toast(t(`err.${bad}`, { mb: 2 }), 'error'); return; }
    setBusy(true);
    try { onChange(await uploadPublicImage('site', file)); } catch (err) { onError(err); } finally { setBusy(false); }
  };
  return (
    <Field label={label}>
      <div className="row">
        {value ? <img src={value} alt="" className="about-thumb" /> : <span className="about-thumb empty" aria-hidden="true">🖼️</span>}
        <label className={`btn btn-sm btn-secondary ${busy ? 'disabled' : ''}`}>{busy ? '…' : t('profile.change_photo')}<input type="file" hidden accept={MIME_AVATAR.join(',')} onChange={pick} /></label>
        {value && <Button size="sm" variant="ghost" onClick={() => onChange('')}>{t('common.remove')}</Button>}
      </div>
    </Field>);
}

function AboutEditor({ initial, onClose, onSaved }) {
  const { t } = useI18n();
  const toast = useToast(); const onError = useErrorToast();
  const [f, setF] = useState(initial);
  const [tab, setTab] = useState('ar');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const L = (k) => `${k}_${tab}`;
  const save = async () => {
    setBusy(true);
    try {
      unwrap(await supabase.from('platform_settings').update({ value: f }).eq('key', 'about_page'));
      // photos that were replaced or removed are no longer referenced
      await removeFiles('avatars', ['admin_photo_url', 'logo_url'].filter((k) => initial[k] && initial[k] !== f[k]).map((k) => avatarPathOf(initial[k])));
      invalidateSettings(); toast(t('common.saved'), 'success'); onSaved();
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  const dir = tab === 'ar' ? 'rtl' : 'ltr';
  return (
    <Modal wide title={t('about.edit')} onClose={onClose} actions={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button></>}>
      <Tabs value={tab} onChange={setTab} items={[{ value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }]} />
      <h3 className="about-edit-h">{t('about.office')}</h3>
      <div className="grid cols-2">
        <Field label={t('about.office_name')}><Input dir={dir} value={f[L('office_name')] || ''} onChange={set(L('office_name'))} /></Field>
        <Field label={t('about.tagline')}><Input dir={dir} value={f[L('tagline')] || ''} onChange={set(L('tagline'))} /></Field>
      </div>
      <Field label={t('about.body')}><Textarea dir={dir} rows={6} value={f[L('body')] || ''} onChange={set(L('body'))} /></Field>
      <Field label={t('about.services')} hint={t('about.services_hint')}><Textarea dir={dir} rows={5} value={f[L('services')] || ''} onChange={set(L('services'))} /></Field>
      <ImageField label={t('about.logo')} value={f.logo_url} onChange={(v) => setF({ ...f, logo_url: v })} />

      <h3 className="about-edit-h">{t('about.admin')}</h3>
      <div className="grid cols-2">
        <Field label={t('about.admin_name')}><Input value={f.admin_name || ''} onChange={set('admin_name')} /></Field>
        <Field label={t('about.admin_title')}><Input dir={dir} value={f[L('admin_title')] || ''} onChange={set(L('admin_title'))} /></Field>
      </div>
      <Field label={t('about.admin_bio')}><Textarea dir={dir} rows={5} value={f[L('admin_bio')] || ''} onChange={set(L('admin_bio'))} /></Field>
      <ImageField label={t('about.admin_photo')} value={f.admin_photo_url} onChange={(v) => setF({ ...f, admin_photo_url: v })} />

      <h3 className="about-edit-h">{t('about.contact')}</h3>
      <div className="grid cols-2">
        <Field label={t('auth.phone')}><Input className="input ltr" dir="ltr" value={f.phone || ''} onChange={set('phone')} /></Field>
        <Field label={t('auth.email')}><Input className="input ltr" dir="ltr" type="email" value={f.email || ''} onChange={set('email')} /></Field>
        <Field label={t('about.address')}><Input dir={dir} value={f[L('address')] || ''} onChange={set(L('address'))} /></Field>
        <Field label={t('about.hours')}><Input dir={dir} value={f[L('hours')] || ''} onChange={set(L('hours'))} /></Field>
      </div>
    </Modal>);
}

/** About the office (مكتب الحلواني للمحاماة) and its admin. Public; admins with settings.manage edit it here. */
export default function About({ standalone = false }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const { settings, loading, reload } = usePublicSettings();
  const [edit, setEdit] = useState(false);
  if (loading && !settings.about_page) return <Spinner />;
  const a = settings.about_page || {};
  const L = (k) => a[`${k}_${lang}`] || a[`${k}_ar`] || a[`${k}_en`] || '';
  const services = lines(L('services'));
  const editable = !standalone && can('settings.manage');

  const page = (
    <>
      <PageHead title={t('nav.about')} subtitle={L('office_name')} actions={editable && <Button variant="primary" onClick={() => setEdit(true)}>✏️ {t('about.edit')}</Button>} />
      <section className="about-hero card">
        {a.logo_url ? <img src={a.logo_url} alt="" className="about-logo" /> : <span className="about-logo"><Logo /></span>}
        <div>
          <h2>{L('office_name')}</h2>
          {L('tagline') && <p className="about-tagline">{L('tagline')}</p>}
        </div>
      </section>

      <div className="about-grid">
        <section className="card">
          <h3>🏛️ {t('about.who_we_are')}</h3>
          {lines(L('body')).map((p, i) => <p key={i} className="about-p">{p}</p>)}
          {services.length > 0 && (<>
            <h3>⚖️ {t('about.our_services')}</h3>
            <ul className="about-services">{services.map((s) => <li key={s}>{s}</li>)}</ul></>)}
        </section>

        <aside className="stack">
          {(a.admin_name || L('admin_bio') || a.admin_photo_url) && (
            <section className="card about-admin">
              {a.admin_photo_url ? <img src={a.admin_photo_url} alt={a.admin_name || ''} className="about-admin-photo" /> : <span className="about-admin-photo empty" aria-hidden="true">👤</span>}
              <h3>{a.admin_name}</h3>
              {L('admin_title') && <p className="about-tagline">{L('admin_title')}</p>}
              {lines(L('admin_bio')).map((p, i) => <p key={i} className="small">{p}</p>)}
            </section>)}
          <section className="card">
            <h3>📞 {t('about.contact')}</h3>
            <ul className="about-contact">
              {a.phone && <li>📱 <a className="ltr" href={`tel:${a.phone.replace(/\s/g, '')}`}>{a.phone}</a></li>}
              {a.email && <li>✉️ <a className="ltr" href={`mailto:${a.email}`}>{a.email}</a></li>}
              {L('address') && <li>📍 {L('address')}</li>}
              {L('hours') && <li>🕘 {L('hours')}</li>}
              {!a.phone && !a.email && !L('address') && <li className="muted small">{t('about.no_contact')}</li>}
            </ul>
          </section>
        </aside>
      </div>
      {edit && <AboutEditor initial={a} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); }} />}
    </>);

  if (!standalone) return page;
  return (
    <div className="about-standalone">
      <header className="row between about-standalone-bar">
        <span className="brand"><Logo /><BrandName /></span>
        <Link className="btn btn-primary btn-sm" to="/login">{t('auth.login')}</Link>
      </header>
      <main className="content">{page}</main>
    </div>);
}
