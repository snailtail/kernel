import { useState } from 'react';
import { api } from '../../../api/client';
import { useApi } from '../../../hooks';
import { useSession } from '../../../session';
import { askReason } from '../../../components/Ask';
import { Link } from 'react-router';

/** Practices a team can switch off (#36); switching off never deletes anything. */
export function ModulesCard() {
  const { reloadMeta } = useSession();
  const { data, setData } = useApi<{ key: string; label: string; description: string; enabled: boolean }[]>('/api/admin/modules');
  const { data: setup, reload } = useApi<{ completed: boolean; demo_records: number; demo_references: { type: string; ref: string; demo_ref: string }[] }>('/api/setup');
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const toggle = async (key: string, enabled: boolean, label: string) => {
    const reason = await askReason(`${enabled ? 'Switch on' : 'Switch off'} ${label}`, enabled ? 'It reappears with all its data.' : 'It disappears from menus, the API and MCP. Nothing is deleted; switch it on again to get everything back.');
    if (!reason) return;
    setError(null);
    try {
      setData(await api.put(`/api/admin/modules`, { [key]: enabled, reason }));
      await reloadMeta();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <div className="section-head">
        <h2>Modules</h2>
        <Link className="btn-link" to="/setup">{setup?.completed ? 'Run setup again' : 'Set up Kernel'}</Link>
      </div>
      <p className="muted small">Problem management is always on. Switch off what your team does not use to keep Kernel simple. A change takes effect within 30 seconds everywhere.</p>
      <div className="module-grid">
        {data.map((m) => (
          <label key={m.key} className={`module-card ${m.enabled ? 'on' : ''}`}>
            <input type="checkbox" checked={m.enabled} onChange={(e) => toggle(m.key, e.target.checked, m.label)} />
            <strong>{m.label}</strong>
            <span className="muted small">{m.description}</span>
          </label>
        ))}
      </div>
      {!!setup?.demo_records && (
        <div className="hint-box hint-row">
          <span>
            {setup.demo_records} demo records are loaded.
            {setup.demo_references.length > 0 && <> Real records link to them and will be unlinked (with a history entry): {setup.demo_references.map((r) => `${r.ref} → ${r.demo_ref}`).join(', ')}.</>}
          </span>
          <button className="btn small" onClick={async () => {
            if (setup.demo_references.length && !window.confirm(`Unlink ${setup.demo_references.length} real record(s) from demo data and remove it?`)) return;
            try { await api.post('/api/setup/demo/remove', { confirm: setup.demo_references.length > 0 }); } catch (err) { setError((err as Error).message); }
            reload();
          }}>Remove demo data</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}
