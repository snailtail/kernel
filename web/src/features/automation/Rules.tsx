// Automation rules (#49): when / if / then, written in plain sentences with dropdowns only. Managers write and enable
// rules; analysts (and agents) propose them; everyone can see what rules exist and what they did.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../../api/client';
import { formatDate, relativeTime } from '../../format';
import { useApi } from '../../hooks';
import { canEdit, useSession } from '../../session';
import type { Rule, RuleDetail, RuleList } from '../../api/types/rules';
import { words, useLookups, Sentence } from './vocabulary';
import { DryRunCard } from './components/DryRunCard';
import { RuleEditor } from './components/RuleEditor';
const RUN_STATUS: Record<string, string> = { matched: 'Ran', skipped: 'Stopped', failed: 'Failed', not_matched: 'Did not match' };

function RuleState({ rule }: { rule: Rule }) {
  if (rule.enabled) return <span className="tag rule-on">On</span>;
  if (rule.tripped_at) return <span className="tag warn-tag" title={`Turned off by its safety limit ${formatDate(rule.tripped_at)}`}>Off: safety limit</span>;
  if (rule.proposed_by_agent) return <span className="tag channel">Proposed by agent</span>;
  if (rule.recommended) return <span className="tag">Recommended, off</span>;
  return <span className="tag">Off</span>;
}

export function RulesPage() {
  const { user } = useSession();
  const { data, reload } = useApi<RuleList>('/api/rules');
  const lookups = useLookups(data?.webhooks);
  const [editing, setEditing] = useState<'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const turnOn = async (r: Rule) => {
    try {
      await api.put(`/api/rules/${r.id}/enabled`, { enabled: true });
      setError(null);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const navigate = useNavigate();
  const manage = data?.can_manage ?? false;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Automation rules</h1>
          <p className="muted">Small rules that do the routine: route new work, raise a VIP's priority, add a reminder note. Each rule runs as itself, with an analyst's permissions, and everything it does shows in the record's history.</p>
        </div>
        <div className="head-actions">{canEdit(user) && <button className="btn primary" onClick={() => setEditing('new')}>{manage ? 'New rule' : 'Propose a rule'}</button>}</div>
      </header>
      {error && <div className="error">{error}</div>}
      <section className="card flush">
        {data?.rules.length === 0 ? (
          <p className="empty">No rules yet. {manage ? 'Start with one that routes new incidents on a service to the team that supports it.' : 'Propose one, and a manager reviews and enables it.'}</p>
        ) : (
          <table className="table compact rule-table">
            <thead><tr><th>Rule</th><th>What it does</th><th>State</th><th className="num">Ran (30 days)</th><th>Last ran</th></tr></thead>
            <tbody>
              {data?.rules.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/rules/${r.id}`)}>
                  <td><Link to={`/rules/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.name}</Link></td>
                  <td><Sentence rule={r} lookups={lookups} /></td>
                  <td>
                    <RuleState rule={r} />
                    {manage && r.recommended && !r.enabled && <button className="btn small" onClick={(e) => { e.stopPropagation(); turnOn(r); }}>Turn on</button>}
                  </td>
                  <td className="num">{r.matched_30d ?? 0}{r.failed_30d ? <span className="error-text small"> · {r.failed_30d} failed</span> : null}</td>
                  <td className="muted small">{r.last_matched_at ? relativeTime(r.last_matched_at) : 'never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {(data?.other_rules.length ?? 0) > 0 && (
        <section className="card">
          <h2>Other rules</h2>
          <p className="muted small">These have their own pages, because they decide something different: what monitoring alerts become, and which patterns suggest a problem.</p>
          <ul className="plain-list other-rules">
            {data!.other_rules.map((o) => (
              <li key={o.kind}><Link to={o.path}>{o.label}</Link> <span className="muted small">{o.count} rules, {o.enabled} on</span></li>
            ))}
          </ul>
        </section>
      )}
      {editing && <RuleEditor manage={manage} webhooks={data?.webhooks ?? []} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); reload(); navigate(`/rules/${id}`); }} />}
    </>
  );
}

export function RulePage() {
  const { id } = useParams();
  const { user } = useSession();
  const { data: r, error, reload } = useApi<RuleDetail>(`/api/rules/${id}`);
  const { data: list } = useApi<RuleList>('/api/rules');
  const lookups = useLookups(list?.webhooks);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const manage = list?.can_manage ?? false;
  if (error) return <div className="error">{error}</div>;
  if (!r) return <p className="muted">Loading…</p>;
  const toggle = async () => {
    try {
      await api.put(`/api/rules/${r.id}/enabled`, { enabled: !r.enabled });
      setActionError(null);
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Remove the rule ${r.name}? Its run log goes with it; the trail keeps what it was.`)) return;
    try {
      await api.del(`/api/rules/${r.id}`);
      navigate('/rules');
    } catch (err) {
      setActionError((err as Error).message);
    }
  };
  const recordPath = (ref: string) => `/${({ INC: 'incidents', PRB: 'problems', CHG: 'changes', REQ: 'requests' } as Record<string, string>)[ref.slice(0, 3)] ?? 'records'}/${ref}`;
  return (
    <>
      <header className="page-head">
        <div>
          <p className="muted small"><Link to="/rules">Automation rules</Link></p>
          <h1>{r.name} <RuleState rule={r} /></h1>
          <p className="rule-lead"><Sentence rule={r} lookups={lookups} /></p>
          <p className="muted small">
            {r.proposed_by_agent ? 'Proposed by an agent' : r.recommended && !r.created_by ? 'Recommended, built in' : `Written by ${r.created_by ?? 'someone'}`}{r.owner && ` · owner ${r.owner}`} · changed {relativeTime(r.updated_at)}
          </p>
        </div>
        {manage && (
          <div className="head-actions">
            <button className="btn" onClick={() => setEditing(true)}>Edit</button>
            <button className={`btn ${r.enabled ? '' : 'primary'}`} onClick={toggle}>{r.enabled ? 'Turn off' : r.proposed_by_agent ? 'Review and enable' : 'Enable'}</button>
          </div>
        )}
      </header>
      {actionError && <div className="error">{actionError}</div>}
      {r.tripped_at && !r.enabled && (
        <div className="banner warn">Its safety limit turned it off {relativeTime(r.tripped_at)}: it took more than 50 actions in a minute. Check what it matched below before you enable it again.</div>
      )}
      {r.proposed_by_agent && !r.enabled && manage && (
        <div className="hint-box">An agent proposed this rule. Read the sentence, try a dry run, and enable it if it does what you want. Agents can never enable rules themselves.</div>
      )}
      <div className="rule-layout">
        <section className="card">
          <h2>Latest runs</h2>
          <p className="muted small">Last 30 days: {r.stats_30d.matched} ran, {r.stats_30d.not_matched} did not match, {r.stats_30d.skipped} stopped, {r.stats_30d.failed} failed.</p>
          {r.runs.length === 0 ? <p className="empty">It has not done anything yet.</p> : (
            <table className="table compact">
              <thead><tr><th>Record</th><th>When</th><th>Result</th><th>What it did</th></tr></thead>
              <tbody>
                {r.runs.map((x) => (
                  <tr key={x.id}>
                    <td><Link to={recordPath(x.record_ref)}>{x.record_ref}</Link></td>
                    <td className="muted small"><time title={formatDate(x.finished_at ?? x.created_at)}>{relativeTime(x.finished_at ?? x.created_at)}</time></td>
                    <td><span className={`tag run-${x.status}`}>{RUN_STATUS[x.status] ?? x.status}</span>{x.depth > 0 && <span className="muted small"> after {x.depth} {x.depth === 1 ? 'rule' : 'rules'}</span>}</td>
                    <td className="small">
                      {x.detail && <div>{x.detail}</div>}
                      {x.results.map((a, n) => <div key={n} className={a.ok ? '' : 'error-text'}>{words(a.type)}: {a.ok ? (a.note ?? 'done') : a.error}</div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <aside>
          <DryRunCard rule={r} />
          {manage && <section className="card"><button className="btn danger" onClick={remove}>Remove rule</button></section>}
        </aside>
      </div>
      {editing && canEdit(user) && <RuleEditor manage={manage} webhooks={list?.webhooks ?? []} rule={r} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </>
  );
}
