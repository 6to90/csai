import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { call, CAPTCHA_TOKEN, invite, mkOrg, mkUser, pool, realLogin, TEST_PASSWORD, tokenOf, uniq } from '../api/helpers';
import { mailpitSender } from '@/server/adapters/mail';
import { inviteCode } from '@/server/domain/invite-proof';

// REAL local Supabase + Next server (no mail transport configured => links come back in the response). Run via scripts/test-supabase.sh.
const CRON = { authorization: 'Bearer test-cron-secret-value' };
const MAIL = process.env.MAIL_URL!;
const provision = (email: string, slug: string, headers: Record<string, string> = CRON) => call('POST', '/api/internal/customers', { headers, body: { email, org_name: 'Acme', slug } });
const mkCustomer = async () => { const email = `cust-${uniq()}@example.com`, slug = `acme-${uniq()}`; const r = await provision(email, slug); expect(r.status).toBe(201); return { email, slug, org: r.body.data.org_id as string, token: tokenOf(r.body.data.accept_url), inv: r.body.data.invitation_id as string }; };
const ip = (_n: string) => ({ 'x-forwarded-for': `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });   // fresh IP bucket per call
const preview = (token: string, h = ip('1.1')) => call('POST', '/api/v1/invitations/preview', { body: { token }, headers: h });
const redeemRaw = (body: Record<string, unknown>, h: Record<string, string>) => call('POST', '/api/v1/invitations/redeem', { body, headers: h });
// Sign-up now needs proof of mailbox: step 1 mails a code (202), step 2 presents it. The test derives the code with the same server secret
// (it is only ever delivered by e-mail in production). Non-202 answers (404/409/429/422...) are returned unchanged from step 1.
const redeem = async (token: string, password: string, h = ip('1.2')) => {
  const first = await redeemRaw({ token, password }, h);
  if (first.status !== 202) return first;
  const email = (await preview(token, ip('1.3'))).body.data.email as string;
  return redeemRaw({ token, password, code: inviteCode(token, email) }, h);
};
const bad = `${uniq()}${'x'.repeat(35)}`;   // fresh per run: rate-limit counters outlive a test run

describe('operator provisioning', () => {
  it('requires the operator secret', async () => {
    for (const h of [{}, { authorization: 'Bearer nope' }] as Record<string, string>[]) expect((await provision('a@example.com', 'acme-none', h)).status).toBe(401);
  });
  it('creates the org + owner invitation, is retry-safe (old link dies), refuses a different e-mail for an unclaimed org', async () => {
    const c = await mkCustomer();
    const again = await provision(c.email, c.slug); expect(again.status).toBe(201);
    const t2 = tokenOf(again.body.data.accept_url); expect(t2).not.toBe(c.token);
    expect((await preview(c.token)).status).toBe(404); expect((await preview(t2)).status).toBe(200);
    expect((await provision(`other-${uniq()}@example.com`, c.slug)).status).toBe(409);
    expect((await pool.query("select count(*)::int n from invitations where org_id=$1", [c.org])).rows[0].n).toBe(1);
    expect((await pool.query("select token_hash::text from invitations where org_id=$1", [c.org])).rows[0].token_hash).not.toContain(t2);
  });
  it('bad input is rejected', async () => {
    for (const body of [{}, { email: 'x', org_name: 'A', slug: 'abc' }, { email: 'a@b.co', org_name: '', slug: 'abc' }, { email: 'a@b.co', org_name: 'A', slug: 'A!' }])
      expect((await call('POST', '/api/internal/customers', { headers: CRON, body })).status).toBe(422);
  });
});

describe('invite-by-link onboarding (new account)', () => {
  it('preview -> redeem -> login -> accept makes the invitee the owner; the link is single-use', async () => {
    const c = await mkCustomer();
    const pv = await preview(c.token); expect(pv.body.data).toMatchObject({ org_name: 'Acme', email: c.email, role: 'owner', has_account: false });
    expect((await redeem(c.token, 'short')).status).toBe(422);                                       // < 10 chars
    const r = await redeem(c.token, TEST_PASSWORD); expect(r.status).toBe(201);
    const s = await realLogin(c.email);
    const acc = await call('POST', '/api/v1/invitations/accept', { user: { token: s.access_token }, body: { token: c.token }, headers: ip('') });
    expect([acc.status, acc.body.data]).toEqual([200, { org_id: c.org, role: 'owner' }]);
    expect((await pool.query('select role from memberships where org_id=$1 and user_id=$2', [c.org, s.user.id])).rows[0].role).toBe('owner');
    for (const res of [await preview(c.token), await redeem(c.token, TEST_PASSWORD)]) expect([res.status, res.body.error.code]).toEqual([404, 'invitation_invalid']);
    expect((await call('POST', '/api/v1/invitations/accept', { user: { token: s.access_token }, body: { token: c.token }, headers: ip('') })).status).toBe(404);
    expect((await pool.query("select 1 from audit_logs where org_id=$1 and action in ('org.create','invitation.create','invitation.accept')", [c.org])).rowCount).toBe(3);
  });
  it('an unmatched, expired or revoked link answers the same 404 everywhere', async () => {
    const c = await mkCustomer(); const d = await mkCustomer();
    await pool.query("update invitations set expires_at = now() - interval '1 minute' where id=$1", [c.inv]);
    await pool.query("update invitations set status='revoked', revoked_at=now() where id=$1", [d.inv]);
    for (const t of [bad, c.token, d.token]) for (const res of [await preview(t), await redeem(t, TEST_PASSWORD)]) expect([res.status, res.body.error.code, res.body.error.message]).toEqual([404, 'invitation_invalid', 'invitation is invalid']);
    expect((await pool.query('select 1 from auth.users where email in ($1,$2)', [c.email, d.email])).rowCount).toBe(0);   // no account was created
  });
  it('concurrent redeems of one link create exactly one account', async () => {
    const c = await mkCustomer();
    const rs = await Promise.all([1, 2, 3, 4].map((i) => redeem(c.token, TEST_PASSWORD, ip(`2.${i}`))));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect((await pool.query('select 1 from auth.users where email=$1', [c.email])).rowCount).toBe(1);
  });
  it('concurrent accepts of one link: exactly one membership', async () => {
    const c = await mkCustomer(); await redeem(c.token, TEST_PASSWORD, ip('3.1'));
    const s = await realLogin(c.email);
    const rs = await Promise.all([1, 2, 3].map(() => call('POST', '/api/v1/invitations/accept', { user: { token: s.access_token }, body: { token: c.token }, headers: ip('') })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await pool.query('select 1 from memberships where org_id=$1', [c.org])).rowCount).toBe(1);
  });
  it('redeem is rate-limited per link', async () => {
    const tok = `${uniq()}${'y'.repeat(35)}`; const out: number[] = []; for (let i = 0; i < 12; i++) out.push((await redeem(tok, TEST_PASSWORD, ip(`4.${i}`))).status);
    expect(out.slice(0, 10)).toEqual(Array(10).fill(404)); expect(out.slice(10)).toEqual([429, 429]);
  });
});

describe('existing accounts and e-mail binding', () => {
  it('an existing account is told to sign in and its password is never changed; another user cannot accept (e-mail mismatch)', async () => {
    const owner = await mkUser('o'); const org = await mkOrg(owner);
    const u = await mkUser('exist', true, { aal: 'aal1' });
    const inv = await invite(org, owner, u.email, 'agent'); const token = tokenOf(inv.body.data.accept_url);
    expect((await preview(token)).body.data.has_account).toBe(true);
    const r = await redeem(token, 'Another-Password-999!'); expect([r.status, r.body.error.code]).toEqual([409, 'account_exists']);
    await realLogin(u.email, TEST_PASSWORD);                                                       // still the old password
    const other = await mkUser('other', true, { aal: 'aal1' });
    expect((await call('POST', '/api/v1/invitations/accept', { user: other, body: { token } })).status).toBe(403);
    expect((await call('POST', '/api/v1/invitations/accept', { user: u, body: { token } })).status).toBe(200);   // not consumed by the mismatch
  });
  it('admin: list shows e-mails + pending invitation and can revoke; resend kills the old link; agent sees only self; other org is invisible', async () => {
    const owner = await mkUser('o2'); const org = await mkOrg(owner); const other = await mkUser('o3'); const org2 = await mkOrg(other);
    const email = `inv-${uniq()}@example.com`;
    const i1 = await invite(org, owner, email, 'viewer'); const t1 = tokenOf(i1.body.data.accept_url);
    expect((await invite(org, owner, email, 'viewer')).status).toBe(409);                           // duplicate pending
    const rs = await call('POST', `/api/v1/org/invitations/${i1.body.data.id}/resend`, { user: owner, org }); expect(rs.status).toBe(200);
    expect((await preview(t1)).status).toBe(404); expect((await preview(tokenOf(rs.body.data.accept_url))).status).toBe(200);
    const m = await call('GET', '/api/v1/org/members', { user: owner, org }); expect(m.body.data[0].email).toBe(owner.email);
    const agent = await mkUser('ag', true, { aal: 'aal1' });
    const ai = await invite(org, owner, agent.email, 'agent'); await call('POST', '/api/v1/invitations/accept', { user: agent, body: { token: tokenOf(ai.body.data.accept_url) } });
    const am = await call('GET', '/api/v1/org/members', { user: agent, org }); expect(am.body.data.map((x: { email: string }) => x.email)).toEqual([agent.email]);
    expect((await call('GET', '/api/v1/org/members', { user: other, org })).status).toBe(404);
    expect((await call('POST', `/api/v1/org/invitations/${i1.body.data.id}/revoke`, { user: other, org: org2 })).status).toBeGreaterThanOrEqual(403);
    expect((await call('POST', `/api/v1/org/invitations/${i1.body.data.id}/revoke`, { user: owner, org })).status).toBe(200);
    expect((await preview(tokenOf(rs.body.data.accept_url))).status).toBe(404);
  });
  it('an admin cannot create owner invitations or promote through the invitation API', async () => {
    const owner = await mkUser('o4'); const org = await mkOrg(owner);
    expect((await call('POST', '/api/v1/org/invitations', { user: owner, org, body: { email: `x-${uniq()}@example.com`, role: 'owner' } })).status).toBe(422);
  });
});

describe('mail adapter', () => {
  it('delivers through Mailpit and the invitation link is in the message', async () => {
    const to = `mail-${uniq()}@example.com`; process.env.MAIL_FROM = 'no-reply@csai.test';
    await mailpitSender(MAIL).send({ to, subject: '테스트\r\nBcc: evil@example.com', text: 'https://app.test/invite?token=abc' });
    const list = await (await fetch(`${MAIL}/api/v1/messages`)).json();
    const m = list.messages.find((x: { To: { Address: string }[] }) => x.To?.[0]?.Address === to); expect(m).toBeTruthy();
    expect(m.Subject).not.toContain('\n'); expect(m.Bcc ?? []).toHaveLength(0);
  });
  it('the server log never contains invite tokens or passwords', async () => {
    const c = await mkCustomer(); await redeem(c.token, TEST_PASSWORD, ip('5.1'));
    const log = process.env.NEXT_LOG ? readFileSync(process.env.NEXT_LOG, 'utf8') : '';
    expect(log).not.toContain(c.token); expect(log).not.toContain(TEST_PASSWORD); void CAPTCHA_TOKEN;
  });
});

describe('redeem proof of mailbox (real GoTrue)', () => {
  it('token + password alone never creates an account; a wrong code is refused; the right code creates a confirmed account that can accept', async () => {
    const c = await mkCustomer();
    const h = ip('6.1');
    expect((await redeemRaw({ token: c.token, password: TEST_PASSWORD }, h)).status).toBe(202);          // code mailed (dev: logged), nothing created yet
    expect((await preview(c.token)).body.data.has_account).toBe(false);
    expect((await redeemRaw({ token: c.token, password: TEST_PASSWORD, code: '00000000' }, h)).status).toBe(422);
    expect((await preview(c.token)).body.data.has_account).toBe(false);
    expect((await redeemRaw({ token: c.token, password: TEST_PASSWORD, code: inviteCode(c.token, c.email) }, h)).status).toBe(201);
    expect((await preview(c.token)).body.data.has_account).toBe(true);
  });
});
