import { formatDate } from '../../format';

export const OUTCOME: Record<string, string> = { successful: 'Successful', failed: 'Failed', rolled_back: 'Rolled back' };

export const fmtWindow = (s: string | null, e: string | null) => (s ? `${formatDate(s)}${e ? ` – ${formatDate(e)}` : ''}` : 'Not planned');
