import { useMemo, useState } from 'react';
import { Markdown } from '../../components/Markdown';
import { useApi } from '../../hooks';

interface OpenApi {
  info: { title: string; description: string };
  paths: Record<string, Record<string, { tags: string[]; summary: string; parameters?: { name: string; in: string; required?: boolean; schema: any }[]; requestBody?: { content: Record<string, { schema: any }> } }>>;
}

export function ApiDocsPage() {
  const { data } = useApi<OpenApi>('/api/openapi.json');
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => {
    const out = new Map<string, { method: string; path: string; op: any }[]>();
    for (const [path, ops] of Object.entries(data?.paths ?? {})) {
      for (const [method, op] of Object.entries(ops)) {
        if (filter && !`${method} ${path} ${op.summary}`.toLowerCase().includes(filter.toLowerCase())) continue;
        const tag = op.tags[0];
        out.set(tag, [...(out.get(tag) ?? []), { method, path, op }]);
      }
    }
    return [...out.entries()];
  }, [data, filter]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>API reference</h1>
          <p className="muted">REST API for scripts, integrations and agents. Machine-readable: <a href="/api/openapi.json">/api/openapi.json</a> (OpenAPI 3.1).</p>
        </div>
      </header>
      {data && <section className="card"><Markdown text={data.info.description} /></section>}
      <div className="filters"><input className="search" placeholder="Filter endpoints…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
      {groups.map(([tag, ops]) => (
        <section key={tag} className="card api-group">
          <h2>{tag}</h2>
          <ul>
            {ops.map(({ method, path, op }) => {
              const id = `${method} ${path}`;
              const body = op.requestBody?.content['application/json']?.schema;
              return (
                <li key={id}>
                  <button className="api-op" onClick={() => setOpen(open === id ? null : id)} aria-expanded={open === id}>
                    <span className={`method method-${method}`}>{method.toUpperCase()}</span>
                    <span className="mono">{path}</span>
                    <span className="muted">{op.summary}</span>
                  </button>
                  {open === id && (
                    <div className="api-detail">
                      {op.parameters && op.parameters.length > 0 && (
                        <table className="table compact">
                          <thead><tr><th>Parameter</th><th>In</th><th>Type</th><th>Required</th></tr></thead>
                          <tbody>
                            {op.parameters.map((p: any) => (
                              <tr key={p.in + p.name}><td className="mono">{p.name}</td><td>{p.in}</td><td className="mono small">{p.schema.enum ? p.schema.enum.join(' | ') : p.schema.type ?? 'any'}</td><td>{p.required ? 'yes' : ''}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {body && (<><h4>Request body</h4><pre className="schema">{JSON.stringify(body, null, 2)}</pre></>)}
                      {!body && !op.parameters?.length && <p className="muted small">No parameters.</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}
