import { type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { TEXT } from './text';

export interface Me { name: string; report_problem: boolean; requests: boolean; status: boolean }
interface Update { at: string; from: 'you' | 'it'; by: string; body: string }
export interface Ticket {
  kind: 'problem_report' | 'request';
  ref: string;
  title: string | null;
  status: string;
  status_label: string;
  handled_by: string;
  created_at: string;
  updated_at: string;
  can: { add_information: boolean; confirm: boolean; rate: boolean };
  rating: 'good' | 'okay' | 'bad' | null;
  updates?: Update[];
}

export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const errorText = (err: unknown) => (err instanceof ApiError ? err.message : TEXT.error);
export const tone = (t: Ticket) => (['closed', 'fulfilled', 'cancelled', 'rejected'].includes(t.status) ? 'done' : t.status === 'resolved' ? 'solved' : t.status === 'on_hold' || t.status === 'awaiting_approval' ? 'waiting' : 'open');

/** A focused message for screen readers when something happens (sent, saved, failed). */
export function Notice({ kind, children }: { kind: 'ok' | 'error'; children: ReactNode }) {
  return <p className={`portal-notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</p>;
}

export interface CatalogueItem { id: number; name: string; description: string; needs_approval: boolean; service: string | null; form?: { key: string; label: string; type: 'text' | 'textarea' | 'choice' | 'date'; required: boolean; choices: string[] }[] }
