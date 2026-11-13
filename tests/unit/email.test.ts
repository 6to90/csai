import { describe, expect, it } from 'vitest';
import { InboundEmail, normalizeMessageId, signBody, syntheticMessageId, toInboundMessage, verifySignature } from '@/server/domain/email';

describe('message-id normalisation (DATABASE §10)', () => {
  it('strips brackets/space, lowercases, caps length; empty -> null', () => {
    expect(normalizeMessageId('  <ABC.Def@Mail.Example>  ')).toBe('abc.def@mail.example');
    expect(normalizeMessageId('<<x@y>>')).toBe('x@y');
    expect(normalizeMessageId('   ')).toBeNull(); expect(normalizeMessageId(undefined)).toBeNull();
    expect(normalizeMessageId('a'.repeat(2000))).toHaveLength(998);
  });
  it('synthetic ids are stable and content-sensitive', () => {
    const a = syntheticMessageId('a@b.co', 'd', 's', 'body'); expect(a).toBe(syntheticMessageId('a@b.co', 'd', 's', 'body')); expect(a).not.toBe(syntheticMessageId('a@b.co', 'd', 's', 'body2'));
    expect(toInboundMessage(InboundEmail.parse({ from: { email: 'A@B.co' }, text: 'x' })).external_id).toMatch(/^synthetic:/);
  });
  it('payload is strict (unknown keys such as org_id are rejected) and the sender is lowercased', () => {
    expect(InboundEmail.safeParse({ from: { email: 'a@b.co' }, text: '', org_id: 'x' }).success).toBe(false);
    expect(toInboundMessage(InboundEmail.parse({ message_id: '<M1@X>', from: { email: 'Bob@Example.COM' }, references: ['<R1@x>', ' '] }))).toMatchObject({ external_id: 'm1@x', from_value: 'bob@example.com', references: ['r1@x'] });
  });
});

describe('webhook signature', () => {
  const secret = 's3cret', raw = '{"a":1}', now = 1_800_000_000, ts = String(now);
  const sig = signBody(secret, ts, raw);
  it('accepts a correct, fresh signature', () => expect(verifySignature(secret, ts, sig, raw, now)).toBe(true));
  it('rejects wrong secret, tampered body, stale/future timestamp, malformed headers', () => {
    expect(verifySignature('other', ts, sig, raw, now)).toBe(false);
    expect(verifySignature(secret, ts, sig, raw + ' ', now)).toBe(false);
    expect(verifySignature(secret, ts, sig, raw, now + 301)).toBe(false); expect(verifySignature(secret, ts, sig, raw, now - 301)).toBe(false);
    expect(verifySignature(secret, ts, sig, raw, now + 300)).toBe(true);
    for (const [t, s] of [[null, sig], [ts, null], ['abc', sig], [ts, 'zz'], [ts, sig.slice(2)]] as [string | null, string | null][]) expect(verifySignature(secret, t, s, raw, now)).toBe(false);
  });
  it('the timestamp is part of the signed data (cannot be re-dated)', () => expect(verifySignature(secret, String(now + 1), sig, raw, now + 1)).toBe(false));
});
