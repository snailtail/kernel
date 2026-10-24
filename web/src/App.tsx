import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { CommandPalette, ShortcutHelp, useShortcuts } from './components/CommandPalette';
import { MyWorkPage } from './features/work/MyWork';
import { NotificationsPage } from './components/Notifications';
import { IncidentsPage } from './features/incidents/Incidents';
import { IncidentPage } from './features/incidents/IncidentPage';
import { Navigate, Route, Routes } from 'react-router';
import { api, type Meta, type Preferences, type User } from './api/client';
import { ActionsPage } from './features/problems/Actions';
import { CandidatesPage } from './features/candidates/Candidates';
import { DashboardPage } from './features/work/Dashboard';
import { KedbPage } from './features/problems/Kedb';
import { ChangeInitialPassword, EnrollTwoFactor, LoginPage } from './features/account/Login';
import { ReauthPrompt } from './components/Reauth';
import { AskHost } from './components/Ask';
import { NewProblemPage } from './features/problems/NewProblem';
import { ProblemPage } from './features/problems/Problem';
import { ProblemsPage } from './features/problems/Problems';
import { startPath } from './nav';
import { SessionContext } from './session';
import { SensitiveWatch } from './components/SensitiveWatch';

// Pages people open less often load on demand, so the start page stays small.
const ChangesPage = lazy(() => import('./features/changes/Changes').then((m) => ({ default: m.ChangesPage })));
const ChangePage = lazy(() => import('./features/changes/ChangePage').then((m) => ({ default: m.ChangePage })));
const ServiceLevelsPage = lazy(() => import('./features/services/ServiceLevels').then((m) => ({ default: m.ServiceLevelsPage })));
const SetupPage = lazy(() => import('./features/admin/Setup').then((m) => ({ default: m.SetupPage })));
const EventsPage = lazy(() => import('./features/events/Events').then((m) => ({ default: m.EventsPage })));
const CiGroupsPage = lazy(() => import('./features/cmdb/Cmdb').then((m) => ({ default: m.CiGroupsPage })));
const CiPage = lazy(() => import('./features/cmdb/CiPage').then((m) => ({ default: m.CiPage })));
const CiRetirePage = lazy(() => import('./features/cmdb/CiRetirePage').then((m) => ({ default: m.CiRetirePage })));
const CmdbListPage = lazy(() => import('./features/cmdb/Cmdb').then((m) => ({ default: m.CmdbListPage })));
const AdminPage = lazy(() => import('./features/admin/Admin').then((m) => ({ default: m.AdminPage })));
const ApiDocsPage = lazy(() => import('./features/help/ApiDocs').then((m) => ({ default: m.ApiDocsPage })));
const GuidePage = lazy(() => import('./features/help/Guide').then((m) => ({ default: m.GuidePage })));
const KnowledgePage = lazy(() => import('./features/knowledge/Knowledge').then((m) => ({ default: m.KnowledgePage })));
const IncidentReviewsPage = lazy(() => import('./features/incidents/IncidentReviews').then((m) => ({ default: m.IncidentReviewsPage })));
const IncidentReviewPage = lazy(() => import('./features/incidents/IncidentReview').then((m) => ({ default: m.IncidentReviewPage })));
const ImprovementsPage = lazy(() => import('./features/improvements/Improvements').then((m) => ({ default: m.ImprovementsPage })));
const ImprovementPage = lazy(() => import('./features/improvements/ImprovementPage').then((m) => ({ default: m.ImprovementPage })));
const BacklogPage = lazy(() => import('./features/development/Backlog').then((m) => ({ default: m.BacklogPage })));
const WorkItemPage = lazy(() => import('./features/development/WorkItemPage').then((m) => ({ default: m.WorkItemPage })));
const RequestsPage = lazy(() => import('./features/requests/Requests').then((m) => ({ default: m.RequestsPage })));
const RequestPage = lazy(() => import('./features/requests/RequestPage').then((m) => ({ default: m.RequestPage })));
const ArticlePage = lazy(() => import('./features/knowledge/Knowledge').then((m) => ({ default: m.ArticlePage })));
const ServiceReportPage = lazy(() => import('./features/services/ServiceReport').then((m) => ({ default: m.ServiceReportPage })));
const StatusBoardPage = lazy(() => import('./features/services/StatusBoard').then((m) => ({ default: m.StatusBoardPage })));
const TeamsPage = lazy(() => import('./features/people/Teams').then((m) => ({ default: m.TeamsPage })));
const RulesPage = lazy(() => import('./features/automation/Rules').then((m) => ({ default: m.RulesPage })));
const RulePage = lazy(() => import('./features/automation/Rules').then((m) => ({ default: m.RulePage })));
const PeoplePage = lazy(() => import('./features/people/People').then((m) => ({ default: m.PeoplePage })));
const PersonPage = lazy(() => import('./features/people/People').then((m) => ({ default: m.PersonPage })));
const AuditPage = lazy(() => import('./features/admin/Audit').then((m) => ({ default: m.AuditPage })));
const SecurityEventsPage = lazy(() => import('./features/admin/SecurityEvents').then((m) => ({ default: m.SecurityEventsPage })));
const ProblemPrintPage = lazy(() => import('./features/problems/ProblemPrint').then((m) => ({ default: m.ProblemPrintPage })));
const ReportsPage = lazy(() => import('./features/reports/Reports').then((m) => ({ default: m.ReportsPage })));
const ReviewPage = lazy(() => import('./features/problems/Review').then((m) => ({ default: m.ReviewPage })));
const SettingsPage = lazy(() => import('./features/account/Settings').then((m) => ({ default: m.SettingsPage })));

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
    // The start page and default record resolve on the server (own choice, the role's default, modules).
    const start = 'home' in prefs || 'default_new' in prefs ? await api.get<User>('/api/auth/me') : null;
    setUser((u) => (u ? { ...u, preferences, ...(start && { home: start.home, default_new: start.default_new }) } : u));
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
            <Route path="/" element={<Navigate to={startPath(user, meta)} replace />} />
            <Route path="/my-work" element={<MyWorkPage />} />
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
            <Route path="/cis/retire" element={<CiRetirePage />} />
            <Route path="/cis/:ref" element={<CiPage />} />
            <Route path="/improvements" element={<ImprovementsPage />} />
            <Route path="/improvements/:ref" element={<ImprovementPage />} />
            <Route path="/work" element={<BacklogPage />} />
            <Route path="/work/:ref" element={<WorkItemPage />} />
            <Route path="/requests" element={<RequestsPage />} />
            <Route path="/requests/:ref" element={<RequestPage />} />
            <Route path="/knowledge" element={<KnowledgePage />} />
            <Route path="/knowledge/:ref" element={<ArticlePage />} />
            <Route path="/service-status" element={<StatusBoardPage />} />
            <Route path="/services/:ref/report" element={<ServiceReportPage />} />
            <Route path="/teams" element={<TeamsPage />} />
            <Route path="/rules" element={<RulesPage />} />
            <Route path="/rules/:id" element={<RulePage />} />
            <Route path="/people" element={<PeoplePage />} />
            <Route path="/people/:id" element={<PersonPage />} />
            <Route path="/actions" element={<ActionsPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/admin/audit" element={<AuditPage />} />
            <Route path="/admin/security-events" element={<SecurityEventsPage />} />
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
