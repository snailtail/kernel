import { Fragment, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useSession } from '../session';
import { askReason } from './Ask';
import { Markdown } from './Markdown';
import type { AiProviderList, AiResult } from '../api/types/admin';

let status: Record<string, boolean> | null = null;
/** Which AI tasks an administrator has set up (all off by default). */
export function useAiStatus() {
  const [s, setS] = useState(status);
  useEffect(() => {
    if (status) return;
    api.get<Record<string, boolean>>('/api/ai/status').then((x) => { status = x; setS(x); }, () => {});
  }, []);
  return s ?? {};
}

/** An AI result: labelled, rendered as Markdown (never HTML), and used only when a person chooses to. */
function AiOutput({ result, onUse }: { result: AiResult; onUse?: (text: string) => void }) {
  return (
    <div className="ai-output">
      <div className="ai-label">✨ AI suggestion from {result.model}: check it before you rely on it{result.lines_total ? ` · ${result.lines_sent} of ${result.lines_total} lines analysed` : ''}</div>
      <Markdown text={result.text} />
      {onUse && <button type="button" className="btn small" onClick={() => window.confirm('Save this summary as a work note, as you see it here?') && onUse(result.text)}>Save as work note</button>}
    </div>
  );
}

/** "Catch me up" on a problem, incident or change. */
export function SummaryButton({ recordRef, onAddNote }: { recordRef: string; onAddNote?: (text: string) => Promise<void> }) {
  const ai = useAiStatus();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!ai.summarize) return null;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.post<AiResult>('/api/ai/summarize', { ref: recordRef }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card ai-card">
      <div className="section-head">
        <h2>Catch me up</h2>
        <button type="button" className="btn small" onClick={run} disabled={busy}>{busy ? 'Thinking…' : result ? 'Again' : 'Summarise with AI'}</button>
      </div>
      {!result && !error && <p className="muted small">A short summary of the state, what has happened and sensible next steps, from this record's own text.</p>}
      {error && <div className="error small">{error}</div>}
      {result && <AiOutput result={result} onUse={onAddNote ? async (t) => { await onAddNote(`AI summary (${result.model}), checked by me:\n\n${t}`); setResult(null); } : undefined} />}
    </section>
  );
}

/** In the log viewer: analyse a text attachment. */
export function AnalyzeLogButton({ attachmentId }: { attachmentId: number }) {
  const ai = useAiStatus();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!ai.analyze_log) return null;
  return (
    <div className="ai-log">
      <button type="button" className="btn small" disabled={busy} onClick={async () => {
        setBusy(true);
        setError(null);
        try {
          setResult(await api.post<AiResult>('/api/ai/analyze-log', { attachment_id: attachmentId }));
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}>{busy ? 'Analysing…' : '✨ Analyse with AI'}</button>
      {error && <div className="error small">{error}</div>}
      {result && <AiOutput result={result} />}
    </div>
  );
}

/** Administration: model providers, where they run, what they may receive, and which model does which task. */
export function AiAdminSection() {
  const { user } = useSession();
  const [data, setData] = useState<AiProviderList | null>(null);
  const [form, setForm] = useState({ name: '', kind: 'openai_compatible', base_url: '', api_key: '', models: '', location: 'on_prem', personal: false, confidential: false, restricted: false, private_allow: '', monthly_token_budget: 1000000 });
  const [message, setMessage] = useState<string | null>(null);
  const load = () => api.get<typeof data>('/api/admin/ai/providers').then(setData, () => setData(null));
  useEffect(() => { load(); }, []);
  if (user.role !== 'admin' || !data) return null;
  const add = async () => {
    setMessage(null);
    try {
      await api.post('/api/admin/ai/providers', {
        name: form.name, kind: form.kind, base_url: form.base_url, ...(form.api_key ? { api_key: form.api_key } : {}),
        models: form.models.split(/[\s,]+/).filter(Boolean), location: form.location,
        data_classes: ['internal', ...(form.personal ? ['personal'] : []), ...(form.confidential ? ['confidential'] : []), ...(form.restricted ? ['restricted'] : [])],
        private_allow: form.private_allow.split(/[\s,]+/).filter(Boolean), monthly_token_budget: Number(form.monthly_token_budget),
      });
      setForm({ ...form, name: '', api_key: '', models: '' });
      load();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };
  const setRoute = async (task: string, value: string) => {
    const reason = await askReason('AI routing', value ? `${data.tasks[task]} will use ${value.split('|')[1]}.` : `${data.tasks[task]} will be turned off.`);
    if (!reason) return;
    const routing = { ...data.routing } as Record<string, { provider_id: number; model: string } | null>;
    routing[task] = value ? { provider_id: Number(value.split('|')[0]), model: value.split('|')[1] } : null;
    try {
      await api.put('/api/admin/ai/routing', { routing, reason });
      load();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>AI</h2>
      <p className="muted small">Off until you add a provider and choose a model per task. Restricted records only go to a model in your own environment that you allow; contact details never go; secrets are redacted first. Every call is audited without its content.</p>
      {data.providers.map((p) => (
        <div key={p.id} className="dev-source">
          <strong>{p.name}</strong>
          <span className="badge">{p.location === 'on_prem' ? 'own environment' : 'cloud'}</span>
          <span className="muted small">{p.kind} · {p.models.join(', ')} · may receive {p.data_classes.join(', ')} · {Number(p.tokens_this_month).toLocaleString()} of {p.monthly_token_budget ? p.monthly_token_budget.toLocaleString() : '∞'} tokens this month</span>
          <button className="btn small" onClick={async () => { try { const r = await api.post<{ reply: string }>(`/api/admin/ai/providers/${p.id}/test`, {}); setMessage(`${p.name} answered: ${r.reply}`); load(); } catch (err) { setMessage((err as Error).message); } }}>Test</button>
          <button className="btn small danger" onClick={async () => { if (window.confirm(`Remove ${p.name}?`)) { await api.del(`/api/admin/ai/providers/${p.id}`); load(); } }}>Remove</button>
        </div>
      ))}
      {data.providers.length > 0 && (
        <dl className="kv">
          {Object.entries(data.tasks).map(([task, label]) => (
            <Fragment key={task}><dt>{label}</dt>
              <dd>
                <select value={data.routing[task] ? `${data.routing[task].provider_id}|${data.routing[task].model}` : ''} onChange={(e) => setRoute(task, e.target.value)}>
                  <option value="">Off</option>
                  {data.providers.filter((p) => p.enabled).flatMap((p) => p.models.map((m) => <option key={`${p.id}|${m}`} value={`${p.id}|${m}`}>{p.name} – {m}</option>))}
                </select>
              </dd></Fragment>
          ))}
        </dl>
      )}
      <div className="form">
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Local Ollama" /></label>
        <label>Kind<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="openai_compatible">OpenAI-compatible (Ollama, vLLM, LM Studio…)</option><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option><option value="google">Google Gemini</option></select></label>
        <label className="full">Base URL<input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="http://ollama.internal:11434/v1" /></label>
        <label>API key<input type="password" autoComplete="off" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} /></label>
        <label>Models<input value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} placeholder="llama3.1:8b, qwen2.5:14b" /></label>
        <label>Runs<select value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value, restricted: e.target.value === 'on_prem' && form.restricted })}><option value="on_prem">In our own environment</option><option value="cloud">In a provider's cloud</option></select></label>
        <label>Private addresses allowed<input value={form.private_allow} onChange={(e) => setForm({ ...form, private_allow: e.target.value })} placeholder="10.0.4.0/24" /></label>
        <label className="check"><input type="checkbox" checked={form.personal} onChange={(e) => setForm({ ...form, personal: e.target.checked })} /> May receive names of people</label>
        <label className="check"><input type="checkbox" checked={form.confidential} onChange={(e) => setForm({ ...form, confidential: e.target.checked })} /> May receive the text of confidential records</label>
        <label className="check"><input type="checkbox" disabled={form.location !== 'on_prem'} checked={form.restricted} onChange={(e) => setForm({ ...form, restricted: e.target.checked })} /> May receive restricted records</label>
        <label>Monthly token budget<input type="number" min={0} value={form.monthly_token_budget} onChange={(e) => setForm({ ...form, monthly_token_budget: Number(e.target.value) })} /></label>
        <div className="actions full"><button type="button" className="btn primary" onClick={add} disabled={!form.name || !form.models}>Add provider</button></div>
      </div>
      {message && <p className="hint-box small">{message}</p>}
    </section>
  );
}
