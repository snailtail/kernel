// Mailbox connectors (#48): a mailbox is a connector, so it reuses the registry, the encrypted write-only
// credentials, the lease, the scheduler, the run log and "Test connection". A mailbox only reads new messages and
// hands each one (raw MIME) to inbound-mail.ts; afterwards the message is marked handled in the mailbox (seen or
// read, and moved to a folder when one is set). Idempotency on Message-ID means a rerun never handles mail twice.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ImapFlow } from 'imapflow';
import { z } from 'zod';
import type { ConnectorType, RunContext } from './connectors.js';
import { mailboxTargetSchema } from '../incidents/inbound-mail.js';
import { blockedReason, parseList } from '../notifications/outbound.js';

/** At most this many messages a run; the rest wait for the next. */
const BATCH = 100;
const pem = z.string().max(20_000).regex(/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/, 'Paste a PEM certificate').optional().or(z.literal(''));

// ---- IMAP --------------------------------------------------------------------------------------

/** The address to connect to: resolved and checked here, so the socket opens exactly what was allowed (no rebinding). */
async function resolveHost(host: string, privateAllow: string[]) {
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length) throw new Error(`${host} does not resolve`);
  const list = privateAllow.length ? parseList(privateAllow) : undefined;
  for (const a of addresses) {
    const reason = blockedReason(a.address, list);
    if (reason) throw new Error(`Blocked connection to ${host}: ${reason}`);
  }
  return addresses[0].address;
}

async function imapClient(ctx: RunContext) {
  const { host, port, security, ca_pem } = ctx.config;
  const address = await resolveHost(host, ctx.privateAllow);
  const client = new ImapFlow({
    host: address,
    port,
    secure: security === 'tls',
    // STARTTLS is required, never optional: credentials are not sent in clear text unless plain was chosen (lab only).
    doSTARTTLS: security === 'starttls' ? true : security === 'plain' ? false : undefined,
    servername: isIP(host) ? undefined : host,
    tls: { servername: isIP(host) ? undefined : host, rejectUnauthorized: true, ...(ca_pem ? { ca: [ca_pem] } : {}) },
    auth: { user: ctx.secret.username, pass: ctx.secret.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  // A stopped run closes the connection, so the fetch settles (connectors.ts keeps the lease until then).
  ctx.signal?.addEventListener('abort', () => client.close(), { once: true });
  await client.connect();
  return client;
}

export const IMAP: ConnectorType = {
  label: 'Mailbox (IMAP)',
  config: mailboxTargetSchema.extend({
    host: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.:-]+$/, 'A host name or address'),
    port: z.number().int().min(1).max(65535).default(993),
    /** tls: implicit TLS (993); starttls: upgraded before signing in (143); plain: clear text, for a lab only. */
    security: z.enum(['tls', 'starttls', 'plain']).default('tls'),
    ca_pem: pem,
    folder: z.string().trim().min(1).max(200).default('INBOX'),
    /** Where handled mail is moved; empty leaves it in the folder, marked \Seen. */
    processed_folder: z.string().trim().max(200).default(''),
  }),
  secret: z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(500) }),
  test: async (ctx) => {
    const client = await imapClient(ctx);
    try {
      const status = await client.status(ctx.config.folder, { messages: true, unseen: true });
      if (ctx.config.processed_folder && !(await client.list()).some((f) => f.path === ctx.config.processed_folder)) {
        return `Connected, but the folder "${ctx.config.processed_folder}" does not exist`;
      }
      return status ? `Connected: ${status.unseen ?? 0} new of ${status.messages ?? 0} messages in ${ctx.config.folder}` : `Connected, but ${ctx.config.folder} could not be read`;
    } finally {
      await client.logout().catch(() => client.close());
    }
  },
  receive: async (ctx, deliver) => {
    const client = await imapClient(ctx);
    const lock = await client.getMailboxLock(ctx.config.folder);
    const warnings: string[] = [];
    try {
      const uids = ((await client.search({ seen: false }, { uid: true })) || []).slice(0, BATCH);
      for (const uid of uids) {
        if (ctx.signal?.aborted) break;
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        try {
          await deliver(msg.source);
        } catch (err) {
          // Left unseen: the next run tries again (Message-ID keeps it from being handled twice).
          warnings.push(`Message ${uid}: ${(err as Error).message}`);
          continue;
        }
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        if (ctx.config.processed_folder) await client.messageMove(String(uid), ctx.config.processed_folder, { uid: true });
      }
    } finally {
      lock.release();
      await client.logout().catch(() => client.close());
    }
    return { warnings };
  },
};

// ---- Microsoft Graph (Exchange Online) -----------------------------------------------------------

async function graph(ctx: RunContext) {
  const { tenant_id, authority_url, graph_url, mailbox } = ctx.config;
  const token = await ctx.request(`${authority_url.replace(/\/$/, '')}/${encodeURIComponent(tenant_id)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: ctx.secret.client_id, client_secret: ctx.secret.client_secret, scope: `${graph_url.replace(/\/$/, '')}/.default`, grant_type: 'client_credentials' }).toString(),
  });
  if (!token.ok) throw new Error(`Sign-in to Microsoft Entra ID failed: HTTP ${token.status}`);
  const auth = { Authorization: `Bearer ${JSON.parse(token.body).access_token}` };
  const base = `${graph_url.replace(/\/$/, '')}/v1.0/users/${encodeURIComponent(mailbox)}`;
  const call = async (path: string, init: Parameters<RunContext['request']>[1] = {}) => {
    const res = await ctx.request(base + path, { ...init, headers: { Accept: 'application/json', ...auth, ...(init.headers ?? {}) } });
    if (!res.ok) throw Object.assign(new Error(`Microsoft Graph: HTTP ${res.status} for ${path.split('?')[0]}`), { status: res.status });
    return res.body;
  };
  /** A folder by well-known name (inbox, archive) or display name. */
  const folderId = async (name: string) => {
    try {
      return JSON.parse(await call(`/mailFolders/${encodeURIComponent(name)}?$select=id`)).id as string;
    } catch {
      const found = JSON.parse(await call(`/mailFolders?$filter=${encodeURIComponent(`displayName eq '${name.replace(/'/g, "''")}'`)}&$select=id`)).value?.[0];
      if (!found) throw new Error(`The folder "${name}" does not exist in ${mailbox}`);
      return found.id as string;
    }
  };
  return { call, folderId };
}

export const MSGRAPH: ConnectorType = {
  label: 'Mailbox (Microsoft 365)',
  config: mailboxTargetSchema.extend({
    tenant_id: z.string().trim().min(1).max(100),
    /** The mailbox (user principal name or id) the app may read: limit it with an application access policy. */
    mailbox: z.string().trim().min(3).max(200),
    folder: z.string().trim().min(1).max(200).default('inbox'),
    processed_folder: z.string().trim().max(200).default(''),
    /** Other clouds (e.g. US Government) have their own endpoints. */
    authority_url: z.string().url().refine((u) => u.startsWith('https://'), 'https only').default('https://login.microsoftonline.com'),
    graph_url: z.string().url().refine((u) => u.startsWith('https://'), 'https only').default('https://graph.microsoft.com'),
  }),
  secret: z.object({ client_id: z.string().min(1).max(200), client_secret: z.string().min(1).max(500) }),
  test: async (ctx) => {
    const g = await graph(ctx);
    const f = JSON.parse(await g.call(`/mailFolders/${encodeURIComponent(await g.folderId(ctx.config.folder))}?$select=totalItemCount,unreadItemCount`));
    if (ctx.config.processed_folder) await g.folderId(ctx.config.processed_folder);
    return `Connected: ${f.unreadItemCount ?? 0} unread of ${f.totalItemCount ?? 0} messages in ${ctx.config.folder}`;
  },
  receive: async (ctx, deliver) => {
    const g = await graph(ctx);
    const folder = await g.folderId(ctx.config.folder);
    const moveTo = ctx.config.processed_folder ? await g.folderId(ctx.config.processed_folder) : null;
    const list = JSON.parse(await g.call(`/mailFolders/${encodeURIComponent(folder)}/messages?$filter=isRead eq false&$orderby=receivedDateTime&$top=${BATCH}&$select=id`)).value ?? [];
    const warnings: string[] = [];
    for (const { id } of list as { id: string }[]) {
      if (ctx.signal?.aborted) break;
      const message = `/messages/${encodeURIComponent(id)}`;
      try {
        // $value is the message as MIME, the same input as IMAP.
        await deliver(Buffer.from(await g.call(`${message}/$value`, { headers: { Accept: 'message/rfc822' } }), 'utf8'));
      } catch (err) {
        warnings.push(`Message ${id.slice(-12)}: ${(err as Error).message}`);
        continue;
      }
      await g.call(message, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isRead: true }) });
      if (moveTo) await g.call(`${message}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destinationId: moveTo }) });
    }
    return { warnings };
  },
};
