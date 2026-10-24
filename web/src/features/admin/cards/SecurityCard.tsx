import { api, type Role } from '../../../api/client';
import { ROLE_LABEL } from '../../../format';
import { useApi } from '../../../hooks';
import { useSession } from '../../../session';
import { askReason } from '../../../components/Ask';
import '../styles.css';

export function SecurityCard() {
  const { meta } = useSession();
  const { data, reload } = useApi<{ checks: { id: string; label: string; ok: boolean; detail: string }[] }>('/api/admin/security');
  const { data: policy, reload: reloadPolicy } = useApi<{ required_roles: Role[] }>('/api/admin/mfa-policy');
  const toggleRole = async (role: Role) => {
    if (!policy) return;
    const roles = policy.required_roles.includes(role) ? policy.required_roles.filter((r) => r !== role) : [...policy.required_roles, role];
    const reason = await askReason('Change two-factor policy', `Two-factor authentication will ${policy.required_roles.includes(role) ? 'no longer be' : 'be'} required for ${ROLE_LABEL[role]}.`, { confirmLabel: 'Change policy' });
    if (!reason) return;
    await api.put('/api/admin/mfa-policy', { required_roles: roles, reason });
    reloadPolicy();
    reload();
  };
  const { data: approvals, reload: reloadApprovals } = useApi<{ required: boolean }>('/api/admin/mcp-approvals');
  const toggleApprovals = async () => {
    if (!approvals) return;
    const reason = await askReason('Decisions through MCP', approvals.required ? 'Agents will be able to make decisions without approval in the web UI.' : 'Agent decisions will wait for approval in the web UI.', { confirmLabel: 'Change setting', danger: approvals.required });
    if (!reason) return;
    await api.put('/api/admin/mcp-approvals', { required: !approvals.required, reason });
    reloadApprovals();
  };
  const { data: aiData, reload: reloadAiData } = useApi<{ attachment_images: boolean; flagged_text: boolean; restricted_records: boolean }>('/api/admin/ai-data');
  const { data: vis, reload: reloadVis } = useApi<{ team_scoped: Record<string, boolean>; restricted_categories: number[]; break_glass: { record_type: string; record_id: number; user_name: string; reason: string; expires_at: string }[] }>('/api/admin/visibility');
  const saveVis = async (next: { team_scoped: Record<string, boolean>; restricted_categories: number[] }, what: string) => {
    const reason = await askReason('Visibility', what, { confirmLabel: 'Change setting' });
    if (!reason) return;
    await api.put('/api/admin/visibility', { team_scoped: { incident: false, problem: false, change: false, ...next.team_scoped }, restricted_categories: next.restricted_categories, reason });
    reloadVis();
  };
  const toggleAiData = async (key: 'attachment_images' | 'flagged_text' | 'restricted_records') => {
    if (!aiData) return;
    const on = !aiData[key];
    const what = key === 'attachment_images' ? 'Screenshots and other images' : key === 'restricted_records' ? 'Restricted records (to agents whose user may see them)' : 'Text attachments flagged as possibly containing secrets or personal identity numbers';
    const reason = await askReason('Attachments for AI agents', `${what} will ${on ? '' : 'no longer '}be sent to the AI provider when an agent reads them through MCP.`, { confirmLabel: 'Change setting', danger: on });
    if (!reason) return;
    await api.put('/api/admin/ai-data', { ...aiData, [key]: on, reason });
    reloadAiData();
  };
  const { data: sens, reload: reloadSens } = useApi<{ secrets: 'redact' | 'block'; flag_personal: boolean; flag_ips: boolean }>('/api/admin/sensitive-data');
  const saveSens = async (next: Partial<NonNullable<typeof sens>>, what: string) => {
    if (!sens) return;
    const reason = await askReason('Sensitive data', what, { confirmLabel: 'Change setting' });
    if (!reason) return;
    await api.put('/api/admin/sensitive-data', { ...sens, ...next, reason });
    reloadSens();
  };
  if (!data) return null;
  const failing = data.checks.filter((c) => !c.ok).length;
  return (
    <section className="card">
      <div className="section-head">
        <h2>Security status</h2>
        <span className={`badge ${failing ? 'major' : 'status-resolved'}`}>{failing ? `${failing} to review` : 'All good'}</span>
      </div>
      <ul className="checklist">
        {data.checks.map((c) => (
          <li key={c.id} className={c.ok ? 'ok' : 'warn'}>
            <span className="check-mark" aria-hidden="true">{c.ok ? '✓' : '!'}</span>
            <div><strong>{c.label}</strong><div className="muted small">{c.detail}</div></div>
          </li>
        ))}
      </ul>
      {approvals && (
        <div className="mfa-policy">
          <h3>Decisions through MCP</h3>
          <label className="check">
            <input type="checkbox" checked={approvals.required} onChange={toggleApprovals} />
            AI agents' decisions (closing, accepting or deferring risk, marking duplicates) wait for a person to approve them in the web UI
          </label>
          {!approvals.required && <p className="warn-box">Agents act directly on a quoted confirmation, which a prompt injection could fabricate.</p>}
        </div>
      )}
      {sens && (
        <div className="mfa-policy">
          <h3>Sensitive data in records</h3>
          <p className="muted small">Kernel scans what people and integrations write – descriptions, comments, events, text attachments – for passwords, keys, tokens and card numbers, and for personal data.</p>
          <label className="check"><input type="radio" name="sens-secrets" checked={sens.secrets === 'redact'} onChange={() => saveSens({ secrets: 'redact' }, 'Secrets will be replaced with [REDACTED] before they are stored, and the writer is told.')} /> Replace secrets with [REDACTED] and save the rest</label>
          <label className="check"><input type="radio" name="sens-secrets" checked={sens.secrets === 'block'} onChange={() => saveSens({ secrets: 'block' }, 'Text with secrets will be refused until the writer removes them. Monitoring and integrations are still accepted, redacted.')} /> Refuse text with secrets (monitoring and integrations are still redacted, never refused)</label>
          <label className="check"><input type="checkbox" checked={sens.flag_personal} onChange={() => saveSens({ flag_personal: !sens.flag_personal }, `Records will ${sens.flag_personal ? 'no longer ' : ''}be marked when their text holds personal identity numbers or email addresses.`)} /> Mark records that hold personal data (personal identity numbers, email addresses)</label>
          <label className="check"><input type="checkbox" checked={sens.flag_ips} onChange={() => saveSens({ flag_ips: !sens.flag_ips }, `IP addresses will ${sens.flag_ips ? 'no longer ' : ''}count as personal data.`)} /> Count IP addresses as personal data</label>
        </div>
      )}
      {aiData && (
        <div className="mfa-policy">
          <h3>Attachments for AI agents</h3>
          <p className="muted small">What an AI agent may read through MCP is sent to the AI provider. Text attachments without flags are always readable.</p>
          <label className="check"><input type="checkbox" checked={aiData.attachment_images} onChange={() => toggleAiData('attachment_images')} /> Images (screenshots may show names, customer data or credentials)</label>
          <label className="check"><input type="checkbox" checked={aiData.flagged_text} onChange={() => toggleAiData('flagged_text')} /> Text flagged as possibly containing secrets or personal identity numbers</label>
          <label className="check"><input type="checkbox" checked={!!aiData.restricted_records} onChange={() => toggleAiData('restricted_records')} /> Restricted records (only to agents whose user may see them)</label>
        </div>
      )}
      {vis && (
        <div className="mfa-policy">
          <h3>Visibility</h3>
          <p className="muted small">Restricted records are seen only by their assignee, creator and named teams. Team scoping shows analysts and viewers their teams' work, unteamed work and their own.</p>
          {(['incident', 'problem', 'change'] as const).map((k) => (
            <label key={k} className="check"><input type="checkbox" checked={!!vis.team_scoped[k]} onChange={() => saveVis({ ...vis, team_scoped: { ...vis.team_scoped, [k]: !vis.team_scoped[k] } }, `${k[0].toUpperCase()}${k.slice(1)}s will ${vis.team_scoped[k] ? 'be visible to everyone again' : 'be scoped to teams'}.`)} /> Scope {k}s to teams</label>
          ))}
          <div className="chip-row">
            <span className="muted small">Start restricted:</span>
            {meta.categories.filter((c) => c.active).map((c) => (
              <label key={c.id} className="check small"><input type="checkbox" checked={vis.restricted_categories.includes(c.id)} onChange={(e) => saveVis({ ...vis, restricted_categories: e.target.checked ? [...vis.restricted_categories, c.id] : vis.restricted_categories.filter((x) => x !== c.id) }, `New records in "${c.name}" will ${e.target.checked ? 'start restricted' : 'no longer start restricted'}.`)} /> {c.name}</label>
            ))}
          </div>
          {vis.break_glass.length > 0 && (
            <ul className="plain-list">{vis.break_glass.map((b, n) => <li key={n} className="warn-box small">{b.user_name} opened a restricted {b.record_type} until {new Date(b.expires_at).toLocaleTimeString()}: {b.reason}</li>)}</ul>
          )}
        </div>
      )}
      {policy && (
        <div className="mfa-policy">
          <h3>Two-factor policy</h3>
          <p className="muted small">Users in these roles must set up two-factor authentication before they can use Kernel.</p>
          <div className="chip-row">
            {meta.roles.filter((r) => r !== 'integration').map((r) => (
              <label key={r} className="check"><input type="checkbox" checked={policy.required_roles.includes(r)} onChange={() => toggleRole(r)} /> {ROLE_LABEL[r]}</label>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
