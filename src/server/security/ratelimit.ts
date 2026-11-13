import 'server-only';
import { createHash } from 'node:crypto';
import { systemClient } from './system-client';
import { HttpError } from '../http';
import { log } from '../log';

export interface RateLimiter { hit(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; count: number; retryAfter: number }> }

/** Postgres-backed fixed window (ARCHITECTURE §6.7). Swap for another RateLimiter implementation (e.g. Redis) later. */
export const pgRateLimiter: RateLimiter = {
  async hit(key, limit, windowSec) {
    const { data, error } = await systemClient().rpc('rate_limit_hit', { p_key: key, p_limit: limit, p_window_seconds: windowSec });
    if (error) throw new Error('rate limiter unavailable');
    const r = (data as { out_allowed: boolean; out_count: number; out_retry_after: number }[])[0];
    return { allowed: r.out_allowed, count: r.out_count, retryAfter: r.out_retry_after };
  },
};

/** failClosed: public endpoints deny on limiter errors; authenticated endpoints allow and log. */
export async function enforceRateLimit(key: string, limit: number, windowSec: number, opts: { failClosed: boolean; limiter?: RateLimiter }): Promise<void> {
  try {
    const r = await (opts.limiter ?? pgRateLimiter).hit(key, limit, windowSec);
    if (!r.allowed) throw new HttpError(429, 'rate_limited', 'too many requests', { 'retry-after': String(r.retryAfter) });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    log('warn', 'rate limiter error', { key: key.split(':')[0], err: e });
    if (opts.failClosed) throw new HttpError(429, 'rate_limited', 'too many requests', { 'retry-after': '5' });
  }
}

/**
 * IP is stored only as a daily-salted hash. X-Forwarded-For is client-controlled except for the entries appended by OUR proxies,
 * so we take the entry TRUSTED_PROXY_HOPS from the right (default 1 = the address our edge proxy saw). Without a proxy set 0 to ignore the header.
 * IP buckets are a secondary defense: primary limits are keyed by user/org/session, which a spoofed header cannot change.
 */
export function clientIp(h: Headers, hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1)): string {
  const parts = (h.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return hops > 0 && parts.length >= hops ? parts[parts.length - hops] : 'unknown';
}
export function ipKey(req: Request): string {
  const ip = clientIp(req.headers);
  const day = new Date().toISOString().slice(0, 10);
  return createHash('sha256').update(`${process.env.RATE_LIMIT_SALT ?? ''}|${day}|${ip}`).digest('hex').slice(0, 24);
}
