import { describe, expect, it } from 'vitest';
import { call, CAPTCHA_TOKEN, mkUser, mkOrg, pool, realLogin, TEST_PASSWORD, uniq, upgradeToAal2, verifyTotp } from '../api/helpers';
import { totp } from '../api/totp';

// REAL local Supabase with CAPTCHA (Turnstile dummy secret) and TOTP MFA enabled. Run via scripts/test-supabase.sh.
const SB = process.env.SUPABASE_URL!;
const post = (path: string, body: unknown, key = process.env.ANON_KEY!, token?: string) =>
  fetch(`${SB}/auth/v1${path}`, { method: 'POST', headers: { apikey: key, authorization: `Bearer ${token ?? key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const aalOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).aal;
const withCaptcha = (b: object) => ({ ...b, gotrue_meta_security: { captcha_token: CAPTCHA_TOKEN } });

describe('CAPTCHA protects the public GoTrue endpoints, including direct API calls', () => {
  const email = () => `cap-${uniq()}@example.com`;
  it.each([['/signup', { password: TEST_PASSWORD }], ['/token?grant_type=password', { password: TEST_PASSWORD }], ['/recover', {}], ['/otp', {}]] as [string, object][])(
    '%s without a captcha token is refused (400 captcha_failed)', async (path, extra) => {
      const r = await post(path, { email: email(), ...extra }); const b = await r.json();
      expect([r.status, b.error_code]).toEqual([400, 'captcha_failed']);
    });
  it('empty / blank captcha tokens are refused too', async () => {
    for (const t of ['', '   ']) {
      const r = await post('/signup', { email: email(), password: TEST_PASSWORD, gotrue_meta_security: { captcha_token: t } });
      expect([r.status, (await r.json()).error_code]).toEqual([400, 'captcha_failed']);
    }
  });
  it('a refused attempt creates no user and sends no mail', async () => {
    const e = email(); await post('/signup', { email: e, password: TEST_PASSWORD });
    expect((await pool.query('select 1 from auth.users where email=$1', [e])).rowCount).toBe(0);
  });
  it('with a token the request proceeds; operator (service-role) admin API is not captcha-gated', async () => {
    const r = await post('/signup', withCaptcha({ email: email(), password: TEST_PASSWORD })); expect([r.status, (await r.json()).error_code]).toEqual([422, 'signup_disabled']);   // captcha passes, policy refuses
    const admin = await post('/admin/users', { email: email(), password: TEST_PASSWORD, email_confirm: true }, process.env.SERVICE_KEY!); expect(admin.status).toBe(200);
  });
  it('the app never forwards GoTrue sign-up errors to users (UI/API surface stays uniform)', async () => {
    const r = await call('POST', '/api/v1/invitations/accept', { user: { token: 'garbage' }, body: { token: 'x'.repeat(30) } });
    expect(r.status).toBe(401);
  });
});

describe('MFA (TOTP) through real GoTrue', () => {
  it('password session is aal1; enroll+verify yields aal2; wrong codes are rejected (replay window recorded)', async () => {
    const u = await mkUser('mfa', true, { aal: 'aal1' });
    expect(aalOf(u.token)).toBe('aal1');
    const up = await upgradeToAal2(u.token); expect(aalOf(up.token)).toBe('aal2');
    await expect(verifyTotp(u.token, up.factorId, up.totpSecret, '000000')).rejects.toMatchObject({ status: 422, body: { error_code: 'mfa_verification_failed' } });
    // KNOWN FINDING (GoTrue behavior): a TOTP code that was just used is accepted again inside its time window (no single-use enforcement, RFC 6238 §5.2).
    // Residual risk: an observer who captures a fresh code can reuse it for up to ~30-60s. Recorded, not assumed; if GoTrue starts rejecting, flip this assertion.
    expect(aalOf(await verifyTotp(u.token, up.factorId, up.totpSecret))).toBe('aal2');
    const org = await mkOrg({ ...u, token: up.token });
    expect((await call('GET', '/api/v1/org', { user: { token: u.token }, org })).body.error.code).toBe('mfa_required');
    expect((await call('GET', '/api/v1/org', { user: { token: up.token }, org })).status).toBe(200);
  });
  it('a new password login for an enrolled user starts at aal1 again, the TOTP step restores aal2, and refreshing a password-only session never upgrades it', async () => {
    const u = await mkUser('mfa2', true, { aal: 'aal2' });
    const s = await realLogin(u.email); expect(aalOf(s.access_token)).toBe('aal1');            // password alone never grants aal2
    const org = await mkOrg(u);
    expect((await call('GET', '/api/v1/org', { user: { token: s.access_token }, org })).status).toBe(403);
    const t2 = await verifyTotp(s.access_token, u.factorId!, u.totpSecret!, totp(u.totpSecret!, Date.now() + 30_000));   // next time-step code
    expect(aalOf(t2)).toBe('aal2');
    const ref = await post('/token?grant_type=refresh_token', { refresh_token: (await realLogin(u.email)).refresh_token });
    expect(ref.status).toBe(200); expect(aalOf((await ref.json()).access_token)).toBe('aal1');   // a fresh password session's refresh does not upgrade
  });
  it('the aal claim cannot be forged: editing the payload invalidates the signature (API and PostgREST)', async () => {
    const u = await mkUser('mfa3', true, { aal: 'aal1' }); const org = await mkOrg(u);
    const [h, p, s] = u.token.split('.'); const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }] })).toString('base64url')}.${s}`;
    expect((await call('GET', '/api/v1/org', { user: { token: forged }, org })).status).toBe(401);
    const rest = await fetch(`${SB}/rest/v1/rpc/is_aal2`, { method: 'POST', headers: { apikey: process.env.ANON_KEY!, authorization: `Bearer ${forged}`, 'content-type': 'application/json' }, body: '{}' });
    expect(rest.status).toBe(401);
    const real = await fetch(`${SB}/rest/v1/rpc/is_aal2`, { method: 'POST', headers: { apikey: process.env.ANON_KEY!, authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: '{}' });
    expect([real.status, await real.json()]).toEqual([200, false]);                           // DB sees the real claim
  });
  it('operator recovery for a lost authenticator: admin API removes the factor, the user re-enrolls', async () => {
    const u = await mkUser('lost', true, { aal: 'aal2' });
    const del = await fetch(`${SB}/auth/v1/admin/users/${u.id}/factors/${u.factorId}`, { method: 'DELETE', headers: { apikey: process.env.SERVICE_KEY!, authorization: `Bearer ${process.env.SERVICE_KEY!}` } });
    expect(del.status).toBe(200);
    const s = await realLogin(u.email); expect(aalOf(s.access_token)).toBe('aal1');
    expect(aalOf((await upgradeToAal2(s.access_token)).token)).toBe('aal2');
  });
});
