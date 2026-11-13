import 'server-only';
import { createHash } from 'node:crypto';
import { systemClient } from './system-client';
import { HttpError } from '../http';

const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
export function readIdempotencyKey(req: Request, required: boolean): string | null {
  const k = req.headers.get('idempotency-key');
  if (!k) { if (required) throw new HttpError(422, 'validation_failed', 'Idempotency-Key header required'); return null; }
  if (!KEY_RE.test(k)) throw new HttpError(422, 'validation_failed', 'invalid Idempotency-Key');
  return k;
}
const stable = (v: unknown): string =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
    : JSON.stringify(v ?? null);

/**
 * Same key + same body replays the first response; same key + different body => 422. A failed first attempt releases the key.
 * Do NOT use for responses that contain secrets/tokens: responses are stored in idempotency_keys.
 */
export async function withIdempotency<T>(a: { orgId: string; scope: string; key: string; body: unknown }, fn: () => Promise<T>): Promise<{ replayed: boolean; value: T }> {
  const db = systemClient();
  const hash = createHash('sha256').update(stable(a.body)).digest('hex');
  const { data, error } = await db.rpc('idem_begin', { p_org: a.orgId, p_scope: a.scope, p_key: a.key, p_hash: hash });
  if (error) throw new HttpError(500, 'internal');
  const r = (data as { out_state: string; out_response: T }[])[0];
  if (r.out_state === 'mismatch') throw new HttpError(422, 'idempotency_mismatch', 'Idempotency-Key reused with a different request');
  if (r.out_state === 'in_progress') throw new HttpError(409, 'conflict', 'request with this Idempotency-Key is in progress', { 'retry-after': '2' });
  if (r.out_state === 'replay') return { replayed: true, value: r.out_response };
  try {
    const value = await fn();
    await db.rpc('idem_finish', { p_org: a.orgId, p_scope: a.scope, p_key: a.key, p_response: value as never });
    return { replayed: false, value };
  } catch (e) {
    await db.rpc('idem_release', { p_org: a.orgId, p_scope: a.scope, p_key: a.key });
    throw e;
  }
}
