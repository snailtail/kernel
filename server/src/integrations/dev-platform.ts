// One adapter per dev platform (#32): how its links look, where its status comes from, how its webhook deliveries are
// verified, and which items and mentions they carry. dev.ts does the rest the same way for every platform.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { outboundFetch } from '../notifications/outbound.js';
import { sha256 } from '../core/hash.js';

export const PLATFORMS = ['github', 'gitlab', 'azure_devops'] as const;
export type Platform = (typeof PLATFORMS)[number];
/** Each platform's name, the one place it is spelled: adapters, mirrored items and their errors use it. */
export const PLATFORM_LABELS: Record<Platform, string> = { github: 'GitHub', gitlab: 'GitLab', azure_devops: 'Azure DevOps' };
const ITEM_TYPES = ['pull_request', 'issue', 'commit', 'workflow_run', 'release', 'deployment'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** A link as an item. `base` is where the platform lives (https://gitlab.com, a self-hosted GitLab…). */
export interface ParsedItem { platform: Platform; base: string; repo: string; item_type: ItemType; key: string; url: string; data?: Record<string, unknown> }
interface ItemStatus { title?: string; state?: string; checks?: string | null; author?: string; data?: Record<string, unknown> }
export type UpsertItem = Omit<ParsedItem, 'base'> & ItemStatus & { environment?: string };

/** What an adapter may do while handling a delivery; dev.ts owns the tables and the visibility rules. */
export interface EventContext {
  upsert(item: UpsertItem): Promise<number>;
  /** Links the item to the Kernel refs in `text` and to `also`; returns the refs that were newly linked. */
  mention(itemId: number, text: string, also?: string[]): Promise<string[]>;
  /** The refs that items of this repository are already linked to (a run follows the pull request it built). */
  refsOf(repo: string, type: ItemType, keys: string[]): Promise<string[]>;
  setChecks(repo: string, prKey: string, checks: string): Promise<void>;
  /** A deployment to an environment: dev.ts finds what it contains, maps it to CIs and may register a change. */
  deployed(d: Deployment): Promise<string[]>;
  /** A work item as the source has it now (#168): mirrored when a team mirrors the place it is in. */
  mirrored(item: MirroredItem | { external_id: string; deleted: true }): Promise<void>;
}

/**
 * A work item in the source, in the source's own words (its type and state names): the fields a mirror copies (#168).
 * Pointers, not copies: never the description.
 */
export interface MirroredItem {
  /** Unique per platform: "organisation#12" on Azure DevOps, "owner/repo#12" on GitHub and GitLab. */
  external_id: string;
  url: string;
  title: string;
  type: string;
  state: string;
  /** Where it is in the source, matched against a mirror's area: an Azure DevOps area path, or an issue's labels (one per line). */
  area: string;
  /** The iteration or milestone; undefined when the source did not say (a GitLab delivery names only its id): kept as it was. */
  iteration: string | undefined;
  points: number | null;
  assignee_email: string | null;
  parent_external_id: string | null;
  /** Hidden in the source (a confidential GitLab issue): never mirrored, its title would reach everyone who sees the team's items. */
  confidential?: boolean;
}

/** How a mirror's place is named in its source. */
export interface MirrorPlace { base: string; scope: string; area: string }

/** A platform whose work items a team can mirror (#168). The mapping to Kernel's types and statuses is per platform. */
export interface Mirroring {
  /** What a mirror's area is called in this source, for the settings. */
  areaName: string;
  /** The default mapping, keyed by the source's names in lower case; a mirror can adjust it. */
  types: Record<string, string>;
  states: Record<string, string>;
  /** Whether an item at `area` belongs to a mirror of `place`. */
  covers(place: MirrorPlace, area: string): boolean;
  /** Every item of the place now, the complete list (throws when it cannot be read: nothing is then marked removed). */
  list(place: MirrorPlace, token: string | null, call: CallJson): Promise<MirroredItem[]>;
  /** These items as they are now; one that was deleted in the source is missing from the result. */
  lookup(place: MirrorPlace, externalIds: string[], token: string | null, call: CallJson): Promise<MirroredItem[]>;
  /** Posts a comment on the item in the source (only Kernel's link comment, never a status change). */
  comment(place: MirrorPlace, externalId: string, body: string, token: string, call: CallJson): Promise<void>;
}

/** The labels of a GitHub or GitLab issue, as its area: one per line. */
export const labelArea = (labels: string[]) => labels.join('\n');
/** Whether an issue with these labels (its area) carries the mirror's label; no label is the whole repository. */
export const hasLabel = (place: MirrorPlace, area: string) => !place.area || area.split('\n').some((l) => l.toLowerCase() === place.area.toLowerCase());

/**
 * A GitHub or GitLab issue's type: the platform's own issue type when it has one other than a plain issue, otherwise
 * the first label the mapping knows as a type (bug, feature…), otherwise "issue".
 */
export function typeFromLabels(own: unknown, labels: string[], types: Record<string, string>) {
  if (typeof own === 'string' && own && own.toLowerCase() !== 'issue') return own;
  return labels.find((l) => l.toLowerCase() !== 'issue' && l.toLowerCase() in types) ?? 'issue';
}

/** The pages of a list, `perPage` at a time, until a short page; more than `max` items is refused (a partial list removes nothing). */
export async function allPages(url: (page: number) => string, perPage: number, max: number, get: (url: string) => Promise<unknown>) {
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const j = await get(url(page));
    if (!Array.isArray(j)) throw Object.assign(new Error('Not a list'), { kind: 'not_a_list' });
    out.push(...j);
    if (j.length < perPage) return out;
    if (out.length >= max) throw Object.assign(new Error('Too many items'), { kind: 'too_many', max });
  }
}

/** A lookup's answer for an item that is no longer there: deleted, moved to another repository or hidden from the token. */
export const isGone = (err: unknown) => [301, 404, 410].includes((err as { status?: number }).status as number);

/** An outbound JSON request that throws on any failure, for reads whose absence must not look like an empty list. */
export type CallJson = (url: string, init?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown }) => Promise<any>;

/** One deployment as the platform reports it, on one scale: success, failure, cancelled, in_progress, queued. */
interface Deployment {
  repo: string;
  key: string;
  url: string;
  environment: string;
  state: string;
  title: string;
  author?: string;
  sha?: string;
  /** The platform or its description calls it a rollback. */
  rollback?: boolean;
  started_at?: string;
  finished_at?: string;
  /** Text that may mention Kernel refs (description, ref, commit title). */
  text?: string;
}

/** The change's status on a pull request's head commit: what teams can make a required check. */
export interface CommitStatus { state: 'success' | 'pending' | 'failure'; description: string; target_url: string }
export type PostJson = (url: string, headers: Record<string, string>, body: unknown) => Promise<boolean>;

/** An outbound GET through the source's network settings: parsed JSON, or null when it failed (best effort). */
export type GetJson = (url: string, headers: Record<string, string>) => Promise<any>;

interface Delivery { event: string; delivery: string; scope: string; ping?: boolean }

export interface Adapter {
  label: string;
  /** "owner/repo", "group/project" or "organisation/project": what a source's allowlist holds. */
  scopePattern: RegExp;
  scopeExample: string;
  /** Events to subscribe to, shown when a source is created. */
  events: string[];
  /** Basic auth sends the secret itself on every delivery, so it must only arrive over HTTPS. */
  httpsOnly?: boolean;
  /** The item a link points to, or null when the URL is not from this platform. `bases` are its configured hosts. */
  parseUrl(u: URL, bases: string[]): ParsedItem | null;
  fetchStatus(item: ParsedItem, token: string | null, get: GetJson): Promise<ItemStatus>;
  /** Checks the delivery's credentials against the source's secret, before the body is parsed. */
  verify(req: FastifyRequest, raw: string, secret: string): boolean;
  /** The event, the delivery id for replay protection and the repository or project, or null when one is missing. */
  read(req: FastifyRequest, body: any): Delivery | null;
  inScope(repositories: string[], scope: string): boolean;
  handle(ctx: EventContext, event: string, body: any, scope: string): Promise<string[]>;
  /** Posts the change status on a pull request (its head commit, or the PR itself where the platform has PR statuses). */
  postStatus(item: { repo: string; key: string; data: Record<string, any> }, base: string, token: string, post: PostJson, status: CommitStatus): Promise<boolean>;
}

/** Deployments described as rollbacks (GitHub's task, a GitHub or ADO description). */
// Only a deployment's own description counts: a "Revert …" commit deployed forward is a new deploy, not a rollback.
export const isRollback = (...texts: unknown[]) => texts.some((t) => /\broll[ -]?back/i.test(String(t ?? '')));

/** A timestamp from a delivery as ISO 8601, or undefined when it is missing or not a date (never stored as text). */
export const iso = (v: unknown) => (typeof v === 'string' && v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);

/** Constant-time comparison of two secrets of any length (both hashed first, so the length leaks nothing). */
export function sameSecret(given: string | undefined, expected: string) {
  if (!given) return false;
  const a = sha256(given);
  const b = sha256(expected);
  return timingSafeEqual(a, b);
}

/** Pipeline and check states on one scale: success, failure, cancelled, in_progress, queued, skipped. */
export function ciState(s: unknown): string | undefined {
  if (typeof s !== 'string' || !s) return undefined;
  const v = s.toLowerCase();
  if (['success', 'succeeded', 'passed'].includes(v)) return 'success';
  if (['failed', 'failure', 'partiallysucceeded', 'timed_out'].includes(v)) return 'failure';
  if (['canceled', 'cancelled', 'cancelling', 'canceling'].includes(v)) return 'cancelled';
  if (['running', 'inprogress', 'in_progress'].includes(v)) return 'in_progress';
  if (['pending', 'created', 'queued', 'notstarted', 'waiting_for_resource', 'preparing', 'scheduled', 'postponed', 'manual'].includes(v)) return 'queued';
  return v;
}

/**
 * Kernel refs mentioned in free text: CHG000017 or CHG-000017, exactly six digits, so another tool's numbers
 * (ServiceNow's INC0010001) are never mistaken for Kernel records.
 */
export function refsIn(text: string) {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(PRB|CHG|INC)-?(\d{6})\b/gi)) out.add(`${m[1].toUpperCase()}${m[2]}`);
  return [...out];
}

/** The first line of a commit message. */
export const firstLine = (s: unknown) => String(s ?? '').split('\n')[0];

/** Makes a PostJson for one source: the same network settings; true when the platform accepted it. */
export function postJsonVia(privateAllow: string[], ca: string | null): PostJson {
  return async (url, headers, body) => {
    try {
      const res = await outboundFetch(url, {
        method: 'POST', body: JSON.stringify(body), headers: { 'User-Agent': 'Kernel', Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
        timeoutMs: 5000, maxBytes: 100_000, privateAllow: privateAllow.length ? privateAllow : undefined, ca: ca ?? undefined,
      });
      return res.ok;
    } catch {
      return false;
    }
  };
}

/** Makes a GetJson for one source: its private ranges and CA certificate, short timeouts and a size limit. */
export function getJsonVia(privateAllow: string[], ca: string | null): GetJson {
  return async (url, headers) => {
    try {
      const res = await outboundFetch(url, { headers: { 'User-Agent': 'Kernel', Accept: 'application/json', ...headers }, timeoutMs: 5000, maxBytes: 500_000, privateAllow: privateAllow.length ? privateAllow : undefined, ca: ca ?? undefined });
      // Rate-limited or not found: the link is kept, and the next webhook delivery fills in the status.
      return res.ok ? JSON.parse(res.body) : null;
    } catch {
      return null;
    }
  };
}

/** Makes a CallJson for one source: its network settings, longer timeouts and a larger limit than a status lookup. */
export function callJsonVia(privateAllow: string[], ca: string | null): CallJson {
  return async (url, init = {}) => {
    const res = await outboundFetch(url, {
      method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers: { 'User-Agent': 'Kernel', Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
      timeoutMs: 30_000, maxBytes: 20_000_000, privateAllow: privateAllow.length ? privateAllow : undefined, ca: ca ?? undefined,
    });
    const host = new URL(url).host;
    // The status and host are what a caller may show; an error's own text never is (it may hold what the request did).
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${host}`), { status: res.status, host });
    try {
      return JSON.parse(res.body);
    } catch {
      throw Object.assign(new Error(`The answer from ${host} is not JSON`), { kind: 'not_json', host });
    }
  };
}

/**
 * Pushed commits, the same on every platform: only commits that mention a Kernel record (in the message, or in the
 * branch name) are kept, at most 50 per delivery.
 */
export async function pushCommits(
  ctx: EventContext,
  commits: { sha: string; message: string; url: string; author?: string; data?: Record<string, unknown> }[],
  branches: string[],
  base: { platform: Platform; repo: string },
) {
  const linked: string[] = [];
  const branchRefs = branches.flatMap((b) => refsIn(b));
  for (const c of commits.slice(0, 50)) {
    const refs = [...refsIn(String(c.message ?? '')), ...branchRefs];
    if (!refs.length) continue;
    const id = await ctx.upsert({ ...base, item_type: 'commit', key: String(c.sha), url: c.url, title: firstLine(c.message), state: 'committed', author: c.author, data: c.data });
    linked.push(...(await ctx.mention(id, '', refs)));
  }
  return linked;
}
