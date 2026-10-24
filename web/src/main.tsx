// The base styles first, so each feature's styles.css (imported by its own files) comes after them.
import './styles/base.css';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';

// The self-service portal (#45) is its own small app for people outside IT, loaded on its own.
const PortalApp = lazy(() => import('./portal/Portal').then((m) => ({ default: m.PortalApp })));
const portal = window.location.pathname === '/portal' || window.location.pathname.startsWith('/portal/');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      {portal ? <Suspense fallback={null}><PortalApp /></Suspense> : <App />}
    </BrowserRouter>
  </StrictMode>,
);
