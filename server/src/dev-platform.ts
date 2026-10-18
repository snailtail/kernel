// One adapter per dev platform (#32): how its links look, where its status comes from, how its webhook deliveries are
// verified, and which items and mentions they carry. dev.ts does the rest the same way for every platform.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { outboundFetch } from './outbound.js';

export const PLATFORMS = ['github', 'gitlab', 'azure_devops'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const ITEM_TYPES = ['pull_request', 'issue', 'commit', 'workflow_run', 'release', 'deployment'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** A link as an item. `base` is where the platform lives (https://gitlab.com, a self-hosted GitLab…). */
export interface ParsedItem { platform: Platform; base: string; repo: string; item_type: ItemType; key: string; url: string; data?: Record<string, unknown> }
export interface ItemStatus { title?: string; state?: string; checks?: string | null; author?: string; data?: Record<string, unknown> }
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
}

/** One deployment as the platform reports it, on one scale: success, failure, cancelled, in_progress, queued. */
export interface Deployment {
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

export interface Delivery { event: string; delivery: string; scope: string; ping?: boolean }

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
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
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
