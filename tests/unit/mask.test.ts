import { describe, expect, it } from 'vitest';
import { last4, maskEmail, redact } from '@/server/security/mask';

describe('redact', () => {
  it('redacts sensitive keys at any depth and token-looking strings', () => {
    const out = JSON.stringify(redact({ user: 'a', api_key: 'sk-abcdefghijklmnop1234', nested: { Authorization: 'Bearer abc.def', note: 'call with Bearer abc123xyz now', jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig' }, list: [{ password: 'p' }, 'sk_live_abcdefghijklmnop12'] }));
    for (const leak of ['sk-abcdefghijklmnop1234', 'abc.def', 'abc123xyz', 'eyJhbGci', 'sk_live_abcdef', '"p"']) expect(out).not.toContain(leak);
    expect(out).toContain('"user":"a"');
  });
  it('is safe on errors, cycles-deep objects and primitives', () => {
    expect(redact(new Error('Bearer abcdef failed'))).toEqual({ name: 'Error', message: 'Bearer [REDACTED] failed' });
    let deep: Record<string, unknown> = {}; const root = deep; for (let i = 0; i < 20; i++) { deep.n = {}; deep = deep.n as Record<string, unknown>; }
    expect(() => JSON.stringify(redact(root))).not.toThrow();
    expect(redact(5)).toBe(5); expect(redact(null)).toBeNull();
  });
  it('masks email and shows last4 only for long values', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
    expect(last4('sk-1234567890')).toBe('7890'); expect(last4('short')).toBe('');
  });
});
