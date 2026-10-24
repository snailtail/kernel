import { type User } from '../../api/client';

export const STATUSES = ['planned', 'active', 'maintenance', 'retired', 'missing'];
export const CRITICALITY: Record<number, string> = { 1: 'Business critical', 2: 'High', 3: 'Medium', 4: 'Low' };
export const canManage = (u: User) => u.role === 'admin' || u.role === 'manager';

export function CiStatus({ status }: { status: string }) {
  return <span className={`badge ci-status ci-${status}`}>{status}</span>;
}
