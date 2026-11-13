import { describe, expect, it } from 'vitest';
import { BASE, call, mkOrg, mkUser } from './helpers';

// Real HTTP against the production build: body caps are enforced on received bytes, and the old 422 contract for bad JSON is unchanged.
const raw = (path: string, body: BodyInit | null, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers }, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);

describe('anonymous endpoints (real HTTP)', () => {
  it('an oversized body is refused with 413 before it is parsed', async () => {
    for (const p of ['/api/v1/invitations/preview', '/api/v1/invitations/redeem', '/api/v1/invitations/accept', '/api/v1/chat/sessions']) {
      const r = await raw(p, JSON.stringify({ pad: 'x'.repeat(300_000) }), { 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
      expect([p, r.status]).toEqual([p, p.endsWith('/accept') ? 401 : 413]);   // accept authenticates first (still never reads the body)
    }
  });
  it('a chunked upload with no Content-Length is cut off with 413', async () => {
    let pulls = 0; const body = new ReadableStream<Uint8Array>({ pull(c) { if (++pulls > 400) return c.close(); c.enqueue(new Uint8Array(4096).fill(120)); } });
    const r = await raw('/api/v1/invitations/preview', body, { 'x-forwarded-for': '10.8.1.1' });
    expect(r.status).toBe(413);
  });
  it('malformed JSON / empty body keep answering 422 (contract unchanged)', async () => {
    for (const b of ['{', '', 'null']) { const r = await raw('/api/v1/invitations/preview', b, { 'x-forwarded-for': '10.7.2.2' }); expect([b, r.status]).toEqual([b, 422]); }
  });
});

describe('authenticated endpoints (real HTTP)', () => {
  it('oversized bodies are 413 and a normal request still works', async () => {
    const owner = await mkUser('body-owner'); const org = await mkOrg(owner);
    const big = await call('PATCH', '/api/v1/org', { user: owner, org, body: { name: 'x'.repeat(50_000) } });
    expect([big.status, big.body.error.code]).toEqual([413, 'payload_too_large']);
    const ok = await call('PATCH', '/api/v1/org', { user: owner, org, body: { name: 'Renamed Co' } });
    expect(ok.status).toBe(200);
  });
});
