import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';
import { Spinner } from '../components/ui.jsx';

export const homeFor = (profile) =>
  profile?.account_type === 'admin' ? '/admin' : profile?.account_type === 'lawyer' ? '/lawyer' : '/client';

/** UI-level routing only. Real authorization is enforced by RLS in the database. */
export function RequireRole({ role, children }) {
  const { session, profile, loading, isApprovedLawyer } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!session) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (!profile) return <Spinner />;
  if (profile.status !== 'active') return <Navigate to="/suspended" replace />;
  if (profile.account_type !== role) return <Navigate to={homeFor(profile)} replace />;
  if (role === 'lawyer' && !isApprovedLawyer && !loc.pathname.startsWith('/lawyer/application')) {
    return <Navigate to="/lawyer/application" replace />;
  }
  return children;
}

export function RequirePerm({ perm, children }) {
  const { can, permissions } = useAuth();
  if (!permissions.length) return <Spinner />;
  if (!can(perm)) return <Navigate to="/admin/profile" replace />;
  return children;
}
