import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { supabase, isConfigured } from '../lib/supabase.js';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [lawyer, setLawyer] = useState(null);          // own lawyer_profiles row
  const [adminRole, setAdminRole] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(isConfigured);

  const loadAccount = useCallback(async (uid) => {
    if (!uid) { setProfile(null); setLawyer(null); setAdminRole(null); setPermissions([]); return; }
    const { data: p } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle();
    setProfile(p || null);
    if (p?.account_type === 'lawyer') {
      const [{ data: l }, { data: idn }] = await Promise.all([
        supabase.from('lawyer_profiles').select('*').eq('user_id', uid).maybeSingle(),
        supabase.from('lawyer_identities').select('full_legal_name,bar_membership_number,bar_branch').eq('user_id', uid).maybeSingle(),
      ]);
      setLawyer(l ? { ...l, ...(idn || {}) } : null);   // identity merged for the owner's own forms only
    } else setLawyer(null);
    if (p?.account_type === 'admin') {
      const { data: a } = await supabase.from('admin_users').select('role').eq('user_id', uid).maybeSingle();
      setAdminRole(a?.role || null);
      if (a?.role) {
        const { data: perms } = await supabase.from('admin_role_permissions').select('permission').eq('role', a.role);
        setPermissions((perms || []).map((x) => x.permission));
      }
    } else { setAdminRole(null); setPermissions([]); }
  }, []);

  useEffect(() => {
    if (!isConfigured) return undefined;
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      setSession(data.session);
      await loadAccount(data.session?.user?.id);
      if (alive) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      setSession(s);
      // defer to avoid deadlocks inside the auth callback
      setTimeout(() => loadAccount(s?.user?.id), 0);
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [loadAccount]);

  // A lawyer waiting for review must notice the admin's decision without logging in again:
  // re-read the account every 15s and whenever the tab regains focus.
  const waitingLawyer = profile?.status === 'pending'
    || (profile?.account_type === 'lawyer' && lawyer?.verification_status !== 'approved');
  const uid = session?.user?.id;
  useEffect(() => {
    if (!waitingLawyer || !uid) return undefined;
    const reload = () => { if (document.visibilityState === 'visible') loadAccount(uid); };
    const iv = setInterval(reload, 15000);
    document.addEventListener('visibilitychange', reload);
    window.addEventListener('focus', reload);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', reload); window.removeEventListener('focus', reload); };
  }, [waitingLawyer, uid, loadAccount]);

  const value = useMemo(() => ({
    session, user: session?.user || null, profile, lawyer, adminRole, permissions, loading,
    can: (perm) => permissions.includes(perm),
    isApprovedLawyer: profile?.account_type === 'lawyer' && lawyer?.verification_status === 'approved' && profile?.status === 'active',
    tz: profile?.timezone || 'Africa/Cairo',
    refresh: () => loadAccount(session?.user?.id),
    signIn: (email, password) => supabase.auth.signInWithPassword({ email, password }),
    isGuest: !!session?.user?.is_anonymous,
    guestSignIn: () => supabase.auth.signInAnonymously({ options: { data: { locale: document.documentElement.lang === 'en' ? 'en' : 'ar' } } }),
    // a guest turns into a real account (same user, keeps their consultations)
    upgradeGuest: async (email, password, meta) => {
      const r = await supabase.auth.updateUser({ email, password, data: meta });
      if (!r.error) await supabase.from('profiles').update({ full_name: meta.full_name, phone: meta.phone || null }).eq('id', session.user.id);
      return r;
    },
    signUp: (email, password, meta) => supabase.auth.signUp({ email, password, options: { data: meta } }),
    resetPassword: (email) => supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + '/login' }),
    signOut: async () => { await supabase.auth.signOut(); },
  }), [session, profile, lawyer, adminRole, permissions, loading, loadAccount]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
