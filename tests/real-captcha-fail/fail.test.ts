import { describe, expect, it } from 'vitest';

// Runs ONLY via scripts/test-captcha-fail.sh, against a stack whose captcha secret is Cloudflare's dummy "always FAIL" secret.
const SB = process.env.SUPABASE_URL!;
describe('server-side captcha verification failure', () => {
  it('a present-but-rejected captcha token blocks sign-up, sign-in and recovery', async () => {
    for (const [path, extra] of [['/signup', { password: 'Test-Password-12345!' }], ['/token?grant_type=password', { password: 'Test-Password-12345!' }], ['/recover', {}]] as [string, object][]) {
      const r = await fetch(`${SB}/auth/v1${path}`, { method: 'POST', headers: { apikey: process.env.ANON_KEY!, 'content-type': 'application/json' }, body: JSON.stringify({ email: `f-${Date.now()}@example.com`, ...extra, gotrue_meta_security: { captcha_token: 'XXXX.DUMMY.TOKEN.XXXX' } }) });
      const b = await r.json(); expect([r.status, b.error_code], path).toEqual([400, 'captcha_failed']);
    }
  });
});
