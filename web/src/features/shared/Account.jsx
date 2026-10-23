import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { unwrap } from '../../lib/hooks.js';
import { Button, Card, Field, Input, PageHead, Select, useErrorToast, useToast } from '../../components/ui.jsx';
import PhotoEditor from './PhotoEditor.jsx';

const ZONES = ['Africa/Cairo', 'Asia/Riyadh', 'Asia/Dubai', 'Europe/London', 'UTC'];

export default function Account({ photo = true }) {
  const { t, lang, setLang } = useI18n();
  const { profile, user, refresh } = useAuth();
  const toast = useToast();
  const onError = useErrorToast();
  const [f, setF] = useState({ full_name: profile?.full_name || '', phone: profile?.phone || '', timezone: profile?.timezone || 'Africa/Cairo', locale: profile?.locale || lang });
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async (e) => {
    e.preventDefault();
    if (f.full_name.trim().length < 3) return toast(t('val.name'), 'error');
    setBusy(true);
    try {
      unwrap(await supabase.from('profiles').update({ full_name: f.full_name.trim(), phone: f.phone.trim() || null, timezone: f.timezone, locale: f.locale }).eq('id', user.id));
      setLang(f.locale);
      await refresh();
      toast(t('common.saved'), 'success');
    } catch (err) { onError(err); } finally { setBusy(false); }
  };
  const changePw = async () => {
    if (pw.length < 8) return toast(t('val.password'), 'error');
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) onError(error); else { setPw(''); toast(t('common.saved'), 'success'); }
  };

  return (
    <>
      <PageHead title={t('nav.profile')} />
      <div className="grid cols-2">
        <Card title={t('account.details')}>
          {photo && <div style={{ marginBottom: 16 }}><PhotoEditor /></div>}
          <form className="stack" onSubmit={save}>
            <Field label={t('auth.full_name')}><Input value={f.full_name} onChange={set('full_name')} /></Field>
            <Field label={t('auth.email')}><Input className="input ltr" value={profile?.email || ''} disabled /></Field>
            <Field label={t('auth.phone')}><Input className="input ltr" value={f.phone} onChange={set('phone')} /></Field>
            <Field label={t('account.language')}>
              <Select value={f.locale} onChange={set('locale')}><option value="ar">العربية</option><option value="en">English</option></Select>
            </Field>
            <Field label={t('account.timezone')} hint={t('account.timezone_hint')}>
              <Select value={f.timezone} onChange={set('timezone')}>{ZONES.map((z) => <option key={z} value={z}>{z}</option>)}</Select>
            </Field>
            <Button variant="primary" type="submit" loading={busy}>{t('common.save')}</Button>
          </form>
        </Card>
        <Card title={t('account.security')}>
          <div className="stack">
            <Field label={t('account.new_password')} hint={t('val.password_hint')}><Input className="input ltr" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
            <Button onClick={changePw} disabled={!pw}>{t('account.change_password')}</Button>
          </div>
        </Card>
      </div>
    </>
  );
}
