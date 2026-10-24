import { useEffect } from 'react';
import { Link } from 'react-router';
import { useSession } from '../../session';
import { GlossaryList } from '../../components/Glossary';
import { ProcessMap } from '../../components/ProcessMap';

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
  // Glossary links (/guide#term-…) scroll to the term.
  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
  }, []);
  const { user, meta, setPreferences } = useSession();
  return (
    <article className="guide-page">
      <header className="page-head">
        <div>
          <h1>How it all fits together</h1>
          <p className="muted">From an alert to a permanent fix, based on ITIL 4. Click a step to see what it is for and where your work is.</p>
        </div>
      </header>
      <ProcessMap />
      <section className="card prose-card">
        <h2>Walk through a scenario</h2>
        <ol className="scenarios">
          {meta.modules?.event !== false && meta.modules?.incident !== false && <li><strong>A server goes down.</strong> An alert arrives under <Link to="/events">Events</Link>; a rule opens an incident on the affected service. The incident page shows what else is affected and any known workaround.</li>}
          <li><strong>The same thing keeps happening.</strong> Recurring incidents show up as <Link to="/candidates">problem candidates</Link>. Log a problem, analyse the root cause with 5 Whys, and document a workaround – it now appears on new incidents for the same CI.</li>
          {meta.modules?.change !== false && <li><strong>Planning the fix.</strong> On the known error, decide to fix it; the guide offers to raise a change, prefilled from the root cause. It is assessed, authorised and scheduled outside freezes.</li>}
          <li><strong>Making sure it worked.</strong> When the change succeeds, resolve the problem and watch for new incidents before closing. Major problems get a review: what went well, what to improve.</li>
        </ol>
      </section>
      <h2 className="section-title">Problem management in 5 minutes</h2>
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
      <section className="card prose-card" id="glossary">
        <h2>Glossary</h2>
        <GlossaryList />
      </section>
    </article>
  );
}
