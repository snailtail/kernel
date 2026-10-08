import { useCallback, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import { api, type Meta, type Preferences, type User } from './api';
import { icons } from './components/Icons';
import { ROLE_LABEL } from './format';
import { ActionsPage } from './pages/Actions';
import { AdminPage } from './pages/Admin';
import { CandidatesPage } from './pages/Candidates';
import { DashboardPage } from './pages/Dashboard';
import { GuidePage } from './pages/Guide';
import { KedbPage } from './pages/Kedb';
import { LoginPage } from './pages/Login';
import { NewProblemPage } from './pages/NewProblem';
import { ProblemPage } from './pages/Problem';
import { ProblemsPage } from './pages/Problems';
import { ReportsPage } from './pages/Reports';
import { SettingsPage } from './pages/Settings';
import { SessionContext, canEdit, isManager } from './session';

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [meta, setMeta] = useState<Meta | null>(null);

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
  if (!meta) return <div className="loading-screen">Loading…</div>;

  return (
    <SessionContext.Provider value={{ user, meta, reloadMeta, logout, setPreferences }}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <img src="/favicon.svg" alt="" width={28} height={28} />
            <div>
              <div className="brand-name">Kernel</div>
              <div className="brand-sub">Problem Management</div>
            </div>
          </div>
          <nav>
            <NavLink to="/" end>{icons.dashboard}Dashboard</NavLink>
            <NavLink to="/problems" end>{icons.problems}Problems</NavLink>
            <NavLink to="/candidates">{icons.candidates}Candidates</NavLink>
            <NavLink to="/kedb">{icons.kedb}Known Errors</NavLink>
            <NavLink to="/actions">{icons.actions}Actions</NavLink>
            <NavLink to="/reports">{icons.reports}Reports</NavLink>
            {canEdit(user) && <NavLink to="/problems/new" className="nav-cta">{icons.plus}Log problem</NavLink>}
            {isManager(user) && <NavLink to="/admin">{icons.admin}Administration</NavLink>}
          </nav>
          <div className="sidebar-foot">
            <NavLink to="/guide" className="help-link">{icons.help}How it works</NavLink>
            <NavLink to="/settings" className="user-chip">
              <span className="avatar">{user.display_name.slice(0, 1).toUpperCase()}</span>
              <span>
                <span className="user-name">{user.display_name}</span>
                <span className="user-role">{ROLE_LABEL[user.role]}</span>
              </span>
            </NavLink>
            <button className="btn-link signout" onClick={logout}>{icons.signout}Sign out</button>
          </div>
        </aside>
        <main className="main">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/problems" element={<ProblemsPage />} />
            <Route path="/problems/new" element={<NewProblemPage />} />
            <Route path="/problems/:ref" element={<ProblemPage />} />
            <Route path="/candidates" element={<CandidatesPage />} />
            <Route path="/kedb" element={<KedbPage />} />
            <Route path="/actions" element={<ActionsPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/guide" element={<GuidePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </SessionContext.Provider>
  );
}
