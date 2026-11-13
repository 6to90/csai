import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { call, CAPTCHA_TOKEN, invite, mkOrg, mkUser, pool, realLogin, TEST_PASSWORD, tokenOf, uniq } from '../api/helpers';

// REAL local Supabase (GoTrue + Mailpit + PostgREST + Kong). Run via scripts/test-supabase.sh.
const SB = process.env.SUPABASE_URL!;
const H = (key: string, extra: Record<string, string> = {}) => ({ apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extra });
const gotrue = (path: string, init: RequestInit & { key?: string } = {}) =>
  fetch(`${SB}/auth/v1${path}`, { ...init, headers: { ...H(init.key ?? process.env.ANON_KEY!), ...(init.headers as object) } });
// CAPTCHA is enabled on the stack: every direct sign-up / password sign-in must carry a captcha token (see captcha.test.ts).
const cap = { gotrue_meta_security: { captcha_token: CAPTCHA_TOKEN } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const forge = (claims: Record<string, unknown>, secret = process.env.JWT_SECRET!) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url'); const h = b({ alg: 'HS256', typ: 'JWT' }), p = b(claims);
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
};

describe('real GoTrue: invite-only sign-up policy', () => {
  it('public sign-up is closed; an operator-provisioned invitee can log in and accept the invitation', async () => {
    const owner = await mkUser('real-owner'); const org = await mkOrg(owner);
    const email = `newbie-${uniq()}@example.com`;
    const inv = await invite(org, owner, email, 'viewer'); expect(inv.status).toBe(201);
    const su = await gotrue('/signup', { method: 'POST', body: JSON.stringify({ email, password: TEST_PASSWORD, ...cap }) });
    expect([su.status, (await su.json()).error_code]).toEqual([422, 'signup_disabled']);
    expect((await pool.query('select 1 from auth.users where email=$1', [email])).rowCount).toBe(0);
    const adm = await gotrue('/admin/users', { method: 'POST', key: process.env.SERVICE_KEY!, body: JSON.stringify({ email, password: TEST_PASSWORD, email_confirm: true }) });
    expect(adm.status).toBe(200);                                                   // operator provisioning (service_role only)
    const session = await realLogin(email);
    const acc = await call('POST', '/api/v1/invitations/accept', { user: { token: session.access_token }, body: { token: tokenOf(inv.body.data.accept_url) }, headers: { 'x-forwarded-for': `10.${uniq().length}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });
    expect(acc.status).toBe(200); expect(acc.body.data).toEqual({ org_id: org, role: 'viewer' });
  });
  it('login failures and sign-ups answer identically for existing and unknown addresses (no account enumeration)', async () => {
    const u = await mkUser('exists');
    const login = (email: string) => gotrue('/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password: 'wrong-password-1', ...cap }) });
    const bad = await login(u.email), none = await login(`nobody-${uniq()}@example.com`);
    expect([bad.status, none.status]).toEqual([400, 400]);
    expect((await bad.json()).error_code).toBe((await none.json()).error_code);
    const su = (email: string) => gotrue('/signup', { method: 'POST', body: JSON.stringify({ email, password: TEST_PASSWORD, ...cap }) });
    const dup = await su(u.email), fresh = await su(`nobody-${uniq()}@example.com`);
    expect([dup.status, (await dup.json()).error_code]).toEqual([422, 'signup_disabled']);   // formerly 422 user_already_exists (oracle) — closed
    expect([fresh.status, (await fresh.json()).error_code]).toEqual([422, 'signup_disabled']);
  });
});

describe('real GoTrue: JWT validation, logout, session expiry, refresh', () => {
  it('real access token authenticates the API; service/anon keys and bad tokens do not', async () => {
    const u = await mkUser('jwt'); const org = await mkOrg(u);
    expect((await call('GET', '/api/v1/org', { user: u, org })).status).toBe(200);
    for (const key of [process.env.SERVICE_KEY!, process.env.ANON_KEY!, 'garbage']) expect((await call('GET', '/api/v1/org', { user: { token: key }, org })).status).toBe(401);
  });
  it('tampered, wrong-secret and expired JWTs are rejected by GoTrue and PostgREST', async () => {
    const u = await mkUser('tamper'); const org = await mkOrg(u);
    const [h, p, s] = u.token.split('.'); const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const escalated = `${h}.${Buffer.from(JSON.stringify({ ...claims, role: 'service_role' })).toString('base64url')}.${s}`;       // keep signature, change role
    const wrongSecret = forge({ ...claims }, 'x'.repeat(40));
    const expired = forge({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 });
    for (const [name, token] of Object.entries({ escalated, wrongSecret, expired })) {
      expect((await call('GET', '/api/v1/org', { user: { token }, org })).status, `${name} via API`).toBe(401);
      expect((await fetch(`${SB}/rest/v1/organizations?select=id`, { headers: H(process.env.ANON_KEY!, { authorization: `Bearer ${token}` }) })).status, `${name} via PostgREST`).toBe(401);
      expect((await gotrue('/user', { headers: { authorization: `Bearer ${token}` } })).status, `${name} via GoTrue`).toBeGreaterThanOrEqual(401);
    }
  });
  it('logout revokes the session: the old access token stops working', async () => {
    const email = `logout-${uniq()}@example.com`; const mk = await mkUser('lo'); void mk;
    const u = await mkUser('logout'); const org = await mkOrg(u);
    expect((await call('GET', '/api/v1/org', { user: u, org })).status).toBe(200);
    const out = await gotrue('/logout', { method: 'POST', headers: { authorization: `Bearer ${u.token}` } }); expect([200, 204]).toContain(out.status);
    const after = await call('GET', '/api/v1/org', { user: u, org });
    expect(after.status).toBe(401); void email;
  });
  it('refresh token rotation: the immediate parent maps to the live token; an older token is rejected (family is not revoked)', async () => {
    const u = await mkUser('refresh');
    const rf = (t: string) => gotrue('/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: t }) });
    const s1 = await realLogin(u.email);
    const s2 = await (await rf(s1.refresh_token)).json(); expect(s2.refresh_token).not.toBe(s1.refresh_token);
    // OBSERVED GoTrue behavior: replaying the immediate parent is answered with the current live token (no error, no new rotation).
    const parentReplay = await rf(s1.refresh_token); expect(parentReplay.status).toBe(200); expect((await parentReplay.json()).refresh_token).toBe(s2.refresh_token);
    const s3 = await (await rf(s2.refresh_token)).json(); expect(s3.refresh_token).toBeTruthy();
    await sleep(11_000);                                                            // past GoTrue's 10s reuse interval
    expect((await rf(s1.refresh_token)).status).toBeGreaterThanOrEqual(400);        // grandparent: reuse detected
    // OBSERVED: reuse is rejected but the live session is NOT revoked (no family revocation in this GoTrue version/config) — recorded, not assumed.
    expect((await rf(s3.refresh_token)).status).toBe(200);
  }, 60_000);
});
