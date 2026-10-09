import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api';
import { useApi } from '../hooks';
import { useSession } from '../session';

interface ModuleInfo { key: string; label: string; description: string; enabled: boolean }
interface State { completed: boolean; has_real_data: boolean; demo_records: number; modules: ModuleInfo[] }

const STEPS = ['What Kernel should help with', 'Support hours', 'Monitoring', 'Example data'] as const;

/** First-run setup: every step can be skipped, and running it again never duplicates anything. */
export function SetupPage() {
  const { user, reloadMeta } = useSession();
  const navigate = useNavigate();
  const { data } = useApi<State>('/api/setup');
  const [step, setStep] = useState(0);
  const [mods, setMods] = useState<Record<string, boolean> | null>(null);
  const [hours, setHours] = useState<'' | '24/7' | 'office'>('');
  const [source, setSource] = useState({ kind: '', name: '' });
  const [demo, setDemo] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  if (user.role !== 'admin') return <p className="empty">Setup is done by an administrator.</p>;
  if (!data) return null;
  const modules = mods ?? Object.fromEntries(data.modules.map((m) => [m.key, m.enabled]));
  const finish = async () => {
    setError(null);
    try {
      const r = await api.post<any>('/api/setup', {
        modules,
        ...(hours ? { support_hours: hours } : {}),
        ...(source.kind && source.name ? { first_source: source } : {}),
        ...(demo ? { demo_data: true } : {}),
      });
      setResult(r.result);
      await reloadMeta();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (result) {
    return (
      <section className="card setup">
        <h1>Kernel is ready</h1>
        {result.first_source?.token && (
          <div className="warn-box">
            Copy the token for <strong>{source.name}</strong> now – it is shown only once:
            <div className="mono">{result.first_source.token}</div>
            <div className="small">Webhook URL: <span className="mono">{location.origin}{result.first_source.url}</span>. Setup steps are under Events → Sources.</div>
          </div>
        )}
        {result.demo?.loaded && <p>Example data is loaded ({result.demo.refs.join(', ')}). Remove it in one click under Administration when you are done exploring.</p>}
        <div className="actions"><button className="btn primary" onClick={() => navigate('/')}>Go to My work</button><Link className="btn" to="/guide">How problem management works</Link></div>
      </section>
    );
  }
  return (
    <section className="card setup">
      <div className="setup-head">
        <h1>Set up Kernel</h1>
        <span className="muted small">Step {step + 1} of {STEPS.length} · every step can be skipped and changed later</span>
      </div>
      <ol className="setup-steps">{STEPS.map((s, n) => <li key={s} className={n === step ? 'on' : n < step ? 'done' : ''}>{s}</li>)}</ol>
      {step === 0 && (
        <>
          <p>Problem management is always on. Switch on only what your team needs now; the rest stays out of the way.</p>
          <div className="module-grid">
            {data.modules.map((m) => (
              <label key={m.key} className={`module-card ${modules[m.key] ? 'on' : ''}`}>
                <input type="checkbox" checked={!!modules[m.key]} onChange={(e) => setMods({ ...modules, [m.key]: e.target.checked })} />
                <strong>{m.label}</strong>
                <span className="muted small">{m.description}</span>
              </label>
            ))}
          </div>
        </>
      )}
      {step === 1 && (
        <>
          <p>SLA targets for incidents count business time. When is your team there to help?</p>
          <div className="module-grid">
            <label className={`module-card ${hours === 'office' ? 'on' : ''}`}><input type="radio" name="hours" checked={hours === 'office'} onChange={() => setHours('office')} /><strong>Office hours</strong><span className="muted small">Monday–Friday 08–17, Swedish public holidays closed</span></label>
            <label className={`module-card ${hours === '24/7' ? 'on' : ''}`}><input type="radio" name="hours" checked={hours === '24/7'} onChange={() => setHours('24/7')} /><strong>Around the clock</strong><span className="muted small">24/7, every day</span></label>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <p>Connect a monitoring tool so its alerts arrive in Kernel. You can add more under Events → Sources.</p>
          <div className="form">
            <label>Tool<select value={source.kind} onChange={(e) => setSource({ kind: e.target.value, name: source.name || e.target.selectedOptions[0].text })}>
              <option value="">Not now</option><option value="uptime_kuma">Uptime Kuma</option><option value="alertmanager">Prometheus Alertmanager</option><option value="azure_monitor">Azure Monitor</option><option value="op5">OP5 / Naemon</option><option value="generic">Something else (generic JSON)</option>
            </select></label>
            {source.kind && <label>Name<input value={source.name} onChange={(e) => setSource({ ...source, name: e.target.value })} /></label>}
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <p>Explore Kernel with a small example: a webshop service, an incident, a known error with a workaround, and a change to fix it. It is marked as demo data and can be removed in one action.</p>
          {data.has_real_data ? <p className="hint-box">Kernel already contains real data, so example data is not offered.</p> : (
            <label className="check"><input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} /> Load example data</label>
          )}
        </>
      )}
      {error && <div className="error">{error}</div>}
      <div className="actions">
        {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>Back</button>}
        <button className="btn-link" onClick={finish}>Skip the rest</button>
        {step < STEPS.length - 1 ? <button className="btn primary" onClick={() => setStep(step + 1)}>Next</button> : <button className="btn primary" onClick={finish}>Finish</button>}
      </div>
    </section>
  );
}
