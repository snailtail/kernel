import { useState } from 'react';
import { api } from '../../../api/client';
import { relativeTime } from '../../../format';
import { useApi } from '../../../hooks';
import { FormModal, Modal } from '../../../components/Modal';
import { askReason } from '../../../components/Ask';
import type { Delivery, Webhook, WebhookList } from '../../../api/types/admin';

export function WebhooksCard() {
  const { data, reload } = useApi<WebhookList>('/api/webhooks');
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  const [log, setLog] = useState<Webhook | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const ping = async (w: Webhook) => {
    const d = await api.post<Delivery>(`/api/webhooks/${w.id}/ping`);
    setMessage(d.status === 'ok' ? `Test delivery to ${w.name} succeeded (HTTP ${d.response_status}).` : `Test delivery to ${w.name} failed: ${d.last_error}`);
    reload();
  };
  const rotate = async (w: Webhook) => {
    if (!confirm(`Replace the signing secret of ${w.name}? Receivers must be updated with the new secret.`)) return;
    setSecret({ name: w.name, secret: (await api.post<{ secret: string }>(`/api/webhooks/${w.id}/rotate`)).secret });
    reload();
  };

  return (
    <section className="card">
      <div className="section-head">
        <h2>Webhooks</h2>
        <button className="btn primary small" onClick={() => setEditing('new')}>Add webhook</button>
      </div>
      <p className="muted small">
        Kernel POSTs problem events to these URLs, signed per <a href="https://www.standardwebhooks.com/" target="_blank" rel="noreferrer noopener">Standard Webhooks</a>
        (<code>webhook-id</code>, <code>webhook-timestamp</code>, <code>webhook-signature</code>). Payloads contain ref, title, status and a link, never long texts.
        Failed deliveries are retried with backoff. Private network addresses must be allowed with <code>KERNEL_OUTBOUND_ALLOW</code>.
      </p>
      {message && <div className={message.includes('failed') ? 'error' : 'success'}>{message}</div>}
      {data?.webhooks.length === 0 && <p className="empty">No webhooks yet.</p>}
      {data && data.webhooks.length > 0 && (
        <table className="table compact">
          <thead><tr><th>Name</th><th>URL</th><th>Format</th><th>Events</th><th>Last delivery</th><th /></tr></thead>
          <tbody>
            {data.webhooks.map((w) => (
              <tr key={w.id} className={w.active ? '' : 'inactive'}>
                <td>{w.name}{w.failed > 0 && <span className="badge major" title="Failed deliveries"> {w.failed} failed</span>}</td>
                <td className="mono small url-cell">{w.url}</td>
                <td>{w.format}</td>
                <td className="small">{w.events.length ? w.events.join(', ') : 'All problem events'}</td>
                <td className="nowrap">{w.last_delivered_at ? relativeTime(w.last_delivered_at) : '–'}</td>
                <td className="nowrap row-links">
                  <button className="btn-link" onClick={() => ping(w)}>Test</button>
                  <button className="btn-link" onClick={() => setLog(w)}>Log</button>
                  <button className="btn-link" onClick={() => rotate(w)} title={`Secret set ${relativeTime(w.secret_set_at)}`}>Rotate secret</button>
                  <button className="btn-link" onClick={() => setEditing(w)}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && data && (
        <WebhookModal
          hook={editing === 'new' ? null : editing}
          events={data.events}
          formats={data.formats}
          onClose={() => setEditing(null)}
          onDone={(created) => { setEditing(null); reload(); if (created?.secret) setSecret({ name: created.name, secret: created.secret }); }}
        />
      )}
      {log && <DeliveriesModal hook={log} onClose={() => setLog(null)} />}
      {secret && (
        <Modal title={`Signing secret – ${secret.name}`} onClose={() => setSecret(null)}>
          <p className="muted">Copy it now – it will not be shown again. Receivers use it to verify the <code>webhook-signature</code> header (Standard Webhooks libraries accept it as is).</p>
          <pre className="secret">{secret.secret}</pre>
        </Modal>
      )}
    </section>
  );
}

function WebhookModal({ hook, events, formats, onClose, onDone }: { hook: Webhook | null; events: string[]; formats: string[]; onClose: () => void; onDone: (w?: Webhook) => void }) {
  const [form, setForm] = useState({ name: hook?.name ?? '', url: hook?.url ?? '', format: hook?.format ?? 'json', events: hook?.events ?? [], services: hook?.services ?? [], active: hook?.active ?? true });
  const { data: services } = useApi<{ ref: string; name: string }[]>('/api/cis?class=service&limit=200');
  const submit = async () => {
    onDone(hook ? await api.put<Webhook>(`/api/webhooks/${hook.id}`, form) : await api.post<Webhook>('/api/webhooks', form));
  };
  const remove = async () => {
    const reason = hook ? await askReason(`Delete ${hook.name}`, 'The webhook and its delivery log are deleted.', { confirmLabel: 'Delete webhook', danger: true }) : null;
    if (hook && reason) {
      await api.post(`/api/webhooks/${hook.id}/delete`, { reason });
      onDone();
    }
  };
  const toggle = (ev: string) => setForm({ ...form, events: form.events.includes(ev) ? form.events.filter((x) => x !== ev) : [...form.events, ev] });
  return (
    <FormModal title={hook ? `Edit ${hook.name}` : 'Add webhook'} submitLabel="Save" onClose={onClose} onSubmit={submit}
      actions={hook && <button type="button" className="btn-link danger spacer-right" onClick={remove}>Delete</button>}>
      <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Team chat" /></label>
      <label>Format
        <select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
          {formats.map((f) => <option key={f} value={f}>{({ json: 'Generic JSON', slack: 'Slack', teams_workflow: 'Microsoft Teams (Workflows)', teams: 'Microsoft Teams (legacy connector)' } as Record<string, string>)[f] ?? f}</option>)}
        </select>
      </label>
      <label className="full">URL<input required type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://hooks.slack.com/services/…" /></label>
      <fieldset className="full event-picker">
        <legend>Events <span className="muted small">(none selected = all problem events)</span></legend>
        {events.map((ev) => (
          <label key={ev} className="check"><input type="checkbox" checked={form.events.includes(ev)} onChange={() => toggle(ev)} /> {ev}</label>
        ))}
      </fieldset>
      {form.events.includes('status.published') && (
        <fieldset className="full event-picker">
          <legend>Status updates for <span className="muted small">(none selected = every public service; only published text under public names is sent)</span></legend>
          {(services ?? []).map((sv) => (
            <label key={sv.ref} className="check"><input type="checkbox" checked={form.services.includes(sv.ref)} onChange={() => setForm({ ...form, services: form.services.includes(sv.ref) ? form.services.filter((x) => x !== sv.ref) : [...form.services, sv.ref] })} /> {sv.name}</label>
          ))}
        </fieldset>
      )}
      <label className="check full"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
    </FormModal>
  );
}

function DeliveriesModal({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
  const { data } = useApi<Delivery[]>(`/api/webhooks/${hook.id}/deliveries`);
  return (
    <Modal title={`Deliveries – ${hook.name}`} onClose={onClose}>
      {data?.length === 0 && <p className="empty">No deliveries yet.</p>}
      {data && data.length > 0 && (
        <table className="table compact">
          <thead><tr><th>When</th><th>Event</th><th>Problem</th><th>Status</th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.id}>
                <td className="nowrap">{relativeTime(d.created_at)}</td>
                <td>{d.event}</td>
                <td className="mono">{d.ref ?? '–'}</td>
                <td title={d.last_error ?? undefined}>
                  <span className={`badge ${d.status === 'ok' ? 'status-resolved' : d.status === 'failed' ? 'major' : 'status-known_error'}`}>{d.status}</span>
                  {d.attempts > 1 && <span className="muted small"> {d.attempts} attempts</span>}
                  {d.last_error && d.status !== 'ok' && <div className="muted small">{d.last_error}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
