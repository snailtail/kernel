// The guard for copying text between records (#117): every path that copies a record's text into another record runs
// here with a restricted and a confidential source. The target either starts as narrow as the source, or does not hold
// the source's text. A normal source copies in full (positive control). Add a row when you add a path.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
type Narrow = 'restricted' | 'confidential' | 'normal';
let n = 0;
const secret = () => `Secret-${Date.now().toString(36)}-${++n}-payroll-share`;

interface Outcome {
  /** The record the text went into, if one was created or changed (problem, incident or change ref). */
  target?: string;
  /** Everything a broader audience could read afterwards, as text. */
  readable: string;
  /** The operation was refused (articles from narrow records). */
  refused?: boolean;
}
interface Row {
  path: string;
  kind?: 'text' | 'title';
  /** The path copies text even from an ordinary record (false: it only ever links, so there is no positive control). */
  copies?: boolean;
  run: (narrow: Narrow, text: string) => Promise<Outcome>;
}

describe('copying text between records (#117)', { skip }, () => {
  let k: Harness;
  let pm: Client;

  before(async () => {
    k = await startKernel();
    pm = await k.login('pm');
    await ownerQuery("INSERT INTO webhooks (name, url, secret, events) VALUES ('Probe', 'https://hooks.example.com/x', 'unused', '{}')");
    // People outside (#46) are the broadest audience of all: status webhooks are checked with the others below.
    await ownerQuery("INSERT INTO webhooks (name, url, secret, events) VALUES ('Status probe', 'https://hooks.example.com/s', 'unused', '{status.published}')");
  });
  after(async () => k?.close());

  /** Makes the record as narrow as asked. */
  const narrowTo = async (ref: string, narrow: Narrow) => {
    if (narrow === 'restricted') ok(await pm.put(`/api/records/${ref}/visibility`, { restricted: true, reason: 'Security investigation' }));
    if (narrow === 'confidential') ok(await pm.put(`/api/records/${ref}/classification`, { classification: 'confidential', reason: 'Personal data' }));
  };
  const dumpProblem = async (ref: string) => JSON.stringify((await ownerQuery(
    `SELECT p.title, p.description, p.root_cause, p.workaround, p.resolution, (SELECT json_agg(l) FROM problem_links l WHERE l.problem_id = p.id) AS links,
            (SELECT json_agg(a) FROM problem_activity a WHERE a.problem_id = p.id) AS activity, (SELECT json_agg(x) FROM actions x WHERE x.parent_kind = 'problem' AND x.parent_id = p.id) AS actions
     FROM problems p WHERE p.ref = $1`, [ref])).rows[0]);
  const webhooks = async () => JSON.stringify((await ownerQuery('SELECT payload FROM webhook_deliveries')).rows);
  /** A known error, narrowed before the text is written, so nothing about it went out while it was broad. */
  const knownError = async (text: string, narrow: Narrow) => {
    const p = (await pm.post('/api/problems', { title: 'Known error source' })).body.ref;
    await narrowTo(p, narrow);
    ok(await pm.post(`/api/problems/${p}/transition`, { to: 'analysis' }));
    ok(await pm.post(`/api/problems/${p}/transition`, { to: 'known_error', root_cause: text, workaround: `Workaround: ${text}` }));
    return p;
  };

  const rows: Row[] = [
    {
      path: 'incident → problem (create a problem from an incident)',
      run: async (narrow, text) => {
        const inc = (await pm.post('/api/incidents', { title: 'Payroll export', description: text })).body.ref;
        await narrowTo(inc, narrow);
        const created = await pm.post(`/api/incidents/${inc}/problem`, {});
        const p = created.body.ref;
        return { target: p, readable: await dumpProblem(p) };
      },
    },
    {
      path: 'problem → change (raise a change for the fix)',
      run: async (narrow, text) => {
        const p = await knownError(text, narrow);
        const c = (await pm.post(`/api/problems/${p}/change`, {})).body.ref;
        return { target: c, readable: JSON.stringify((await ownerQuery('SELECT title, description FROM changes WHERE ref = $1', [c])).rows[0]) };
      },
    },
    {
      path: 'problem → knowledge article (publish the known error)',
      run: async (narrow, text) => {
        const p = await knownError(text, narrow);
        const r = await pm.post(`/api/problems/${p}/article`, {});
        return { refused: r.status === 400, readable: JSON.stringify((await ownerQuery('SELECT title, body FROM articles')).rows) };
      },
    },
    {
      path: 'incident → knowledge article (draft from the resolution)',
      run: async (narrow, text) => {
        const inc = (await pm.post('/api/incidents', { title: 'Mailbox rule', description: text })).body.ref;
        ok(await pm.post(`/api/incidents/${inc}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: `Removed: ${text}` }));
        await narrowTo(inc, narrow);
        const r = await pm.post(`/api/incidents/${inc}/article`, {});
        return { refused: r.status === 400, readable: JSON.stringify((await ownerQuery('SELECT title, body FROM articles')).rows) };
      },
    },
    {
      path: 'major incident → related incident (resolution copied to the children)',
      run: async (narrow, text) => {
        const parent = (await pm.post('/api/incidents', { title: 'Outage', impact: 1, urgency: 1 })).body.ref;
        ok(await pm.post(`/api/incidents/${parent}/major`, {}));
        const child = (await pm.post('/api/incidents', { title: 'Reported again' })).body.ref;
        ok(await pm.post(`/api/incidents/${parent}/children`, { child }));
        await narrowTo(parent, narrow);
        ok(await pm.post(`/api/incidents/${parent}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: text }));
        return { readable: JSON.stringify((await ownerQuery("SELECT i.resolution, (SELECT json_agg(a.data) FROM incident_activity a WHERE a.incident_id = i.id AND a.kind = 'status') AS history FROM incidents i WHERE ref = $1", [child])).rows[0]) };
      },
    },
    {
      path: 'incident → problem link note (the incident title on an existing problem)',
      kind: 'title',
      run: async (narrow, text) => {
        const inc = (await pm.post('/api/incidents', { title: text })).body.ref;
        await narrowTo(inc, narrow);
        const p = (await pm.post('/api/problems', { title: 'Existing problem' })).body.ref;
        ok(await pm.put(`/api/incidents/${inc}/problem`, { problem: p }));
        return { readable: JSON.stringify((await ownerQuery("SELECT l.note FROM problem_links l JOIN problems p ON p.id = l.problem_id WHERE p.ref = $1 AND l.kind = 'incident'", [p])).rows) };
      },
    },
    {
      path: 'problem candidate → new problem (the evidence listed in its description, #31)',
      kind: 'title',
      run: async (narrow, text) => {
        ok(await pm.put('/api/candidates/rules/recurring_records', { settings: { min_records: 3, window_days: 7 } }));
        const ci = (await pm.post('/api/cis', { name: `cand-${secret()}`, ci_type: 'application' })).body.ref;
        const incs = [];
        for (const title of [text, 'Slow page', 'Slow page again']) incs.push((await pm.post('/api/incidents', { title, cis: [ci] })).body.ref);
        await narrowTo(incs[0], narrow);
        const created = await pm.post('/api/candidates/create', { key: `recurring_records:ci:${ci}` });
        ok(created);
        return { target: created.body.ref, readable: await dumpProblem(created.body.ref) };
      },
    },
    {
      path: 'problem candidate (changes that fail) → new problem: change titles in the link notes and description (#31)',
      kind: 'title',
      run: async (narrow, text) => {
        const ci = (await pm.post('/api/cis', { name: `chg-${secret()}`, ci_type: 'application' })).body.ref;
        const refs = [];
        for (const title of [text, 'Patch the app', 'Patch the app again']) {
          const c = (await pm.post('/api/changes', { title, cis: [ci] })).body.ref;
          // Straight to a recorded outcome: the workflow is not what this row is about.
          await ownerQuery("UPDATE changes SET status = 'review', outcome = 'rolled_back', actual_start = now(), actual_end = now() WHERE ref = $1", [c]);
          refs.push(c);
        }
        await narrowTo(refs[0], narrow);
        const created = await pm.post('/api/candidates/create', { key: `change_correlation:ci:${ci}` });
        ok(created);
        return { target: created.body.ref, readable: await dumpProblem(created.body.ref) };
      },
    },
    {
      path: 'bulk: incidents → problem link note (#110)',
      kind: 'title',
      run: async (narrow, text) => {
        const inc = (await pm.post('/api/incidents', { title: text })).body.ref;
        await narrowTo(inc, narrow);
        const p = (await pm.post('/api/problems', { title: 'Existing problem' })).body.ref;
        ok(await pm.post('/api/incidents/bulk', { ids: [inc], operation: { op: 'link_problem', problem: p } }));
        return { readable: JSON.stringify((await ownerQuery("SELECT l.note FROM problem_links l JOIN problems p ON p.id = l.problem_id WHERE p.ref = $1 AND l.kind = 'incident'", [p])).rows) };
      },
    },
    {
      path: 'bulk: related to a major incident, resolution copied to the children (#110)',
      run: async (narrow, text) => {
        const parent = (await pm.post('/api/incidents', { title: 'Outage', impact: 1, urgency: 1 })).body.ref;
        ok(await pm.post(`/api/incidents/${parent}/major`, {}));
        const child = (await pm.post('/api/incidents', { title: 'Reported again' })).body.ref;
        ok(await pm.post('/api/incidents/bulk', { ids: [child], operation: { op: 'set_parent', parent } }));
        await narrowTo(parent, narrow);
        ok(await pm.post(`/api/incidents/${parent}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: text }));
        return { readable: JSON.stringify((await ownerQuery("SELECT i.resolution, (SELECT json_agg(a.data) FROM incident_activity a WHERE a.incident_id = i.id AND a.kind = 'status') AS history FROM incidents i WHERE ref = $1", [child])).rows[0]) };
      },
    },
    {
      path: 'post-incident review factor → new problem',
      run: async (narrow, text) => {
        const inc = (await pm.post('/api/incidents', { title: 'Review source' })).body.ref;
        ok(await pm.post(`/api/incidents/${inc}/review`, {}));
        await narrowTo(inc, narrow);
        const item = (await pm.post(`/api/incidents/${inc}/review/items`, { kind: 'factor', body: text })).body.items[0];
        const r = (await pm.post(`/api/incidents/${inc}/review/items/${item.id}/problem`, {})).body;
        const p = r.items.find((x: any) => x.id === item.id).problem_ref;
        return { target: p, readable: await dumpProblem(p) + (await webhooks()) };
      },
    },
    {
      path: 'post-incident review factor → existing problem',
      copies: false,
      run: async (narrow, text) => {
        const inc = (await pm.post('/api/incidents', { title: 'Review source' })).body.ref;
        ok(await pm.post(`/api/incidents/${inc}/review`, {}));
        await narrowTo(inc, narrow);
        const p = (await pm.post('/api/problems', { title: 'Shared problem' })).body.ref;
        const item = (await pm.post(`/api/incidents/${inc}/review/items`, { kind: 'factor', body: text })).body.items[0];
        ok(await pm.post(`/api/incidents/${inc}/review/items/${item.id}/problem`, { problem: p }));
        return { readable: await dumpProblem(p) };
      },
    },
    {
      path: 'post-incident review follow-up → action',
      run: async (narrow, text) => {
        const inc = (await pm.post('/api/incidents', { title: 'Review source' })).body.ref;
        ok(await pm.post(`/api/incidents/${inc}/review`, {}));
        await narrowTo(inc, narrow);
        const p = (await pm.post('/api/problems', { title: 'Shared problem' })).body.ref;
        const item = (await pm.post(`/api/incidents/${inc}/review/items`, { kind: 'follow_up', body: text })).body.items[0];
        ok(await pm.post(`/api/incidents/${inc}/review/items/${item.id}/action`, { problem: p, title: 'Rotate credentials' }));
        return { readable: await dumpProblem(p) };
      },
    },
    {
      // The proposal names services, never the incident; a person writes and publishes what goes outside.
      path: 'major incident → status update for people outside (subscribers, organisation contacts, status webhooks)',
      copies: false,
      run: async (narrow, text) => {
        const svc = (await pm.post('/api/cis', { name: `Billing ${n}`, ci_type: 'business_service' })).body.ref;
        ok(await pm.put(`/api/status/${svc}/public`, { public: true, public_name: `Billing ${n}` }));
        ok(await pm.put('/api/admin/status-page', { public_enabled: true, title: 'Status', reason: 'Copy-text check' }));
        const inc = (await pm.post('/api/incidents', { title: text, description: text, impact: 1, urgency: 1, cis: [svc] })).body.ref;
        await narrowTo(inc, narrow);
        ok(await pm.post(`/api/incidents/${inc}/major`, {}));
        const proposal = (await pm.get(`/api/incidents/${inc}`)).body.status_proposal;
        ok(await pm.post('/api/status/updates', { incident: inc, services: proposal.services, phase: proposal.phase, status: proposal.status, message: proposal.message, public: true }));
        const outside = await fetch(`${k.base}/api/public/status`).then((r) => r.text());
        return { readable: JSON.stringify(proposal) + outside };
      },
    },
    {
      // The change names the request by ref; the answers stay on the request (#44).
      path: 'service request → standard change (its fulfilment task)',
      copies: false,
      run: async (narrow, text) => {
        ok(await (await k.login('admin')).put('/api/admin/modules', { request: true, reason: 'Copy-text check' }));
        const svc = (await pm.post('/api/cis', { name: `Requests ${n}`, ci_type: 'business_service' })).body.ref;
        const template = (await pm.post('/api/change-templates', { name: `Template ${n}-${narrow}`, max_risk: 'high', implementation_plan: 'Run it.', backout_plan: 'Undo it.' })).body.id;
        const item = (await pm.post('/api/request-items', {
          service: svc, name: `Item ${n}-${narrow}`, standard_change_template_id: template, form: [{ key: 'why', label: 'Why', type: 'textarea' }],
          fulfilment_tasks: [{ title: 'Check it' }, { title: 'Carry it out', kind: 'change' }],
        })).body.id;
        const person = (await pm.post('/api/people', { name: `Requester ${n}` })).body.id;
        const r = (await pm.post('/api/requests', { item_id: item, requester: { id: person }, answers: { why: text } })).body;
        await narrowTo(r.ref, narrow);
        ok(await pm.post(`/api/requests/${r.ref}/tasks/${r.tasks[0].id}/complete`, {}));
        const change = (await pm.get(`/api/requests/${r.ref}`)).body.tasks[1].change_ref;
        assert.ok(change, 'the change was made');
        return { target: change, readable: JSON.stringify((await ownerQuery('SELECT title, description FROM changes WHERE ref = $1', [change])).rows) };
      },
    },
    {
      path: 'post-incident review → knowledge article',
      run: async (narrow, text) => {
        const inc = (await pm.post('/api/incidents', { title: 'Review source' })).body.ref;
        ok(await pm.post(`/api/incidents/${inc}/review`, {}));
        ok(await pm.patch(`/api/incidents/${inc}/review`, { was_hard: text }));
        await narrowTo(inc, narrow);
        const r = await pm.post(`/api/incidents/${inc}/review/article`, {});
        return { refused: r.status === 400, readable: JSON.stringify((await ownerQuery('SELECT title, body FROM articles')).rows) };
      },
    },
  ];

  for (const row of rows) {
    test(row.path, async () => {
      // Positive control: from an ordinary record the text arrives.
      const plain = secret();
      const control = await row.run('normal', plain);
      if (row.copies !== false) assert.ok(!control.refused && control.readable.includes(plain), `${row.path}: an ordinary source copies its text (positive control)`);
      const narrowTexts: string[] = [];
      for (const narrow of ['restricted', 'confidential'] as const) {
        const text = secret();
        narrowTexts.push(text);
        const out = await row.run(narrow, text);
        if (out.refused) continue;
        if (row.kind === 'title' && narrow === 'confidential') {
          assert.ok(out.readable.includes(text), `${row.path}: a confidential record's title stays readable (#61)`);
          continue;
        }
        if (out.target) {
          const table = { PRB: 'problems', INC: 'incidents', CHG: 'changes' }[out.target.slice(0, 3)]!;
          const t = (await ownerQuery(`SELECT restricted, classification FROM ${table} WHERE ref = $1`, [out.target])).rows[0];
          const inherited = narrow === 'restricted' ? t.restricted : t.classification === 'confidential';
          assert.ok(inherited || !out.readable.includes(text), `${row.path}: ${out.target} must start ${narrow} or not hold the text`);
          // A confidential title is read by everyone, so the text must not be the title.
          if (narrow === 'confidential') {
            const title = (await ownerQuery(`SELECT title FROM ${table} WHERE ref = $1`, [out.target])).rows[0].title;
            assert.equal(title.includes(text), false, `${row.path}: not as the title of the confidential ${out.target}`);
          }
        } else {
          assert.equal(out.readable.includes(text), false, `${row.path}: the ${narrow} source's text reached a broader audience`);
        }
      }
      // Nothing ever left Kernel through a webhook with a narrow source's text in it.
      const sent = await webhooks();
      for (const t of narrowTexts) assert.equal(sent.includes(t), false, `${row.path}: a webhook carried the text`);
    });
  }

  test('leaving text behind is audited', async () => {
    // Free text in the audit trail is kept as a digest, so the entries are counted: every withheld copy above left one.
    const { rows } = await ownerQuery("SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'copy_text' AND action = 'withheld'");
    assert.ok(rows[0].n >= 4, `${rows[0].n} withheld copies audited`);
  });

  test('a new place that creates a record from another is noticed', async () => {
    // Where records are created. A new call site fails this test: decide whether it copies text from another record
    // (then use copyText / startNarrow from audience.ts and add a row above), and update the counts.
    const expected: Record<string, number> = {
      'problems/actions.ts': 1, 'problems/candidates.ts': 1, 'changes/changes.ts': 1, 'events/events.ts': 1, 'reporting/knowledge.ts': 1, 'mcp/changes.ts': 1, 'mcp/knowledge.ts': 1, 'mcp/problems.ts': 1, 'problems/problems.ts': 1, 'requests/requests.ts': 1, 'incidents/post-incident-reviews.ts': 3, 'routes/changes.ts': 1, 'routes/knowledge.ts': 1, 'routes/problems.ts': 1, 'security/setup.ts': 2,
      // An incident from an email (#48): its text comes from outside Kernel, not from another record.
      'incidents/inbound-mail.ts': 1,
      // Two, plus a problem reported in the portal (#45, insertPortalIncident): the person's own words, not text from
      // another record.
      'incidents/incidents.ts': 3,
    };
    const dir = new URL('../../src/', import.meta.url);
    const found: Record<string, number> = {};
    for (const f of (readdirSync(dir, { recursive: true }) as string[]).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      const calls = [...src.matchAll(/(?<!function )\b(createProblem|createProblemInTx|createArticle|createChange|insertAction|insertIncident)\(/g)].length;
      if (calls) found[f] = calls;
    }
    assert.deepEqual(found, expected);
    // The files that copy between records use the shared rule.
    for (const f of ['problems/candidates.ts', 'changes/changes.ts', 'incidents/incidents.ts', 'reporting/knowledge.ts', 'incidents/major-incidents.ts', 'requests/requests.ts', 'incidents/post-incident-reviews.ts']) {
      assert.match(readFileSync(new URL(f, dir), 'utf8'), /from '\.\.\/security\/audience\.js'/, `${f} copies between records without audience.ts`);
    }
  });
});
