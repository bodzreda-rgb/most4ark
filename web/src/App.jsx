import { Navigate, Route, Routes } from 'react-router-dom';
import { isConfigured } from './lib/supabase.js';
import { useAuth } from './auth/AuthContext.jsx';
import { RequirePerm, RequireRole, homeFor } from './auth/guards.jsx';
import { ConfigMissing, Login, Register, Suspended } from './auth/AuthPages.jsx';
import { ShellFor } from './components/Layout.jsx';
import { Spinner } from './components/ui.jsx';
import Account from './features/shared/Account.jsx';
import Notifications from './features/shared/Notifications.jsx';
import ConsultationDetail from './features/shared/ConsultationDetail.jsx';
import { MyConsultations, NewConsultation } from './features/client/Consultations.jsx';
import Application from './features/lawyer/Application.jsx';
import LawyerProfile from './features/lawyer/LawyerProfile.jsx';
import Dashboard from './features/lawyer/Dashboard.jsx';
import Calendar from './features/lawyer/Calendar.jsx';
import Cases from './features/lawyer/Cases.jsx';
import CaseDetail from './features/lawyer/CaseDetail.jsx';
import Clients, { ClientDetail } from './features/lawyer/Clients.jsx';
import Finance, { TransactionDetail } from './features/lawyer/Finance.jsx';
import LawyerConsultations from './features/lawyer/LawyerConsultations.jsx';
import Directory from './features/client/Directory.jsx';
import Ask from './features/client/Ask.jsx';
import AiChat from './features/shared/AiChat.jsx';
import About from './features/shared/About.jsx';
import Library, { ResourceDetail } from './features/lawyer/Library.jsx';
import Templates from './features/lawyer/Templates.jsx';
import Overview from './features/admin/Overview.jsx';
import { AdminLawyerDetail, AdminLawyers } from './features/admin/Lawyers.jsx';
import AdminUsers from './features/admin/Users.jsx';
import AdminConsultations from './features/admin/Consultations.jsx';
import LibraryAdmin from './features/admin/LibraryAdmin.jsx';
import TemplatesAdmin from './features/admin/TemplatesAdmin.jsx';
import DirectoryAdmin from './features/admin/DirectoryAdmin.jsx';
import Settings from './features/admin/Settings.jsx';
import Reports from './features/admin/Reports.jsx';
import AuditLog from './features/admin/Audit.jsx';

function Home() {
  const { session, profile, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!session) return <Navigate to="/login" replace />;
  if (!profile) return <Spinner />;
  return <Navigate to={profile.status !== 'active' ? '/suspended' : homeFor(profile)} replace />;
}

const P = ({ perm, children }) => <RequirePerm perm={perm}>{children}</RequirePerm>;

export default function App() {
  if (!isConfigured) return <ConfigMissing />;
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/suspended" element={<Suspended />} />
      <Route path="/about" element={<About standalone />} />

      <Route path="/client" element={<RequireRole role="client"><ShellFor role="client" /></RequireRole>}>
        <Route index element={<MyConsultations />} />
        <Route path="new" element={<NewConsultation />} />
        <Route path="ask" element={<Ask />} />
        <Route path="assistant" element={<AiChat />} />
        <Route path="directory" element={<Directory />} />
        <Route path="about" element={<About />} />
        <Route path="consultations/:id" element={<ConsultationDetail role="client" />} />
        <Route path="notifications" element={<Notifications base="/client" />} />
        <Route path="profile" element={<Account />} />
      </Route>

      <Route path="/lawyer" element={<RequireRole role="lawyer"><ShellFor role="lawyer" /></RequireRole>}>
        <Route index element={<Dashboard />} />
        <Route path="application" element={<Application />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="cases" element={<Cases />} />
        <Route path="cases/:id" element={<CaseDetail />} />
        <Route path="clients" element={<Clients />} />
        <Route path="clients/:id" element={<ClientDetail />} />
        <Route path="finance" element={<Finance />} />
        <Route path="finance/:id" element={<TransactionDetail />} />
        <Route path="consultations" element={<LawyerConsultations />} />
        <Route path="consultations/:id" element={<ConsultationDetail role="lawyer" />} />
        <Route path="library" element={<Library />} />
        <Route path="library/:id" element={<ResourceDetail />} />
        <Route path="templates" element={<Templates />} />
        <Route path="about" element={<About />} />
        <Route path="notifications" element={<Notifications base="/lawyer" />} />
        <Route path="profile" element={<LawyerProfile />} />
      </Route>

      <Route path="/admin" element={<RequireRole role="admin"><ShellFor role="admin" /></RequireRole>}>
        <Route index element={<P perm="reports.read"><Overview /></P>} />
        <Route path="lawyers" element={<P perm="lawyers.review"><AdminLawyers /></P>} />
        <Route path="lawyers/:id" element={<P perm="lawyers.review"><AdminLawyerDetail /></P>} />
        <Route path="consultations" element={<P perm="consultations.manage"><AdminConsultations /></P>} />
        <Route path="consultations/:id" element={<P perm="consultations.manage"><ConsultationDetail role="admin" /></P>} />
        <Route path="users" element={<P perm="users.read"><AdminUsers /></P>} />
        <Route path="library" element={<P perm="library.manage"><LibraryAdmin /></P>} />
        <Route path="templates" element={<P perm="templates.manage"><TemplatesAdmin /></P>} />
        <Route path="settings" element={<P perm="categories.manage"><Settings /></P>} />
        <Route path="reports" element={<P perm="reports.read"><Reports /></P>} />
        <Route path="audit" element={<P perm="audit.read"><AuditLog /></P>} />
        <Route path="directory" element={<P perm="lawyers.review"><DirectoryAdmin /></P>} />
        <Route path="about" element={<About />} />
        <Route path="notifications" element={<Notifications base="/admin" />} />
        <Route path="profile" element={<Account />} />
      </Route>

      <Route path="*" element={<Home />} />
    </Routes>
  );
}
