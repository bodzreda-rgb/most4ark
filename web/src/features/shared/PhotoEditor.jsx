import { useRef, useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { unwrap } from '../../lib/hooks.js';
import { MIME_AVATAR, avatarPathOf, removeFiles, uploadPublicImage, validateFile } from '../../lib/storage.js';
import { Avatar } from '../../components/Layout.jsx';
import { Button, useErrorToast, useToast } from '../../components/ui.jsx';

/** Profile picture: upload / replace / remove. Stored in the public avatars bucket. */
export default function PhotoEditor() {
  const { t } = useI18n();
  const { user, profile, refresh } = useAuth();
  const toast = useToast(); const onError = useErrorToast();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const current = profile?.avatar_url;

  const setUrl = async (url) => {
    unwrap(await supabase.from('profiles').update({ avatar_url: url }).eq('id', user.id));
    await removeFiles('avatars', [avatarPathOf(current)]);
    await refresh();
  };
  const upload = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    const bad = validateFile(file, { maxMb: 2, mimes: MIME_AVATAR });
    if (bad) { toast(t(`err.${bad}`, { mb: 2 }), 'error'); return; }
    setBusy(true);
    try { await setUrl(await uploadPublicImage(user.id, file)); toast(t('profile.photo_saved'), 'success'); }
    catch (err) { onError(err); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await setUrl(null); toast(t('common.saved'), 'success'); } catch (err) { onError(err); } finally { setBusy(false); }
  };

  return (
    <div className="photo-editor">
      <button type="button" className="avatar-wrap big" onClick={() => input.current?.click()} aria-label={t('profile.change_photo')} disabled={busy}>
        <Avatar name={profile?.full_name} src={current} size={96} /><span className="avatar-pen" aria-hidden="true">📷</span>
      </button>
      <div className="stack" style={{ gap: 6 }}>
        <strong>{t('profile.photo')}</strong>
        <span className="small muted">{t('profile.photo_hint')}</span>
        <div className="row">
          <Button size="sm" variant="primary" loading={busy} onClick={() => input.current?.click()}>{current ? t('profile.change_photo') : t('profile.add_photo')}</Button>
          {current && <Button size="sm" variant="ghost" disabled={busy} onClick={remove}>{t('common.remove')}</Button>}
        </div>
      </div>
      <input ref={input} type="file" accept={MIME_AVATAR.join(',')} hidden onChange={upload} />
    </div>);
}
