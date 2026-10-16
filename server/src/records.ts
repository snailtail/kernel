// The registry of record types. Every practice (problems today; incidents, changes, CIs… later) registers here with
// the same conventions, so generic REST/MCP tools (search, get_record, link_records, next_steps, my_work) and the
// parity test work for all of them. See docs/api-conventions.md.
import type { User } from './auth.js';
import { config } from './config.js';
import { notFound } from './errors.js';
import type { Action } from './policy.js';

export interface SearchHit {
  type: string;
  ref: string;
  title: string;
  status: string;
  url: string;
  summary?: string;
}

export interface RecordType {
  type: string;
  /** Ref prefix, e.g. PRB in PRB000012. */
  prefix: string;
  /** The full ref format when the prefix alone could match references from other tools. */
  pattern?: RegExp;
  readAction: Action;
  /** Path of the record in the web UI. */
  uiPath: (ref: string) => string;
  get: (user: User, ref: string) => Promise<Record<string, unknown>>;
  search: (user: User, q: string, limit: number) => Promise<SearchHit[]>;
  /** REST routes (Fastify paths) every record type must provide. */
  rest: { list: string; create: string; get: string; update: string; transition: string; links: string; comments: string };
  /** MCP tools every record type must provide. */
  mcp: { list: string; get: string; create: string; update: string; transition: string };
  /**
   * Where its history lives in the audit trail: the entity type (default: the type) and the refs it was audited
   * under (default: the record's ref), given the record as `get` returned it.
   */
  history?: { entityType: string; refs?: (record: Record<string, unknown>) => string[] };
}

const registry = new Map<string, RecordType>();

export function registerRecordType(t: RecordType) {
  registry.set(t.type, t);
}

export const recordTypes = () => [...registry.values()];

/** Deep link to the record in the web UI (absolute when KERNEL_PUBLIC_URL is set). */
export const recordUrl = (t: RecordType, ref: string) => `${(config.publicUrl ?? '').replace(/\/$/, '')}${t.uiPath(ref)}`;

export function typeForRef(ref: string) {
  const prefix = ref.toUpperCase().match(/^[A-Z]+/)?.[0];
  const t = recordTypes().find((r) => r.prefix === prefix && (!r.pattern || r.pattern.test(ref.toUpperCase())));
  if (!t) throw notFound(`No record type for reference ${ref}`);
  return t;
}
