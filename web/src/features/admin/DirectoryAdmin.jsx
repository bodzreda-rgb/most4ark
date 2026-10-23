import { useRef, useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { invalidateSettings, usePublicSettings } from '../../lib/settings.js';
import { MIME_AVATAR, avatarPathOf, removeFiles, uploadPublicImage, validateFile } from '../../lib/storage.js';
import { Avatar } from '../../components/Layout.jsx';
import { AsyncView, Button, Checkbox, Empty, Field, Input, Modal, PageHead, SearchBox, StatusBadge, Tabs, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';
import Directory from '../client/Directory.jsx';

const listing = (args) => supabase.rpc('admin_update_lawyer_listing', args);

/** Admin edits what clients see for one lawyer: photo, brief, bio, availability, visibility. */
function ListingEditor({ l, onClose, onSaved }) {
  const { t } = useI18n();
  const toast = useToast(); const onError = useErrorToast();
  const input = useRef(null);
  const [f, setF] = useState({ headline: l.headline || '', bio: l.bio || '', accepts: l.accepts_consultations, show: l.show_in_directory, featured: l.featured });
  const [photo, setPhoto] = useState(l.avatar_url || '');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const pick = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    const bad = validateFile(file, { maxMb: 2, mimes: MIME_AVATAR });
    if (bad) { toast(t(`err.${bad}`, { mb: 2 }), 'error'); return; }
    setBusy(true);
    try { setPhoto(await uploadPublicImage(l.user_id, file)); } catch (err) { onError(err); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      unwrap(await listing({ p_lawyer: l.user_id, p_show: f.show, p_featured: f.featured, p_accepts: f.accepts,
        p_headline: f.headline, p_bio: f.bio, p_avatar_url: photo === (l.avatar_url || '') ? null : photo }));
      if (l.avatar_url && photo !== l.avatar_url) await removeFiles('avatars', [avatarPathOf(l.avatar_url)]);
      toast(t('common.saved'), 'success'); onSaved();
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <Modal wide title={`${t('dir.admin.edit_listing')} — ${l.full_legal_name || l.public_alias}`} onClose={onClose}
      actions={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button></>}>
      <div className="photo-editor">
        <button type="button" className="avatar-wrap big" onClick={() => input.current?.click()} aria-label={t('profile.change_photo')} disabled={busy}>
          <Avatar name={l.public_alias} src={photo} size={96} /><span className="avatar-pen" aria-hidden="true">📷</span>
        </button>
        <div className="row">
          <Button size="sm" variant="primary" loading={busy} onClick={() => input.current?.click()}>{photo ? t('profile.change_photo') : t('profile.add_photo')}</Button>
          {photo && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPhoto('')}>{t('common.remove')}</Button>}
        </div>
        <input ref={input} type="file" accept={MIME_AVATAR.join(',')} hidden onChange={pick} />
      </div>
      <Field label={t('profile.headline')} hint={t('dir.admin.headline_hint')}><Input value={f.headline} onChange={set('headline')} maxLength={160} /></Field>
      <Field label={t('lawyer.bio')}><Textarea rows={6} value={f.bio} onChange={set('bio')} maxLength={2000} /></Field>
      <div className="row">
        <Checkbox label={t('dir.admin.visible')} checked={f.show} onChange={set('show')} />
        <Checkbox label={t('dir.admin.featured')} checked={f.featured} onChange={set('featured')} />
        <Checkbox label={t('dir.accepts')} checked={f.accepts} onChange={set('accepts')} />
      </div>
    </Modal>);
}

function Manage() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const onError = useErrorToast(); const toast = useToast();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);
  const canEdit = can('lawyers.manage');
  const specs = useAsync(async () => unwrap(await supabase.from('specializations').select('id,name_ar,name_en')), []);
  const state = useAsync(async () => unwrap(await supabase.rpc('admin_directory_list')), []);
  const specName = (id) => { const s = (specs.data || []).find((x) => x.id === id); return s ? (lang === 'ar' ? s.name_ar : s.name_en) : ''; };
  const toggle = async (l, args) => {
    try { unwrap(await listing({ p_lawyer: l.user_id, ...args })); toast(t('common.saved'), 'success'); state.reload(); } catch (e) { onError(e); }
  };
  const term = q.trim().toLowerCase();
  const filtered = (rows) => (term ? rows.filter((l) => [l.public_alias, l.full_legal_name, l.city, l.headline].some((x) => (x || '').toLowerCase().includes(term))) : rows);
  return (
    <>
      <div className="row" style={{ margin: '16px 0' }}><SearchBox value={q} onChange={setQ} placeholder={t('common.search')} /></div>
      <AsyncView state={state} empty={<Empty glyph="🧭" title={t('dir.admin.none')}>{t('dir.admin.none_hint')}</Empty>}>
        {(rows) => (
          <div className="list">{filtered(rows).map((l) => (
            <div className={`list-item dir-admin-row ${l.show_in_directory ? '' : 'is-hidden'}`} key={l.user_id}>
              <Avatar name={l.public_alias} src={l.avatar_url} size={52} />
              <span className="grow">
                <strong>{l.full_legal_name || l.public_alias}</strong> <span className="muted small ltr">{l.public_alias}</span>
                {l.headline && <div className="small lawyer-headline">{l.headline}</div>}
                <div className="small muted">{[l.city, l.years_experience != null && `${l.years_experience} ${t('dir.years')}`, ...(l.specialization_ids || []).map(specName)].filter(Boolean).join(' · ')}</div>
                <div className="row" style={{ marginTop: 4 }}>
                  <span className={`badge ${l.show_in_directory ? 'success' : 'neutral'}`}>{l.show_in_directory ? `👁 ${t('dir.admin.shown')}` : `🚫 ${t('dir.admin.hidden')}`}</span>
                  {l.featured && <span className="badge warn">⭐ {t('dir.admin.featured')}</span>}
                  {l.verification_status !== 'approved' && <StatusBadge status={l.verification_status} prefix="vstatus" />}
                  {!l.avatar_url && <span className="badge neutral">{t('dir.admin.no_photo')}</span>}
                </div>
              </span>
              {canEdit && <>
                <Button size="sm" onClick={() => toggle(l, { p_show: !l.show_in_directory })}>{l.show_in_directory ? `🚫 ${t('dir.admin.hide')}` : `👁 ${t('dir.admin.show')}`}</Button>
                <Button size="sm" variant="ghost" onClick={() => toggle(l, { p_featured: !l.featured })} aria-label={t('dir.admin.featured')}>{l.featured ? '★' : '☆'}</Button>
                <Button size="sm" variant="primary" onClick={() => setEdit(l)}>✏️ {t('common.edit')}</Button>
              </>}
            </div>))}</div>)}
      </AsyncView>
      {edit && <ListingEditor l={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); state.reload(); }} />}
    </>);
}

/** Directory on/off for everyone (platform setting `directory_enabled`). */
function DirectorySwitch() {
  const { t } = useI18n();
  const { can } = useAuth();
  const { settings, reload } = usePublicSettings();
  const onError = useErrorToast(); const toast = useToast();
  if (!can('settings.manage')) return null;
  const on = settings.directory_enabled !== false;
  const flip = async () => {
    try { unwrap(await supabase.from('platform_settings').update({ value: !on }).eq('key', 'directory_enabled')); invalidateSettings(); reload(); toast(t('common.saved'), 'success'); }
    catch (e) { onError(e); }
  };
  return <Button variant={on ? 'secondary' : 'primary'} onClick={flip}>{on ? `⏸ ${t('dir.admin.turn_off')}` : `▶ ${t('dir.admin.turn_on')}`}</Button>;
}

export default function DirectoryAdmin() {
  const { t } = useI18n();
  const { settings } = usePublicSettings();
  const [tab, setTab] = useState('manage');
  return (
    <>
      <PageHead title={t('nav.directory')} subtitle={t('dir.admin.subtitle')} actions={<DirectorySwitch />} />
      {settings.directory_enabled === false && <div className="alert warn small">⏸ {t('dir.admin.is_off')}</div>}
      <Tabs value={tab} onChange={setTab} items={[{ value: 'manage', label: t('dir.admin.manage') }, { value: 'preview', label: t('dir.admin.preview') }]} />
      {tab === 'manage' ? <Manage /> : <Directory embedded />}
    </>);
}
