import dns from 'node:dns';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// SSRF scenarios against POST /api/v1/channels: a tenant-supplied smtp_url must be rejected BEFORE anything is created or stored.
const h = vi.hoisted(() => ({ rpc: vi.fn(), put: vi.fn() }));
vi.mock('@/server/security/authz', () => ({ requireOrg: async () => ({ orgId: 'o1', db: { rpc: h.rpc } }) }));
vi.mock('@/server/security/ratelimit', () => ({ enforceRateLimit: async () => {} }));
vi.mock('@/server/security/secrets-instance', () => ({ secrets: () => ({ put: h.put }) }));
vi.mock('@/server/log', () => ({ log: vi.fn() }));

import { POST } from '@/app/api/v1/channels/route';

const call = (body: unknown) => POST(new Request('http://x/api/v1/channels', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
const email = (smtp_url?: string) => ({ kind: 'email', name: 'Support', address: 'support@acme.test', ...(smtp_url ? { smtp_url } : {}) });

beforeEach(() => { delete process.env.SMTP_ALLOW_PRIVATE_HOSTS; h.rpc.mockReset(); h.put.mockReset(); h.rpc.mockResolvedValue({ data: [{ out_id: 'c1', out_public_key: null, out_integration_id: 'i1' }], error: null }); });
afterEach(() => vi.restoreAllMocks());

describe('channel creation rejects internal SMTP targets', () => {
  it.each([
    'smtps://127.0.0.1:465', 'smtp://169.254.169.254:25', 'smtps://u:p@10.0.0.8:465', 'smtp+starttls://192.168.1.10:587', 'smtps://[::1]:465', 'smtps://[fd00::1]:465',
    'smtps://localhost:465', 'smtps://smtp.example.com:6379', 'smtps://smtp.example.com:22', 'smtp://user:pw@smtp.example.com:25',
  ])('%s => 422 and nothing created or stored', async (u) => {
    const r = await call(email(u)); expect([r.status, (await r.json()).error.code]).toEqual([422, 'validation_failed']);
    expect(h.rpc).not.toHaveBeenCalled(); expect(h.put).not.toHaveBeenCalled();
  });
  it('non-SMTP schemes are rejected by the schema', async () => {
    for (const u of ['http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'gopher://127.0.0.1:25/_x']) expect((await call(email(u))).status).toBe(422);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('a hostname that resolves to a private address is rejected (DNS-based SSRF)', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '10.1.2.3', family: 4 }] as never);
    expect((await call(email('smtps://smtp.attacker.example:465'))).status).toBe(422); expect(h.put).not.toHaveBeenCalled();
  });
  it('a hostname with one public and one internal answer is rejected', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] as never);
    expect((await call(email('smtps://smtp.attacker.example:465'))).status).toBe(422);
  });
  it('an unresolvable host is rejected (fail closed)', async () => {
    vi.spyOn(dns.promises, 'lookup').mockRejectedValue(Object.assign(new Error('x'), { code: 'ENOTFOUND' }));
    expect((await call(email('smtps://nx.example.invalid:465'))).status).toBe(422);
  });
});

describe('regression: legitimate channels are unaffected', () => {
  it('a public SMTP host is accepted and the URL stored encrypted via secrets().put', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const r = await call(email('smtps://user:pw@smtp.example.com:465')); const b = await r.json();
    expect(r.status).toBe(201); expect(b.data.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(h.put).toHaveBeenCalledWith('o1', 'i1', 'smtp_url', 'smtps://user:pw@smtp.example.com:465');
    expect(JSON.stringify(b)).not.toContain('pw@');                         // the SMTP password is never echoed
  });
  it('an email channel without smtp_url needs no DNS at all', async () => {
    const spy = vi.spyOn(dns.promises, 'lookup'); expect((await call(email())).status).toBe(201); expect(spy).not.toHaveBeenCalled();
  });
  it('web chat channels are untouched', async () => {
    h.rpc.mockResolvedValue({ data: [{ out_id: 'c2', out_public_key: 'pk', out_integration_id: 'i2' }], error: null });
    const r = await call({ kind: 'web_chat', name: 'Site', allowed_origins: ['https://shop.example.com'] }); expect(r.status).toBe(201);
  });
});
