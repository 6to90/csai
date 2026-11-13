import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fromDbError, HttpError, route } from '@/server/http';

describe('error mapping', () => {
  it.each([
    [{ code: '42501', message: 'forbidden' }, 403, 'forbidden'],
    [{ code: '28000', message: 'unauthorized' }, 401, 'unauthorized'],
    [{ code: 'P0002', message: 'invitation_invalid' }, 404, 'invitation_invalid'],
    [{ code: '42501', message: 'email_mismatch' }, 403, 'email_mismatch'],
    [{ code: '23505', message: 'duplicate key value violates ...' }, 409, 'conflict'],
    [{ code: '22023', message: 'validation_failed' }, 422, 'validation_failed'],
    [{ code: 'XX000', message: 'relation "secret_table" exploded' }, 500, 'internal'],
  ])('%j -> %i %s', (e, status, code) => { const h = fromDbError(e); expect([h.status, h.code]).toEqual([status, code]); });

  it('route() never leaks internals and adds request id', async () => {
    const r = await route(async () => { throw new Error('db password=hunter2 at /srv/app.ts'); })(new Request('http://x'));
    const body = await r.json();
    expect(r.status).toBe(500); expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(body.error.request_id).toBe(r.headers.get('x-request-id'));
  });
  it('maps validation and HttpError (with headers)', async () => {
    const v = await route(async () => z.object({ a: z.string() }).parse({}))(new Request('http://x'));
    expect(v.status).toBe(422);
    const t = await route(async () => { throw new HttpError(429, 'rate_limited', 'slow', { 'retry-after': '7' }); })(new Request('http://x'));
    expect([t.status, t.headers.get('retry-after')]).toEqual([429, '7']);
  });
});
