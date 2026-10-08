import { Link } from 'react-router';
import { useSession } from '../session';

const PHASES = [
  {
    status: 'New',
    phase: 'Problem identification',
    text: 'A problem is the cause, or potential cause, of one or more incidents. Problems are identified reactively, from incidents that recur or have a big impact, and proactively, from trend analysis, monitoring events, vendor information or risks. Record what you see, link the incidents or events, and set an owner.',
  },
  {
    status: 'Under Analysis',
    phase: 'Problem control',
    text: 'Analyse the problem to find its root cause, using structured techniques such as 5 Whys, Ishikawa or Kepner-Tregoe. Prioritise by the risk the problem poses. If a workaround reduces the impact, document it straight away – it does not have to wait for the root cause.',
  },
  {
    status: 'Known Error',
    phase: 'Error control',
    text: 'A known error is a problem that has been analysed but not resolved. Keep its workaround available and effective, and weigh the risk of living with it against the cost and risk of a permanent fix. The decision – fix, accept the risk, or defer – is recorded and periodically reviewed.',
  },
  {
    status: 'Resolved',
    phase: 'Resolution',
    text: 'The permanent fix is usually implemented through change enablement. Link the change, document the resolution, and verify that the problem does not recur.',
  },
  {
    status: 'Closed',
    phase: 'Closure',
    text: 'A problem manager closes the record with a closure code. Major problems get a review first: what happened, what went well, what to improve, and follow-up actions.',
  },
];

export function GuidePage() {
  const { user, setPreferences } = useSession();
  return (
    <article className="guide-page">
      <header className="page-head">
        <div>
          <h1>Problem management in 5 minutes</h1>
          <p className="muted">Based on the ITIL 4 problem management practice.</p>
        </div>
      </header>
      <section className="card prose-card">
        <p>
          <strong>Incident management</strong> restores service as quickly as possible. <strong>Problem management</strong> asks why it broke, and
          makes sure it does not break again – or, when a fix is not worth it, that the risk is understood and accepted. It reduces the number and
          impact of incidents and turns recurring firefighting into lasting improvements.
        </p>
      </section>
      <ol className="phase-list">
        {PHASES.map((p, i) => (
          <li key={p.status} className="card">
            <span className="phase-n">{i + 1}</span>
            <div>
              <h2>{p.phase} <span className="muted small">– status “{p.status}”</span></h2>
              <p>{p.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <section className="card prose-card">
        <h2>Good habits</h2>
        <ul>
          <li>Link every related incident, event and change – it shows impact and proves the fix.</li>
          <li>Write work notes as you go. Future readers (and you) need the reasoning, not just the conclusion.</li>
          <li>Prioritise by risk: impact if it happens again × how likely that is.</li>
          <li>Track follow-up work as actions with an owner and a due date.</li>
          <li>Look for patterns: the Candidates page and Reports show where problems hide.</li>
        </ul>
      </section>
      <div className="actions">
        {!user.preferences.intro_seen && <button className="btn" onClick={() => setPreferences({ intro_seen: true })}>Don’t show the introduction again</button>}
        <Link className="btn primary" to="/problems">Go to problems</Link>
      </div>
    </article>
  );
}
