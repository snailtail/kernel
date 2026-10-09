// The one HTTP client for all outbound requests (webhooks today; connectors later). Protects against SSRF:
// - every resolved address is checked, and the connection goes to that checked address (no DNS rebinding);
// - loopback, link-local (incl. cloud metadata 169.254.169.254 / fd00:ec2::254), unspecified, multicast and
//   reserved ranges are always blocked; private ranges (RFC 1918, ULA, CGNAT) only via KERNEL_OUTBOUND_ALLOW;
// - redirects are followed manually (max 3), each hop re-checked; timeout and response size limit.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { rootCertificates } from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';

export class OutboundBlockedError extends Error {}

const ALWAYS_BLOCKED = new BlockList();
for (const [net, prefix, type] of [
  ['0.0.0.0', 8, 'ipv4'], ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['198.18.0.0', 15, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'], ['fd00:ec2::254', 128, 'ipv6'],
  // Addresses that embed IPv4 and may route to internal hosts: IPv4-compatible, NAT64, 6to4; and deprecated site-local.
  ['::', 96, 'ipv6'], ['64:ff9b::', 96, 'ipv6'], ['64:ff9b:1::', 48, 'ipv6'], ['2002::', 16, 'ipv6'], ['fec0::', 10, 'ipv6'],
] as const) ALWAYS_BLOCKED.addSubnet(net, prefix, type);

const PRIVATE = new BlockList();
for (const [net, prefix, type] of [
  ['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['fc00::', 7, 'ipv6'],
] as const) PRIVATE.addSubnet(net, prefix, type);

/** KERNEL_OUTBOUND_ALLOW: comma-separated CIDRs or addresses that may be reached even though private/loopback. */
function allowList() {
  return parseList((process.env.KERNEL_OUTBOUND_ALLOW ?? '').split(','));
}

function parseList(entries: string[]) {
  const list = new BlockList();
  for (const entry of entries.map((s) => s.trim()).filter(Boolean)) {
    const [addr, bits] = entry.split('/');
    const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    if (!isIP(addr)) continue;
    if (bits) list.addSubnet(addr, Number(bits), type);
    else list.addAddress(addr, type);
  }
  return list;
}

/**
 * Validates a per-caller allowlist (e.g. a connector's "allow private network"): only private ranges may be listed;
 * loopback, link-local, metadata and reserved addresses can never be opened this way.
 */
export function validatePrivateAllow(entries: string[]) {
  for (const entry of entries) {
    const [addr, bits] = entry.trim().split('/');
    if (!isIP(addr)) return `${entry} is not an address or CIDR`;
    const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    if (!PRIVATE.check(addr, type) || ALWAYS_BLOCKED.check(addr, type)) return `${entry} is not in a private range`;
    if (bits && (Number(bits) < (type === 'ipv4' ? 8 : 7) || Number(bits) > (type === 'ipv4' ? 32 : 128))) return `${entry} has an invalid prefix`;
  }
  return null;
}

/** Why an address may not be contacted, or null if it may. `privateAllow` may open private ranges only. */
export function blockedReason(address: string, privateAllow?: BlockList): string | null {
  let ip = address;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); // IPv4-mapped IPv6
  if (mapped) ip = mapped[1];
  const type = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
  if (allowList().check(ip, type)) return null;
  if (ALWAYS_BLOCKED.check(ip, type)) return `${ip} is a loopback, link-local, metadata or reserved address`;
  if (PRIVATE.check(ip, type)) return privateAllow?.check(ip, type) ? null : `${ip} is a private address (allow it for this connector, or with KERNEL_OUTBOUND_ALLOW)`;
  return null;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** DNS lookup that rejects blocked addresses; the socket then connects to exactly the address checked here. */
export function checkedLookup(hostname: string, options: object, callback: LookupCallback, privateAllow?: BlockList) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    for (const a of list) {
      const reason = blockedReason(a.address, privateAllow);
      if (reason) return callback(Object.assign(new OutboundBlockedError(`Blocked outbound request to ${hostname}: ${reason}`), { code: 'EBLOCKED' }), []);
    }
    if ((options as { all?: boolean }).all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

const agent = new Agent({ connect: { lookup: checkedLookup as any, timeout: 5000 }, bodyTimeout: 10_000, headersTimeout: 10_000 });
const allowAgents = new Map<string, { agent: Agent; list: BlockList | undefined }>();
/**
 * An agent whose lookup also accepts the given private ranges, and that trusts an extra CA certificate (e.g. an
 * internal OP5 behind a company CA). Certificate verification is never switched off.
 */
function agentFor(privateAllow?: string[], ca?: string) {
  if (!privateAllow?.length && !ca) return { agent, list: undefined };
  const key = `${[...(privateAllow ?? [])].sort().join(',')}|${ca ? createHash('sha256').update(ca).digest('hex') : ''}`;
  let entry = allowAgents.get(key);
  if (!entry) {
    const list = privateAllow?.length ? parseList(privateAllow) : undefined;
    const lookup = (h: string, o: object, cb: LookupCallback) => checkedLookup(h, o, cb, list);
    const ctx = ca ? { ca: [...rootCertificates, ca] } : {};
    entry = { agent: new Agent({ connect: { lookup: lookup as any, timeout: 5000, ...ctx }, bodyTimeout: 30_000, headersTimeout: 30_000 }), list };
    allowAgents.set(key, entry);
  }
  return entry;
}

/** Headers that carry credentials; never sent to another origin after a redirect. */
const CREDENTIAL_HEADERS = /^(authorization|proxy-authorization|cookie|x-kernel-token)$/i;

export interface OutboundResponse {
  status: number;
  ok: boolean;
  body: string;
}

/** Checks a URL before it is stored (e.g. a webhook URL), so obvious mistakes are rejected early. */
export function checkUrl(url: string, privateAllow?: BlockList): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Invalid URL';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Only http(s) URLs are allowed';
  if (u.username || u.password) return 'Credentials in the URL are not allowed';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return blockedReason(host, privateAllow);
  if (/^(localhost|.*\.localhost|.*\.internal|metadata\.google\.internal)$/i.test(host)) return `${host} is an internal host name`;
  return null;
}

export async function outboundFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number; privateAllow?: string[]; ca?: string } = {},
): Promise<OutboundResponse> {
  const maxBytes = init.maxBytes ?? 1_000_000;
  if (init.privateAllow?.length) {
    const problem = validatePrivateAllow(init.privateAllow);
    if (problem) throw new OutboundBlockedError(problem);
  }
  const { agent: dispatcher, list: privateList } = agentFor(init.privateAllow, init.ca);
  const origin = new URL(url).origin;
  let current = url;
  for (let hop = 0; hop <= 3; hop++) {
    const problem = checkUrl(current, privateList);
    if (problem) throw new OutboundBlockedError(problem);
    let res;
    try {
      res = await undiciFetch(current, {
        method: init.method ?? 'GET',
        // Credentials only go to the origin they were meant for, never to where a redirect points.
        headers: new URL(current).origin === origin ? init.headers : Object.fromEntries(Object.entries(init.headers ?? {}).filter(([k]) => !CREDENTIAL_HEADERS.test(k))),
        body: init.body,
        redirect: 'manual',
        dispatcher,
        signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
      });
    } catch (err) {
      // undici wraps connect errors; surface our own reason when the lookup blocked the address.
      const cause = (err as { cause?: Error }).cause;
      if (cause instanceof OutboundBlockedError) throw cause;
      throw err;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      if ((init.method ?? 'GET') !== 'GET' && res.status !== 307 && res.status !== 308) throw new Error(`Redirect ${res.status} not followed for ${init.method}`);
      current = new URL(res.headers.get('location')!, current).toString();
      continue;
    }
    // Read at most maxBytes of the response.
    let body = '';
    let size = 0;
    if (res.body) {
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          await res.body.cancel().catch(() => {});
          break;
        }
        body += decoder.decode(chunk, { stream: true });
      }
    }
    return { status: res.status, ok: res.ok, body };
  }
  throw new Error('Too many redirects');
}
