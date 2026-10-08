import { useState } from 'react';
import { Link } from 'react-router';
import type { Guidance } from '../api';
import { useSession } from '../session';
import { icons } from './Icons';

export const isGuided = (prefs: { guided?: boolean }) => prefs.guided !== false;

/** Guided mode panel on the problem page: the phase, its purpose, and the remaining steps. */
export function GuidePanel({ guidance }: { guidance: Guidance }) {
  const { user, setPreferences } = useSession();
  const [open, setOpen] = useState(true);
  if (!isGuided(user.preferences)) return null;
  const checkable = guidance.steps.filter((s) => s.done !== null);
  const done = checkable.filter((s) => s.done).length;
  return (
    <section className="card guide" aria-label="Process guidance">
      <div className="section-head">
        <h2>
          {icons.help} {guidance.phase}
          {checkable.length > 0 && <span className="count">{done} of {checkable.length} done</span>}
        </h2>
        <button className="btn-link small" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>
      </div>
      {open && (
        <>
          <p className="guide-purpose">{guidance.purpose}</p>
          {guidance.steps.length > 0 && (
            <ul className="guide-steps">
              {guidance.steps.map((s) => (
                <li key={s.id} className={s.done ? 'done' : s.done === null ? 'advice' : ''}>
                  <span className="guide-check" aria-hidden="true">{s.done ? '✓' : s.done === null ? '•' : ''}</span>
                  <div>
                    <div className="guide-label">{s.label}{s.done === null && <span className="muted small"> (recommended)</span>}</div>
                    <div className="muted small">{s.hint}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="guide-next"><strong>Next:</strong> {guidance.next}</p>
          <p className="muted small">
            <Link to="/guide">How problem management works</Link> ·{' '}
            <button className="btn-link small" onClick={() => setPreferences({ guided: false })}>Turn off guided mode</button>{' '}
            (you can turn it on again in Settings)
          </p>
        </>
      )}
    </section>
  );
}

/** A short contextual hint, shown only in guided mode. */
export function Hint({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  if (!isGuided(user.preferences)) return null;
  return <p className="hint-box">{children}</p>;
}
