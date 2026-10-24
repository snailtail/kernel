// The self-service portal (#45): a small, friendly front door for people outside IT, mobile first. It talks only to
// /api/portal/* with its own session; nothing from Kernel's own UI is loaded here.
import { useCallback, useEffect, useState } from 'react';
import { Link, Route, Routes } from 'react-router';
import { api } from '../api/client';
import { TEXT } from './text';
import { type Me } from './common';
import { SignIn, LinkSignIn } from './SignIn';
import { TicketPage } from './TicketPage';
import { ServiceStatus } from './ServiceStatus';
import { Home } from './Home';
import { Report } from './Report';
import { Article } from './Article';
import { Catalogue } from './Catalogue';
import { Ask } from './Ask';

export function PortalApp() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const load = useCallback(() => api.get<Me>('/api/portal/me').then(setMe, () => setMe(null)), []);
  useEffect(() => {
    document.title = TEXT.appName;
    load();
  }, [load]);
  const signOut = async () => {
    await api.post('/api/portal/auth/logout').catch(() => {});
    setMe(null);
  };

  return (
    <div className="portal">
      <a className="skip-link" href="#portal-main">{TEXT.skip}</a>
      <header className="portal-header">
        <Link to="/portal" className="portal-brand">{TEXT.appName}</Link>
        {me && <button type="button" className="portal-link-button" onClick={signOut}>{TEXT.signOut}</button>}
      </header>
      <main id="portal-main" className="portal-main" tabIndex={-1}>
        {me === undefined ? <p className="portal-muted" role="status">{TEXT.loading}</p> : (
          <Routes>
            <Route path="/portal/signin" element={<LinkSignIn onDone={load} />} />
            {me === null ? <Route path="*" element={<SignIn />} /> : <>
              <Route path="/portal" element={<Home me={me} />} />
              <Route path="/portal/report" element={<Report />} />
              <Route path="/portal/ask" element={<Catalogue />} />
              <Route path="/portal/ask/:id" element={<Ask />} />
              <Route path="/portal/status" element={<ServiceStatus />} />
              <Route path="/portal/tickets/:ref" element={<TicketPage />} />
              <Route path="/portal/help/:ref" element={<Article />} />
              <Route path="*" element={<p>{TEXT.notFound} <Link to="/portal">{TEXT.back}</Link></p>} />
            </>}
          </Routes>
        )}
      </main>
    </div>
  );
}
