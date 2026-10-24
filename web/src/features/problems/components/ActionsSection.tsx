import { api, type ProblemDetail } from '../../../api/client';
import { ActionsCard } from '../../../components/Actions';
import { canEdit, useSession } from '../../../session';

export function ActionsSection({ problem: p, onChange }: { problem: ProblemDetail; onChange: (p: ProblemDetail) => void }) {
  const { user } = useSession();
  return (
    <ActionsCard parent={p.ref} actions={p.actions} editable={canEdit(user)} onChanged={() => api.get<ProblemDetail>(`/api/problems/${p.ref}`).then(onChange)}
      placeholder="No follow-up actions. Add actions for fixes, vendor follow-ups, monitoring or review outcomes." />
  );
}
