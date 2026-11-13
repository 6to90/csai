import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JSON_LIMIT } from '@/server/http-body';

// Every JSON endpoint: oversize / chunked / malformed / empty bodies. Auth, DB and rate limiting are replaced by stubs so the body handling is what is under test.
const ID = '11111111-1111-4111-8111-111111111111';
// conversations/* routes verify ownership (select().eq().eq().maybeSingle()) before they read the body
const stubDb = { rpc: vi.fn(async () => ({ data: [], error: null })), from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: ID } }) }) }) }) }) };
vi.mock('@/server/security/authz', () => ({
  requireUser: async () => ({ userId: ID, db: stubDb, email: 'a@b.co' }),
  requireOrg: async () => ({ userId: ID, orgId: ID, role: 'owner', db: stubDb }),
}));
vi.mock('@/server/chat', async (orig) => ({ ...(await orig<typeof import('@/server/chat')>()), requireChatSession: async () => ({ id: 's1', org_id: ID, channel_account_id: ID, conversation_id: ID, visitor_id: 'v', verified_email: null }) }));
vi.mock('@/server/security/ratelimit', () => ({ enforceRateLimit: async () => {}, ipKey: () => '1.2.3.4' }));
vi.mock('@/server/security/system-client', () => ({ systemClient: () => ({ rpc: async () => ({ data: [], error: null }), from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) }) }));
vi.mock('@/server/security/secrets-instance', () => ({ secrets: () => ({ get: async () => null, put: async () => {} }) }));
vi.mock('@/server/security/net-guard', async (orig) => ({ ...(await orig<typeof import('@/server/security/net-guard')>()) }));
vi.mock('@/server/log', () => ({ log: vi.fn() }));

type Handler = (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const R: [string, string, keyof typeof JSON_LIMIT, 'POST' | 'PATCH', Record<string, string>?][] = [
  ['@/app/api/v1/chat/messages/route', 'chat/messages', 'chatMessage', 'POST'],
  ['@/app/api/v1/chat/sessions/route', 'chat/sessions', 'small', 'POST'],
  ['@/app/api/v1/invitations/preview/route', 'invitations/preview', 'token', 'POST'],
  ['@/app/api/v1/invitations/accept/route', 'invitations/accept', 'token', 'POST'],
  ['@/app/api/v1/invitations/redeem/route', 'invitations/redeem', 'tiny', 'POST'],
  ['@/app/api/internal/customers/route', 'internal/customers', 'small', 'POST'],
  ['@/app/api/v1/org/route', 'org', 'tiny', 'PATCH'],
  ['@/app/api/v1/org/invitations/route', 'org/invitations', 'tiny', 'POST'],
  ['@/app/api/v1/orgs/route', 'orgs', 'tiny', 'POST'],
  ['@/app/api/v1/org/members/[id]/route', 'org/members/x', 'tiny', 'PATCH', { id: ID }],
  ['@/app/api/v1/conversations/[id]/route', 'conversations/x', 'small', 'PATCH', { id: ID }],
  ['@/app/api/v1/conversations/[id]/messages/route', 'conversations/x/messages', 'agentMessage', 'POST', { id: ID }],
  ['@/app/api/v1/channels/route', 'channels', 'form', 'POST'],
  ['@/app/api/v1/channels/[id]/route', 'channels/x', 'form', 'PATCH', { id: ID }],
];

beforeEach(() => { process.env.CRON_SECRET = 'cron-secret'; process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 1).toString('base64'); });

const send = async (mod: string, method: 'POST' | 'PATCH', params: Record<string, string> | undefined, body: BodyInit | null, extra: Record<string, string> = {}) => {
  const h = (await import(/* @vite-ignore */ mod))[method] as Handler;
  const init = { method, body, headers: { 'content-type': 'application/json', authorization: 'Bearer cron-secret', 'x-org-id': ID, ...extra }, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit;
  return h(new Request('http://x/api', init), { params: Promise.resolve(params ?? {}) });
};

describe.each(R)('%s', (mod, _name, limit, method, params) => {
  const cap = JSON_LIMIT[limit];
  it(`body over ${cap} bytes => 413 payload_too_large`, async () => {
    const r = await send(mod, method, params, JSON.stringify({ pad: 'x'.repeat(cap + 10) }));
    expect([r.status, (await r.json()).error.code]).toEqual([413, 'payload_too_large']);
  });
  it('chunked endless upload (no Content-Length) is cut off with 413, not buffered', async () => {
    let pulls = 0, cancelled = false;
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(4096).fill(97)); }, cancel() { cancelled = true; } });
    const r = await send(mod, method, params, endless);
    expect(r.status).toBe(413); expect(cancelled).toBe(true); expect(pulls).toBeLessThan(cap / 4096 + 20);
  });
  it('lying small Content-Length does not bypass the cap', async () => {
    const big = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(8192).fill(97)); } });
    expect((await send(mod, method, params, big, { 'content-length': '2' })).status).toBe(413);
  });
  it('malformed JSON, empty body and non-object JSON keep the old contract: 422 (never 500, never 413)', async () => {
    for (const b of ['{', '', 'null', '[]', '"x"']) { const r = await send(mod, method, params, b); expect([b, r.status]).toEqual([b, 422]); }
  });
  it('malformed Content-Length => 400', async () => {
    expect((await send(mod, method, params, '{}', { 'content-length': 'abc' })).status).toBe(400);
  });
});

describe('regression: a normal-sized request is still accepted by the reader', () => {
  it('chat message of the maximum allowed length (4000 chars of 3-byte text) fits the cap and reaches the handler', async () => {
    const r = await send('@/app/api/v1/chat/messages/route', 'POST', undefined, JSON.stringify({ body: '가'.repeat(4000), client_id: 'abcdefgh1234' }));
    expect(r.status).not.toBe(413); expect(r.status).not.toBe(400);
  });
  it('agent reply of the maximum allowed length (20000 chars of 3-byte text) fits the cap', async () => {
    const r = await send('@/app/api/v1/conversations/[id]/messages/route', 'POST', { id: ID }, JSON.stringify({ body: '가'.repeat(20000), client_id: ID }));
    expect(r.status).not.toBe(413);
  });
});
