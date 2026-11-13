import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signBody } from '@/server/domain/email';

// Attack/regression scenarios for POST /api/v1/webhooks/email/[id]: body-size cap enforced on received bytes, before any secret lookup.
const CH = '11111111-1111-4111-8111-111111111111', SECRET = 's3cr3t';
const h = vi.hoisted(() => ({ secretGet: vi.fn(), rpc: vi.fn() }));
vi.mock('@/server/security/ratelimit', () => ({ enforceRateLimit: async () => {}, ipKey: () => '1.2.3.4' }));
vi.mock('@/server/security/secrets-instance', () => ({ secrets: () => ({ get: h.secretGet }) }));
vi.mock('@/server/security/system-client', () => ({
  systemClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { org_id: 'o1', kind: 'email', status: 'active', integration_id: 'i1' } }) }) }) }),
    rpc: h.rpc,
  }),
}));
vi.mock('@/server/log', () => ({ log: vi.fn() }));

import { POST } from '@/app/api/v1/webhooks/email/[id]/route';

const MAX = 25 * 1024 * 1024;
const call = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  POST(new Request(`http://x/api/v1/webhooks/email/${CH}`, { method: 'POST', body, headers, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit), { params: Promise.resolve({ id: CH }) });
const signed = (raw: string) => { const ts = String(Math.floor(Date.now() / 1000)); return { 'x-signature-timestamp': ts, 'x-signature': signBody(SECRET, ts, raw) }; };
const code = async (r: Response) => [r.status, (await r.json()).error?.code];

beforeEach(() => { h.secretGet.mockReset(); h.secretGet.mockResolvedValue(SECRET); h.rpc.mockReset(); h.rpc.mockResolvedValue({ data: true, error: null }); });

describe('webhook body size cap', () => {
  it('chunked upload with no Content-Length that exceeds the cap => 413, reading stops early, secret never fetched', async () => {
    let pulls = 0, cancelled = false;
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
    expect(await code(await call(endless))).toEqual([413, 'payload_too_large']);
    expect(cancelled).toBe(true); expect(pulls).toBeLessThan(40);        // cap is 25 MiB; an unbounded read would never return
    expect(h.secretGet).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
  });
  it('lying small Content-Length does not bypass the cap', async () => {
    let pulls = 0;
    const big = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(4 * 1024 * 1024)); } });
    expect((await call(big, { 'content-length': '10' })).status).toBe(413);
    expect(pulls).toBeLessThan(20); expect(h.rpc).not.toHaveBeenCalled();
  });
  it('declared oversize Content-Length => 413 immediately', async () => {
    expect((await call('x', { 'content-length': String(MAX + 1) })).status).toBe(413);
    expect(h.secretGet).not.toHaveBeenCalled();
  });
  it.each(['abc', '-5', '1.5', ''])('malformed Content-Length %j => 400, nothing stored', async (v) => {
    expect((await call('x', { 'content-length': v })).status).toBe(400); expect(h.rpc).not.toHaveBeenCalled();
  });
  it('empty body => rejected (bad signature), nothing stored', async () => {
    expect((await call('')).status).toBe(401); expect((await call(null)).status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('empty body with a valid signature over nothing => 422, nothing stored', async () => {
    expect((await call('', signed(''))).status).toBe(422); expect(h.rpc).not.toHaveBeenCalled();
  });
  it('an unsigned body below the cap is still rejected (401) and not stored', async () => {
    expect((await call(JSON.stringify({ from: { email: 'a@b.co' }, text: 'x' }))).status).toBe(401); expect(h.rpc).not.toHaveBeenCalled();
  });
  it('regression: a correctly signed message under the cap is accepted and stored', async () => {
    const raw = JSON.stringify({ message_id: '<m1@x>', from: { email: 'cust@example.com' }, subject: 'hi', text: 'hello' });
    const r = await call(raw, signed(raw)); expect([r.status, (await r.json()).data]).toEqual([200, { duplicate: false }]);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it('regression: a body just under the cap that is signed correctly is accepted by the reader (then fails parsing, not size)', async () => {
    const raw = 'a'.repeat(1024 * 1024);                                 // 1 MiB of garbage
    expect((await call(raw, signed(raw))).status).toBe(422);
  });
});
