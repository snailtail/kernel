// Live updates (#70): Server-Sent Events for record pages and lists, and presence on record pages.
//
// - Database triggers send "kind:id" on kernel_live at commit (migration 126); one dedicated connection listens.
// - Events carry only kind and id. Before anything is sent, the database decides, with that listener's own viewer
//   (row-level security, #53), whether they may see the record; the browser then refetches through the normal API.
// - Streams are for signed-in browsers only (session cookie, never a token in the URL). Every stream re-checks its
//   session, account, role and teams at least every minute, and before an event is sent if the last check is older
//   than 15 s: a revoked session or a disabled account closes the stream; changed teams refilter it.
// - Presence ("who else has this open") lives in memory only, goes only to people who can see the record, and is
//   off for anyone who opts out (preference live_presence = false).
import { forgetExists } from './confidential.js';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentSessionHash, type User } from './auth.js';
import { config } from './config.js';
import { contextStore } from './context.js';
import { listen, query } from './db.js';
import { badRequest, forbidden, HttpError, notFound } from './errors.js';
import { moduleEnabled, type Module } from './modules.js';
import { viewerFor } from './visibility.js';

const KINDS = { problem: 'problems', incident: 'incidents', change: 'changes', ci: 'configuration_items', improvement: 'improvements', request: 'requests' } as const;
type Kind = keyof typeof KINDS;
const MODULE_OF: Partial<Record<Kind, Module>> = { incident: 'incident', change: 'change', ci: 'cmdb', request: 'request' };

export const LIMITS = {
  perUser: Number(process.env.KERNEL_LIVE_PER_USER ?? 6),
  total: Number(process.env.KERNEL_LIVE_TOTAL ?? 1000),
  heartbeatMs: 25_000,
  recheckMs: 60_000,
  recheckBeforeSendMs: 15_000,
  flushMs: 300,
  maxBuffered: 256 * 1024,
  maxTopics: 50,
};

interface Stream {
  id: string;
  user: User;
  sessionHash: string;
  viewer: string;
  reply: FastifyReply;
  topics: Set<string>;
  editing: string | null;
  presence: boolean;
  checkedAt: number;
  openedAt: number;
}

const streams = new Map<string, Stream>();
const pending = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;
let timers: NodeJS.Timeout[] = [];
let stopListening: (() => Promise<void>) | null = null;

const kindOk = (k: string): k is Kind => Object.hasOwn(KINDS, k) && (!MODULE_OF[k as Kind] || moduleEnabled(MODULE_OF[k as Kind]!));

function write(s: Stream, chunk: string) {
  const raw = s.reply.raw;
  // Backpressure: a client that does not keep up is dropped; it reconnects and refetches.
  if (raw.destroyed || raw.writableLength > LIMITS.maxBuffered) return close(s);
  raw.write(chunk);
}
const send = (s: Stream, event: string, data: unknown) => write(s, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function close(s: Stream) {
  if (!streams.delete(s.id)) return;
  if (!s.reply.raw.destroyed) s.reply.raw.end();
  for (const t of s.topics) if (t.includes(':') && !t.endsWith(':*')) broadcastPresence(t);
}

/** Runs fn with the database filtering for this viewer. */
const asViewer = <T>(viewer: string, fn: () => Promise<T>) =>
  contextStore.run({ userId: null, userName: 'live', actorType: 'system', channel: 'web', tokenPrefix: '', ip: '', userAgent: '', requestId: '', viewer }, fn);

/** The ids among these that the viewer may see. */
async function visibleIds(viewer: string, kind: Kind, ids: number[]) {
  if (!ids.length) return new Set<number>();
  const { rows } = await asViewer(viewer, () => query(`SELECT id FROM ${KINDS[kind]} WHERE id = ANY($1::int[])`, [ids]));
  return new Set(rows.map((r) => Number(r.id)));
}

/** Session still valid, account active: refresh the viewer (role, teams) and drop record topics no longer visible. */
async function recheck(s: Stream) {
  const { rows } = await query(
    `SELECT u.id, u.role, u.active FROM sessions ss JOIN users u ON u.id = ss.user_id
     WHERE ss.token_hash = $1 AND ss.expires_at > now() AND ss.last_seen_at > now() - $2 * interval '1 hour'`,
    [s.sessionHash, config.sessionIdleHours],
  );
  if (!rows[0]?.active) {
    send(s, 'closed', { reason: 'signed_out' });
    return close(s), false;
  }
  s.user = { ...s.user, role: rows[0].role };
  s.viewer = await viewerFor(s.user, 'web');
  s.checkedAt = Date.now();
  const byKind = new Map<Kind, number[]>();
  for (const t of s.topics) {
    const [k, id] = t.split(':');
    if (id !== '*' && kindOk(k)) byKind.set(k, [...(byKind.get(k) ?? []), Number(id)]);
  }
  for (const [k, ids] of byKind) {
    const ok = await visibleIds(s.viewer, k, ids);
    for (const id of ids) if (!ok.has(id)) s.topics.delete(`${k}:${id}`);
  }
  return true;
}

async function flush() {
  flushTimer = null;
  const batch = [...pending];
  pending.clear();
  const byKind = new Map<Kind, number[]>();
  const users = new Set<number>();
  for (const p of batch) {
    const [k, id] = p.split(':');
    if (k === 'user' && /^\d+$/.test(id)) users.add(Number(id));
    else if (kindOk(k) && /^\d+$/.test(id)) byKind.set(k, [...(byKind.get(k) ?? []), Number(id)]);
  }
  for (const s of [...streams.values()]) {
    try {
      // Someone's teams changed: their view may have shrunk, so re-check now rather than within the minute.
      if (users.has(s.user.id)) await recheckAndAnnounce(s);
      const wanted = [...byKind].map(([k, ids]) => [k, ids.filter((id) => s.topics.has(`${k}:*`) || s.topics.has(`${k}:${id}`))] as const).filter(([, ids]) => ids.length);
      if (!wanted.length) continue;
      if (Date.now() - s.checkedAt > LIMITS.recheckBeforeSendMs && !(await recheck(s))) continue;
      for (const [k, ids] of wanted) {
        const ok = await visibleIds(s.viewer, k, ids);
        for (const id of ids) {
          if (ok.has(id)) send(s, 'change', { kind: k, id });
          // The record was just restricted away from this person: stop following it at once (presence too).
          else if (s.topics.delete(`${k}:${id}`)) broadcastPresence(`${k}:${id}`);
        }
      }
    } catch {
      close(s);
    }
  }
}

function onNotify(payload: string) {
  if (payload.length > 64) return;
  // A record's classification changed somewhere (#61): no instance may keep assuming nothing is confidential.
  if (payload.startsWith('classification:')) return forgetExists();
  // 'user:<id>' comes from team membership changes; everything else is 'kind:id'.
  pending.add(payload);
  flushTimer ??= setTimeout(() => void flush(), LIMITS.flushMs);
}

/** A re-check, then fresh presence for record topics that were dropped. */
async function recheckAndAnnounce(s: Stream) {
  const before = [...s.topics];
  if (!(await recheck(s))) return false;
  for (const t of before) if (!s.topics.has(t)) broadcastPresence(t);
  return true;
}

/** Who has this record open (other than the recipient); never the people who opted out. */
function broadcastPresence(topic: string) {
  const here = [...streams.values()].filter((s) => s.topics.has(topic));
  for (const s of here) {
    const others = new Map<number, { name: string; editing: boolean }>();
    for (const o of here) {
      if (o.user.id === s.user.id || !o.presence) continue;
      const prev = others.get(o.user.id);
      others.set(o.user.id, { name: o.user.display_name || o.user.username, editing: (prev?.editing ?? false) || o.editing === topic });
    }
    send(s, 'presence', { topic, people: [...others.values()] });
  }
}

export async function openStream(req: FastifyRequest, reply: FastifyReply, user: User) {
  // Browsers only: the session cookie, never a bearer token (agents use webhooks, #11).
  if (req.headers.authorization) throw forbidden('Live updates are for the web UI; use webhooks for integrations');
  if (streams.size >= LIMITS.total) throw new HttpError(503, 'Too many live connections; the page falls back to refreshing');
  // A user's oldest stream gives way, so a reloaded tab never locks itself out.
  const mine = [...streams.values()].filter((s) => s.user.id === user.id).sort((a, b) => a.openedAt - b.openedAt);
  while (mine.length >= LIMITS.perUser) close(mine.shift()!);
  const s: Stream = {
    id: randomUUID(), user, sessionHash: currentSessionHash(req), viewer: await viewerFor(user, 'web'), reply,
    topics: new Set(), editing: null, presence: user.preferences?.live_presence !== false, checkedAt: Date.now(), openedAt: Date.now(),
  };
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  streams.set(s.id, s);
  req.raw.on('close', () => close(s));
  // No replay: after a reconnect the page refetches what it shows.
  write(s, 'retry: 5000\n\n');
  send(s, 'hello', { stream: s.id });
}

export const subscribeSchema = z.object({
  topics: z.array(z.string().regex(/^(problem|incident|change|ci|improvement|request):(\d{1,10}|\*)$/)).max(LIMITS.maxTopics),
  editing: z.string().regex(/^(problem|incident|change|ci|improvement|request):\d{1,10}$/).nullable().optional(),
});

/** Replaces what a stream follows. Record topics the user cannot see are dropped without a word. */
export async function subscribe(req: FastifyRequest, user: User, streamId: string, input: z.infer<typeof subscribeSchema>) {
  const s = streams.get(streamId);
  if (!s || s.user.id !== user.id || s.sessionHash !== currentSessionHash(req)) throw notFound();
  const before = new Set(s.topics);
  const next = new Set<string>();
  const byKind = new Map<Kind, number[]>();
  for (const t of input.topics) {
    const [k, id] = t.split(':');
    if (!kindOk(k)) continue;
    if (id === '*') next.add(t);
    else byKind.set(k, [...(byKind.get(k) ?? []), Number(id)]);
  }
  for (const [k, ids] of byKind) for (const id of await visibleIds(s.viewer, k, ids)) next.add(`${k}:${id}`);
  if (input.editing && !next.has(input.editing)) throw badRequest('Follow a record before editing it');
  s.topics = next;
  s.editing = input.editing ?? null;
  const touched = new Set([...before, ...next].filter((t) => !t.endsWith(':*')));
  for (const t of touched) broadcastPresence(t);
  return { topics: [...next] };
}

export function startLive(log: (msg: string) => void) {
  stopListening = listen('kernel_live', onNotify, log);
  timers = [
    setInterval(() => { for (const s of streams.values()) write(s, ': ping\n\n'); }, LIMITS.heartbeatMs),
    setInterval(() => { for (const s of [...streams.values()]) if (Date.now() - s.checkedAt >= LIMITS.recheckMs) recheckAndAnnounce(s).catch(() => close(s)); }, 10_000),
  ];
  for (const t of timers) t.unref();
}

export async function stopLive() {
  for (const t of timers) clearInterval(t);
  timers = [];
  for (const s of [...streams.values()]) close(s);
  await stopListening?.();
}

/** For tests and the security status. */
export const liveStats = () => ({ streams: streams.size, users: new Set([...streams.values()].map((s) => s.user.id)).size });
export const recheckAll = async () => { for (const s of [...streams.values()]) await recheckAndAnnounce(s).catch(() => close(s)); };
export const heartbeatNow = () => { for (const s of streams.values()) write(s, ': ping\n\n'); };
