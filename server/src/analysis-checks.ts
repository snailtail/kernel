// Server-side quality checks for structured analyses. The same checks feed the UI hints and the MCP tool
// check_analysis, so an agent cannot conclude an analysis while the method's basics are missing.
import type { Technique } from './analyses.js';

export interface Finding {
  level: 'error' | 'warning';
  message: string;
}

export interface CheckResult {
  ready: boolean;
  findings: Finding[];
}

const blank = (s: unknown) => typeof s !== 'string' || !s.trim();
const BLAME = /\b(human error|operator error|user error|mistake|careless|forgot|didn'?t follow)\b/i;

function fiveWhys(d: any, conclusion: string): Finding[] {
  const f: Finding[] = [];
  const whys: any[] = (d.whys ?? []).filter((w: any) => !blank(w.why) || !blank(w.because));
  if (blank(d.problem_statement)) f.push({ level: 'error', message: 'Write a precise problem statement (what goes wrong, where, when, how much).' });
  if (whys.length < 3) f.push({ level: 'warning', message: `Only ${whys.length} step(s); a real root cause usually takes 4–6 "whys".` });
  whys.forEach((w, i) => {
    if (blank(w.because)) f.push({ level: 'error', message: `Step ${i + 1} has a question but no answer.` });
    else if (blank(w.evidence) && !w.assumption) f.push({ level: 'error', message: `Step ${i + 1}: add the evidence for "${w.because.slice(0, 60)}", or mark it as an assumption to verify.` });
  });
  const assumptions = whys.filter((w) => w.assumption).length;
  if (assumptions) f.push({ level: 'warning', message: `${assumptions} step(s) are assumptions; add actions to verify them before acting on the conclusion.` });
  const last = whys[whys.length - 1];
  if (last && BLAME.test(last.because ?? '')) f.push({ level: 'warning', message: 'The chain ends at human error. Ask why the system allowed it – the fixable cause is usually a process or design gap.' });
  if (d.root_cause_in_control === null || d.root_cause_in_control === undefined) f.push({ level: 'error', message: 'Decide whether the last cause is within our control (stop criterion).' });
  else if (d.root_cause_in_control === false) f.push({ level: 'warning', message: 'The last cause is outside our control; continue with "why could it affect us?" to find what we can change.' });
  if (blank(conclusion)) f.push({ level: 'error', message: 'Write the conclusion: the root cause the chain arrived at.' });
  return f;
}

function ishikawa(d: any, conclusion: string): Finding[] {
  const f: Finding[] = [];
  if (blank(d.effect)) f.push({ level: 'error', message: 'State the effect (the problem) at the head of the fish.' });
  const cats: any[] = d.categories ?? [];
  const unconsidered = cats.filter((c) => !(c.causes ?? []).some((x: string) => x.trim()) && !c.considered).map((c) => c.name);
  if (unconsidered.length) f.push({ level: 'error', message: `Consider every category: ${unconsidered.join(', ')} have no causes and are not marked as considered.` });
  const total = cats.reduce((n, c) => n + (c.causes ?? []).filter((x: string) => x.trim()).length, 0);
  if (total < 3) f.push({ level: 'warning', message: 'Fewer than three possible causes in total; brainstorm wider before narrowing down.' });
  if (blank(conclusion)) f.push({ level: 'error', message: 'Conclude which causes contributed, based on evidence.' });
  return f;
}

function kepnerTregoe(d: any, conclusion: string): Finding[] {
  const f: Finding[] = [];
  if (blank(d.problem_statement)) f.push({ level: 'error', message: 'State the problem as object + deviation.' });
  for (const dim of ['what', 'where', 'when', 'extent']) {
    if (blank(d[dim]?.is)) f.push({ level: 'error', message: `${dim.toUpperCase()}: describe what IS affected.` });
    if (blank(d[dim]?.is_not)) f.push({ level: 'error', message: `${dim.toUpperCase()}: describe what could be affected but IS NOT – the comparison is the point of the method.` });
  }
  const causes: any[] = (d.possible_causes ?? []).filter((c: any) => !blank(c.cause));
  if (!causes.length) f.push({ level: 'error', message: 'Derive possible causes from the distinctions and changes.' });
  for (const c of causes) {
    if (c.result === 'untested') f.push({ level: 'error', message: `Test "${c.cause.slice(0, 60)}": does it explain both IS and IS NOT?` });
  }
  const explaining = causes.filter((c) => c.result === 'explains');
  if (causes.length && !explaining.length && !causes.some((c) => c.result === 'untested')) f.push({ level: 'warning', message: 'No possible cause explains everything; look for more distinctions and changes.' });
  if (explaining.length > 1) f.push({ level: 'warning', message: `${explaining.length} causes explain everything; verify which is true before acting.` });
  if (blank(conclusion)) f.push({ level: 'error', message: 'Conclude with the most probable cause and how to verify it.' });
  return f;
}

function timeline(d: any, conclusion: string): Finding[] {
  const f: Finding[] = [];
  const events: any[] = d.events ?? [];
  if (events.length < 3) f.push({ level: 'warning', message: 'Fewer than three events; add incidents, alerts, changes and recovery steps.' });
  if (!events.some((e) => e.kind === 'change' || e.kind === 'deployment')) f.push({ level: 'warning', message: 'No change or deployment on the timeline. What changed before the problem started?' });
  if (!events.some((e) => e.kind === 'incident' || e.kind === 'alert')) f.push({ level: 'warning', message: 'No incident or alert on the timeline; when was the problem detected?' });
  const missing = events.filter((e) => blank(e.description)).length;
  if (missing) f.push({ level: 'error', message: `${missing} event(s) have no description.` });
  if (events.some((e) => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(e.at ?? ''))) f.push({ level: 'error', message: 'Every event needs a date and time.' });
  if (blank(conclusion)) f.push({ level: 'error', message: 'Conclude what triggered the problem and what slowed detection or recovery.' });
  return f;
}

export function checkAnalysis(technique: Technique, data: unknown, conclusion: string): CheckResult {
  const run = { five_whys: fiveWhys, ishikawa, kepner_tregoe: kepnerTregoe, timeline }[technique];
  const findings = run((data ?? {}) as any, conclusion ?? '');
  return { ready: !findings.some((x) => x.level === 'error'), findings };
}
