import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { GroupsPage } from './components/CmdbGraph';
import { relativeTime } from '../../format';
import { useLive } from '../../hooks/useLive';
import { useApi, useListParams, useSearchText } from '../../hooks';
import { useListToolkit } from '../../components/list/ListToolkit';
import { useColumns, type ColumnKey } from '../../components/list/columns';
import { SavedViews } from '../../components/SavedViews';
import { useSession } from '../../session';
import type { Ci, CiType } from '../../api/types/cmdb';
import { STATUSES, CRITICALITY, canManage, CiStatus } from './common';
import { CiModal } from './components/CiModal';

const CI_COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'env', label: 'Environment' }, { key: 'criticality', label: 'Criticality' },
  { key: 'team', label: 'Team' }, { key: 'sources', label: 'Sources' }, { key: 'seen', label: 'Last seen' },
];

export function CmdbListPage() {
  const { user } = useSession();
  const { params, set } = useListParams();
  const [q, setQ] = useSearchText();
  const { data: types } = useApi<CiType[]>('/api/ci-types');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const { data, loading, refresh } = useApi<Ci[]>(`/api/cis?${params}`);
  useLive(['ci:*'], refresh);
  const tk = useListToolkit({ list: 'cis', rows: data, idOf: (c) => c.ref, hrefOf: (c) => `/cis/${c.ref}`, filter: params.toString(), onChanged: refresh });
  const cols = useColumns('cis', CI_COLUMNS);
  const { data: proposals } = useApi<{ ref: string }[]>('/api/cis/retire-proposals');

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Configuration items</h1>
          <p className="muted">What we operate, as pointers to where it really lives. Services are listed first.</p>
        </div>
        <SavedViews list="cis" />
        <div className="head-actions">
          <Link className="btn" to="/services">Service catalogue</Link>
          <Link className="btn" to="/cis/groups">Groups</Link>
          {!!proposals?.length && <Link className="btn" to="/cis/retire">Proposed for retirement ({proposals.length})</Link>}
          {canManage(user) && <button className="btn primary" onClick={() => setCreating(true)}>Add CI or service</button>}
        </div>
      </header>
      <div className="filters">
        <input className="search" placeholder="Search name, tag, IP, FQDN…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={params.get('class') ?? 'all'} onChange={(e) => set('class', e.target.value === 'all' ? '' : e.target.value)}>
          <option value="all">CIs and services</option><option value="ci">CIs</option><option value="service">Services</option>
        </select>
        <select value={params.get('type') ?? ''} onChange={(e) => set('type', e.target.value)}>
          <option value="">Any type</option>
          {types?.map((t) => <option key={t.name} value={t.name}>{t.label}</option>)}
        </select>
        <select value={params.get('status') ?? 'current'} onChange={(e) => set('status', e.target.value === 'current' ? '' : e.target.value)}>
          <option value="current">Not retired</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          <option value="all">All</option>
        </select>
        <select value={params.get('environment') ?? ''} onChange={(e) => set('environment', e.target.value)}>
          <option value="">Any environment</option>{['prod', 'test', 'dev', 'other'].map((e) => <option key={e}>{e}</option>)}
        </select>
        {cols.picker}
      </div>
      <section className={`card flush ${loading ? 'is-loading' : ''}`} {...cols.container}>
        {data?.length === 0 ? <p className="empty">No configuration items match.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{tk.selectAll && <th className="check-col">{tk.selectAll}</th>}<th>Ref</th><th>Name</th><th data-col="type">Type</th><th data-col="status">Status</th><th className="hide-sm" data-col="env">Env</th><th className="hide-sm" data-col="criticality">Criticality</th><th className="hide-sm" data-col="team">Team</th><th className="hide-sm" data-col="sources">Sources</th><th className="hide-sm" data-col="seen">Last seen</th></tr></thead>
              <tbody>
                {data?.map((c, n) => (
                  <tr key={c.id} {...tk.rowProps(c, n)}>
                    {tk.selectAll && <td className="check-col">{tk.select(c, n)}</td>}
                    <td className="mono nowrap"><Link to={`/cis/${c.ref}`}>{c.ref}</Link></td>
                    <td className="title-cell"><Link to={`/cis/${c.ref}`}>{c.name}</Link></td>
                    <td className="muted" data-col="type">{c.type_label}</td>
                    <td data-col="status"><CiStatus status={c.status} /></td>
                    <td className="hide-sm" data-col="env">{c.environment}</td>
                    <td className="hide-sm" data-col="criticality"><span className={`crit crit-${c.criticality}`}>{CRITICALITY[c.criticality]}</span></td>
                    <td className="hide-sm muted" data-col="team">{c.team || '–'}</td>
                    <td className="hide-sm small" data-col="sources">{c.source_systems?.join(', ') ?? 'manual'}</td>
                    <td className="hide-sm muted nowrap" data-col="seen">{c.last_seen_at ? relativeTime(c.last_seen_at) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {tk.bar}
      {creating && types && <CiModal types={types} onClose={() => setCreating(false)} onDone={(ci) => navigate(`/cis/${ci.ref}`)} />}
    </>
  );
}

export function CiGroupsPage() {
  const { user } = useSession();
  return <GroupsPage canManage={canManage(user)} />;
}
