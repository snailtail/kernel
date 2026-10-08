// Per-request context (who is acting, through which channel), available to the service layer for auditing.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  userId: number | null;
  userName: string;
  actorType: 'user' | 'api_token' | 'mcp' | 'integration' | 'system' | 'anonymous';
  channel: string;
  tokenPrefix: string;
  ip: string;
  userAgent: string;
  requestId: string;
}

export const contextStore = new AsyncLocalStorage<RequestContext>();

const SYSTEM: RequestContext = { userId: null, userName: 'system', actorType: 'system', channel: 'system', tokenPrefix: '', ip: '', userAgent: '', requestId: '' };

export const currentContext = (): RequestContext => contextStore.getStore() ?? SYSTEM;

/** Runs background work (scheduled jobs, workers) as the system actor. */
export const asSystem = <T>(fn: () => T) => contextStore.run(SYSTEM, fn);
