import { describe, expect, it } from 'vitest';
import { buildCsp, securityHeaders } from '@/lib/security-headers';

const base = { nonce: 'abc123', isDev: false, https: true, supabaseOrigin: 'https://proj.supabase.co' };
describe('CSP', () => {
  const csp = buildCsp(base); const dir = (n: string) => csp.split('; ').find((d) => d.startsWith(n))!;
  it('production: nonce + strict-dynamic, no unsafe-inline/unsafe-eval anywhere', () => {
    expect(dir('script-src')).toContain("'nonce-abc123'"); expect(dir('script-src')).toContain("'strict-dynamic'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*\s|https:\s*;|data:.*script/);
  });
  it('locks down framing, plugins, base and form targets', () => {
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "default-src 'self'"]) expect(csp).toContain(d);
  });
  it('allows only what the app needs: its own Supabase origin and Turnstile', () => {
    expect(dir('connect-src')).toBe("connect-src 'self' https://proj.supabase.co wss://proj.supabase.co");   // wss for Realtime
    expect(dir('frame-src')).toBe('frame-src https://challenges.cloudflare.com');
    expect(dir('script-src')).toContain('https://challenges.cloudflare.com');
  });
  it('upgrade-insecure-requests only for https production', () => {
    expect(csp).toContain('upgrade-insecure-requests');
    expect(buildCsp({ ...base, https: false })).not.toContain('upgrade-insecure-requests');
  });
  it('dev policy is looser (eval for React dev tools, websockets for HMR) and never upgrades', () => {
    const dev = buildCsp({ ...base, isDev: true });
    expect(dev).toContain("'unsafe-eval'"); expect(dev).toContain('ws://localhost:*'); expect(dev).not.toContain('upgrade-insecure-requests');
  });
});
describe('securityHeaders', () => {
  it('HSTS only over https in production; never in dev or http', () => {
    expect(securityHeaders(base)['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains');
    expect(securityHeaders({ ...base, https: false })['Strict-Transport-Security']).toBeUndefined();
    expect(securityHeaders({ ...base, isDev: true })['Strict-Transport-Security']).toBeUndefined();
  });
  it('Permissions-Policy denies powerful features by default', () => {
    const p = securityHeaders(base)['Permissions-Policy'];
    for (const f of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()']) expect(p).toContain(f);
  });
  it('API responses get a deny-all CSP', () => {
    expect(securityHeaders(base, true)['Content-Security-Policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  });
  it('baseline headers are present', () => {
    const h = securityHeaders(base);
    expect(h['X-Content-Type-Options']).toBe('nosniff'); expect(h['X-Frame-Options']).toBe('DENY'); expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin'); expect(h['Referrer-Policy']).toBeTruthy();
  });
});
