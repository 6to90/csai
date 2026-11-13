import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';

export const BASE = process.env.API_BASE!;
export const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 20 });
export const uniq = () => randomUUID().slice(0, 8);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function mintJwt(sub: string, opts: { exp?: number; secret?: string; role?: string; aal?: string } = {}) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ sub, role: opts.role ?? 'authenticated', aud: 'authenticated', aal: opts.aal ?? 'aal2', exp: opts.exp ?? Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${p}.${createHmac('sha256', opts.secret ?? process.env.JWT_SECRET!).update(`${h}.${p}`).digest('base64url')}`;
}
export interface TUser { id: string; email: string; token: string; totpSecret?: string; factorId?: string }
const REAL = process.env.REAL_SUPABASE === '1';
const PASSWORD = 'Test-Password-12345!';
const authHeaders = (key: string) => ({ apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' });

/**
 * REAL mode: users come from real GoTrue (admin create + real password grant => real JWT with session_id).
 * By default users are MFA-verified (aal2: TOTP enrolled + verified through GoTrue) because owners/admins need it; pass { aal: 'aal1' } for a plain password session.
 * Stub mode: direct auth.users insert + HS256 mint with the requested aal claim.
 */
export async function mkUser(label: string, confirmed = true, opts: { aal?: 'aal1' | 'aal2' } = {}): Promise<TUser> {
  const aal = opts.aal ?? 'aal2';
  const email = `${label}-${uniq()}@example.com`;
  if (!REAL) {
    const { rows } = await pool.query('insert into auth.users(id, email, email_confirmed_at) values (gen_random_uuid(), $1,$2) returning id', [email, confirmed ? new Date() : null]);
    return { id: rows[0].id, email, token: mintJwt(rows[0].id, { aal }) };
  }
  const base = process.env.SUPABASE_URL!;
  const c = await fetch(`${base}/auth/v1/admin/users`, { method: 'POST', headers: authHeaders(process.env.SERVICE_KEY!), body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }) });
  if (c.status !== 200) throw new Error(`gotrue admin create failed: ${c.status}`);
  const id = (await c.json()).id as string;
  let token = (await realLogin(email)).access_token; let totpSecret: string | undefined, factorId: string | undefined;
  if (aal === 'aal2') ({ token, totpSecret, factorId } = await upgradeToAal2(token));
  // GoTrue never issues a session to an unconfirmed address; to exercise "valid JWT, unverified e-mail" we un-confirm AFTER login.
  if (!confirmed) await pool.query('update auth.users set email_confirmed_at = null where id=$1', [id]);
  return { id, email, token, totpSecret, factorId };
}
const bearer = (t: string) => ({ apikey: process.env.ANON_KEY!, authorization: `Bearer ${t}`, 'content-type': 'application/json' });
/** Real GoTrue MFA: enroll TOTP -> challenge -> verify with a computed code -> returns the aal2 access token. */
export async function upgradeToAal2(aal1Token: string) {
  const base = `${process.env.SUPABASE_URL}/auth/v1`;
  const en = await fetch(`${base}/factors`, { method: 'POST', headers: bearer(aal1Token), body: JSON.stringify({ factor_type: 'totp', friendly_name: `t-${uniq()}`, issuer: 'csai-test' }) });
  if (en.status !== 200) throw new Error(`mfa enroll failed ${en.status}`);
  const f = await en.json(); const secret = f.totp.secret as string;
  const token = await verifyTotp(aal1Token, f.id, secret);
  return { token, totpSecret: secret, factorId: f.id as string };
}
export async function verifyTotp(accessToken: string, factorId: string, secret: string, code?: string): Promise<string> {
  const base = `${process.env.SUPABASE_URL}/auth/v1`;
  const ch = await fetch(`${base}/factors/${factorId}/challenge`, { method: 'POST', headers: bearer(accessToken), body: '{}' });
  if (ch.status !== 200) throw new Error(`mfa challenge failed ${ch.status}`);
  const v = await fetch(`${base}/factors/${factorId}/verify`, { method: 'POST', headers: bearer(accessToken), body: JSON.stringify({ challenge_id: (await ch.json()).id, code: code ?? (await import('./totp')).totp(secret) }) });
  if (v.status !== 200) throw Object.assign(new Error(`mfa verify failed ${v.status}`), { status: v.status, body: await v.json().catch(() => null) });
  return (await v.json()).access_token as string;
}
export const CAPTCHA_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';   // Cloudflare's documented dummy token; accepted only by the dummy "always pass" secret
export async function realLogin(email: string, password = PASSWORD) {
  const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: authHeaders(process.env.ANON_KEY!), body: JSON.stringify({ email, password, gotrue_meta_security: { captcha_token: CAPTCHA_TOKEN } }) });
  const body = await r.json();
  if (r.status !== 200) throw Object.assign(new Error(`login failed ${r.status}`), { status: r.status, body });
  return body as { access_token: string; refresh_token: string; expires_in: number; user: { id: string } };
}
export const TEST_PASSWORD = PASSWORD;

export const sql = async <T = Record<string, unknown>>(q: string, p: unknown[] = []) => (await pool.query(q, p)).rows as T[];

export interface Res<T = any> { status: number; body: T; headers: Headers; text: string }
export async function call(method: string, path: string, o: { user?: TUser | { token: string }; org?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  // distinct fake client IP per user (the app trusts 1 proxy hop, i.e. the LAST X-Forwarded-For entry) so IP buckets don't leak between tests
  const headers: Record<string, string> = { 'x-forwarded-for': o.user && 'id' in o.user ? `10.${parseInt(o.user.id.slice(0, 2), 16)}.${parseInt(o.user.id.slice(2, 4), 16)}.${parseInt(o.user.id.slice(4, 6), 16)}` : '10.0.0.1', ...(o.headers ?? {}) };
  if (o.user) headers.authorization = `Bearer ${o.user.token}`;
  if (o.org) headers['x-org-id'] = o.org;
  if (o.body !== undefined || o.raw !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, { method, headers, body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined), redirect: 'manual' });
  const text = await r.text();
  let body: any = null; try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body, headers: r.headers, text };
}
export const tokenOf = (acceptUrl: string) => new URL(acceptUrl).searchParams.get('token')!;

export async function mkOrg(owner: TUser): Promise<string> {
  const r = await call('POST', '/api/v1/orgs', { user: owner, body: { name: 'Org', slug: `org-${uniq()}` } });
  if (r.status !== 201) throw new Error(`mkOrg failed ${r.status} ${r.text}`);
  return r.body.data.id;
}
export async function invite(org: string, by: TUser, email: string, role = 'agent') {
  return call('POST', '/api/v1/org/invitations', { user: by, org, body: { email, role } });
}
export async function addMember(org: string, by: TUser, who: TUser, role: string) {
  const inv = await invite(org, by, who.email, role);
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status} ${inv.text}`);
  const acc = await call('POST', '/api/v1/invitations/accept', { user: who, body: { token: tokenOf(inv.body.data.accept_url) } });
  if (acc.status !== 200) throw new Error(`accept failed ${acc.status} ${acc.text}`);
}
