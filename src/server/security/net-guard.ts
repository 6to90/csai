import 'server-only';
import dns from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { IS_TEST_BUILD } from '@/server/test-build';

/**
 * Outbound-connection guard for TENANT-supplied hosts (per-channel SMTP URLs). Prevents SSRF into loopback, private, link-local,
 * CGNAT, cloud-metadata, multicast, documentation and other reserved ranges (IPv4 + IPv6), and re-validates at CONNECT time
 * (guardedLookup) so DNS rebinding between "save" and "send" cannot reach an internal address.
 * Operator-controlled transports (MAIL_SMTP_URL) are not tenant input and are not guarded.
 */
export class SmtpTargetError extends Error { constructor(public code: string) { super(code); } }

const blocked = new BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96] /* NAT64 */, ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23] /* Teredo + IETF */,
  ['2001:db8::', 32], ['2002::', 16] /* 6to4 */, ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(a, p, 'ipv6');

/** True for anything that is not a public unicast address (unparseable input counts as blocked). */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '').split('%')[0];
  const fam = isIP(addr);
  if (fam === 0) return true;
  if (fam === 4) return blocked.check(addr, 'ipv4');
  // BlockList compares IPv4 against IPv4-mapped IPv6 ranges, so a ::ffff:0:0/96 rule would block every IPv4 address. Mapped IPv6 is rejected explicitly instead.
  if (new URL(`http://[${addr}]`).hostname.toLowerCase().startsWith('[::ffff:')) return true;
  return blocked.check(addr, 'ipv6');
}

/**
 * Test-only exception for a local fake SMTP server. Two conditions, and the FIRST cannot be satisfied by a production build:
 *  1. the code was built with CSAI_TEST_BUILD=1 (a build-time constant inlined by next.config.ts) or runs under the unit-test runner (NODE_ENV=test; in a
 *     Next production bundle NODE_ENV is itself inlined as "production"), and
 *  2. SMTP_ALLOW_PRIVATE_HOSTS=1 at runtime.
 * So setting the runtime variable on a production deployment does nothing. Never build with CSAI_TEST_BUILD=1 for real use.
 */
export const allowPrivateSmtp = () => process.env.SMTP_ALLOW_PRIVATE_HOSTS === '1' && (IS_TEST_BUILD || process.env.NODE_ENV === 'test');

const ALLOWED_PORTS = new Set([25, 465, 587, 2525]);
const DEFAULT_PORT: Record<string, number> = { 'smtps:': 465, 'smtp+starttls:': 587, 'smtp:': 25 };

export interface SmtpTarget { host: string; port: number; protocol: string }
/** Syntax, protocol and port policy. Throws SmtpTargetError. Does not touch the network. */
export function parseSmtpTarget(raw: string): SmtpTarget {
  let u: URL;
  try { u = new URL(raw); } catch { throw new SmtpTargetError('smtp_url_invalid'); }
  if (!(u.protocol in DEFAULT_PORT)) throw new SmtpTargetError('smtp_protocol_not_allowed');
  if (u.protocol === 'smtp:' && (u.username || u.password)) throw new SmtpTargetError('smtp_plaintext_credentials');   // credentials only over TLS
  if (u.pathname.replace(/^\//, '') || u.search || u.hash) throw new SmtpTargetError('smtp_url_invalid');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host.length > 253 || /\s/.test(host)) throw new SmtpTargetError('smtp_url_invalid');
  const port = u.port ? Number(u.port) : DEFAULT_PORT[u.protocol];
  if (!allowPrivateSmtp() && !ALLOWED_PORTS.has(port)) throw new SmtpTargetError('smtp_port_not_allowed');
  return { host, port, protocol: u.protocol };
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
const systemResolver: Resolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/** Save-time check: every address the name resolves to must be public. Fails closed on resolution errors. */
export async function assertPublicHost(host: string, resolve: Resolver = systemResolver): Promise<void> {
  if (isIP(host)) { if (isBlockedAddress(host)) throw new SmtpTargetError('smtp_host_blocked'); return; }
  if (/^(localhost|.*\.(localhost|local|internal|lan|home|corp|intranet))$/.test(host)) throw new SmtpTargetError('smtp_host_blocked');
  let addrs: { address: string; family: number }[];
  try { addrs = await resolve(host); } catch { throw new SmtpTargetError('smtp_host_unresolvable'); }
  if (!addrs.length) throw new SmtpTargetError('smtp_host_unresolvable');
  if (addrs.some((a) => isBlockedAddress(a.address))) throw new SmtpTargetError('smtp_host_blocked');
}

export async function assertSmtpUrlAllowed(raw: string, resolve?: Resolver): Promise<SmtpTarget> {
  const t = parseSmtpTarget(raw);
  if (!allowPrivateSmtp()) await assertPublicHost(t.host, resolve);
  return t;
}

/**
 * Connect-time guard: a drop-in `lookup` for net/tls.connect. The address it returns is the one the socket connects to, so there is no
 * gap between "checked" and "used" for DNS rebinding to exploit. Any blocked address in the answer rejects the connection.
 */
export function makeGuardedLookup(resolve: Resolver = systemResolver): LookupFunction {
  return (hostname, opts, cb) => {
    const fail = (e: Error) => cb(e as NodeJS.ErrnoException, '', 0);
    resolve(hostname).then((list) => {
      if (!list.length || list.some((a) => isBlockedAddress(a.address))) return fail(new SmtpTargetError('smtp_host_blocked'));
      if (opts.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    }, fail);
  };
}
export const guardedLookup = makeGuardedLookup();
