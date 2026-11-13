import { describe, expect, it } from 'vitest';
import { safeNext } from '@/lib/safe-next';
import { clientIp } from '@/server/security/ratelimit';

describe('safeNext (open redirect guard)', () => {
  it.each(['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)', '', null, undefined, '/a b', '/dash?x=https://evil'])('rejects %s', (v) => expect(safeNext(v as string)).toBe('/dashboard'));
  it('accepts local paths', () => { expect(safeNext('/dashboard')).toBe('/dashboard'); expect(safeNext('/dashboard/orgs/1')).toBe('/dashboard/orgs/1'); });
});
describe('clientIp (X-Forwarded-For spoofing)', () => {
  const h = (v: string) => new Headers({ 'x-forwarded-for': v });
  it('takes the entry our proxy appended, not the client-supplied first one', () => {
    expect(clientIp(h('1.1.1.1, 9.9.9.9'), 1)).toBe('9.9.9.9');          // client forged 1.1.1.1; proxy saw 9.9.9.9
    expect(clientIp(h('forged, 7.7.7.7, 9.9.9.9'), 2)).toBe('7.7.7.7');
  });
  it('ignores the header when untrusted or too short', () => {
    expect(clientIp(h('1.1.1.1'), 0)).toBe('unknown'); expect(clientIp(h('1.1.1.1'), 2)).toBe('unknown'); expect(clientIp(new Headers(), 1)).toBe('unknown');
  });
});
