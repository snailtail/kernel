import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { CommandPalette, ShortcutHelp, useShortcuts } from './components/CommandPalette';
import { MyWorkPage } from './pages/MyWork';
import { NotificationsPage } from './components/Notifications';
import { IncidentPage, IncidentsPage } from './pages/Incidents';
import { Navigate, Route, Routes } from 'react-router';
import { api, type Meta, type Preferences, type User } from './api';
import { icons } from './components/Icons';
import { ROLE_LABEL } from './format';
import { ActionsPage } from './pages/Actions';
import { CandidatesPage } from './pages/Candidates';
import { DashboardPage } from './pages/Dashboard';
import { KedbPage } from './pages/Kedb';
import { ChangeInitialPassword, EnrollTwoFactor, LoginPage } from './pages/Login';
import { ReauthPrompt } from './components/Reauth';
import { AskHost } from './components/Ask';
import { NewProblemPage } from './pages/NewProblem';
import { ProblemPage } from './pages/Problem';
import { ProblemsPage } from './pages/Problems';
import { SessionContext } from './session';
import { SensitiveWatch } from './components/SensitiveWatch';

// Pages people open less often load on demand, so the start page stays small.
const ChangesPage = lazy(() => import('./pages/Changes').then((m) => ({ default: m.ChangesPage })));
const ChangePage = lazy(() => import('./pages/Changes').then((m) => ({ default: m.ChangePage })));
const ServiceLevelsPage = lazy(() => import('./pages/ServiceLevels').then((m) => ({ default: m.ServiceLevelsPage })));
const SetupPage = lazy(() => import('./pages/Setup').then((m) => ({ default: m.SetupPage })));
const EventsPage = lazy(() => import('./pages/Events').then((m) => ({ default: m.EventsPage })));
const CiGroupsPage = lazy(() => import('./pages/Cmdb').then((m) => ({ default: m.CiGroupsPage })));
const CiPage = lazy(() => import('./pages/Cmdb').then((m) => ({ default: m.CiPage })));
const CmdbListPage = lazy(() => import('./pages/Cmdb').then((m) => ({ default: m.CmdbListPage })));
const AdminPage = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminPage })));
const ApiDocsPage = lazy(() => import('./pages/ApiDocs').then((m) => ({ default: m.ApiDocsPage })));
const GuidePage = lazy(() => import('./pages/Guide').then((m) => ({ default: m.GuidePage })));
const KnowledgePage = lazy(() => import('./pages/Knowledge').then((m) => ({ default: m.KnowledgePage })));
const IncidentReviewsPage = lazy(() => import('./pages/IncidentReviews').then((m) => ({ default: m.IncidentReviewsPage })));
const IncidentReviewPage = lazy(() => import('./pages/IncidentReview').then((m) => ({ default: m.IncidentReviewPage })));
const ArticlePage = lazy(() => import('./pages/Knowledge').then((m) => ({ default: m.ArticlePage })));
const ServiceReportPage = lazy(() => import('./pages/ServiceReport').then((m) => ({ default: m.ServiceReportPage })));
const StatusBoardPage = lazy(() => import('./pages/StatusBoard').then((m) => ({ default: m.StatusBoardPage })));
const TeamsPage = lazy(() => import('./pages/Teams').then((m) => ({ default: m.TeamsPage })));
const PeoplePage = lazy(() => import('./pages/People').then((m) => ({ default: m.PeoplePage })));
const PersonPage = lazy(() => import('./pages/People').then((m) => ({ default: m.PersonPage })));
const AuditPage = lazy(() => import('./pages/Audit').then((m) => ({ default: m.AuditPage })));
const ProblemPrintPage = lazy(() => import('./pages/ProblemPrint').then((m) => ({ default: m.ProblemPrintPage })));
const ReportsPage = lazy(() => import('./pages/Reports').then((m) => ({ default: m.ReportsPage })));
const ReviewPage = lazy(() => import('./pages/Review').then((m) => ({ default: m.ReviewPage })));
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [overlay, setOverlay] = useState<'palette' | 'help' | null>(null);

  const reloadMeta = useCallback(async () => setMeta(await api.get<Meta>('/api/meta')), []);

  useEffect(() => {
    api.get<User>('/api/auth/me').then(setUser, () => setUser(null));
    const onUnauthorized = () => setUser(null);
    window.addEventListener('kernel:unauthorized', onUnauthorized);
    return () => window.removeEventListener('kernel:unauthorized', onUnauthorized);
  }, []);

  useEffect(() => {
    if (user) reloadMeta().catch(() => {});
  }, [user, reloadMeta]);

  // Apply the chosen theme; "system" follows the OS via prefers-color-scheme.
  useEffect(() => {
    const theme = user?.preferences?.theme;
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [user?.preferences?.theme]);

  const setPreferences = async (prefs: Preferences) => {
    const preferences = await api.put<Preferences>('/api/auth/preferences', prefs);
    setUser((u) => (u ? { ...u, preferences } : u));
  };

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    setUser(null);
    setMeta(null);
  };

  if (user === undefined) return null;
  if (user === null) return <LoginPage onLogin={setUser} />;
  if (user.must_change_password) return <ChangeInitialPassword onDone={() => setUser({ ...user, must_change_password: false })} onLogout={logout} />;
  if (user.mfa_enrollment_required) return (<><ReauthPrompt /><EnrollTwoFactor onDone={() => setUser({ ...user, mfa_enrollment_required: false, mfa_enabled: true })} onLogout={logout} /></>);
  if (!meta) return <div className="loading-screen">Loading…</div>;

  // Integration accounts only report records through the API; in the browser they manage their tokens.
  if (user.role === 'integration') {
    return (
      <SessionContext.Provider value={{ user, meta, reloadMeta, logout, setPreferences }}>
        <ReauthPrompt />
        <main className="main integration-only">
          <div className="banner intro">
            <div><strong>Integration account.</strong> This account reports incidents and events through the API; create its tokens below.</div>
            <button className="btn small" onClick={logout}>Sign out</button>
          </div>
          <SettingsPage />
        </main>
      </SessionContext.Provider>
    );
  }

  return (
    <SessionContext.Provider value={{ user, meta, reloadMeta, logout, setPreferences }}>
      <ReauthPrompt />
      <AskHost />
      <Shortcuts open={setOverlay} />
      {overlay === 'palette' && <CommandPalette onClose={() => setOverlay(null)} />}
      {overlay === 'help' && <ShortcutHelp onClose={() => setOverlay(null)} />}
      <div className="shell">
        <Sidebar onSearch={() => setOverlay('palette')} />
        <main className="main">
          <SensitiveWatch />
          <Suspense fallback={<p className="muted">Loading…</p>}>
          <Routes>
            <Route path="/" element={<MyWorkPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/problems" element={<ProblemsPage />} />
            <Route path="/problems/new" element={<NewProblemPage />} />
            <Route path="/problems/:ref" element={<ProblemPage />} />
            <Route path="/problems/:ref/print" element={<ProblemPrintPage />} />
            <Route path="/candidates" element={<CandidatesPage />} />
            <Route path="/kedb" element={<KedbPage />} />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/services" element={<ServiceLevelsPage />} />
            <Route path="/changes" element={<ChangesPage />} />
            <Route path="/changes/:ref" element={<ChangePage />} />
            <Route path="/incidents" element={<IncidentsPage />} />
            <Route path="/incidents/:ref" element={<IncidentPage />} />
            <Route path="/incidents/:ref/review" element={<IncidentReviewPage />} />
            <Route path="/reviews/:ref" element={<IncidentReviewPage />} />
            <Route path="/incident-reviews" element={<IncidentReviewsPage />} />
            <Route path="/cis" element={<CmdbListPage />} />
            <Route path="/cis/groups" element={<CiGroupsPage />} />
            <Route path="/cis/:ref" element={<CiPage />} />
            <Route path="/knowledge" element={<KnowledgePage />} />
            <Route path="/knowledge/:ref" element={<ArticlePage />} />
            <Route path="/service-status" element={<StatusBoardPage />} />
            <Route path="/services/:ref/report" element={<ServiceReportPage />} />
            <Route path="/teams" element={<TeamsPage />} />
            <Route path="/people" element={<PeoplePage />} />
            <Route path="/people/:id" element={<PersonPage />} />
            <Route path="/actions" element={<ActionsPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/admin/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/guide" element={<GuidePage />} />
            <Route path="/api-docs" element={<ApiDocsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </main>
      </div>
    </SessionContext.Provider>
  );
}

/** Mounted inside the router so shortcuts can navigate. */
function Shortcuts({ open }: { open: (what: 'palette' | 'help') => void }) {
  useShortcuts(open);
  return null;
}
