import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';
import { homeFor } from './guards.jsx';
import { useI18n } from '../lib/i18n.jsx';
import { errorKey } from '../lib/errors.js';
import { Alert, Button, Checkbox, Field, Input, Segmented, Spinner } from '../components/ui.jsx';
import { Logo } from '../components/Layout.jsx';

function AuthFrame({ title, children }) {
  const { t, lang, setLang } = useI18n();
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand"><Logo /><span>{t('app.name')}</span></div>
        <p className="muted" style={{ textAlign: 'center' }}>{t('app.tagline')}</p>
        <h2 style={{ textAlign: 'center' }}>{title}</h2>
        {children}
        <p style={{ textAlign: 'center', marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{lang === 'ar' ? 'English' : 'العربية'}</button>
        </p>
      </div>
    </div>
  );
}

export function Login() {
  const { t } = useI18n();
  const { signIn, session, profile, loading, resetPassword } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  if (loading) return <Spinner />;
  if (session && profile) return <Navigate to={loc.state?.from || homeFor(profile)} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(''); setInfo('');
    const { error: err } = await signIn(email.trim(), password);
    setBusy(false);
    if (err) setError(t(errorKey(err)));
    else nav('/', { replace: true });
  };
  const forgot = async () => {
    if (!email.trim()) { setError(t('auth.enter_email_first')); return; }
    const { error: err } = await resetPassword(email.trim());
    if (err) setError(t(errorKey(err))); else setInfo(t('auth.reset_sent'));
  };

  return (
    <AuthFrame title={t('auth.login')}>
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        {info && <Alert tone="success">{info}</Alert>}
        <Field label={t('auth.email')}><Input className="input ltr" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label={t('auth.password')}><Input className="input ltr" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <Button variant="primary" block loading={busy} type="submit">{t('auth.login')}</Button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={forgot}>{t('auth.forgot')}</button>
        <p style={{ textAlign: 'center', margin: 0 }}>{t('auth.no_account')} <Link to="/register">{t('auth.register')}</Link></p>
      </form>
    </AuthFrame>
  );
}

export function Register() {
  const { t, lang } = useI18n();
  const { signUp, session, profile, loading } = useAuth();
  const nav = useNavigate();
  const [type, setType] = useState('client');
  const [f, setF] = useState({ full_name: '', email: '', phone: '', password: '', agree: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  if (loading) return <Spinner />;
  if (session && profile) return <Navigate to={homeFor(profile)} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (f.full_name.trim().length < 3) return setError(t('val.name'));
    if (!/^\S+@\S+\.\S+$/.test(f.email)) return setError(t('val.email'));
    if (!/^[+\d][\d\s-]{7,16}$/.test(f.phone)) return setError(t('val.phone'));
    if (f.password.length < 8 || !/\d/.test(f.password) || !/[A-Za-z؀-ۿ]/.test(f.password)) return setError(t('val.password'));
    if (!f.agree) return setError(t('val.agree'));
    setBusy(true);
    const { data, error: err } = await signUp(f.email.trim(), f.password, {
      full_name: f.full_name.trim(), phone: f.phone.trim(), account_type: type, locale: lang,
    });
    setBusy(false);
    if (err) return setError(t(errorKey(err)));
    if (data.session) nav('/', { replace: true });
    else setDone(true);   // email confirmation required
  };

  if (done) {
    return (
      <AuthFrame title={t('auth.check_email')}>
        <Alert tone="success">{t('auth.check_email_body')}</Alert>
        <p style={{ textAlign: 'center' }}><Link to="/login">{t('auth.login')}</Link></p>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title={t('auth.register')}>
      <form className="stack" onSubmit={submit} noValidate>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Segmented value={type} onChange={setType} items={[{ value: 'client', label: t('auth.i_am_client') }, { value: 'lawyer', label: t('auth.i_am_lawyer') }]} />
        </div>
        {type === 'lawyer' && <Alert tone="info">{t('auth.lawyer_note')}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={type === 'lawyer' ? t('auth.legal_name') : t('auth.full_name')}><Input value={f.full_name} onChange={set('full_name')} autoComplete="name" /></Field>
        <Field label={t('auth.email')}><Input className="input ltr" type="email" value={f.email} onChange={set('email')} autoComplete="email" /></Field>
        <Field label={t('auth.phone')}><Input className="input ltr" type="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" placeholder="+20 100 000 0000" /></Field>
        <Field label={t('auth.password')} hint={t('val.password_hint')}><Input className="input ltr" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
        <Checkbox checked={f.agree} onChange={set('agree')} label={t('auth.agree_terms')} />
        <Button variant="primary" block loading={busy} type="submit">{t('auth.register')}</Button>
        <p style={{ textAlign: 'center', margin: 0 }}>{t('auth.have_account')} <Link to="/login">{t('auth.login')}</Link></p>
      </form>
    </AuthFrame>
  );
}

export function Suspended() {
  const { t } = useI18n();
  const { profile, signOut } = useAuth();
  return (
    <AuthFrame title={t('auth.suspended_title')}>
      <Alert tone="danger">{t('auth.suspended_body')}{profile?.status_reason ? ` — ${profile.status_reason}` : ''}</Alert>
      <p style={{ textAlign: 'center', marginTop: 16 }}><Button onClick={signOut}>{t('auth.logout')}</Button></p>
    </AuthFrame>
  );
}

export function ConfigMissing() {
  const { t } = useI18n();
  return (
    <AuthFrame title={t('config.title')}>
      <Alert tone="warn">{t('config.body')}</Alert>
      <pre className="ltr small" style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 8, overflow: 'auto' }}>
{`web/.env.local
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=...`}
      </pre>
    </AuthFrame>
  );
}
