import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { useI18n } from '../lib/i18n.jsx';
import { supabase } from '../lib/supabase.js';
import { Button } from './ui.jsx';

export const Logo = () => <img src="/logo-192.png" alt="" aria-hidden="true" />;

/** Round avatar: the user's photo when they uploaded one, otherwise the app logo. */
export const Avatar = ({ name, src, size }) => (
  <img className="avatar" src={src || '/logo-192.png'} alt="" title={name || undefined} aria-hidden="true"
    style={size ? { width: size, height: size } : undefined} />
);

export const BrandName = () => (
  <span className="brand-name"><span className="brand-ar">مستشارك</span><small className="brand-en">Mostshark</small></span>
);

function useUnread(userId) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!userId) return undefined;
    let alive = true;
    const load = async () => {
      const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
      if (alive) setN(count || 0);
    };
    load();
    const ch = supabase.channel('notif-' + userId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` }, load)
      .subscribe();
    const iv = setInterval(load, 60000);
    return () => { alive = false; clearInterval(iv); supabase.removeChannel(ch); };
  }, [userId]);
  return n;
}

export function AppShell({ nav, base }) {
  const { t, lang, setLang } = useI18n();
  const { user, profile, signOut, isGuest } = useAuth();
  const navigate = useNavigate();
  const unread = useUnread(user?.id);
  const [more, setMore] = useState(false);
  const primary = nav.slice(0, 4);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><Logo /><BrandName /></div>
        <nav className="nav" aria-label={t('nav.main')}>
          {nav.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="ico" aria-hidden="true">{i.icon}</span><span>{t(i.label)}</span>
            </NavLink>
          ))}
        </nav>
        <div className="user-chip"><Avatar name={profile?.full_name} src={profile?.avatar_url} /><span className="small">{profile?.full_name}</span></div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="small muted topbar-role">{t('nav.' + (profile?.account_type || 'client'))}</span>
          <div className="grow" />
          <Button variant="ghost" size="sm" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')} aria-label="language">{lang === 'ar' ? 'English' : 'العربية'}</Button>
          <button className="btn btn-ghost bell" onClick={() => navigate(`${base}/notifications`)} aria-label={t('nav.notifications')}>
            🔔{unread > 0 && <span className="count">{unread > 99 ? '99+' : unread}</span>}
          </button>
          <Button variant="secondary" size="sm" onClick={async () => { await signOut(); navigate('/login'); }}>{t('auth.logout')}</Button>
          {/* last in the bar = top-left corner in Arabic (RTL): photo + pencil opens the profile editor */}
          <Link className="user-chip profile-edit" to={`${base}/profile`} title={t('profile.edit')} aria-label={t('profile.edit')}>
            <span className="avatar-wrap"><Avatar name={profile?.full_name} src={profile?.avatar_url} /><span className="avatar-pen" aria-hidden="true">✏️</span></span>
            <span className="small"><strong>{profile?.full_name}</strong></span>
          </Link>
        </header>
        {isGuest && (
          <div className="guest-banner" role="note">
            <span>👤 {t('guest.banner')}</span>
            <Link className="btn btn-primary btn-sm" to="/register">{t('guest.create_account')}</Link>
          </div>)}
        <main className="content"><Outlet /></main>
      </div>
      <nav className="bottomnav" aria-label={t('nav.main')}>
        {primary.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span aria-hidden="true">{i.icon}</span><span>{t(i.label)}</span>
          </NavLink>
        ))}
        {nav.length > 4 && <button onClick={() => setMore(true)}><span aria-hidden="true">☰</span><span>{t('nav.more')}</span></button>}
      </nav>
      {more && (
        <div className="overlay" onClick={() => setMore(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('nav.more')}>
            <div className="stack">
              {nav.slice(4).concat([{ to: `${base}/notifications`, icon: '🔔', label: 'nav.notifications' }]).map((i) => (
                <NavLink key={i.to} to={i.to} className="btn btn-secondary" onClick={() => setMore(false)}>{i.icon} {t(i.label)}</NavLink>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const CLIENT_NAV = [
  { to: '/client', end: true, icon: '💬', label: 'nav.my_consultations' },
  { to: '/client/ask', icon: '❓', label: 'nav.ask' },
  { to: '/client/assistant', icon: '🤖', label: 'nav.assistant' },
  { to: '/client/directory', icon: '🧭', label: 'nav.directory' },
  { to: '/client/new', icon: '➕', label: 'nav.new_consultation' },
  { to: '/client/about', icon: '🏛️', label: 'nav.about' },
  { to: '/client/profile', icon: '👤', label: 'nav.profile' },
];
export const LAWYER_NAV = [
  { to: '/lawyer', end: true, icon: '🏠', label: 'nav.dashboard' },
  { to: '/lawyer/calendar', icon: '📅', label: 'nav.calendar' },
  { to: '/lawyer/cases', icon: '⚖️', label: 'nav.cases' },
  { to: '/lawyer/clients', icon: '👥', label: 'nav.clients' },
  { to: '/lawyer/finance', icon: '💰', label: 'nav.finance' },
  { to: '/lawyer/consultations', icon: '💬', label: 'nav.consultations' },
  { to: '/lawyer/library', icon: '📚', label: 'nav.library' },
  { to: '/lawyer/templates', icon: '📄', label: 'nav.templates' },
  { to: '/lawyer/about', icon: '🏛️', label: 'nav.about' },
  { to: '/lawyer/profile', icon: '👤', label: 'nav.profile' },
];
export const ADMIN_NAV = [
  { to: '/admin', end: true, icon: '📊', label: 'nav.overview', perm: 'reports.read' },
  { to: '/admin/lawyers', icon: '🪪', label: 'nav.lawyers', perm: 'lawyers.review' },
  { to: '/admin/consultations', icon: '💬', label: 'nav.consultations', perm: 'consultations.manage' },
  { to: '/admin/users', icon: '👥', label: 'nav.users', perm: 'users.read' },
  { to: '/admin/library', icon: '📚', label: 'nav.library', perm: 'library.manage' },
  { to: '/admin/templates', icon: '📄', label: 'nav.templates', perm: 'templates.manage' },
  { to: '/admin/settings', icon: '⚙️', label: 'nav.settings', perm: 'categories.manage' },
  { to: '/admin/reports', icon: '📈', label: 'nav.reports', perm: 'reports.read' },
  { to: '/admin/audit', icon: '🧾', label: 'nav.audit', perm: 'audit.read' },
  { to: '/admin/directory', icon: '🧭', label: 'nav.directory', perm: 'lawyers.review' },
  { to: '/admin/about', icon: '🏛️', label: 'nav.about' },
  { to: '/admin/profile', icon: '👤', label: 'nav.profile' },
];

export function ShellFor({ role }) {
  const { can } = useAuth();
  if (role === 'client') return <AppShell nav={CLIENT_NAV} base="/client" />;
  if (role === 'lawyer') return <AppShell nav={LAWYER_NAV} base="/lawyer" />;
  return <AppShell nav={ADMIN_NAV.filter((i) => !i.perm || can(i.perm))} base="/admin" />;
}
