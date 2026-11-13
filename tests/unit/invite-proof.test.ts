import { beforeEach, describe, expect, it } from 'vitest';
import { inviteCode, verifyInviteCode } from '@/server/domain/invite-proof';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const TOKEN = 't'.repeat(43);
beforeEach(() => { process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64'); });

describe('invite proof-of-mailbox code', () => {
  it('is 8 digits, deterministic within a step, and verifies', () => {
    const c = inviteCode(TOKEN, 'a@example.com', T0);
    expect(c).toMatch(/^\d{8}$/); expect(inviteCode(TOKEN, 'a@example.com', T0 + 60_000)).toBe(c);
    expect(verifyInviteCode(TOKEN, 'a@example.com', c, T0 + 120_000)).toBe(true);
  });
  it('is bound to the invited address (changed invitee e-mail invalidates the code; case/space-insensitive for the same address)', () => {
    const c = inviteCode(TOKEN, 'a@example.com', T0);
    expect(verifyInviteCode(TOKEN, 'attacker@example.com', c, T0)).toBe(false);
    expect(verifyInviteCode(TOKEN, '  A@Example.com ', c, T0)).toBe(true);
  });
  it('is bound to the token: another invitation (re-issued link) cannot reuse a code', () => {
    const c = inviteCode(TOKEN, 'a@example.com', T0);
    expect(verifyInviteCode('u'.repeat(43), 'a@example.com', c, T0)).toBe(false);
  });
  it('expires: valid for the current + previous 15-minute step, rejected after that', () => {
    const c = inviteCode(TOKEN, 'a@example.com', T0);
    expect(verifyInviteCode(TOKEN, 'a@example.com', c, T0 + 20 * 60_000)).toBe(true);
    expect(verifyInviteCode(TOKEN, 'a@example.com', c, T0 + 31 * 60_000)).toBe(false);
    expect(verifyInviteCode(TOKEN, 'a@example.com', c, T0 + 24 * 3600_000)).toBe(false);
  });
  it('cannot be computed without the server secret', () => {
    const c = inviteCode(TOKEN, 'a@example.com', T0);
    process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
    expect(verifyInviteCode(TOKEN, 'a@example.com', c, T0)).toBe(false);
  });
  it.each(['', '1234567', '123456789', 'abcdefgh', '1234 678', '１２３４５６７８'])('rejects malformed code %j', (bad) => {
    expect(verifyInviteCode(TOKEN, 'a@example.com', bad, T0)).toBe(false);
  });
  it('fails closed without a server secret', () => {
    delete process.env.SECRETS_MASTER_KEY;
    expect(() => inviteCode(TOKEN, 'a@example.com', T0)).toThrow();
  });
});
