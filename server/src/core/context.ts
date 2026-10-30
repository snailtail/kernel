// Per-request context (who is acting, through which channel), available to the service layer for auditing.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Notice } from '../notifications/notifications.js';

export interface RequestContext {
  userId: number | null;
  userName: string;
  actorType: 'user' | 'api_token' | 'mcp' | 'integration' | 'system' | 'anonymous' | 'portal' | 'rule';
  channel: string;
  tokenPrefix: string;
  ip: string;
  /** The client's country from a trusted proxy (Cloudflare's CF-IPCountry), or ''. */
  country?: string;
  userAgent: string;
  requestId: string;
  /** Who the database filters for (row-level security, #53): 'system', '' (nobody) or a user's viewer string. */
  viewer: string;
  /** Inside an automation rule's run (#49): how many rules led here, so a chain stops at its limit. */
  ruleDepth?: number;
}

export const contextStore = new AsyncLocalStorage<RequestContext>();

const SYSTEM: RequestContext = { userId: null, userName: 'system', actorType: 'system', channel: 'system', tokenPrefix: '', ip: '', userAgent: '', requestId: '', viewer: 'system' };

export const currentContext = (): RequestContext => contextStore.getStore() ?? SYSTEM;

/** Runs background work (scheduled jobs, workers) as the system actor. */
export const asSystem = <T>(fn: () => T) => contextStore.run(SYSTEM, fn);

/**
 * Runs work an integration does (a dev source's delivery, a mirror's reconciliation) as that integration: audited
 * under its name and channel, and seeing every row, since what it may touch was decided when it was configured.
 */
export const asIntegration = <T>(who: { name: string; channel: string; requestId: string; ip?: string }, fn: () => T) =>
  contextStore.run({ ...SYSTEM, userName: who.name, actorType: 'integration', channel: who.channel, requestId: who.requestId, ip: who.ip ?? '' }, fn);

/**
 * A bulk request (#125): one change to many records, each through its own service function. Pages and notifications
 * read this to send one summary per target and per person instead of one per record.
 */
export interface BulkContext {
  /** Ties the request's pages (dedup key bulk:<id>) and its list link together. */
  id: string;
  practice: string;
  actor: { id: number | null; name: string };
  /** Notices of the record being changed, kept only if its change commits. */
  staged: Notice[];
  /** Notices held back until the request is done, then sent per person and event. */
  notices: Notice[];
  done: boolean;
}

const bulkStore = new AsyncLocalStorage<BulkContext>();

/** The bulk request this code runs in, if any (not once it is done). */
export const currentBulk = () => {
  const b = bulkStore.getStore();
  return b && !b.done ? b : undefined;
};

export const asBulk = <T>(b: BulkContext, fn: () => T) => bulkStore.run(b, fn);

/** For work that outlives the request (timers): it must not land in the request's summaries. */
export const outsideBulk = <T>(fn: () => T) => bulkStore.exit(fn);
