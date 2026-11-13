import { beforeEach, describe, expect, it, vi } from 'vitest';

// Attack scenarios against POST /api/v1/invitations/redeem with the DB, GoTrue admin API, mailer and rate limiter replaced by spies.
const h = vi.hoisted(() => ({
  preview: [] as unknown[], createUser: vi.fn(), sent: [] as { to: string; code: string }[], mailOk: true,
  limiter: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('@/server/security/system-client', () => ({
  systemClient: () => ({ rpc: async () => ({ data: h.preview, error: null }), auth: { admin: { createUser: h.createUser } } }),
}));
vi.mock('@/server/security/ratelimit', () => ({ enforceRateLimit: h.limiter, ipKey: () => '1.2.3.4' }));
vi.mock('@/server/adapters/mail', () => ({ sendInviteCodeMail: async (to: string, code: string) => { if (h.mailOk) h.sent.push({ to, code }); return h.mailOk; } }));
vi.mock('@/server/log', () => ({ log: vi.fn() }));

import { POST } from '@/app/api/v1/invitations/redeem/route';
import { inviteCode } from '@/server/domain/invite-proof';

const TOKEN = 'k'.repeat(43), OTHER = 'z'.repeat(43), PW = 'Correct-Horse-123';
const call = (body: unknown) => POST(new Request('http://x/api/v1/invitations/redeem', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
const live = (email = 'invitee@example.com', has = false) => { h.preview = [{ out_email: email, out_has_account: has }]; };

beforeEach(() => {
  process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 3).toString('base64');
  vi.stubEnv('NODE_ENV', 'test');
  h.createUser.mockReset(); h.createUser.mockResolvedValue({ error: null }); h.sent.length = 0; h.mailOk = true; h.limiter.mockClear(); live();
});

describe('redeem requires proof of mailbox (no email_confirm on token possession alone)', () => {
  it('token + password alone creates NOTHING: it mails a code to the invited address and returns 202 without the code', async () => {
    const r = await call({ token: TOKEN, password: PW }); const body = await r.json();
    expect(r.status).toBe(202); expect(h.createUser).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(1); expect(h.sent[0].to).toBe('invitee@example.com');
    expect(JSON.stringify(body)).not.toContain(h.sent[0].code); expect(r.headers.get('cache-control')).toBe('no-store');
    expect(body.data.email_hint).not.toContain('invitee');                      // masked
  });
  it('a holder of the token who cannot read the mailbox is stopped: wrong / guessed / missing code => 422, no account', async () => {
    for (const code of ['00000000', '12345678', '99999999']) {
      const r = await call({ token: TOKEN, password: PW, code }); expect([r.status, (await r.json()).error.code]).toEqual([422, 'invalid_code']);
    }
    expect(h.createUser).not.toHaveBeenCalled();
  });
  it('malformed code => 422 validation, no account', async () => {
    for (const code of ['abc', '1234567', '123456789', '12 45678']) expect((await call({ token: TOKEN, password: PW, code })).status).toBe(422);
    expect(h.createUser).not.toHaveBeenCalled();
  });
  it('a valid code creates the CONFIRMED account for the invited address taken from the DB (never from the request)', async () => {
    const code = inviteCode(TOKEN, 'invitee@example.com');
    const r = await call({ token: TOKEN, password: PW, code, email: 'attacker@evil.test' });   // extra field is ignored
    expect(r.status).toBe(201); expect((await r.json()).data.email).toBe('invitee@example.com');
    expect(h.createUser).toHaveBeenCalledTimes(1);
    expect(h.createUser).toHaveBeenCalledWith({ email: 'invitee@example.com', password: PW, email_confirm: true });
  });
  it('a code issued for another invitation/token is rejected (token re-issue invalidates old codes)', async () => {
    const r = await call({ token: OTHER, password: PW, code: inviteCode(TOKEN, 'invitee@example.com') });
    expect(r.status).toBe(422); expect(h.createUser).not.toHaveBeenCalled();
  });
  it('invitation e-mail changed after the code was issued => code no longer works', async () => {
    const code = inviteCode(TOKEN, 'invitee@example.com'); live('someone.else@example.com');
    expect((await call({ token: TOKEN, password: PW, code })).status).toBe(422); expect(h.createUser).not.toHaveBeenCalled();
  });
  it('an expired code is rejected', async () => {
    const code = inviteCode(TOKEN, 'invitee@example.com', Date.now() - 60 * 60_000);
    expect((await call({ token: TOKEN, password: PW, code })).status).toBe(422); expect(h.createUser).not.toHaveBeenCalled();
  });
  it('reused / revoked / expired / unknown token (preview finds nothing) => 404, no mail, no account', async () => {
    h.preview = [];
    for (const body of [{ token: TOKEN, password: PW }, { token: TOKEN, password: PW, code: '12345678' }]) {
      const r = await call(body); expect([r.status, (await r.json()).error.code]).toEqual([404, 'invitation_invalid']);
    }
    expect(h.sent).toHaveLength(0); expect(h.createUser).not.toHaveBeenCalled();
  });
  it('an address that already has an account => 409; no mail is sent and the existing password is never touched', async () => {
    live('invitee@example.com', true);
    for (const body of [{ token: TOKEN, password: PW }, { token: TOKEN, password: PW, code: inviteCode(TOKEN, 'invitee@example.com') }]) expect((await call(body)).status).toBe(409);
    expect(h.sent).toHaveLength(0); expect(h.createUser).not.toHaveBeenCalled();
  });
  it('production without a working mailer fails closed (503) instead of trusting the link', async () => {
    vi.stubEnv('NODE_ENV', 'production'); h.mailOk = false;
    const r = await call({ token: TOKEN, password: PW }); expect([r.status, (await r.json()).error.code]).toEqual([503, 'mail_unavailable']);
    expect(h.createUser).not.toHaveBeenCalled();
  });
  it('code guessing and mailbox spam are rate-limited per link', async () => {
    await call({ token: TOKEN, password: PW }); await call({ token: TOKEN, password: PW, code: '00000000' });
    const keys = h.limiter.mock.calls.map((c) => [c[0], c[1]] as [string, number]);
    expect(keys.some(([k, n]) => /:invite_code_send$/.test(k) && n <= 3)).toBe(true);
    expect(keys.some(([k, n]) => /:invite_code_try$/.test(k) && n <= 5)).toBe(true);
  });
  it('weak password reported without creating anything else', async () => {
    h.createUser.mockResolvedValue({ error: { code: 'weak_password' } });
    const r = await call({ token: TOKEN, password: PW, code: inviteCode(TOKEN, 'invitee@example.com') });
    expect([r.status, (await r.json()).error.code]).toEqual([422, 'weak_password']);
  });
});
