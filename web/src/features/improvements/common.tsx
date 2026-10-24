import { askReason, askText } from '../../components/Ask';
import { isGuided } from '../../components/Guide';
import { useApi } from '../../hooks';
import { useSession } from '../../session';
import { IMPROVEMENT_STATUS, type ImprovementStatus } from '../../statuses';
import type { LinkRow } from '../../api/types/improvements';
import './styles.css';

export const STATUSES = Object.keys(IMPROVEMENT_STATUS) as ImprovementStatus[];
/** The dashboard tiles an improvement can watch (kpis.ts TILES). */
export const KPI_LABEL: Record<string, string> = {
  mttr: 'Mean time to resolve', sla: 'Resolved within SLA', change_success: 'Change success rate', recurring: 'Recurring incidents',
  problems_resolved: 'Problems resolved', major_open: 'Open major incidents',
};

export const rating = (m: { value: number | null; effort: number | null }) => (m.value && m.effort ? `V${m.value} · E${m.effort}` : '–');
/** The matrix quadrants, the same split as the server's quick_wins filter: value 4–5 is high, effort 1–2 is low. */
export const quadrantOf = (m: { value: number | null; effort: number | null }) =>
  !m.value || !m.effort ? null : m.value >= 4 ? (m.effort <= 2 ? 'quick' : 'big') : m.effort <= 2 ? 'fill' : 'pit';

/** The continual improvement model in four lines (guided mode, #37). */
export function ModelHint() {
  const { user } = useSession();
  const { data } = useApi<{ steps: string[] }>(isGuided(user.preferences) ? '/api/improvements/model' : null);
  if (!data) return null;
  return (
    <div className="hint-box model-hint">
      <strong>The continual improvement model</strong>
      <ol>{data.steps.map((s) => <li key={s}>{s}</li>)}</ol>
    </div>
  );
}

/** Moving a card or a row: done asks for the benefit, rejecting for a reason (the same rules as the API). */
export async function transitionBody(to: ImprovementStatus, current?: string | null) {
  if (to === 'done') {
    const benefit = current?.trim() ? current : await askText('Mark done', 'What did it bring?', { confirmLabel: 'Mark done', message: 'Write down the benefit, in numbers if you have them: it is what the register is for.' });
    return benefit ? { to, benefit } : null;
  }
  if (to === 'rejected') {
    const reason = await askReason('Reject the improvement', 'Say why, so the idea is not lost and can be picked up again later.', { confirmLabel: 'Reject', danger: true });
    return reason ? { to, reason } : null;
  }
  return { to };
}

export const LINK_PATH: Record<string, (ref: string, x: LinkRow) => string | null> = {
  change: (r) => `/changes/${r}`, problem: (r) => `/problems/${r}`, incident: (r) => `/incidents/${r}`, review: (r) => `/reviews/${r}`,
  action: (_r, x) => x.action_path ?? null, document: () => null,
};
