// Problem record as a Markdown document: for major problem reviews, known error articles and archiving.
import { maskForViewer } from '../security/confidential.js';
import { getProblem } from '../problems/problems.js';

const STATUS: Record<string, string> = { new: 'New', analysis: 'Under Analysis', known_error: 'Known Error', resolved: 'Resolved', closed: 'Closed' };
const PRIORITY: Record<number, string> = { 1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low', 5: 'Planning' };
const TECHNIQUE: Record<string, string> = { five_whys: '5 Whys', ishikawa: 'Ishikawa', kepner_tregoe: 'Kepner-Tregoe', timeline: 'Timeline' };

const day = (v: string | Date | null) => (v ? new Date(v).toISOString().slice(0, 10) : '–');
const cell = (v: unknown) => String(v ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export async function problemMarkdown(ref: string) {
  // Exports leave Kernel's access control, so a confidential problem's free text is always masked in them (#61).
  const p: any = await maskForViewer(null, await getProblem(ref), ref);
  const out: string[] = [];
  const section = (title: string, body: string | null | undefined) => {
    if ((body ?? '').trim()) out.push(`## ${title}`, '', (body ?? '').trim(), '');
  };
  if (p.confidential_masked) out.push('> Confidential: the free text is not included in exports.', '');

  out.push(`# ${p.ref}: ${p.title}`, '');
  out.push(
    '| Field | Value |',
    '|---|---|',
    `| Status | ${STATUS[p.status]}${p.closure_code ? ` (${p.closure_code.replace('_', ' ')})` : ''} |`,
    `| Priority | P${p.priority} ${PRIORITY[p.priority]} (impact ${p.impact}, urgency ${p.urgency})${p.is_major ? ' – **major problem**' : ''} |`,
    `| Category / service | ${cell(p.category ?? '–')} / ${cell(p.affected_service || '–')} |`,
    `| Detection | ${p.detection} |`,
    `| Owner | ${cell(p.assignee ?? 'Unassigned')} |`,
    `| Logged | ${day(p.created_at)} by ${cell(p.created_by_name)} |`,
    ...(p.known_error_at ? [`| Known error | ${day(p.known_error_at)} |`] : []),
    ...(p.resolved_at ? [`| Resolved | ${day(p.resolved_at)} |`] : []),
    ...(p.closed_at ? [`| Closed | ${day(p.closed_at)} |`] : []),
    '',
  );

  section('Description', p.description);
  section('Root cause', p.root_cause);
  section('Workaround', p.workaround);
  if (p.known_error_at) {
    const ec = [
      `- Decision: **${p.ec_decision ?? 'pending'}**${p.ec_decided_by_name ? ` (${p.ec_decided_by_name}, ${day(p.ec_decided_at)})` : ''}`,
      p.ec_risk_level ? `- Risk of not fixing: ${['', 'high', 'medium', 'low'][p.ec_risk_level]}` : '',
      p.workaround_effectiveness ? `- Workaround: ${p.workaround_effectiveness}` : '',
      p.ec_review_date ? `- Review date: ${p.ec_review_date}` : '',
      p.ec_risk ? `\n**Risk:** ${p.ec_risk}` : '',
      p.ec_fix_cost ? `\n**Cost of fixing:** ${p.ec_fix_cost}` : '',
      p.ec_decision_note ? `\n**Rationale:** ${p.ec_decision_note}` : '',
    ].filter(Boolean).join('\n');
    section('Error control', ec);
  }
  section('Resolution', p.resolution);
  section('Major problem review', p.major_review);
  section(
    'Root cause analyses',
    p.analyses.map((a: any) => `### ${a.title} (${TECHNIQUE[a.technique]})\n\n${analysisBody(a)}${a.conclusion ? `\n\n**Conclusion:** ${a.conclusion}` : ''}`).join('\n\n'),
  );
  section(
    'Follow-up actions',
    p.actions.length
      ? ['| Action | Owner | Due | Status |', '|---|---|---|---|', ...p.actions.map((a: any) => `| ${cell(a.title)} | ${cell(a.owner ?? '–')} | ${a.due_date ?? '–'} | ${a.status} |`)].join('\n')
      : '',
  );
  section(
    'Linked records',
    p.links.length
      ? ['| Kind | Reference | System | Note |', '|---|---|---|---|', ...p.links.map((l: any) => `| ${l.kind} | ${l.url ? `[${cell(l.reference)}](${l.url})` : cell(l.reference)} | ${cell(l.system)} | ${cell(l.note)} |`)].join('\n')
      : '',
  );
  const history = [...p.activity].reverse().filter((a: any) => a.kind === 'status' || a.kind === 'created');
  section(
    'Timeline',
    history.map((a: any) => `- ${day(a.created_at)} – ${a.kind === 'created' ? 'Logged' : `${STATUS[a.data.from]} → ${STATUS[a.data.to]}`}${a.user_name ? ` (${a.user_name})` : ''}${a.body && a.kind === 'status' ? `: ${a.body}` : ''}`).join('\n'),
  );
  out.push(`---`, `_Exported from Kernel ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC_`, '');
  return out.join('\n');
}

function analysisBody(a: any) {
  const d = a.data ?? {};
  switch (a.technique) {
    case 'five_whys':
      return [d.problem_statement ? `_${d.problem_statement}_\n` : '', ...(d.whys ?? []).map((w: any, i: number) => `${i + 1}. ${w.why} → ${w.because}`)].join('\n');
    case 'ishikawa':
      return [d.effect ? `Effect: _${d.effect}_\n` : '', ...(d.categories ?? []).filter((c: any) => c.causes?.some((x: string) => x.trim())).map((c: any) => `- **${c.name}:** ${c.causes.filter((x: string) => x.trim()).join('; ')}`)].join('\n');
    case 'kepner_tregoe':
      return [
        d.problem_statement ? `_${d.problem_statement}_\n` : '',
        '| | IS | IS NOT | Distinction |', '|---|---|---|---|',
        ...['what', 'where', 'when', 'extent'].map((k) => `| ${k} | ${cell(d[k]?.is)} | ${cell(d[k]?.is_not)} | ${cell(d[k]?.distinction)} |`),
        ...(d.possible_causes?.length ? ['', ...d.possible_causes.map((c: any) => `- ${c.cause} — ${c.result.replace(/_/g, ' ')}`)] : []),
      ].join('\n');
    case 'timeline':
      return (d.events ?? []).slice().sort((x: any, y: any) => x.at.localeCompare(y.at)).map((e: any) => `- ${e.at.replace('T', ' ')} [${e.kind}] ${e.description ?? "…"}${e.reference ? ` (${e.reference})` : ''}`).join('\n');
    default:
      return '';
  }
}
