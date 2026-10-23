// The registry of record types. Every practice (problems today; incidents, changes, CIs… later) registers here with
// the same conventions, so generic REST/MCP tools (search, get_record, link_records, next_steps, my_work) and the
// parity test work for all of them. See docs/api-conventions.md.
import type { User } from './auth.js';
import { notFound } from './errors.js';
import type { Module } from './modules.js';
import type { Action } from './policy.js';
import { absoluteUrl } from './core/url.js';
import type { Db } from './db.js';


export interface SearchHit {
  type: string;
  ref: string;
  title: string;
  status: string;
  url: string;
  summary?: string;
}

/** One entry in a record's activity log, as logActivity wrote it. */
export interface ActivityEntry { id: number; recordId: number; userId: number | null; kind: string; body: string; data: object }

/**
 * A table that holds a record's free text: the rows of `key` = the record's id (redaction, #61); in a register shared
 * by several kinds (actions, #184) only those with `parent_kind` = `parentKind`.
 */
export interface TextPlace { table: string; key: string; columns: string[]; json?: string[]; parentKind?: string }

/**
 * Who works on a record (confidential text, #61): the assignee column and the team column, or null where the kind
 * has none; `extra` adds a rule of its own, as SQL for record alias `a` and user `u`.
 */
export interface People { assignee: string | null; team: string | null; extra?: (a: string, u: string) => string }

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
   * under (default: the record's ref), given the record as `get` returned it. `mentions` adds entries of another
   * entity type whose changes contain the given JSON, such as the sync batches that created or updated a CI.
   */
  history?: { entityType?: string; refs?: (record: Record<string, unknown>) => string[]; mentions?: (record: Record<string, unknown>) => { entity_type: string; changes: unknown }[] };
  /** The table its rows live in (with `id` and `ref`). */
  table: string;
  /**
   * Its activity log (none for a kind whose notes go in another record's): the table, the column that points at the
   * record, extra columns the history shows, how many entries it shows (default all), and what else an entry does
   * (`after`: touch, audit, rules, notices…).
   */
  activity?: { table: string; fk: string; columns?: string[]; limit?: number; after?: (db: Db, entry: ActivityEntry) => Promise<void> };
  /** For a kind without a log of its own: the kind whose log holds its notes, and the column of its table that points there. */
  notesIn?: { type: string; fk: string };
  /** The module it belongs to, when it can be switched off (#36). */
  module?: Module;
  /**
   * Kinds that hold people's free text: who works on them, and every place their text can be. These kinds can be
   * confidential (#61), restricted (#53), marked as holding personal data, and have their history redacted.
   */
  people?: People;
  textPlaces?: TextPlace[];
  /** The topic live updates (#70) use for it: its database trigger sends "topic:id" on kernel_live. */
  liveTopic?: string;
  /** A work note, through the practice's own rules (generic add_comment). */
  comment: (user: User, ref: string, body: string) => Promise<unknown>;
  /** Changes fields through the practice's own rules (automation rules' set_field and assign_team). */
  update?: (user: User, ref: string, input: Record<string, unknown>) => Promise<unknown>;
  /** Moves the record to another status through the practice's own rules (automation rules' transition). */
  transition?: (user: User, ref: string, input: { to: string }) => Promise<unknown>;
}

const registry = new Map<string, RecordType>();

export function registerRecordType(t: RecordType) {
  registry.set(t.type, t);
}

/**
 * Every registered type. The domains register when they are imported (app.ts imports them all); an empty registry
 * would silently switch masking and visibility off, so it throws instead.
 */
export function recordTypes() {
  if (!registry.size) throw new Error('No record types registered: import the domain modules first');
  return [...registry.values()];
}

/** The type with this name (problem, incident…). */
export function recordType(type: string) {
  recordTypes();
  const t = registry.get(type);
  if (!t) throw new Error(`Unknown record type ${type}`);
  return t;
}

/**
 * The kinds that hold people's free text (see RecordType.people): what can be confidential, restricted, redacted and
 * marked as holding personal data.
 */
export const textKinds = () => recordTypes().filter((t): t is RecordType & { people: People; textPlaces: TextPlace[] } => !!t.people && !!t.textPlaces);

const prefixOf = (ref: string) => ref.toUpperCase().match(/^[A-Z]+/)?.[0];

/** The type a ref's prefix names, or undefined (the full format is typeForRef's check). */
export const typeOfPrefix = (ref: string) => recordTypes().find((t) => t.prefix === prefixOf(ref))?.type;

/** A text kind by its ref, or undefined (no throwing: callers decide what other refs mean). */
export const textKindOfRef = (ref: string) => textKinds().find((t) => t.prefix === prefixOf(ref));

/** Matches a ref (exactly six digits) of one of these types, e.g. for the text kinds' prefixes. */
export const refRegex = (types: RecordType[], flags = 'i') => new RegExp(`^(${types.map((t) => t.prefix).join('|')})\\d{6}$`, flags);

/** Deep link to the record in the web UI (absolute when KERNEL_PUBLIC_URL is set). */
export const recordUrl = (t: RecordType, ref: string) => absoluteUrl(t.uiPath(ref));

export function typeForRef(ref: string) {
  const prefix = prefixOf(ref);
  const t = recordTypes().find((r) => r.prefix === prefix && (!r.pattern || r.pattern.test(ref.toUpperCase())));
  if (!t) throw notFound(`No record type for reference ${ref}`);
  return t;
}
